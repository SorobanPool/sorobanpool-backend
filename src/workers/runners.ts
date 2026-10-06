import { rpc } from '@stellar/stellar-sdk';
import { A } from '../chain/args.js';
import type { RawEvent } from '../indexer/decode.js';
import { Indexer, type RpcPort } from '../indexer/indexer.service.js';
import { Projector } from '../indexer/projector.js';
import { dueActions, runKeeper, type ChainPort as KeeperChain, type KeeperAction, type KeeperDispute, type KeeperParams, type KeeperPool } from '../keeper/jobs.js';
import { PrismaCursorStore, PrismaEventSink, PrismaReadStore } from '../persistence/prisma-stores.js';
import type { PoolState } from '../indexer/read-model.js';
import { CONTRACT_NAMES } from '../chain/deployments.js';
import type { Services } from '../app/services.js';
import { combineQuotes } from '../fx/fx.js';
import { dispatchDue, NotificationProducer, queueDeadlineReminders } from '../notifications/dispatcher.js';
import { checkSponsor, expireOffers, MismatchTracker, reconcilePools } from './maintenance.js';

/**
 * Soroban RPC adapter for the indexer. The Indexer treats `endLedger` as inclusive, but the RPC's `endLedger`
 * is EXCLUSIVE (verified live: start=N,end=N returns nothing; start=N,end=N+1 returns ledger N). Passing it
 * through unchanged silently loses every event in the newest ledger of each polling window, so it is shifted by one.
 */
export function rpcPort(server: Pick<rpc.Server, 'getLatestLedger' | 'getHealth' | 'getEvents'>): RpcPort {
  return {
    latestLedger: async () => (await server.getLatestLedger()).sequence,
    oldestLedger: async () => (await server.getHealth()).oldestLedger,
    getEvents: async (startLedger, endLedger, contractIds) => {
      // Soroban RPC allows at most 5 contract ids per filter (and 5 filters).
      const filters: { type: 'contract'; contractIds: string[] }[] = [];
      for (let i = 0; i < contractIds.length; i += 5) filters.push({ type: 'contract', contractIds: contractIds.slice(i, i + 5) });
      const out: RawEvent[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const res = await server.getEvents(cursor ? { cursor, filters, limit: 200 } : { startLedger, endLedger: endLedger + 1, filters, limit: 200 });
        for (const e of res.events) {
          out.push({
            id: e.id, ledger: e.ledger, ledgerClosedAt: e.ledgerClosedAt, contractId: String(e.contractId ?? ''),
            topic: e.topic.map((t) => t.toXDR('base64')), value: e.value.toXDR('base64'),
          });
        }
        if (res.events.length < 200) break;
        cursor = res.cursor;
      }
      return out;
    },
  };
}

export interface Runner {
  stop(): void;
}

/** Runs `fn` every `ms`, never overlapping, logging failures instead of crashing the process. */
function every(name: string, ms: number, fn: () => Promise<void>): Runner {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[${name}] ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }, ms);
  return { stop: () => clearInterval(t) };
}

export function startIndexer(s: Services, server: rpc.Server, intervalMs = 5000): { runner: Runner; indexer: Indexer } {
  const ids = CONTRACT_NAMES.map((n) => s.deployments.contracts[n].id);
  const producer = new NotificationProducer(s.prisma, async () => combineQuotes(await s.fx.quotes(), s.now()).rate, s.now);
  const indexer = new Indexer(
    rpcPort(server), new PrismaCursorStore(s.prisma), new PrismaEventSink(s.prisma), new Projector(new PrismaReadStore(s.prisma)), ids, s.env.INDEXER_START_LEDGER, 1000,
    (ev) => producer.onEvent(ev),
  );
  const runner = every('indexer', intervalMs, async () => {
    await indexer.tick();
    if (indexer.shouldAlert) console.error(`[indexer] ALERT lag=${indexer.metrics.lag} ledgers`);
  });
  return { runner, indexer };
}

const FINAL: PoolState[] = ['Settled', 'Expired', 'Failed', 'Cancelled'];
const secs = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : 0);

/** Contract parameters the keeper needs, read from `config.get_params` (u64 fields arrive as bigint). */
export async function keeperParams(s: Services): Promise<KeeperParams> {
  const p = await s.chain.view<Record<string, bigint | number>>('config', 'get_params');
  return {
    acceptWindowSecs: Number(p.accept_window_secs), deliveryGraceSecs: Number(p.delivery_grace_secs), confirmWindowSecs: Number(p.confirm_window_secs),
    perishableConfirmWindowSecs: Number(p.perishable_confirm_window_secs), earlyReleaseWeightBp: Number(p.early_release_weight_bp), arbitrationSlaSecs: Number(p.arbitration_sla_secs),
  };
}

