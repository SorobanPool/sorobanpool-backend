import { scValToNative, Keypair } from '@stellar/stellar-sdk';
import { A, outcome, poolTerms, struct, u32, bytes32 } from './args.js';
import { USDC_FIXTURE } from './fixtures.js';

const g = () => Keypair.random().publicKey();

describe('contract argument builders', () => {
  it('orders struct keys ascending, as Soroban requires', () => {
    const keys = Object.keys(scValToNative(struct({ zeta: u32(1), alpha: u32(2), mid: u32(3) })) as object);
    expect(keys).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('encodes PoolTerms like the contract type', () => {
    const supplier = g();
    const native = scValToNative(
      poolTerms({
        supplier, offerHash: '07'.repeat(32), unitLabelHash: '08'.repeat(32), category: 'rice',
        tiers: [{ minUnits: 100, unitPrice: USDC_FIXTURE }, { minUnits: 200, unitPrice: USDC_FIXTURE * 9n / 10n }],
        moq: 100, maxUnits: 500, maxPerMember: 250, leadTimeSecs: 432000, perishable: false,
      }),
    ) as Record<string, unknown>;
    expect(Object.keys(native)).toEqual([
      'category', 'lead_time_secs', 'max_per_member', 'max_units', 'moq', 'offer_hash', 'perishable', 'supplier', 'tiers', 'unit_label_hash',
    ]);
    expect(native.supplier).toBe(supplier);
    expect(native.lead_time_secs).toBe(432000n);
    expect(native.tiers).toEqual([{ min_units: 100, unit_price: USDC_FIXTURE }, { min_units: 200, unit_price: 9_000_000n }]);
  });

  it('encodes enums, options and numbers', () => {
    expect(scValToNative(outcome({ kind: 'ReleaseToSupplier' }))).toEqual(['ReleaseToSupplier']);
    expect(scValToNative(outcome({ kind: 'RefundMember', units: 6 }))).toEqual(['RefundMember', 6]);
    expect(scValToNative(outcome({ kind: 'Split', bp: 2500 }))).toEqual(['Split', 2500]);
    const [opener, pool, reason, units] = A.disputeOpen(g(), 7n, 'Damaged', 3, '01'.repeat(32)).map((v) => scValToNative(v));
    expect([typeof opener, pool, reason, units]).toEqual(['string', 7n, ['Damaged'], 3]);
    const reg = A.register(g(), 'Supplier', '02'.repeat(32), undefined).map((v) => scValToNative(v));
    expect(reg[1]).toEqual(['Supplier']);
    expect(reg[3]).toBeNull();
    expect(A.dispatch(g(), 1n).map((v) => scValToNative(v))[2]).toBeNull();
  });

  it('rejects hashes that are not 32 bytes', () => {
    expect(() => bytes32('abcd')).toThrow(/32 bytes/);
  });
});
