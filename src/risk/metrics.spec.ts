import { riskOverview, type DisputeFact, type PoolFact } from './metrics.js';

const now = new Date('2026-10-10T12:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
let n = 0;
// Distinct parties by default: one organizer and supplier repeated would itself (rightly) trip the collusion check.
const pool = (over: Partial<PoolFact>): PoolFact => ({ id: String(++n), state: 'Settled', supplier: `S${n}`, organizer: `O${n}`, escrow: 0n, gross: 100n, indexedAt: ago(5), endedAt: ago(1), ...over });

describe('riskOverview', () => {
  it('sums GMV from delivered value and escrow still held, and counts pools by state', () => {
    const r = riskOverview([pool({ gross: 100n }), pool({ gross: 50n }), pool({ state: 'Open', gross: 0n, escrow: 70n, endedAt: null })], [], now);
    expect(r.gmv).toBe(150n);
    expect(r.escrowHeld).toBe(70n);
    expect(r.poolsByState).toEqual({ Settled: 2, Open: 1 });
    expect(r.flags).toEqual([]);
  });

  it('flags a failure rate above 5% over the last 7 days only', () => {
    const pools = [...Array.from({ length: 9 }, () => pool({})), pool({ state: 'Failed', gross: 0n }), pool({ state: 'Expired', gross: 0n, endedAt: ago(30) })];
    const r = riskOverview(pools, [], now);
    expect(r.failureRate7d).toBeCloseTo(0.1); // 1 of 10 recent; the 30-day-old expiry is outside the window
    expect(r.flags.map((f) => f.kind)).toContain('FAILURE_RATE');
    expect(riskOverview(Array.from({ length: 30 }, () => pool({})).concat([pool({ state: 'Failed' })]), [], now).flags).toEqual([]); // 1/31 = 3.2%
  });

  it('flags a dispute rate above 8% and ranks suppliers by dispute rate', () => {
    const pools = [...Array.from({ length: 5 }, () => pool({ supplier: 'GOOD' })), ...Array.from({ length: 5 }, () => pool({ supplier: 'BAD' }))];
    const d = (supplier: string): DisputeFact => ({ poolId: '1', supplier, openedAt: ago(2) });
    const r = riskOverview(pools, [d('BAD'), d('BAD'), d('GOOD')], now);
    expect(r.dispute7d.rate).toBeCloseTo(0.3);
    expect(r.flags.map((f) => f.kind)).toContain('DISPUTE_RATE');
    expect(r.bySupplier[0]).toMatchObject({ supplier: 'BAD', pools: 5, disputes: 2 });
    expect(r.bySupplier[0]!.disputeRate).toBeCloseTo(0.4);
  });

  it('spots an organizer who sends most pools to one supplier (collusion signal) but not a healthy spread', () => {
    const colluding = [...Array.from({ length: 4 }, () => pool({ organizer: 'OC', supplier: 'SX' })), pool({ organizer: 'OC', supplier: 'SY' })];
    const r = riskOverview(colluding, [], now);
    expect(r.pairs[0]).toMatchObject({ organizer: 'OC', supplier: 'SX', pools: 4 });
    expect(r.flags.find((f) => f.kind === 'PAIR_CONCENTRATION')?.subject).toBe('OC|SX');

    const healthy = ['A', 'B', 'C', 'D'].flatMap((s) => [pool({ organizer: 'OH', supplier: s }), pool({ organizer: 'OH', supplier: s })]);
    expect(riskOverview(healthy, [], now).flags).toEqual([]);
    // two pools to one supplier is too little evidence to flag
    expect(riskOverview([pool({ organizer: 'OZ', supplier: 'S' }), pool({ organizer: 'OZ', supplier: 'S' })], [], now).flags).toEqual([]);
  });

  it('handles an empty system without dividing by zero', () => {
    const r = riskOverview([], [], now);
    expect(r).toMatchObject({ gmv: 0n, escrowHeld: 0n, failureRate7d: 0, flags: [] });
  });
});