export async function loadKeeperState(s: Services): Promise<{ pools: KeeperPool[]; disputes: KeeperDispute[] }> {
  const rows = await s.prisma.pool.findMany({ where: { OR: [{ state: { notIn: FINAL } }, { AND: [{ state: { in: FINAL } }, { refundsPushed: false }] }] } });
  const offers = new Map((await s.prisma.offer.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.offerId))] } } })).map((o) => [o.id, o]));
  const pools: KeeperPool[] = rows.map((p) => ({
    id: p.id, state: p.state as PoolState, perishable: offers.get(p.offerId)?.perishable ?? false, totalUnits: p.totalUnits, pickedUnits: p.pickedUnits,
    leadTimeSecs: (offers.get(p.offerId)?.leadTimeHours ?? 0) * 3600, fillDeadline: secs(p.fillDeadline), filledAt: secs(p.filledAt), acceptedAt: secs(p.acceptedAt),
    deliveredAt: secs(p.deliveredAt), allocationPending: p.allocationPending, hasUnclaimedRefunds: FINAL.includes(p.state as PoolState) && !p.refundsPushed && p.escrowBalance.gt(0),
  }));
  const open = await s.prisma.dispute.findMany({ where: { state: 'OPEN' } });
  return { pools, disputes: open.map((d) => ({ id: d.id, open: true, openedAt: secs(d.openedAt) })) };
}

export function keeperChain(s: Services): KeeperChain {
  const call = async (a: KeeperAction): Promise<unknown> => {
    switch (a.fn) {
      case 'timeout': return s.chain.invokeServer('disputes', 'timeout', A.disputeTimeout(a.args[0]));
      case 'allocate_shortfall': return s.chain.invokeServer('group_buy', 'allocate_shortfall', A.poolBatch(a.args[0], a.args[1]));
      case 'push_refunds': {
        const r = await s.chain.invokeServer('group_buy', 'push_refunds', A.poolBatch(a.args[0], a.args[1]));
        if (Number(r.returnValue ?? 1) === 0) await s.prisma.pool.update({ where: { id: a.args[0] }, data: { refundsPushed: true } });
        return r;
      }
      default: return s.chain.invokeServer('group_buy', a.fn, A.poolOnly(a.args[0]));
    }
  };
  return {
    invoke: async (a) => {
      try {
        await call(a);
        return true;
      } catch (e) {
        // The chain re-checks every condition; a refusal (wrong state / too early) is expected and harmless.
        if (/Error\(Contract, #\d+\)/.test((e as Error).message)) return false;
        throw e;
      }
    },
  };
}

export async function keeperTick(s: Services): Promise<{ ok: number; refused: number; errored: number }> {
  // A final pool whose escrow has reached zero owes nobody anything: stop scanning it.
  await s.prisma.pool.updateMany({ where: { state: { in: FINAL }, refundsPushed: false, escrowBalance: { lte: 0 } }, data: { refundsPushed: true } });
  const { pools, disputes } = await loadKeeperState(s);
  const actions = dueActions(pools, disputes, await keeperParams(s), Math.floor(s.now().getTime() / 1000));
  return runKeeper(keeperChain(s), actions, (a, e) => console.error(`[keeper] ${a.job} ${String(a.args[0])}: ${(e as Error).message}`));
}

export function startKeeper(s: Services, intervalMs = 15_000): Runner {
  return every('keeper', intervalMs, async () => {
    const r = await keeperTick(s);
    if (r.ok || r.errored) console.log(`[keeper] ok=${r.ok} refused=${r.refused} errored=${r.errored}`);
  });
}

/** Hourly: extend contract instance/code TTL before they lapse. A missing entry is a paging-level problem. */
export function startTtlKeeper(s: Services, intervalMs = 3_600_000): Runner {
  return every('ttl-extend', intervalMs, async () => {
    const r = await s.chain.keepAlive();
    if (r.missing.length) console.error(`[ttl-extend] ALERT entries not found (archived?): ${r.missing.join(', ')}`);
    if (r.extended.length) console.log(`[ttl-extend] extended ${r.extended.join(', ')} in ${r.txHash}`);
  });
}

/** Every 5 minutes: expire stale offers and page when the fee sponsor runs low. */
export function startMaintenance(s: Services, intervalMs = 300_000): Runner {
  const tracker = new MismatchTracker();
  return every('maintenance', intervalMs, async () => {
    const n = await expireOffers(s.prisma, s.now());
    if (n) console.log(`[maintenance] expired ${n} offer(s)`);
    const reminded = await queueDeadlineReminders(s.prisma, s.now());
    if (reminded) console.log(`[maintenance] queued ${reminded} deadline reminder(s)`);
    const bad = tracker.persistent(await reconcilePools(s.prisma, s.chain as never, A.poolOnly));
    for (const m of bad) console.error(`[reconcile] ALERT pool ${m.poolId} ${m.field}: db=${m.db} chain=${m.chain}`);
    const h = await checkSponsor(s.chain, s.env.SPONSOR_MIN_XLM);
    if (h.low) console.error(`[maintenance] ALERT sponsor balance ${Number(h.balanceStroops) / 1e7} XLM is below ${s.env.SPONSOR_MIN_XLM}`);
  });
}

/** Every 30 seconds: send due SMS (quiet hours are applied when queued; failures back off). */
export function startNotifier(s: Services, intervalMs = 30_000): Runner {
  return every('notifier', intervalMs, async () => {
    const r = await dispatchDue(s.prisma, s.sms, s.now());
    if (r.sent || r.failed) console.log(`[notifier] sent=${r.sent} retried=${r.retried} failed=${r.failed}`);
  });
}
