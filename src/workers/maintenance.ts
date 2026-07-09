import type { PrismaClient } from '../generated/prisma/client.js';

/** Live offers past `validUntil` stop being offered; pools already created from them are unaffected. */
export async function expireOffers(prisma: Pick<PrismaClient, 'offer'>, now: Date): Promise<number> {
  const r = await prisma.offer.updateMany({ where: { status: 'LIVE', validUntil: { lt: now } }, data: { status: 'EXPIRED' } });
  return r.count;
}

export interface SponsorHealth {
  balanceStroops: bigint;
  minStroops: bigint;
  low: boolean;
}

/** The sponsor pays every fee; a drained sponsor halts the whole product, so this is paged on before it happens. */
export async function checkSponsor(chain: { sponsorBalance(): Promise<bigint> }, minXlm: number): Promise<SponsorHealth> {
  const minStroops = BigInt(Math.round(minXlm * 10_000_000));
  const balanceStroops = await chain.sponsorBalance();
  return { balanceStroops, minStroops, low: balanceStroops < minStroops };
}

export interface PoolMismatch {
  poolId: bigint;
  field: 'state' | 'totalUnits' | 'escrowBalance';
  db: string;
  chain: string;
}

/** Soroban unit enum variants decode as `['Open']` through scValToNative; accept a bare string as well. */
export const chainState = (v: unknown): string => String(Array.isArray(v) ? v[0] : v);

const FINAL_STATES = ['Settled', 'Expired', 'Failed', 'Cancelled'];

/**
 * Compares the indexed read model with the contracts for pools that are still live. The chain is the source of truth,
 * so any difference means the indexer missed or misapplied an event. `limit` bounds RPC calls per run.
 */
export async function reconcilePools(
  prisma: Pick<PrismaClient, 'pool'>,
  chain: { view<T>(name: 'group_buy', fn: string, args: never[]): Promise<T> } | { view: (name: never, fn: string, args: never) => Promise<unknown> },
  poolArg: (id: bigint) => unknown[],
  limit = 50,
): Promise<PoolMismatch[]> {
  const rows = await prisma.pool.findMany({ where: { state: { notIn: FINAL_STATES } }, orderBy: { id: 'asc' }, take: limit });
  const out: PoolMismatch[] = [];
  for (const p of rows) {
    const c = await (chain as { view: (n: string, f: string, a: unknown[]) => Promise<Record<string, unknown>> }).view('group_buy', 'pool', poolArg(p.id));
    const checks: [PoolMismatch['field'], string, string][] = [
      ['state', p.state, chainState(c.state)],
      ['totalUnits', String(p.totalUnits), String(c.total_units)],
      ['escrowBalance', toStroopsString(p.escrowBalance.toString()), String(c.escrow_balance)],
    ];
    for (const [field, db, onChain] of checks) if (db !== onChain) out.push({ poolId: p.id, field, db, chain: onChain });
  }
  return out;
}

/** "167.0549050" (USDC, 7 dp) -> "1670549050" stroops, without floating point. */
export function toStroopsString(decimal: string): string {
  const [whole, frac = ''] = decimal.split('.');
  return (BigInt(whole!) * 10_000_000n + BigInt(frac.padEnd(7, '0').slice(0, 7))).toString();
}

/** Remembers which pools mismatched last run: only a mismatch seen twice in a row is real (indexer lag is transient). */
export class MismatchTracker {
  private last = new Set<string>();
  persistent(current: PoolMismatch[]): PoolMismatch[] {
    const keys = new Set(current.map((m) => `${m.poolId}:${m.field}`));
    const out = current.filter((m) => this.last.has(`${m.poolId}:${m.field}`));
    this.last = keys;
    return out;
  }
}
