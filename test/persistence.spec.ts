import { startTestDb, type TestDb } from './pg.js';
import { a, addr, bytes, i128, raw, tup, u32, u64 } from './events.js';
import { decodeEvent } from '../src/indexer/decode.js';
import { Indexer, type RpcPort } from '../src/indexer/indexer.service.js';
import { Projector } from '../src/indexer/projector.js';
import {
  PrismaCursorStore, PrismaEventSink, PrismaOtpStore, PrismaReadStore, PrismaSessionStore, PrismaUsageStore,
} from '../src/persistence/prisma-stores.js';
import { OtpService } from '../src/auth/otp.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { SponsorshipPolicy } from '../src/relayer/allowlist.js';

const HUB = '03'.repeat(32);
let t: TestDb;
beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.close(); });

const organizer = addr();
const supplier = addr();
const m1 = addr();

async function seedOffer(id: string) {
  await t.prisma.offer.create({
    data: {
      id, supplierId: 's', title: 'Rice', description: 'd', unitLabel: '50kg', category: 'rice', images: ['a', 'b'],
      tiersNgn: [], tiersUsdc: [{ minUnits: 100, unitPrice: '10000000' }, { minUnits: 200, unitPrice: '9000000' }],
      fxQuoteId: 'q', moq: 100, maxUnits: 500, maxPerMember: 100, leadTimeHours: 72, deliveryAreas: {},
      validUntil: new Date(), offerHash: '07'.repeat(32), status: 'LIVE',
    },
  });
}

describe('projection into Postgres', () => {
  it('links a new pool to its prepared hub details and tracks the lifecycle', async () => {
    await seedOffer('offer-1');
    await t.prisma.pendingPool.create({
      data: {
        hubHash: HUB, offerId: 'offer-1', organizerAddress: organizer, hubAddress: 'Wuse Market Gate B',
        hubContact: '08031234567', pickupWindow: { from: 'Mon' }, fillDeadline: new Date('2026-10-09T10:00:00Z'), shareSlug: 'rice-wuse',
      },
    });
    const proj = new Projector(new PrismaReadStore(t.prisma));
    const apply = (r: ReturnType<typeof raw>) => proj.apply(decodeEvent(r)!);
    const id = u64(9007199254740993n); // above Number.MAX_SAFE_INTEGER

    await apply(raw('group_buy', 'pool_new', id, tup(a(organizer), a(supplier), bytes(7), bytes(3)), 10));
    let pool = await t.prisma.pool.findUniqueOrThrow({ where: { id: 9007199254740993n } });
    expect(pool).toMatchObject({ offerId: 'offer-1', hubAddress: 'Wuse Market Gate B', shareSlug: 'rice-wuse', state: 'Open' });
    expect(pool.currentUnitPrice.toString()).toBe('1'); // tier 1 price

    await apply(raw('group_buy', 'committed', id, tup(a(m1), u32(150), i128(1_500_000_000n)), 11));
    await apply(raw('group_buy', 'tier_up', id, tup(u32(0), u32(150)), 11));
    await apply(raw('group_buy', 'committed', id, tup(a(addr()), u32(60), i128(600_000_000n)), 12));
    pool = await t.prisma.pool.findUniqueOrThrow({ where: { id: 9007199254740993n } });
    expect(pool.totalUnits).toBe(210);
    expect(pool.escrowBalance.toString()).toBe('210');
    expect(pool.currentUnitPrice.toString()).toBe('0.9'); // 210 units reached tier 2

    await apply(raw('group_buy', 'filled', id, tup(u32(210), i128(9_000_000n)), 13));
    await apply(raw('group_buy', 'accepted', id, a(supplier), 14));
    await apply(raw('group_buy', 'dispatch', id, tup(), 15));
    await apply(raw('group_buy', 'delivered', id, tup(u32(200), bytes(5)), 16));
    pool = await t.prisma.pool.findUniqueOrThrow({ where: { id: 9007199254740993n } });
    expect(pool).toMatchObject({ state: 'Delivered', receivedUnits: 200, allocationPending: true, lastEventLedger: 16 });
    expect(pool.finalUnitPrice?.toString()).toBe('0.9');
    expect(pool.filledAt && pool.acceptedAt && pool.dispatchedAt && pool.deliveredAt).toBeTruthy();
    await apply(raw('group_buy', 'alloc_ok', id, u32(200), 17));
    await apply(raw('group_buy', 'pickup', id, a(m1), 18));
    pool = await t.prisma.pool.findUniqueOrThrow({ where: { id: 9007199254740993n } });
    expect(pool).toMatchObject({ allocationPending: false, pickedUnits: 150 });
    const c = await t.prisma.commitment.findUniqueOrThrow({ where: { poolId_memberAddress: { poolId: 9007199254740993n, memberAddress: m1 } } });
    expect(c).toMatchObject({ units: 150, pickedUp: true });
    expect(c.paid.toString()).toBe('150');
  });

  it('is idempotent across replays and records each event once', async () => {
    const proj = new Projector(new PrismaReadStore(t.prisma));
    const ev = raw('group_buy', 'committed', u64(9007199254740993n), tup(a(m1), u32(1), i128(10_000_000n)), 20);
    expect(await proj.apply(decodeEvent(ev)!)).toBe(true);
    expect(await proj.apply(decodeEvent(ev)!)).toBe(false);
    const row = await t.prisma.chainEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(row.processedAt).not.toBeNull();
  });

  it('rolls back completely when a handler fails, so the event can be retried', async () => {
    const proj = new Projector(new PrismaReadStore(t.prisma));
    const bad = raw('group_buy', 'accepted', u64(123456n), a(supplier), 30); // pool does not exist
    await expect(proj.apply(decodeEvent(bad)!)).rejects.toThrow(/unknown pool/);
    expect(await t.prisma.chainEvent.findUnique({ where: { id: bad.id } })).toBeNull(); // not marked processed
  });

  it('tracks disputes with their opening time and SLA deadline', async () => {
    const proj = new Projector(new PrismaReadStore(t.prisma));
    await proj.apply(decodeEvent(raw('disputes', 'd_open', u64(5n), tup(u64(9007199254740993n), a(m1), i128(800_000_000n)), 40))!);
    const d = await t.prisma.dispute.findUniqueOrThrow({ where: { id: 5n } });
    expect(d.state).toBe('OPEN');
    expect(d.slaDueAt.getTime() - d.openedAt.getTime()).toBe(5 * 24 * 3600_000);
    await proj.apply(decodeEvent(raw('disputes', 'd_resolve', u64(5n), tup(a(addr()), bytes(4)), 41))!);
    expect((await t.prisma.dispute.findUniqueOrThrow({ where: { id: 5n } })).state).toBe('RESOLVED');
  });
});

