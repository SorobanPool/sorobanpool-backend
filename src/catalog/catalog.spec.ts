import { canonicalJson } from '../common/canonical-json.js';
import { offerHash, type OfferTerms } from './offer.js';
import { validateOffer, findBannedKeyword, type OfferDraft, computeCategoryMedians, isPriceOutlier, ALLOWED_CATEGORIES, CATEGORIES } from './offer-validation.js';
import { combineQuotes, convertTiers, FxDivergenceError, ngnToStroops } from '../fx/fx.js';
import { loadEnv } from '../config/env.js';

const now = new Date('2026-10-05T00:00:00Z');
const draft = (over: Partial<OfferDraft> = {}): OfferDraft => ({
  title: 'Mama Gold Rice 50kg',
  description: 'Parboiled long grain rice',
  brand: 'Mama Gold',
  branded: true,
  unitLabel: '50kg bag',
  category: 'rice',
  images: ['a.webp', 'b.webp'],
  tiers: [
    { minUnits: 100, unitPrice: 10n },
    { minUnits: 200, unitPrice: 9n },
  ],
  moq: 100,
  maxUnits: 500,
  maxPerMember: 100,
  leadTimeHours: 72,
  validUntil: new Date('2026-10-12T00:00:00Z'),
  ...over,
});

describe('canonical JSON and offer hash', () => {
  it('is independent of key order and handles bigint and dates', () => {
    expect(canonicalJson({ b: 1n, a: [2, { z: 1, y: undefined }] })).toBe('{"a":[2,{"z":1}],"b":"1"}');
  });
  it('changes when any commercial term changes', () => {
    const base: OfferTerms = {
      supplierAddress: 'GABC', title: 't', unitLabel: 'u', category: 'rice', perishable: false,
      tiers: [{ minUnits: 10, unitPrice: 5n }], moq: 10, maxUnits: 50, maxPerMember: 10,
      leadTimeHours: 24, validUntil: new Date('2026-10-10T00:00:00Z'),
    };
    const h = offerHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(offerHash({ ...base })).toBe(h);
    expect(offerHash({ ...base, moq: 11 })).not.toBe(h);
    expect(offerHash({ ...base, tiers: [{ minUnits: 10, unitPrice: 6n }] })).not.toBe(h);
  });
});

