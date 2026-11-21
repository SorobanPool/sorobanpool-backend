import { getSecondsUntilExpiry, validateQuoteExpiry, AnchorError, QUOTE_EXPIRY_SECONDS, MockAnchor } from './anchor.js';
import { startHarness, type Harness } from '../../test/harness.js';

describe('Quote Expiry', () => {
  describe('validateQuoteExpiry', () => {
    it('accepts valid quote expiry', () => {
      const now = new Date('2026-03-10T12:00:00Z');
      const expiresAtSeconds = Math.floor(now.getTime() / 1000) + 30; // 30 seconds in future

      expect(() => validateQuoteExpiry(expiresAtSeconds, now)).not.toThrow();
    });

    it('rejects expired quote', () => {
      const now = new Date('2026-03-10T12:00:00Z');
      const expiresAtSeconds = Math.floor(now.getTime() / 1000) - 30; // 30 seconds in past

      expect(() => validateQuoteExpiry(expiresAtSeconds, now)).toThrow(AnchorError);
      try {
        validateQuoteExpiry(expiresAtSeconds, now);
      } catch (e) {
        const error = e as AnchorError;
        expect(error.code).toBe('QUOTE_EXPIRED');
      }
    });

    it('rejects quote at exactly the expiry boundary', () => {
      const now = new Date('2026-03-10T12:00:00Z');
      const expiresAtSeconds = Math.floor(now.getTime() / 1000);

      expect(() => validateQuoteExpiry(expiresAtSeconds, now)).toThrow(AnchorError);
    });

    it('accepts quote at boundary + 1 second', () => {
      const now = new Date('2026-03-10T12:00:00Z');
      const expiresAtSeconds = Math.floor(now.getTime() / 1000) + 1;

      expect(() => validateQuoteExpiry(expiresAtSeconds, now)).not.toThrow();
    });
  });

  describe('getSecondsUntilExpiry', () => {
    it('returns correct seconds until expiry', () => {
      const now = new Date('2026-03-10T12:00:00Z');
      const expiresAtSeconds = Math.floor(now.getTime() / 1000) + 45;

      const remaining = getSecondsUntilExpiry(expiresAtSeconds, now);
      expect(remaining).toBe(45);
    });

    it('returns 0 for expired quote', () => {
      const now = new Date('2026-03-10T12:00:00Z');
      const expiresAtSeconds = Math.floor(now.getTime() / 1000) - 30;

      const remaining = getSecondsUntilExpiry(expiresAtSeconds, now);
      expect(remaining).toBe(0);
    });
  });

  describe('MockAnchor quote expiry', () => {
    let h: Harness;
    beforeAll(async () => { h = await startHarness(); });
    afterAll(async () => { await h.close(); });

    it('includes expiresAtSeconds in startDeposit response', async () => {
      const user = await h.s.prisma.user.create({ data: { phone: '+2348015555555' } });
      const before = Math.floor(h.s.now().getTime() / 1000);
      const deposit = await h.s.anchor!.startDeposit(user.id, 50_000n);
      const after = Math.floor(h.s.now().getTime() / 1000);

      expect(deposit.expiresAtSeconds).toBeDefined();
      expect(deposit.expiresAtSeconds).toBeGreaterThanOrEqual(before + QUOTE_EXPIRY_SECONDS);
      expect(deposit.expiresAtSeconds).toBeLessThanOrEqual(after + QUOTE_EXPIRY_SECONDS + 1);
    });

    it('quote expires after 60 seconds', async () => {
      const user = await h.s.prisma.user.create({ data: { phone: '+2348016666666' } });
      const deposit = await h.s.anchor!.startDeposit(user.id, 100_000n);

      // Quote should be valid at current time
      expect(() => validateQuoteExpiry(deposit.expiresAtSeconds, h.s.now())).not.toThrow();

      // Create a time 61 seconds in the future
      const futureTime = new Date(h.s.now().getTime() + 61_000);
      expect(() => validateQuoteExpiry(deposit.expiresAtSeconds, futureTime)).toThrow(AnchorError);
    });

    it('quote is valid at 59 seconds boundary', async () => {
      const user = await h.s.prisma.user.create({ data: { phone: '+2348017777777' } });
      const deposit = await h.s.anchor!.startDeposit(user.id, 150_000n);

      // Create a time 59 seconds in the future
      const boundaryTime = new Date(h.s.now().getTime() + 59_000);
      expect(() => validateQuoteExpiry(deposit.expiresAtSeconds, boundaryTime)).not.toThrow();
    });

    it('quote is invalid at 61 seconds boundary', async () => {
      const user = await h.s.prisma.user.create({ data: { phone: '+2348018888888' } });
      const deposit = await h.s.anchor!.startDeposit(user.id, 200_000n);

      // Create a time 61 seconds in the future
      const boundaryTime = new Date(h.s.now().getTime() + 61_000);
      expect(() => validateQuoteExpiry(deposit.expiresAtSeconds, boundaryTime)).toThrow(AnchorError);
    });
  });
});
