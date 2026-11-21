import { chainState, checkSponsor, expireOffers, expireStaleAnchorTransfers, MismatchTracker, purgeIdempotencyKeys, reconcilePools, toStroopsString } from './maintenance.js';
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

describe('reconcile', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });

  it('chainState accepts decoded enum arrays and strings; toStroopsString is exact', () => {
    expect([chainState(['Open']), chainState('Filled')]).toEqual(['Open', 'Filled']);
    expect(toStroopsString('167.054905')).toBe('1670549050');
    expect(toStroopsString('0')).toBe('0');
    expect(toStroopsString('12345678901234.1234567')).toBe('123456789012341234567');
  });

  it('reports state, units and escrow differences for live pools only, and alerts only when persistent', async () => {
    const u = await h.s.prisma.user.create({ data: { phone: '+2348012222222' } });
    const offer = await h.s.prisma.offer.create({ data: { supplierId: u.id, title: 't', description: 'd', unitLabel: 'u', category: 'rice', images: [], tiersNgn: [], tiersUsdc: [], fxQuoteId: 'q', moq: 1, maxUnits: 9, maxPerMember: 9, leadTimeHours: 1, deliveryAreas: [], validUntil: new Date(), offerHash: 'h3', status: 'LIVE' } });
    const mk = (id: bigint, state: string, totalUnits: number, escrow: string) => h.s.prisma.pool.create({ data: { id, offerId: offer.id, organizerAddress: 'o', supplierAddress: 's', hubAddress: 'h', hubContact: 'c', hubHash: 'x', pickupWindow: {}, state, totalUnits, escrowBalance: escrow, fillDeadline: new Date(), shareSlug: `r${id}` } });
    await mk(701n, 'Open', 5, '10'); // matches
    await mk(702n, 'Open', 5, '10'); // chain has moved on
    await mk(703n, 'Settled', 5, '10'); // final: not checked
    const onChain: Record<string, Record<string, unknown>> = {
      '701': { state: ['Open'], total_units: 5, escrow_balance: 100_000_000n },
      '702': { state: ['Filled'], total_units: 7, escrow_balance: 100_000_000n },
    };
    const chain = { view: async (_n: string, _f: string, a: bigint[]) => onChain[String(a[0])]! };
    const found = await reconcilePools(h.s.prisma, chain as never, (id) => [id]);
    expect(found.map((m) => `${m.poolId}:${m.field}:${m.db}->${m.chain}`)).toEqual(['702:state:Open->Filled', '702:totalUnits:5->7']);
    const t = new MismatchTracker();
    expect(t.persistent(found)).toEqual([]); // first sighting: could be indexer lag
    expect(t.persistent(found)).toHaveLength(2); // second: real
    expect(t.persistent([])).toEqual([]);
  });
});

describe('purgeIdempotencyKeys (#173)', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });

  it('deletes keys older than the retention window in batches and keeps fresh ones', async () => {
    const now = new Date('2026-03-10T00:00:00Z');
    const day = 86_400_000;
    const mk = (key: string, ageDays: number) =>
      h.s.prisma.idempotencyKey.create({ data: { key, userId: 'u1', createdAt: new Date(now.getTime() - ageDays * day) } });
    for (let i = 0; i < 5; i++) await mk(`old-${i}`, 8 + i);
    await mk('edge', 6.9);
    await mk('fresh', 1);

    // batchSize 2 forces three batches for five expired keys.
    expect(await purgeIdempotencyKeys(h.s.prisma, now, 7, 2)).toBe(5);
    const left = (await h.s.prisma.idempotencyKey.findMany({ orderBy: { key: 'asc' } })).map((k) => k.key);
    expect(left).toEqual(['edge', 'fresh']);
    expect(await purgeIdempotencyKeys(h.s.prisma, now, 7, 2)).toBe(0);
  });

  it('stops after maxBatches so a large backlog drains over several runs', async () => {
    const now = new Date('2026-03-10T00:00:00Z');
    for (let i = 0; i < 6; i++) {
      await h.s.prisma.idempotencyKey.create({ data: { key: `backlog-${i}`, userId: 'u2', createdAt: new Date('2026-01-01T00:00:00Z') } });
    }
    expect(await purgeIdempotencyKeys(h.s.prisma, now, 7, 2, 2)).toBe(4);
    expect(await purgeIdempotencyKeys(h.s.prisma, now, 7, 2, 2)).toBe(2);
  });
});

