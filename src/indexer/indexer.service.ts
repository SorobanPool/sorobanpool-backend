import { decodeEvent, type DecodedEvent, type RawEvent } from './decode.js';
import type { Projector } from './projector.js';

export const LAG_ALERT_LEDGERS = 20;
/** The retention window slides ~1 ledger per 5 s, so a fresh start begins this far inside it (about 5 minutes). */
export const RETENTION_MARGIN_LEDGERS = 60;

export interface RpcPort {
  latestLedger(): Promise<number>;
  /** Oldest ledger the RPC still serves events for (events are only retained for a limited window). */
  oldestLedger(): Promise<number>;
  getEvents(startLedger: number, endLedger: number, contractIds: string[]): Promise<RawEvent[]>;
}

export interface CursorStore {
  get(): Promise<number | undefined>;
  set(ledger: number): Promise<void>;
}

export interface EventSink {
  /** Stores the raw event idempotently (ChainEvent table). */
  saveRaw(raw: RawEvent): Promise<void>;
}

/**
 * Where a brand-new indexer (no cursor yet) begins. A number is an operator's explicit choice and is honoured
 * strictly: below the RPC retention window it fails loudly, because history would be silently lost. `'oldest'`
 * (the default for a fresh install) starts at the oldest retained ledger and logs that earlier history, if any,
 * must be backfilled from an archive (docs/runbooks/indexer-backfill.md).
 */
export type StartLedger = number | 'oldest';

export interface IndexerMetrics {
  lag: number;
  lastLedger: number;
  behindRetention: boolean;
}

export class Indexer {
  metrics: IndexerMetrics = { lag: 0, lastLedger: 0, behindRetention: false };

  constructor(
    private readonly rpc: RpcPort,
    private readonly cursor: CursorStore,
    private readonly sink: EventSink,
    private readonly projector: Projector,
    private readonly contractIds: string[],
    private readonly startLedger: StartLedger,
    private readonly batch = 1000,
    /** Runs after an event is newly committed (never on replays). Failures are logged, not fatal: at-most-once side effects. */
    private readonly onApplied?: (ev: DecodedEvent) => Promise<unknown>,
  ) {}

  /** One poll: fetch from the cursor, store raw, project, advance. Safe to call repeatedly. */
  async tick(): Promise<{ processed: number }> {
    const latest = await this.rpc.latestLedger();
    const oldest = await this.rpc.oldestLedger();
    const from = (await this.cursor.get()) ?? this.initialCursor(oldest);
    this.metrics.behindRetention = from + 1 < oldest;
    if (this.metrics.behindRetention) {
      throw new Error(`indexer is behind the RPC event retention window (cursor ${from}, oldest ${oldest}); backfill required`);
    }
    const to = Math.min(latest, from + this.batch);
    let processed = 0;
    if (to > from) {
      const raws = await this.rpc.getEvents(from + 1, to, this.contractIds);
      for (const raw of raws) {
        await this.sink.saveRaw(raw);
        const ev = decodeEvent(raw);
        if (ev && (await this.projector.apply(ev))) {
          processed++;
          if (this.onApplied) await this.onApplied(ev).catch((e: Error) => console.error(`[indexer] onApplied ${ev.contract}.${ev.event}: ${e.message}`));
        }
      }
      await this.cursor.set(to);
    }
    this.metrics.lastLedger = Math.max(to, from);
    this.metrics.lag = latest - this.metrics.lastLedger;
    return { processed };
  }

  private initialCursor(oldest: number): number {
    if (this.startLedger !== 'oldest') return this.startLedger - 1;
    const start = oldest + RETENTION_MARGIN_LEDGERS;
    console.warn(`[indexer] no cursor yet: starting near the oldest retained ledger (${start}, oldest ${oldest}); earlier events, if any, need a backfill`);
    return start - 1;
  }

  get shouldAlert(): boolean {
    return this.metrics.lag > LAG_ALERT_LEDGERS || this.metrics.behindRetention;
  }
}
