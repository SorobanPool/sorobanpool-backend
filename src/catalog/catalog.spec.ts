import { canonicalJson } from '../common/canonical-json.js';
import { offerHash, type OfferTerms } from './offer.js';
import { validateOffer, findBannedKeyword, type OfferDraft } from './offer-validation.js';
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
  it('blocks regulated goods by keyword without matching inside other words', () => {
    expect(findBannedKeyword('Premium vodka 75cl')).toBe('vodka');
    expect(findBannedKeyword('Cooking oil')).toBeUndefined();
    expect(findBannedKeyword('Ginger tea')).toBeUndefined();
    expect(findBannedKeyword('Air guns and spirits')).toBe('spirit');
    expect(validateOffer(draft({ title: 'Imported wine' }), now).errors.join()).toMatch(/banned keyword/);
  });
  it('flags price outliers for review but does not block them', () => {
    const r = validateOffer(draft(), now, 1000n);
    expect(r.errors).toEqual([]);
    expect(r.flags).toHaveLength(1);
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