describe('offer validation', () => {
  it('accepts a good offer', () => {
    expect(validateOffer(draft(), now)).toEqual({ errors: [], flags: [] });
  });
  
  // Issue #70: Test draft with fewer than 2 images
  it('allows drafts with fewer than 2 images but blocks publish', () => {
    const r1 = validateOffer(draft({ images: ['one.webp'] }), now, undefined, { isDraft: true });
    expect(r1.errors).toEqual([]);
    
    const r2 = validateOffer(draft({ images: ['one.webp'] }), now, undefined, { isDraft: false });
    expect(r2.errors.join('|')).toMatch(/at least 2 photos are required/);
  });
  
  // Issue #70: Test with 0 and 2 images
  it('requires at least 2 photos on publish', () => {
    const r0 = validateOffer(draft({ images: [] }), now);
    expect(r0.errors.join('|')).toMatch(/at least 2 photos are required/);
    
    const r2 = validateOffer(draft({ images: ['a.webp', 'b.webp'] }), now);
    expect(r2.errors).toEqual([]);
  });
  
  it('rejects bad tiers, photos, category, brand and validity', () => {
    const r = validateOffer(
      draft({
        tiers: [{ minUnits: 100, unitPrice: 10n }, { minUnits: 100, unitPrice: 10n }],
        images: ['one.webp'],
        category: 'beer',
        brand: '',
        validUntil: new Date('2026-12-01T00:00:00Z'),
        moq: 99,
      }),
      now,
    );
    expect(r.errors.join('|')).toMatch(/minUnits must increase/);
    expect(r.errors.join('|')).toMatch(/strictly decrease/);
    expect(r.errors.join('|')).toMatch(/moq must equal/);
    expect(r.errors.join('|')).toMatch(/photos/);
    expect(r.errors.join('|')).toMatch(/not allowed/);
    expect(r.errors.join('|')).toMatch(/brand/);
    expect(r.errors.join('|')).toMatch(/at most 14 days/);
  });
  
  // Issue #69: Test 14-day boundary
  it('enforces 14-day maximum validity', () => {
    const exactly14Days = new Date(now.getTime() + 14 * 86_400_000);
    const r14 = validateOffer(draft({ validUntil: exactly14Days }), now);
    expect(r14.errors).toEqual([]);
    
    const over14Days = new Date(now.getTime() + 14 * 86_400_000 + 1000);
    const rOver = validateOffer(draft({ validUntil: over14Days }), now);
    expect(rOver.errors.join('|')).toMatch(/at most 14 days/);
  });
  
  it('blocks regulated goods by keyword without matching inside other words', () => {
    expect(findBannedKeyword('Premium vodka 75cl')).toBe('vodka');
    expect(findBannedKeyword('Cooking oil')).toBeUndefined();
    expect(findBannedKeyword('Ginger tea')).toBeUndefined();
    expect(findBannedKeyword('Air guns and spirits')).toBe('spirit');
    expect(validateOffer(draft({ title: 'Imported wine' }), now).errors.join()).toMatch(/not allowed/);
  });
  it('handles simple obfuscation (repeated letters)', () => {
    // Repeated letters: vodkaaa -> vodkaa -> should match vodka
    expect(findBannedKeyword('vodkaa')).toBe('vodka');
    expect(findBannedKeyword('cigarette pack')).toBe('cigarette');
    expect(findBannedKeyword('whiskyyy bottle')).toBe('whisky');
  });
  it('does not trigger false positives on compound words', () => {
    // 'tobacco brown' should not match because 'tobacco' is a whole word
    expect(findBannedKeyword('ginger drink')).toBeUndefined();
    expect(findBannedKeyword('spiritual books')).toBeUndefined();
  });
  it('error message names the matched field without exposing the full list', () => {
    const r = validateOffer(draft({ description: 'Contains tramadol' }), now);
    expect(r.errors[0]).toContain('tramadol');
    expect(r.errors[0]).toContain('not allowed');
    expect(r.errors[0]).not.toContain('BANNED_KEYWORDS');
  });
  
  it('flags price outliers for review but does not block them', () => {
    const r = validateOffer(draft(), now, 1000n);
    expect(r.errors).toEqual([]);
    expect(r.flags).toHaveLength(1);
  });
});

// Issue #65: Test median computation
describe('category median computation', () => {
  it('computes median for odd count', () => {
    const offers = [
      { category: 'rice', tiers: [{ unitPrice: 100n }] },
      { category: 'rice', tiers: [{ unitPrice: 200n }] },
      { category: 'rice', tiers: [{ unitPrice: 300n }] },
    ];
    const medians = computeCategoryMedians(offers);
    expect(medians.get('rice')).toBe(200n);
  });
  
  it('computes median for even count', () => {
    const offers = [
      { category: 'rice', tiers: [{ unitPrice: 100n }] },
      { category: 'rice', tiers: [{ unitPrice: 200n }] },
      { category: 'rice', tiers: [{ unitPrice: 300n }] },
      { category: 'rice', tiers: [{ unitPrice: 400n }] },
    ];
    const medians = computeCategoryMedians(offers);
    expect(medians.get('rice')).toBe(250n);
  });
  
  it('handles new category with no data', () => {
    const offers: Array<{ category: string; tiers: Array<{ unitPrice: bigint }> }> = [];
    const medians = computeCategoryMedians(offers);
    expect(medians.get('rice')).toBeUndefined();
  });
  
  it('handles multiple categories', () => {
    const offers = [
      { category: 'rice', tiers: [{ unitPrice: 100n }] },
      { category: 'rice', tiers: [{ unitPrice: 300n }] },
      { category: 'beans', tiers: [{ unitPrice: 50n }] },
      { category: 'beans', tiers: [{ unitPrice: 150n }] },
    ];
    const medians = computeCategoryMedians(offers);
    expect(medians.get('rice')).toBe(200n);
    expect(medians.get('beans')).toBe(100n);
  });
  
  it('identifies extreme outliers', () => {
    expect(isPriceOutlier(1000n, 100n)).toBe(true); // 10x higher
    expect(isPriceOutlier(10n, 100n)).toBe(true);  // 10x lower
    expect(isPriceOutlier(250n, 100n)).toBe(false); // 2.5x is within 3x
    expect(isPriceOutlier(100n, undefined)).toBe(false); // no median available
  });
});

