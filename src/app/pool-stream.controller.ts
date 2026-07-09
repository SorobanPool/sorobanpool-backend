import { Controller, HttpException, Inject, type MessageEvent, Param, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';
import { Public } from './http.js';
import { SERVICES, type Services } from './services.js';

export const MAX_STREAMS = 500;
const POLL_MS = 2_000;
const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events for a pool page: pushes the pool's headline figures whenever the indexer applies a new event.
 * It polls the read model (cheap, indexed by id) instead of subscribing in-process, so it also works when the
 * indexer runs in a different process from the API. The browser's EventSource reconnects on its own.
 */
@Controller('pools')
export class PoolStreamController {
  private open = 0;
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Public() @Sse(':id/stream')
  stream(@Param('id') idParam: string): Observable<MessageEvent> {
    if (!/^\d{1,18}$/.test(idParam)) throw new HttpException({ error: 'VALIDATION', message: 'invalid pool id' }, 400);
    if (this.open >= MAX_STREAMS) throw new HttpException({ error: 'BUSY', message: 'Too many live streams' }, 503);
    const id = BigInt(idParam);
    return new Observable<MessageEvent>((sub) => {
      this.open++;
      let last = -1;
      let busy = false;
      const poll = async () => {
        if (busy) return;
        busy = true;
        try {
          const p = await this.s.prisma.pool.findUnique({ where: { id } });
          if (!p) { sub.error(new HttpException({ error: 'NOT_FOUND', message: 'No such pool' }, 404)); return; }
          if (p.lastEventLedger !== last) {
            last = p.lastEventLedger;
            sub.next({ type: 'pool', data: { id: idParam, state: p.state, totalUnits: p.totalUnits, currentTierIdx: p.currentTierIdx, ledger: p.lastEventLedger } });
          }
        } catch { /* transient DB error: the next poll retries */ } finally { busy = false; }
      };
      void poll();
      const t = setInterval(() => void poll(), POLL_MS);
      const hb = setInterval(() => sub.next({ type: 'ping', data: {} }), HEARTBEAT_MS);
      return () => { clearInterval(t); clearInterval(hb); this.open--; };
    });
  }
}
