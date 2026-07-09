import { type CallHandler, Controller, Get, Headers, Inject, Injectable, type ExecutionContext, type NestInterceptor, UnauthorizedException } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { Public } from '../app/http.js';
import { SERVICES, type Services } from '../app/services.js';

const BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labelStr = (l: Record<string, string>) => {
  const e = Object.entries(l);
  return e.length ? `{${e.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : '';
};

/** Minimal Prometheus text-format registry: counters and one latency histogram, no dependencies. */
export class Metrics {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly hist = new Map<string, { buckets: number[]; sum: number; count: number }>();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const m = this.counters.get(name) ?? new Map<string, number>();
    const k = labelStr(labels);
    m.set(k, (m.get(k) ?? 0) + by);
    this.counters.set(name, m);
  }

  observe(name: string, labels: Record<string, string>, seconds: number): void {
    const k = labelStr(labels);
    const key = `${name}|${k}`;
    const h = this.hist.get(key) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i]!++; });
    h.sum += seconds;
    h.count++;
    this.hist.set(key, h);
  }

  render(gauges: Record<string, number> = {}): string {
    const out: string[] = [];
    for (const [name, series] of this.counters) {
      out.push(`# TYPE ${name} counter`);
      for (const [k, v] of series) out.push(`${name}${k} ${v}`);
    }
    const seen = new Set<string>();
    for (const [key, h] of this.hist) {
      const [name, k] = key.split('|') as [string, string];
      if (!seen.has(name)) { out.push(`# TYPE ${name} histogram`); seen.add(name); }
      const base = k ? k.slice(1, -1) + ',' : '';
      BUCKETS.forEach((b, i) => out.push(`${name}_bucket{${base}le="${b}"} ${h.buckets[i]}`));
      out.push(`${name}_bucket{${base}le="+Inf"} ${h.count}`, `${name}_sum${k} ${h.sum}`, `${name}_count${k} ${h.count}`);
    }
    for (const [name, v] of Object.entries(gauges)) out.push(`# TYPE ${name} gauge`, `${name} ${v}`);
    return out.join('\n') + '\n';
  }
}

export const METRICS = Symbol('METRICS');

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(@Inject(METRICS) private readonly m: Metrics) {}
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<{ method: string; route?: { path?: string } }>();
    const res = http.getResponse<{ statusCode: number; once(ev: 'finish', cb: () => void): void }>();
    const start = process.hrtime.bigint();
    res.once('finish', () => {
      // Route pattern, never the raw URL, so ids cannot blow up label cardinality.
      const route = req.route?.path ?? 'unmatched';
      const labels = { method: req.method, route, status: String(res.statusCode) };
      this.m.inc('http_requests_total', labels);
      this.m.observe('http_request_duration_seconds', { method: req.method, route }, Number(process.hrtime.bigint() - start) / 1e9);
    });
    return next.handle();
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(SERVICES) private readonly s: Services, @Inject(METRICS) private readonly m: Metrics) {}

  /** Prometheus scrape target. In production a bearer METRICS_TOKEN is required. */
  @Public() @Get()
  async scrape(@Headers('authorization') auth?: string): Promise<string> {
    const token = this.s.env.METRICS_TOKEN;
    if (token ? auth !== `Bearer ${token}` : this.s.env.NODE_ENV === 'production') throw new UnauthorizedException('metrics token required');
    const [pending, failed] = await Promise.all([
      this.s.prisma.notification.count({ where: { status: 'PENDING' } }),
      this.s.prisma.notification.count({ where: { status: 'FAILED' } }),
    ]);
    return this.m.render({ sp_notifications_pending: pending, sp_notifications_failed: failed });
  }
}
