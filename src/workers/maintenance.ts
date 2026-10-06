import type { PrismaClient } from '../generated/prisma/client.js';

/** Live offers past `validUntil` stop being offered; pools already created from them are unaffected. */
export async function expireOffers(prisma: Pick<PrismaClient, 'offer'>, now: Date): Promise<number> {
  const r = await prisma.offer.updateMany({ where: { status: 'LIVE', validUntil: { lt: now } }, data: { status: 'EXPIRED' } });
  return r.count;
}

export interface SponsorHealth {
  balanceStroops: bigint;
  minStroops: bigint;
  low: boolean;
}

/** The sponsor pays every fee; a drained sponsor halts the whole product, so this is paged on before it happens. */
export async function checkSponsor(chain: { sponsorBalance(): Promise<bigint> }, minXlm: number): Promise<SponsorHealth> {
  const minStroops = BigInt(Math.round(minXlm * 10_000_000));
  const balanceStroops = await chain.sponsorBalance();
  return { balanceStroops, minStroops, low: balanceStroops < minStroops };
}
