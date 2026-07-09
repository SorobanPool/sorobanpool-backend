import { FixedWindowLimiter } from './rate-limit.js';
import { startHarness, type Harness } from '../../test/harness.js';

describe('FixedWindowLimiter', () => {
  it('allows the limit, then reports the wait, then resets with the window', () => {
    const l = new FixedWindowLimiter(3, 60_000);
    expect([l.take('a', 0), l.take('a', 1), l.take('a', 2)]).toEqual([0, 0, 0]);
    expect(l.take('a', 10_000)).toBe(50);
    expect(l.take('b', 10_000)).toBe(0);
    expect(l.take('a', 60_000)).toBe(0);
  });
});

describe('rate limiting over HTTP', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ RATE_LIMIT_PER_MIN: '5' }); });
  afterAll(async () => { await h.close(); });
  it('answers 429 with RATE_LIMITED past the limit but never throttles health', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await h.http().get('/v1/offers')).status);
    expect(codes.slice(5)).toEqual([429, 429]);
    const r = await h.http().get('/v1/offers');
    expect(r.body.error).toBe('RATE_LIMITED');
    expect((await h.http().get('/v1/health')).status).toBe(200);
  });
});
