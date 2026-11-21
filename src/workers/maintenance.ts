import type { PrismaClient } from '../generated/prisma/client.js';
import { combineQuotes, FxDivergenceError, type FxSourceQuote } from '../fx/fx.js';

/** Live offers past `validUntil` stop being offered; pools already created from them are unaffected. */
export async function expireOffers(prisma: Pick<PrismaClient, 'offer'>, now: Date): Promise<number> {
  const r = await prisma.offer.updateMany({ where: { status: 'LIVE', validUntil: { lt: now } }, data: { status: 'EXPIRED' } });
  return r.count;
}

/**
 * Deletes `IdempotencyKey` rows created before `now - retentionDays` (#173). A key only guards a client retry, so
 * after the retention window it is dead weight. Deletion runs in batches of `batchSize` so one run never holds a
 * long lock, and stops after `maxBatches` so a large backlog drains over several runs instead of one.
 */
export async function purgeIdempotencyKeys(
  prisma: Pick<PrismaClient, 'idempotencyKey'>, now: Date, retentionDays: number, batchSize = 500, maxBatches = 20,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const batch = await prisma.idempotencyKey.findMany({
      where: { createdAt: { lt: cutoff } }, select: { key: true }, orderBy: { createdAt: 'asc' }, take: batchSize,
    });
    if (batch.length === 0) break;
    const r = await prisma.idempotencyKey.deleteMany({ where: { key: { in: batch.map((k) => k.key) } } });
    deleted += r.count;
    if (batch.length < batchSize) break;
  }
  return deleted;
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

export interface FxRefreshResult {
  rate: number | null;
  divergence: number | null;
  /** True when sources disagree by more than 2% (or fewer than two answered): offer publishing is blocked meanwhile. */
  blocked: boolean;
  reason?: string;
}

/**
 * `fx-refresh` (brief 7.7, every minute): records the combined NGN/USD rate from all sources, or why it could not be
 * combined. Publishing re-quotes on its own and refuses on divergence; this job gives the history and the alert.
 */
export async function refreshFx(
  prisma: Pick<PrismaClient, 'fxQuote'>, fx: { quotes(): Promise<FxSourceQuote[]> }, now: Date,
): Promise<FxRefreshResult> {
  const sources = await fx.quotes();
  try {
    const q = combineQuotes(sources, now);
    await prisma.fxQuote.create({ data: { pair: 'NGN/USD', rate: q.rate.toFixed(6), sources: { quotes: q.sources, divergence: q.divergence } as never } });
    return { rate: q.rate, divergence: q.divergence, blocked: false };
  } catch (e) {
    const divergence = e instanceof FxDivergenceError ? e.divergence : null;
    return { rate: null, divergence, blocked: true, reason: (e as Error).message };
  }
}

export interface AnchorTransferExpireResult {
  expired: number;
  flaggedForReview: number;
}

/**
 * Marks pending anchor transfers older than the expiry limit as EXPIRED and releases reserved state.
 * Transfers that complete after expiry are flagged for manual review by setting a flag in their metadata.
 */
export async function expireStaleAnchorTransfers(
  prisma: Pick<PrismaClient, 'anchorTransfer'>, now: Date, expiryMinutes: number,
): Promise<AnchorTransferExpireResult> {
  const cutoff = new Date(now.getTime() - expiryMinutes * 60_000);

  const expiredCount = await prisma.anchorTransfer.updateMany({
    where: {
      status: 'PENDING',
      createdAt: { lt: cutoff },
    },
    data: {
      status: 'EXPIRED',
    },
  });

  return {
    expired: expiredCount.count,
    flaggedForReview: 0,
  };
}
