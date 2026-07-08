import { mulDivFloor } from '../common/money.js';

/** Mirrors the contract math in sorobanpool-contracts `sp_common::math`; parity-tested against pricing-vectors.json. */
export interface Tier {
  minUnits: number;
  unitPrice: bigint;
}

/** Index of the highest tier reached, or null below MOQ. */
export function tierIndex(tiers: readonly Tier[], totalUnits: number): number | null {
  let found: number | null = null;
  tiers.forEach((t, i) => {
    if (totalUnits >= t.minUnits) found = i;
  });
  return found;
}

/** The price a committer pays: the tier price before their units (the most they could end up paying). */
export function ceilingPrice(tiers: readonly Tier[], totalBefore: number): bigint {
  return tiers[tierIndex(tiers, totalBefore) ?? 0]!.unitPrice;
}

export const finalUnitPrice = ceilingPrice;

export function quoteCommit(tiers: readonly Tier[], totalBefore: number, units: number): bigint {
  return ceilingPrice(tiers, totalBefore) * BigInt(units);
}

/** Shortfall allocation in commit order; allocations sum to exactly `received`. */
export function cumulativeAlloc(cumBefore: number, units: number, received: number, total: number): number {
  const hi = mulDivFloor(BigInt(cumBefore + units), BigInt(received), BigInt(total));
  const lo = mulDivFloor(BigInt(cumBefore), BigInt(received), BigInt(total));
  return Number(hi - lo);
}

export function refundFor(paid: bigint, allocatedUnits: number, finalPrice: bigint): bigint {
  return paid - BigInt(allocatedUnits) * finalPrice;
}

export interface CommitQuote {
  /** Maximum the member pays now. */
  amountNow: bigint;
  /** Price per unit if the pool closed right now. */
  currentUnitPrice: bigint;
  /** Refund if the pool closed at the current tier after this commit. */
  expectedRefundIfClosedNow: bigint;
  nextBreak: { unitsToGo: number; unitPrice: bigint } | null;
}

/** Everything the "before you pay" screen shows. */
export function quote(tiers: readonly Tier[], totalUnits: number, units: number): CommitQuote {
  const amountNow = quoteCommit(tiers, totalUnits, units);
  const after = totalUnits + units;
  const currentUnitPrice = finalUnitPrice(tiers, Math.max(after, tiers[0]!.minUnits));
  const nextIdx = (tierIndex(tiers, after) ?? -1) + 1;
  const next = tiers[nextIdx];
  return {
    amountNow,
    currentUnitPrice,
    expectedRefundIfClosedNow: amountNow - currentUnitPrice * BigInt(units),
    nextBreak: next ? { unitsToGo: next.minUnits - after, unitPrice: next.unitPrice } : null,
  };
}