describe('indexer on Postgres', () => {
  it('stores raw events once, advances a persisted cursor and survives re-polling', async () => {
    const ev = raw('bond', 'deposit', a(supplier), i128(5_000_000_000n), 50);
    const rpc: RpcPort = {
      latestLedger: async () => 60, oldestLedger: async () => 1,
      getEvents: async (from, to) => ([ev].filter((e) => e.ledger >= from && e.ledger <= to)),
    };
    const idx = new Indexer(rpc, new PrismaCursorStore(t.prisma), new PrismaEventSink(t.prisma), new Projector(new PrismaReadStore(t.prisma)), ['C'], 1, 100);
    expect(await idx.tick()).toEqual({ processed: 1 });
    expect(await t.prisma.indexerCursor.findUniqueOrThrow({ where: { id: 'main' } })).toMatchObject({ lastLedger: 60 });
    expect((await t.prisma.bond.findUniqueOrThrow({ where: { supplierAddress: supplier } })).total.toString()).toBe('500');
    await new PrismaCursorStore(t.prisma).set(0); // simulate a lost cursor: events are re-fetched
    expect(await idx.tick()).toEqual({ processed: 0 }); // but not re-applied
    expect((await t.prisma.bond.findUniqueOrThrow({ where: { supplierAddress: supplier } })).total.toString()).toBe('500');
  });
});

describe('auth and sponsorship on Postgres', () => {
  it('runs the OTP and rotating refresh flows against real tables', async () => {
    const sent: string[] = [];
    const otp = new OtpService(new PrismaOtpStore(t.prisma), { send: async (_p, text) => void sent.push(text) }, 's'.repeat(32), () => new Date(), () => 908172);
    await otp.request('08031234567');
    await expect(otp.verify('08031234567', '000000')).rejects.toMatchObject({ code: 'OTP_WRONG' });
    await expect(otp.verify('08031234567', '908172')).resolves.toBe('+2348031234567');
    await expect(otp.verify('08031234567', '908172')).rejects.toMatchObject({ code: 'OTP_EXPIRED' });

    const user = await t.prisma.user.create({ data: { phone: '+2348031234567' } });
    const tokens = new TokenService('s'.repeat(32), new PrismaSessionStore(t.prisma));
    const first = await tokens.issue(user.id, ['TRADER']);
    const second = await tokens.refresh(first.refreshToken, async () => ['TRADER']);
    await expect(tokens.refresh(first.refreshToken, async () => [])).rejects.toMatchObject({ code: 'REFRESH_REUSED' });
    await expect(tokens.refresh(second.refreshToken, async () => [])).rejects.toMatchObject({ code: 'REFRESH_REUSED' });
    expect(await t.prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });

  it('counts sponsored transactions atomically per user per day', async () => {
    const policy = new SponsorshipPolicy(new Map([['CGROUP', 'group_buy']]), new PrismaUsageStore(t.prisma), 3, () => new Date('2026-10-05T10:00:00Z'));
    await Promise.all([1, 2, 3].map(() => policy.authorize('u1', 'CGROUP', 'commit')));
    await expect(policy.authorize('u1', 'CGROUP', 'commit')).rejects.toMatchObject({ code: 'CAP_REACHED' });
    expect((await t.prisma.sponsorUsage.findUniqueOrThrow({ where: { userId_day: { userId: 'u1', day: '2026-10-05' } } })).count).toBe(4);
  });
});
