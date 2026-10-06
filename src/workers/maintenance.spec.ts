import { checkSponsor, expireOffers } from './maintenance.js';
import { startHarness, type Harness } from '../../test/harness.js';

describe('checkSponsor', () => {
  it('flags a balance below the floor and not one at or above it', async () => {
    const at = (b: bigint) => checkSponsor({ sponsorBalance: async () => b }, 100);
    expect((await at(999_999_999n)).low).toBe(true);
    expect((await at(1_000_000_000n)).low).toBe(false);
    expect((await at(0n)).low).toBe(true);
  });
  it('propagates balance read failures instead of reporting healthy', async () => {
    await expect(checkSponsor({ sponsorBalance: async () => { throw new Error('horizon 503'); } }, 100)).rejects.toThrow('horizon 503');
  });
});

describe('expireOffers', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });

  it('expires only live offers past validUntil', async () => {
    const user = await h.s.prisma.user.create({ data: { phone: '+2348011111111' } });
    const mk = (status: 'LIVE' | 'DRAFT', validUntil: Date) => h.s.prisma.offer.create({ data: {
      supplierId: user.id, title: 't', description: 'd', unitLabel: 'bag', category: 'rice', images: [], tiersNgn: [], tiersUsdc: [],
      fxQuoteId: 'q', moq: 1, maxUnits: 10, maxPerMember: 5, leadTimeHours: 24, deliveryAreas: [], validUntil, offerHash: 'h', status,
    } });
    const now = new Date('2026-01-10T00:00:00Z');
    const past = await mk('LIVE', new Date('2026-01-09T00:00:00Z'));
    const future = await mk('LIVE', new Date('2026-01-11T00:00:00Z'));
    const draft = await mk('DRAFT', new Date('2026-01-09T00:00:00Z'));
    expect(await expireOffers(h.s.prisma, now)).toBe(1);
    const status = async (id: string) => (await h.s.prisma.offer.findUniqueOrThrow({ where: { id } })).status;
    expect([await status(past.id), await status(future.id), await status(draft.id)]).toEqual(['EXPIRED', 'LIVE', 'DRAFT']);
    expect(await expireOffers(h.s.prisma, now)).toBe(0);
  });
});
