import { Keypair, TransactionBuilder, type FeeBumpTransaction, type Transaction } from '@stellar/stellar-sdk';

/**
 * Wraps a user-signed inner transaction in a fee bump paid by the sponsor, so users never hold XLM.
 * `baseFee` must be at least the inner transaction's fee rate or Stellar rejects the bump.
 */
export function feeBump(
  sponsor: Keypair,
  inner: Transaction,
  networkPassphrase: string,
  baseFee: string,
): FeeBumpTransaction {
  if (BigInt(baseFee) < BigInt(Math.ceil(Number(inner.fee) / Math.max(inner.operations.length, 1)))) {
    throw new Error('fee bump base fee is lower than the inner transaction fee rate');
  }
  const bumped = TransactionBuilder.buildFeeBumpTransaction(sponsor, baseFee, inner, networkPassphrase);
  bumped.sign(sponsor);
  return bumped;
}

/** Runway in days given balance, average daily spend; the sponsor-balance job alerts below 7. */
export function runwayDays(balanceStroops: bigint, avgDailySpendStroops: bigint): number {
  if (avgDailySpendStroops <= 0n) return Number.POSITIVE_INFINITY;
  return Number(balanceStroops / avgDailySpendStroops);
}
