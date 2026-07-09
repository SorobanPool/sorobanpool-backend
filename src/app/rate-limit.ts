import { type CanActivate, type ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import { SERVICES, type Services } from './services.js';

/** Fixed-window counter per client key. In-process: with several API replicas the effective limit is per replica. */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { windowStart: number; n: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Returns seconds to wait when over the limit, else 0. */
  take(key: string, nowMs: number): number {
    const e = this.hits.get(key);
    if (!e || nowMs - e.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: nowMs, n: 1 });
      if (this.hits.size > 50_000) this.prune(nowMs);
      return 0;
    }
    if (e.n >= this.limit) return Math.ceil((e.windowStart + this.windowMs - nowMs) / 1000);
    e.n++;
    return 0;
  }

  private prune(nowMs: number): void {
    for (const [k, e] of this.hits) if (nowMs - e.windowStart >= this.windowMs) this.hits.delete(k);
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiter: FixedWindowLimiter;
  constructor(@Inject(SERVICES) private readonly s: Services) {
    this.limiter = new FixedWindowLimiter(s.env.RATE_LIMIT_PER_MIN, 60_000);
  }
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ ip?: string; path?: string }>();
    if (req.path?.endsWith('/health')) return true;
    const wait = this.limiter.take(req.ip ?? 'unknown', this.s.now().getTime());
    if (wait > 0) throw new HttpException({ error: 'RATE_LIMITED', message: `Too many requests; retry in ${wait}s`, retryAfterSecs: wait }, 429);
    return true;
  }
}
