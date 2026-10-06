import { Metrics } from './metrics.js';
import { startHarness, type Harness } from '../../test/harness.js';

describe('Metrics', () => {
  it('renders counters, histograms and gauges in Prometheus text format', () => {
    const m = new Metrics();
    m.inc('c_total', { a: 'x"y' });
    m.inc('c_total', { a: 'x"y' }, 2);
    m.observe('d_seconds', { r: '/p' }, 0.07);
    const t = m.render({ g: 4 });
    expect(t).toContain('c_total{a="x\\"y"} 3');
    expect(t).toContain('d_seconds_bucket{r="/p",le="0.05"} 0');
    expect(t).toContain('d_seconds_bucket{r="/p",le="0.1"} 1');
    expect(t).toContain('d_seconds_count{r="/p"} 1');
    expect(t).toContain('g 4');
  });
});

describe('GET /v1/metrics', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ METRICS_TOKEN: 'm'.repeat(20) }); });
  afterAll(async () => { await h.close(); });
  it('requires the token, and counts requests by route pattern', async () => {
    await h.http().get('/v1/health');
    await h.http().get('/v1/offers/abc');
    expect((await h.http().get('/v1/metrics')).status).toBe(401);
    const r = await h.http().get('/v1/metrics').set('Authorization', `Bearer ${'m'.repeat(20)}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('http_requests_total{method="GET",route="/v1/health"');
    expect(r.text).toContain('route="/v1/offers/:id"');
    expect(r.text).not.toContain('/offers/abc');
    expect(r.text).toContain('sp_notifications_pending 0');
  });
});
