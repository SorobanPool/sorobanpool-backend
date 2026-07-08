/** Risk numbers for the admin console (brief 8.4) and the alert thresholds (brief 12.3). Pure: tested without a database. */
export const FAILURE_RATE_ALERT = 0.05; // failure rate over 7 days
export const DISPUTE_RATE_ALERT = 0.08; // dispute rate over 7 days
export const PAIR_MIN_POOLS = 3; // a pair needs at least this many pools to be worth flagging
export const PAIR_SHARE_ALERT = 0.6; // share of one organizer's pools that go to a single supplier

export interface PoolFact {
  id: string;
  state: string;
  supplier: string;
  organizer: string;
  /** What the pool holds in escrow now (stroops). */
  escrow: bigint;
  /** Value delivered: received units x final price (stroops); 0 until delivered. */
  gross: bigint;
  /** When we first saw it, and when it ended (settled/failed/expired/cancelled), if it has. */
  indexedAt: Date;
  endedAt: Date | null;
}

export interface DisputeFact {
  poolId: string;
  supplier: string;
  openedAt: Date;
}

export interface Flag {
  kind: 'FAILURE_RATE' | 'DISPUTE_RATE' | 'PAIR_CONCENTRATION';
  message: string;
  subject?: string;
}

export interface RiskOverview {
  gmv: bigint;
  escrowHeld: bigint;
  poolsByState: Record<string, number>;
  failureRate7d: number;
  dispute7d: { disputes: number; deliveredPools: number; rate: number };
  bySupplier: { supplier: string; pools: number; disputes: number; disputeRate: number }[];
  pairs: { organizer: string; supplier: string; pools: number; shareOfOrganizer: number }[];
  flags: Flag[];
}

const FAILED = new Set(['Failed', 'Expired', 'Cancelled']);
const DELIVERED = new Set(['Delivered', 'Settled']);
const DAY = 86_400_000;
const ratio = (a: number, b: number): number => (b === 0 ? 0 : a / b);

export function riskOverview(pools: readonly PoolFact[], disputes: readonly DisputeFact[], now: Date): RiskOverview {
  const since = now.getTime() - 7 * DAY;
  const poolsByState: Record<string, number> = {};
  for (const p of pools) poolsByState[p.state] = (poolsByState[p.state] ?? 0) + 1;

  const ended7d = pools.filter((p) => p.endedAt && p.endedAt.getTime() >= since && (FAILED.has(p.state) || p.state === 'Settled'));
  const failed7d = ended7d.filter((p) => FAILED.has(p.state)).length;
  const failureRate7d = ratio(failed7d, ended7d.length);

  const delivered = pools.filter((p) => DELIVERED.has(p.state));
  const disputes7d = disputes.filter((d) => d.openedAt.getTime() >= since);
  const dispute7d = { disputes: disputes7d.length, deliveredPools: delivered.length, rate: ratio(disputes7d.length, delivered.length) };

  const sup = new Map<string, { pools: number; disputes: number }>();
  for (const p of delivered) sup.set(p.supplier, { pools: (sup.get(p.supplier)?.pools ?? 0) + 1, disputes: sup.get(p.supplier)?.disputes ?? 0 });
  for (const d of disputes) {
    const e = sup.get(d.supplier);
    if (e) e.disputes++;
  }
  const bySupplier = [...sup.entries()].map(([supplier, v]) => ({ supplier, ...v, disputeRate: ratio(v.disputes, v.pools) })).sort((a, b) => b.disputeRate - a.disputeRate || b.pools - a.pools);

  const perOrganizer = new Map<string, number>();
  const pair = new Map<string, number>();
  for (const p of pools) {
    perOrganizer.set(p.organizer, (perOrganizer.get(p.organizer) ?? 0) + 1);
    pair.set(`${p.organizer}|${p.supplier}`, (pair.get(`${p.organizer}|${p.supplier}`) ?? 0) + 1);
  }
  const pairs = [...pair.entries()]
    .map(([k, n]) => {
      const [organizer, supplier] = k.split('|') as [string, string];
      return { organizer, supplier, pools: n, shareOfOrganizer: ratio(n, perOrganizer.get(organizer)!) };
    })
    .sort((a, b) => b.pools - a.pools);

  const flags: Flag[] = [];
  if (ended7d.length > 0 && failureRate7d > FAILURE_RATE_ALERT) flags.push({ kind: 'FAILURE_RATE', message: `Pool failure rate is ${(failureRate7d * 100).toFixed(1)}% over 7 days (limit ${FAILURE_RATE_ALERT * 100}%)` });
  if (delivered.length > 0 && dispute7d.rate > DISPUTE_RATE_ALERT) flags.push({ kind: 'DISPUTE_RATE', message: `Dispute rate is ${(dispute7d.rate * 100).toFixed(1)}% over 7 days (limit ${DISPUTE_RATE_ALERT * 100}%)` });
  for (const x of pairs) {
    if (x.pools >= PAIR_MIN_POOLS && x.shareOfOrganizer >= PAIR_SHARE_ALERT) {
      flags.push({ kind: 'PAIR_CONCENTRATION', subject: `${x.organizer}|${x.supplier}`, message: `${x.pools} pools (${Math.round(x.shareOfOrganizer * 100)}% of this organizer's) go to one supplier: review for collusion` });
    }
  }

  return {
    gmv: pools.reduce((s, p) => s + p.gross, 0n),
    escrowHeld: pools.reduce((s, p) => s + p.escrow, 0n),
    poolsByState, failureRate7d, dispute7d, bySupplier, pairs, flags,
  };
}
