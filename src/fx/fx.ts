import { mulDivFloor } from '../common/money.js';
import type { Tier } from '../pools/pricing.js';

export const MAX_DIVERGENCE = 0.02;
export const QUOTE_TTL_MS = 60_000;

export interface FxSourceQuote {
  source: string;
  /** NGN per 1 USD (USDC treated as 1 USD). */
  ngnPerUsd: number;
}

export interface FxQuote {
  rate: number;
  sources: FxSourceQuote[];
  divergence: number;
  at: Date;
}

export class FxDivergenceError extends Error {
  constructor(public readonly divergence: number) {
    super(`FX sources diverge by ${(divergence * 100).toFixed(2)}% (limit ${(MAX_DIVERGENCE * 100).toFixed(0)}%)`);
  }
}

/** Median of at least two sources; throws when they disagree by more than 2% so publishing is blocked. */
export function combineQuotes(sources: FxSourceQuote[], at: Date): FxQuote {
  const valid = sources.filter((s) => Number.isFinite(s.ngnPerUsd) && s.ngnPerUsd > 0);
  if (valid.length < 2) throw new Error('need at least two FX sources');
  const rates = valid.map((s) => s.ngnPerUsd).sort((a, b) => a - b);
  const min = rates[0]!;
  const max = rates[rates.length - 1]!;
  const divergence = (max - min) / min;
  const mid = Math.floor(rates.length / 2);
  const rate = rates.length % 2 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2;
  if (divergence > MAX_DIVERGENCE) throw new FxDivergenceError(divergence);
  return { rate, sources: valid, divergence, at };
}

export const isQuoteFresh = (q: FxQuote, now: Date): boolean => now.getTime() - q.at.getTime() <= QUOTE_TTL_MS;

/**
 * NGN kobo-free price -> USDC stroops, rounded down (amounts owed to the supplier round down, as on-chain).
 * `rate` is NGN per USD; it is carried as a fixed-point integer so no float touches money.
 */
export function ngnToStroops(priceNgn: bigint, rate: number): bigint {
  const RATE_SCALE = 1_000_000n;
  const scaledRate = BigInt(Math.round(rate * Number(RATE_SCALE)));
  if (scaledRate <= 0n) throw new Error('invalid FX rate');
  return mulDivFloor(priceNgn * 10_000_000n, RATE_SCALE, scaledRate);
}

export interface NgnTier {
  minUnits: number;
  priceNgn: bigint;
}

/** Converts tiers and re-checks strict ordering, which rounding could break for near-equal prices. */
export function convertTiers(tiers: readonly NgnTier[], rate: number): Tier[] {
  const out = tiers.map((t) => ({ minUnits: t.minUnits, unitPrice: ngnToStroops(t.priceNgn, rate) }));
  out.forEach((t, i) => {
    if (t.unitPrice <= 0n) throw new Error(`tier ${i + 1} converts to a non-positive USDC price`);
    const prev = out[i - 1];
    if (prev && t.unitPrice >= prev.unitPrice) throw new Error(`tier ${i + 1} is not cheaper than tier ${i} in USDC`);
  });
  return out;
}