describe('expireStaleAnchorTransfers', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });

  it('marks pending anchor transfers older than the limit as EXPIRED', async () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const expiryMinutes = 1440; // 24 hours
    const user = await h.s.prisma.user.create({ data: { phone: '+2348013333333' } });

    // Create transfers at different ages
    const oldTransfer = await h.s.prisma.anchorTransfer.create({
      data: {
        id: 'old-1',
        userId: user.id,
        kind: 'DEPOSIT',
        anchor: 'mock',
        anchorTxId: '',
        status: 'PENDING',
        createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      },
    });
    const freshTransfer = await h.s.prisma.anchorTransfer.create({
      data: {
        id: 'fresh-1',
        userId: user.id,
        kind: 'DEPOSIT',
        anchor: 'mock',
        anchorTxId: '',
        status: 'PENDING',
        createdAt: new Date(now.getTime() - 12 * 60 * 60 * 1000), // 12 hours ago
      },
    });
    const completedTransfer = await h.s.prisma.anchorTransfer.create({
      data: {
        id: 'completed-1',
        userId: user.id,
        kind: 'DEPOSIT',
        anchor: 'mock',
        anchorTxId: 'tx-1',
        status: 'COMPLETED',
        createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000), // 2 days ago but COMPLETED
      },
    });

    const result = await expireStaleAnchorTransfers(h.s.prisma, now, expiryMinutes);

    expect(result.expired).toBe(1);
    expect(result.flaggedForReview).toBe(0);

    // Verify status changes
    const oldStatus = (await h.s.prisma.anchorTransfer.findUnique({ where: { id: 'old-1' } }))?.status;
    const freshStatus = (await h.s.prisma.anchorTransfer.findUnique({ where: { id: 'fresh-1' } }))?.status;
    const completedStatus = (await h.s.prisma.anchorTransfer.findUnique({ where: { id: 'completed-1' } }))?.status;

    expect(oldStatus).toBe('EXPIRED');
    expect(freshStatus).toBe('PENDING');
    expect(completedStatus).toBe('COMPLETED');
  });

  it('expires only pending transfers not others', async () => {
    const now = new Date('2026-03-11T12:00:00Z');
    const expiryMinutes = 60;
    const user = await h.s.prisma.user.create({ data: { phone: '+2348014444444' } });

    // Create old transfer with different statuses
    const failedTransfer = await h.s.prisma.anchorTransfer.create({
      data: {
        id: 'failed-old',
        userId: user.id,
        kind: 'DEPOSIT',
        anchor: 'mock',
        anchorTxId: '',
        status: 'FAILED',
        createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      },
    });
    const expiredTransfer = await h.s.prisma.anchorTransfer.create({
      data: {
        id: 'expired-old',
        userId: user.id,
        kind: 'DEPOSIT',
        anchor: 'mock',
        anchorTxId: '',
        status: 'EXPIRED',
        createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      },
    });

    const result = await expireStaleAnchorTransfers(h.s.prisma, now, expiryMinutes);

    expect(result.expired).toBe(0);
    const failedStatus = (await h.s.prisma.anchorTransfer.findUnique({ where: { id: 'failed-old' } }))?.status;
    const expiredStatus = (await h.s.prisma.anchorTransfer.findUnique({ where: { id: 'expired-old' } }))?.status;
    expect(failedStatus).toBe('FAILED');
    expect(expiredStatus).toBe('EXPIRED');
  });
});
