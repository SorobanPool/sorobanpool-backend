import { dispatchDue, enqueue, MAX_ATTEMPTS, NotificationProducer } from './dispatcher.js';
import { startHarness, type Harness } from '../../test/harness.js';
import type { DecodedEvent } from '../indexer/decode.js';

describe('notification dispatcher', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });
  const db = () => h.s.prisma;
  const user = (phone: string, language: 'EN' | 'PCM' = 'EN', walletAddress?: string) => db().user.create({ data: { phone, language, walletAddress } });
  const sms = () => { const sent: { phone: string; text: string }[] = []; return { sent, send: async (phone: string, text: string) => { sent.push({ phone, text }); } }; };
  const day = new Date('2026-10-05T10:00:00Z'); // 11:00 WAT, outside quiet hours

  it('sends in the user language and marks SENT once', async () => {
    const u = await user('+2348020000001', 'PCM');
    await enqueue(db(), u.id, 'settled', { product: 'Rice', refund: '12,000' }, day);
    const s = sms();
    expect(await dispatchDue(db(), s, day)).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(s.sent[0]!.text).toContain('don finish');
    expect(await dispatchDue(db(), s, day)).toEqual({ sent: 0, retried: 0, failed: 0 });
  });

  it('defers quiet-hour messages to 07:00 WAT but not delivery-day ones', async () => {
    const u = await user('+2348020000002');
    const night = new Date('2026-10-05T21:30:00Z'); // 22:30 WAT
    await enqueue(db(), u.id, 'settled', { product: 'Rice', refund: '1' }, night);
    await enqueue(db(), u.id, 'dispatched', { product: 'Rice', hub: 'Wuse', date: 'Mon' }, night);
    const s = sms();
    expect((await dispatchDue(db(), s, night)).sent).toBe(1);
    expect(s.sent[0]!.text).toContain('on the way');
    expect((await dispatchDue(db(), s, new Date('2026-10-06T06:00:00Z'))).sent).toBe(1); // 07:00 WAT
  });

  it('backs off on failure and gives up after MAX_ATTEMPTS', async () => {
    const u = await user('+2348020000003');
    await enqueue(db(), u.id, 'settled', { product: 'Rice', refund: '1' }, day);
    const bad = { send: async () => { throw new Error('provider down'); } };
    let t = day;
    let last = { sent: 0, retried: 0, failed: 0 };
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      last = await dispatchDue(db(), bad, t);
      t = new Date(t.getTime() + 2 ** (i + 1) * 60_000 + 1000);
    }
    expect(last.failed).toBe(1);
    const row = await db().notification.findFirstOrThrow({ where: { userId: u.id } });
    expect(row).toMatchObject({ status: 'FAILED', attempts: MAX_ATTEMPTS, lastError: 'provider down' });
  });

  it('producer notifies each committed member once per event, with naira figures from the FX rate', async () => {
    const wallet = 'GMEMBERWALLET';
    const u = await user('+2348020000004', 'EN', wallet);
    const offer = await db().offer.create({ data: {
      supplierId: u.id, title: 'Mama Gold Rice', description: 'd', unitLabel: 'bag', category: 'rice', images: [], tiersNgn: [], tiersUsdc: [], fxQuoteId: 'q',
      moq: 1, maxUnits: 10, maxPerMember: 5, leadTimeHours: 72, deliveryAreas: [], validUntil: day, offerHash: 'h', status: 'LIVE' } });
    await db().pool.create({ data: { id: 501n, offerId: offer.id, organizerAddress: 'o', supplierAddress: 's', hubAddress: 'Wuse Market', hubContact: 'c', hubHash: 'hh',
      pickupWindow: { from: '2026-10-12T09:00:00Z', to: '2026-10-12T17:00:00Z' }, state: 'Filled', fillDeadline: day, shareSlug: 'slug501', finalUnitPrice: '0.8' } });
    await db().commitment.create({ data: { poolId: 501n, memberAddress: wallet, units: 100, paid: '100' } });
    const p = new NotificationProducer(db(), async () => 1500, () => day);
    const ev = (event: string): DecodedEvent => ({ id: 'e', ledger: 1, closedAt: day, contractId: 'C', contract: 'group_buy', event, key: 501n, data: null });
    expect(await p.onEvent(ev('filled'))).toBe(1);
    expect(await p.onEvent(ev('committed'))).toBe(0); // not a notifying event
    expect(await p.onEvent({ ...ev('filled'), contract: 'bond' })).toBe(0);
    const s = sms();
    await dispatchDue(db(), s, day);
    const msg = s.sent.find((m) => m.phone === '+2348020000004')!.text;
    expect(msg).toContain('Mama Gold Rice');
    expect(msg).toContain('N1,200/unit'); // 0.8 USDC * 1500
    expect(msg).toContain('N30,000'); // refund (100 - 100*0.8) * 1500
  });
});
