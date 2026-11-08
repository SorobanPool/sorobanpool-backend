import { refreshFx } from '../workers/maintenance.js';
import { LiveFxProvider } from './sources.js';

/** Recorded response shapes of the two public endpoints (November 2026), so tests never touch the network. */
const ER_API = { result: 'success', rates: { NGN: 1347.744892, USD: 1 } };
const COINGECKO = { 'usd-coin': { ngn: 1349.31 } };

function fakeFetch(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const host = new URL(url).host;
    const r = responses[host];
    if (r instanceof Error) throw r;
    if (r === undefined) return new Response('nope', { status: 503 });
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('live FX sources', () => {
  const quiet = { onError: () => undefined };

  it('reads both feeds and caches the answer for 30 s', async () => {
    let t = 0;
    const { f, calls } = fakeFetch({ 'open.er-api.com': ER_API, 'api.coingecko.com': COINGECKO });
    const fx = new LiveFxProvider(['er-api', 'coingecko'], { fetchImpl: f, now: () => t, ...quiet });
    expect(await fx.quotes()).toEqual([{ source: 'er-api', ngnPerUsd: 1347.744892 }, { source: 'coingecko', ngnPerUsd: 1349.31 }]);
    t = 29_000;
    await fx.quotes();
    expect(calls).toHaveLength(2);
    t = 31_000;
    await fx.quotes();
    expect(calls).toHaveLength(4);
  });

  it('drops a feed that errors, times out or returns an implausible rate', async () => {
    const { f } = fakeFetch({ 'open.er-api.com': { result: 'success', rates: { NGN: 3 } }, 'api.coingecko.com': new Error('ECONNRESET') });
    const errors: string[] = [];
    const fx = new LiveFxProvider(['er-api', 'coingecko'], { fetchImpl: f, onError: (n) => void errors.push(n) });
    expect(await fx.quotes()).toEqual([]);
    expect(errors.sort()).toEqual(['coingecko', 'er-api']);
  });

  it('needs at least two known sources', () => {
    expect(() => new LiveFxProvider(['er-api'])).toThrow(/at least two/);
    expect(() => new LiveFxProvider(['er-api', 'bogus'])).toThrow(/unknown FX source/);
  });
});

describe('fx-refresh job', () => {
  const rows: unknown[] = [];
  const prisma = { fxQuote: { create: async (a: { data: unknown }) => { rows.push(a.data); return a.data; } } } as never;
  const now = new Date('2026-11-08T12:00:00Z');

  it('records the combined rate and its sources', async () => {
    const r = await refreshFx(prisma, { quotes: async () => [{ source: 'a', ngnPerUsd: 1347.74 }, { source: 'b', ngnPerUsd: 1349.31 }] }, now);
    expect(r.blocked).toBe(false);
    expect(r.rate).toBeCloseTo(1348.525, 3);
    expect(rows).toHaveLength(1);
  });

  it('reports a block (publishing refused) when sources diverge by more than 2%, or too few answer', async () => {
    const diverged = await refreshFx(prisma, { quotes: async () => [{ source: 'a', ngnPerUsd: 1350 }, { source: 'b', ngnPerUsd: 1500 }] }, now);
    expect(diverged).toMatchObject({ blocked: true, rate: null });
    expect(diverged.divergence).toBeCloseTo(0.111, 3);
    const lonely = await refreshFx(prisma, { quotes: async () => [{ source: 'a', ngnPerUsd: 1350 }] }, now);
    expect(lonely).toMatchObject({ blocked: true, divergence: null });
    expect(rows).toHaveLength(1); // nothing recorded for either
  });
});
