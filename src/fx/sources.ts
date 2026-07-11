import type { FxSourceQuote } from './fx.js';

/**
 * Live NGN-per-USD sources (brief 7.7 `fx-refresh`, 7.10). Two independent kinds of price on purpose: a fiat FX feed
 * and the market price of USDC itself in naira. If they disagree by more than 2% (`combineQuotes`), offer
 * publishing is blocked until they agree again. Both are keyless public endpoints; production should add a paid
 * feed with an SLA (FX_SOURCES takes any combination of the names below).
 */
export interface FxSource {
  readonly name: string;
  fetch(fetchImpl: typeof fetch, signal: AbortSignal): Promise<number>;
}

const json = async (r: Response): Promise<unknown> => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

export const FX_SOURCE_REGISTRY: Record<string, FxSource> = {
  /** Fiat USD/NGN reference rate, updated daily (open.er-api.com, free tier, no key). */
  'er-api': {
    name: 'er-api',
    async fetch(f, signal) {
      const d = (await json(await f('https://open.er-api.com/v6/latest/USD', { signal }))) as { result?: string; rates?: Record<string, number> };
      if (d.result !== 'success') throw new Error('er-api returned no result');
      return Number(d.rates?.NGN);
    },
  },
  /** Market price of USDC in naira (CoinGecko simple price, no key). */
  coingecko: {
    name: 'coingecko',
    async fetch(f, signal) {
      const d = (await json(await f('https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=ngn', { signal }))) as { 'usd-coin'?: { ngn?: number } };
      return Number(d['usd-coin']?.ngn);
    },
  },
};

/** A naira rate outside this band is a broken feed, not a market move; it is dropped rather than averaged in. */
export const SANE_NGN_PER_USD = { min: 100, max: 100_000 } as const;

export interface LiveFxOptions {
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  onError?: (source: string, e: Error) => void;
}

/**
 * Queries every configured source in parallel and returns the ones that answered sensibly. Answers are cached for
 * `cacheMs` (default 30 s, half the 60 s quote lifetime) so API traffic does not hammer free endpoints.
 */
export class LiveFxProvider {
  private cached: { at: number; quotes: FxSourceQuote[] } | null = null;
  private readonly sources: FxSource[];

  constructor(names: string[], private readonly o: LiveFxOptions = {}) {
    this.sources = names.map((n) => {
      const s = FX_SOURCE_REGISTRY[n];
      if (!s) throw new Error(`unknown FX source "${n}" (known: ${Object.keys(FX_SOURCE_REGISTRY).join(', ')})`);
      return s;
    });
    if (this.sources.length < 2) throw new Error('FX_SOURCES needs at least two independent sources (brief 7.7)');
  }

  async quotes(): Promise<FxSourceQuote[]> {
    const now = (this.o.now ?? Date.now)();
    if (this.cached && now - this.cached.at < (this.o.cacheMs ?? 30_000)) return this.cached.quotes;
    const f = this.o.fetchImpl ?? fetch;
    const results = await Promise.all(this.sources.map(async (s) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 5_000);
      try {
        const v = await s.fetch(f, ctl.signal);
        if (!Number.isFinite(v) || v < SANE_NGN_PER_USD.min || v > SANE_NGN_PER_USD.max) throw new Error(`implausible rate ${v}`);
        return { source: s.name, ngnPerUsd: v };
      } catch (e) {
        (this.o.onError ?? ((n, err) => console.error(`[fx] ${n}: ${err.message}`)))(s.name, e as Error);
        return null;
      } finally {
        clearTimeout(t);
      }
    }));
    const quotes = results.filter((q): q is FxSourceQuote => q !== null);
    this.cached = { at: now, quotes };
    return quotes;
  }
}
