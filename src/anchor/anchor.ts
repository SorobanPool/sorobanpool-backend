import type { PrismaClient } from '../generated/prisma/client.js';
import type { FxProvider } from '../app/services.js';
import { combineQuotes, ngnToStroops } from '../fx/fx.js';

/**
 * Naira on/off-ramp abstraction (brief 7.10). The real implementation is SEP-24/SEP-6 against a licensed anchor and
 * is blocked on brief section 17 (anchor choice, contract-account support, licensing). Until then only `MockAnchor`
 * exists, and it must never be wired up on mainnet.
 */
export type TransferStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

export interface DepositStart {
  transferId: string;
  anchor: string;
  /** Where the trader sends the naira. */
  instructions: { bank: string; accountName: string; accountNumber: string; reference: string };
  amountNgn: bigint;
  /** Indicative only: the rate at the moment the bank transfer is confirmed is final. */
  estimatedUsdcStroops: bigint;
  ngnPerUsd: number;
}

export interface TransferView {
  id: string;
  kind: 'DEPOSIT' | 'WITHDRAW';
  status: TransferStatus;
  amountNgn: bigint | null;
  amountUsdcStroops: bigint | null;
  anchor: string;
}

export interface AnchorProvider {
  readonly name: string;
  startDeposit(userId: string, amountNgn: bigint): Promise<DepositStart>;
  transfer(id: string, userId: string): Promise<TransferView | null>;
}

/** Credits USDC to a wallet. Testnet uses the admin account; mainnet has no implementation on purpose. */
export interface UsdcPayout {
  pay(wallet: string, stroops: bigint): Promise<void>;
}

export const MIN_DEPOSIT_NGN = 1_000n;
export const MAX_DEPOSIT_NGN = 5_000_000n;

export class AnchorError extends Error {
  constructor(public readonly code: 'AMOUNT_OUT_OF_RANGE' | 'NOT_FOUND' | 'BAD_STATE' | 'FX_UNAVAILABLE', message: string) {
    super(message);
  }
}

/** Fake bank: remembers deposits and "confirms" them on request. For development and tests only. */
export class MockAnchor implements AnchorProvider {
  readonly name = 'mock-anchor';
  constructor(
    private readonly db: PrismaClient,
    private readonly fx: FxProvider,
    private readonly payout: UsdcPayout,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async rate(): Promise<number> {
    try {
      return combineQuotes(await this.fx.quotes(), this.now()).rate;
    } catch {
      throw new AnchorError('FX_UNAVAILABLE', 'Exchange rates are not available right now');
    }
  }

  async startDeposit(userId: string, amountNgn: bigint): Promise<DepositStart> {
    if (amountNgn < MIN_DEPOSIT_NGN || amountNgn > MAX_DEPOSIT_NGN) throw new AnchorError('AMOUNT_OUT_OF_RANGE', `Deposits are between ₦${MIN_DEPOSIT_NGN} and ₦${MAX_DEPOSIT_NGN}`);
    const rate = await this.rate();
    const estimated = ngnToStroops(amountNgn, rate);
    const row = await this.db.anchorTransfer.create({
      data: { id: `mock_${this.now().getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`, userId, kind: 'DEPOSIT', anchor: this.name, anchorTxId: '', amountNgn: amountNgn.toString(), status: 'PENDING' },
    });
    return {
      transferId: row.id, anchor: this.name, amountNgn, estimatedUsdcStroops: estimated, ngnPerUsd: rate,
      instructions: { bank: 'Mock Bank (testing only)', accountName: 'SorobanPool Test Collections', accountNumber: '0000000000', reference: row.id },
    };
  }

  async transfer(id: string, userId: string): Promise<TransferView | null> {
    const t = await this.db.anchorTransfer.findFirst({ where: { id, userId } });
    if (!t) return null;
    return {
      id: t.id, kind: t.kind as 'DEPOSIT', status: t.status as TransferStatus, anchor: t.anchor,
      amountNgn: t.amountNgn ? BigInt(t.amountNgn.toString().split('.')[0]!) : null,
      amountUsdcStroops: t.amountUsdc ? BigInt(Math.round(Number(t.amountUsdc.toString()) * 1e7)) : null,
    };
  }

  /** Simulates the bank confirming the transfer: fixes the final rate, then credits USDC to the user's wallet. Idempotent. */
  async confirmDeposit(id: string): Promise<TransferView> {
    const t = await this.db.anchorTransfer.findUnique({ where: { id } });
    if (!t) throw new AnchorError('NOT_FOUND', 'Unknown transfer');
    if (t.status === 'COMPLETED') return (await this.transfer(id, t.userId))!;
    if (t.status !== 'PENDING') throw new AnchorError('BAD_STATE', `Transfer is ${t.status}`);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: t.userId } });
    if (!user.walletAddress) throw new AnchorError('BAD_STATE', 'The user has no wallet to credit');
    const ngn = BigInt(t.amountNgn!.toString().split('.')[0]!);
    const usdc = ngnToStroops(ngn, await this.rate()); // final rate: at payment, not at quote
    // Claim the transition first so a retry or a duplicate callback can never pay twice.
    const claimed = await this.db.anchorTransfer.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'COMPLETED', amountUsdc: (Number(usdc) / 1e7).toFixed(7), anchorTxId: `mock-bank-${id}` } });
    if (claimed.count === 1) {
      try {
        await this.payout.pay(user.walletAddress, usdc);
      } catch (e) {
        await this.db.anchorTransfer.update({ where: { id }, data: { status: 'FAILED' } });
        throw e;
      }
    }
    return (await this.transfer(id, t.userId))!;
  }
}


/** JSON-safe form of a transfer (stroops and naira as strings, USDC as a decimal). */
export function transferJson(t: TransferView) {
  const usdc = t.amountUsdcStroops;
  return {
    id: t.id, kind: t.kind, status: t.status, anchor: t.anchor, amountNgn: t.amountNgn?.toString() ?? null,
    amountUsdc: usdc === null ? null : `${usdc / 10_000_000n}.${(usdc % 10_000_000n).toString().padStart(7, '0')}`,
  };
}
