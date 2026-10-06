import { startHarness, type Harness } from '../../test/harness.js';

/** Reads SSE frames from a real listening server (supertest cannot hold a stream open). */
async function frames(res: Response, n: number, onFrame: (i: number) => void = () => {}): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const out: { event: string; data: Record<string, unknown> }[] = [];
  const deadline = Date.now() + 15_000;
  while (out.length < n && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) { out.push({ event, data: JSON.parse(data) as Record<string, unknown> }); onFrame(out.length); }
    }
  }
  await reader.cancel();
  return out;
}

describe('pool stream (SSE)', () => {
  let h: Harness;
  let base: string;
  beforeAll(async () => {
    h = await startHarness();
    await h.app.listen(0, '127.0.0.1');
    base = (await h.app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(async () => { await h.close(); });

  it('sends the current figures at once and again after the indexer applies a new event', async () => {
    const u = await h.s.prisma.user.create({ data: { phone: '+2348013333333' } });
    const offer = await h.s.prisma.offer.create({ data: { supplierId: u.id, title: 't', description: 'd', unitLabel: 'u', category: 'rice', images: [], tiersNgn: [], tiersUsdc: [], fxQuoteId: 'q', moq: 1, maxUnits: 9, maxPerMember: 9, leadTimeHours: 1, deliveryAreas: [], validUntil: new Date(), offerHash: 'h4', status: 'LIVE' } });
    await h.s.prisma.pool.create({ data: { id: 801n, offerId: offer.id, organizerAddress: 'o', supplierAddress: 's', hubAddress: 'h', hubContact: 'c', hubHash: 'y', pickupWindow: {}, state: 'Open', totalUnits: 1, fillDeadline: new Date(), shareSlug: 'st801', lastEventLedger: 5 } });
    const res = await fetch(`${base}/v1/pools/801/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // Change the row only after the first frame has arrived, so the test cannot race the stream's first poll.
    const got = await frames(res, 2, (n) => {
      if (n === 1) void h.s.prisma.pool.update({ where: { id: 801n }, data: { state: 'Filled', totalUnits: 9, lastEventLedger: 9 } }).catch((e: Error) => console.error('UPDATE FAILED', e.message));
    });
    expect(got.map((f) => f.event)).toEqual(['pool', 'pool']);
    expect(got[0]!.data).toMatchObject({ state: 'Open', totalUnits: 1, ledger: 5 });
    expect(got[1]!.data).toMatchObject({ state: 'Filled', totalUnits: 9, ledger: 9 });
  });

  it('rejects malformed ids', async () => {
    expect((await fetch(`${base}/v1/pools/abc/stream`)).status).toBe(400);
  });
});
