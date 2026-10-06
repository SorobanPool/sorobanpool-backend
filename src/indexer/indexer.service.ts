import { decodeEvent, type DecodedEvent, type RawEvent } from './decode.js';
import type { Projector } from './projector.js';

export const LAG_ALERT_LEDGERS = 20;

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
    private readonly startLedger: number,
    private readonly batch = 1000,
    /** Runs after an event is newly committed (never on replays). Failures are logged, not fatal: at-most-once side effects. */
    private readonly onApplied?: (ev: DecodedEvent) => Promise<unknown>,
  ) {}

  /** One poll: fetch from the cursor, store raw, project, advance. Safe to call repeatedly. */
  async tick(): Promise<{ processed: number }> {
    const latest = await this.rpc.latestLedger();
    const from = (await this.cursor.get())?.valueOf() ?? this.startLedger - 1;
    const oldest = await this.rpc.oldestLedger();
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

  get shouldAlert(): boolean {
    return this.metrics.lag > LAG_ALERT_LEDGERS || this.metrics.behindRetention;
  }
}
