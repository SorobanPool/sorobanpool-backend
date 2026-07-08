/** Contract functions the relayer will sponsor fees for. Anything else is refused before simulation. */
export const SPONSORED_FUNCTIONS: Record<string, readonly string[]> = {
  registry: ['register'],
  group_buy: [
    'create_pool', 'cancel_pool', 'commit', 'increase', 'withdraw_commitment', 'close_early', 'close',
    'accept', 'reject', 'fail_accept', 'dispatch', 'fail_delivery', 'confirm_delivery',
    'member_confirm_delivery', 'allocate_shortfall', 'confirm_pickup', 'settle', 'claim_refund', 'push_refunds',
  ],
  disputes: ['open', 'add_evidence', 'resolve', 'timeout'],
  supplier_bond: ['deposit', 'withdraw'],
};

/** Never sponsored: privileged or admin-only operations. */
export const NEVER_SPONSORED = ['upgrade', 'set_params', 'set_address', 'attest', 'revoke', 'suspend', 'pause', 'unpause'];

export const DEFAULT_DAILY_CAP = 50;

export class SponsorshipError extends Error {
  constructor(public readonly code: 'NOT_ALLOWED' | 'CAP_REACHED' | 'UNKNOWN_CONTRACT', message: string) {
    super(message);
  }
}

export interface UsageStore {
  /** Atomically increments and returns the new count for (user, day). */
  increment(userId: string, day: string): Promise<number>;
}

export class SponsorshipPolicy {
  constructor(
    /** contract id -> logical name (config / registry / group_buy ...), from deployments/<network>.json */
    private readonly contractNames: ReadonlyMap<string, string>,
    private readonly usage: UsageStore,
    private readonly dailyCap = DEFAULT_DAILY_CAP,
    private readonly now: () => Date = () => new Date(),
  ) {}

  check(contractId: string, fn: string): void {
    const name = this.contractNames.get(contractId);
    if (!name) throw new SponsorshipError('UNKNOWN_CONTRACT', `contract ${contractId} is not part of this deployment`);
    if (NEVER_SPONSORED.includes(fn) || !SPONSORED_FUNCTIONS[name]?.includes(fn)) {
      throw new SponsorshipError('NOT_ALLOWED', `${name}.${fn} is not sponsored`);
    }
  }

  /** Checks the allow-list, then spends one unit of the user's daily allowance. */
  async authorize(userId: string, contractId: string, fn: string): Promise<void> {
    this.check(contractId, fn);
    const day = this.now().toISOString().slice(0, 10);
    const n = await this.usage.increment(userId, day);
    if (n > this.dailyCap) throw new SponsorshipError('CAP_REACHED', 'Daily free-transaction limit reached');
  }
}

export class MemoryUsageStore implements UsageStore {
  private counts = new Map<string, number>();
  async increment(userId: string, day: string): Promise<number> {
    const k = `${userId}:${day}`;
    const n = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, n);
    return n;
  }
}
