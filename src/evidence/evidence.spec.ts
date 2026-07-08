import sharp from 'sharp';
import { canReadEvidence, evidenceHash, signUrl, toPublicThumbnail, validateUpload, verifySignedUrl } from './evidence.js';
import { renderShareCard, shareCardSvg } from '../sharecards/sharecard.js';

describe('evidence', () => {
  it('hashes bytes deterministically', () => {
    expect(evidenceHash(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('limits type and size', () => {
    expect(validateUpload('image/jpeg', 1000)).toBeNull();
    expect(validateUpload('application/x-msdownload', 1000)).toMatch(/not allowed/);
    expect(validateUpload('image/png', 16 * 1024 * 1024)).toMatch(/between/);
    expect(validateUpload('image/png', 0)).toMatch(/between/);
  });
  it('restricts reading to participants, the assigned arbiter and admins', () => {
    const base = { userId: 'u', roles: ['TRADER'], isPoolParticipant: false };
    expect(canReadEvidence(base)).toBe(false);
    expect(canReadEvidence({ ...base, isPoolParticipant: true })).toBe(true);
    expect(canReadEvidence({ ...base, roles: ['ADMIN'] })).toBe(true);
    expect(canReadEvidence({ ...base, roles: ['ARBITER'], disputeId: 5n, assignedArbiterFor: 5n })).toBe(true);
    expect(canReadEvidence({ ...base, roles: ['ARBITER'], disputeId: 5n, assignedArbiterFor: 6n })).toBe(false);
    expect(canReadEvidence({ ...base, roles: ['ARBITER'] })).toBe(false);
  });
  it('signs URLs for five minutes and rejects tampering', () => {
    const now = 1_700_000_000_000;
    const { url, expires } = signUrl('k'.repeat(32), 'GET', 'pool/1/a.jpg', 'u1', now);
    const q = new URL(url, 'http://x').searchParams;
    const p = { key: q.get('key')!, u: q.get('u')!, e: Number(q.get('e')), s: q.get('s')! };
    expect(expires - now / 1000).toBe(300);
    expect(verifySignedUrl('k'.repeat(32), 'GET', p, now + 299_000)).toBe(true);
    expect(verifySignedUrl('k'.repeat(32), 'GET', p, now + 301_000)).toBe(false);
    expect(verifySignedUrl('k'.repeat(32), 'GET', { ...p, u: 'u2' }, now)).toBe(false);
    expect(verifySignedUrl('x'.repeat(32), 'GET', p, now)).toBe(false);
    expect(verifySignedUrl('k'.repeat(32), 'PUT', p, now)).toBe(false); // a read link never authorises a write
  });
  it('turns a large photo into a small WebP with no metadata', async () => {
    const src = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#c33' } })
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-location' } } })
      .jpeg()
      .toBuffer();
    const out = await toPublicThumbnail(src);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(640);
    expect(meta.exif).toBeUndefined();
    expect(out.length).toBeLessThan(src.length);
  });
});

describe('share card', () => {
  const input = {
    product: 'Mama Gold <Rice> 50kg', supplier: 'Tunde & Sons Ltd', currentPriceNaira: '45,000',
    nextBreak: { unitsToGo: 30, priceNaira: '43,500' }, unitsToMoq: 0, progressPct: 140, deadlineLabel: 'closes Fri 9 Oct',
  };
  it('escapes user text and clamps progress', () => {
    const svg = shareCardSvg(input);
    expect(svg).toContain('Mama Gold &lt;Rice&gt; 50kg');
    expect(svg).toContain('Tunde &amp; Sons');
    expect(svg).toContain('width="1080" height="28" rx="14" fill="#0b6b3a"'); // 100%, not 140%
    expect(svg).toContain('Built on Stellar');
  });
  it('renders a 1200x630 PNG', async () => {
    const png = await renderShareCard(input);
    const meta = await sharp(png).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 1200, 630]);
  });
});