describe('fx', () => {
  const at = new Date('2026-10-05T00:00:00Z');
  it('takes the median and blocks on divergence over 2%', () => {
    const q = combineQuotes([{ source: 'a', ngnPerUsd: 1500 }, { source: 'b', ngnPerUsd: 1510 }, { source: 'c', ngnPerUsd: 1505 }], at);
    expect(q.rate).toBe(1505);
    expect(() => combineQuotes([{ source: 'a', ngnPerUsd: 1500 }, { source: 'b', ngnPerUsd: 1600 }], at)).toThrow(FxDivergenceError);
    expect(() => combineQuotes([{ source: 'a', ngnPerUsd: 1500 }], at)).toThrow(/two FX sources/);
  });
  it('converts NGN to stroops rounding down and keeps tiers strictly descending', () => {
    expect(ngnToStroops(1500n, 1500)).toBe(10_000_000n); // 1500 NGN at 1500 NGN/USD = 1 USDC
    expect(ngnToStroops(1n, 3)).toBe(3_333_333n); // floor
    const tiers = convertTiers([{ minUnits: 10, priceNgn: 1500n }, { minUnits: 50, priceNgn: 1400n }], 1500);
    expect(tiers[1]!.unitPrice < tiers[0]!.unitPrice).toBe(true);
    expect(() => convertTiers([{ minUnits: 10, priceNgn: 1500n }, { minUnits: 50, priceNgn: 1500n }], 1500)).toThrow();
  });
});

describe('env', () => {
  const base = {
    DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://x', S3_ENDPOINT: 'http://x', S3_BUCKET_PUBLIC: 'p',
    S3_BUCKET_EVIDENCE: 'e', S3_ACCESS_KEY_REF: 'a', S3_SECRET_KEY_REF: 'b',
    JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32), OTP_HMAC_SECRET: 'z'.repeat(32),
    ENCRYPTION_KEY_ID: 'k', RPC_URL: 'http://rpc', HORIZON_URL: 'http://h', NETWORK_PASSPHRASE: 'p',
    SPONSOR_SECRET_REF: 's', ATTESTOR_SECRET_REF: 't', WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ORIGIN: 'http://localhost:3001', PUBLIC_APP_URL: 'http://localhost:3001',
  };
  it('loads valid env and lists every problem otherwise', () => {
    expect(loadEnv(base).ROLE).toBe('api');
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
  it('refuses mainnet without explicit opt-in', () => {
    expect(() => loadEnv({ ...base, STELLAR_NETWORK: 'mainnet' })).toThrow(/MAINNET_ENABLED/);
    expect(loadEnv({ ...base, STELLAR_NETWORK: 'mainnet', MAINNET_ENABLED: 'true' }).STELLAR_NETWORK).toBe('mainnet');
  });
});

describe('categories', () => {
  it('every category has an id, names (EN and PCM), and perishability', () => {
    for (const c of CATEGORIES) {
      expect(c.id).toMatch(/^\w+$/);
      expect(c.nameEn.length).toBeGreaterThan(0);
      expect(c.namePcm.length).toBeGreaterThan(0);
      expect(typeof c.perishable).toBe('boolean');
    }
  });
  it('ALLOWED_CATEGORIES matches the category list', () => {
    expect(ALLOWED_CATEGORIES).toHaveLength(CATEGORIES.length);
    for (const c of CATEGORIES) {
      expect(ALLOWED_CATEGORIES).toContain(c.id);
    }
  });
  it('validation fails if a category is missing from the list', () => {
    const invalid = draft({ category: 'nonexistent' });
    const r = validateOffer(invalid, now);
    expect(r.errors.join()).toMatch(/not allowed/);
  });
});
