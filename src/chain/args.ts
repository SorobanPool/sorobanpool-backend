import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { Tier } from '../pools/pricing.js';

/** ScVal builders matching the contract interfaces (docs/events.md and contracts/*). Unit-tested for shape. */
export type Role = 'Trader' | 'Organizer' | 'Supplier';
export type DisputeReason = 'Short' | 'WrongItem' | 'Damaged' | 'Quality' | 'NotDelivered' | 'Other';
export type Outcome =
  | { kind: 'ReleaseToSupplier' }
  | { kind: 'RefundMember'; units: number }
  | { kind: 'Split'; bp: number }
  | { kind: 'RefundPool' };

export const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
export const u32 = (n: number): xdr.ScVal => nativeToScVal(n, { type: 'u32' });
export const u64 = (n: bigint | number): xdr.ScVal => nativeToScVal(BigInt(n), { type: 'u64' });
export const i128 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: 'i128' });
export const sym = (s: string): xdr.ScVal => xdr.ScVal.scvSymbol(s);
export const bytes32 = (hexOrBuf: string | Uint8Array): xdr.ScVal => {
  const b = typeof hexOrBuf === 'string' ? Buffer.from(hexOrBuf, 'hex') : Buffer.from(hexOrBuf);
  if (b.length !== 32) throw new Error('expected 32 bytes');
  return xdr.ScVal.scvBytes(b);
};
export const optSym = (s?: string): xdr.ScVal => (s ? sym(s) : xdr.ScVal.scvVoid());
export const optBytes32 = (h?: string): xdr.ScVal => (h ? bytes32(h) : xdr.ScVal.scvVoid());

/** Soroban `#[contracttype]` structs are maps with symbol keys in ascending order. */
export function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.keys(fields)
    .sort()
    .map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k]! }));
  return xdr.ScVal.scvMap(entries);
}

/** Unit enum variant = vec[symbol]; tuple variant = vec[symbol, payload]. */
export const variant = (name: string, payload?: xdr.ScVal): xdr.ScVal =>
  xdr.ScVal.scvVec(payload ? [sym(name), payload] : [sym(name)]);

export const role = (r: Role): xdr.ScVal => variant(r);
export const reason = (r: DisputeReason): xdr.ScVal => variant(r);
export function outcome(o: Outcome): xdr.ScVal {
  switch (o.kind) {
    case 'RefundMember': return variant('RefundMember', u32(o.units));
    case 'Split': return variant('Split', u32(o.bp));
    default: return variant(o.kind);
  }
}

export interface PoolTermsInput {
  supplier: string;
  offerHash: string;
  unitLabelHash: string;
  category: string;
  tiers: Tier[];
  moq: number;
  maxUnits: number;
  maxPerMember: number;
  leadTimeSecs: number;
  perishable: boolean;
}

export function poolTerms(t: PoolTermsInput): xdr.ScVal {
  return struct({
    supplier: addr(t.supplier),
    offer_hash: bytes32(t.offerHash),
    unit_label_hash: bytes32(t.unitLabelHash),
    category: sym(t.category),
    tiers: xdr.ScVal.scvVec(t.tiers.map((x) => struct({ min_units: u32(x.minUnits), unit_price: i128(x.unitPrice) }))),
    moq: u32(t.moq),
    max_units: u32(t.maxUnits),
    max_per_member: u32(t.maxPerMember),
    lead_time_secs: u64(t.leadTimeSecs),
    perishable: xdr.ScVal.scvBool(t.perishable),
  });
}

export const A = {
  register: (user: string, r: Role, profileHash: string, cluster?: string) => [addr(user), role(r), bytes32(profileHash), optSym(cluster)],
  attest: (attestor: string, user: string, r: Role, verHash: string, level: number) => [addr(attestor), addr(user), role(r), bytes32(verHash), u32(level)],
  createPool: (organizer: string, terms: PoolTermsInput, hubHash: string, feeBp: number, cluster: string | undefined, fillDeadline: number) =>
    [addr(organizer), poolTerms(terms), bytes32(hubHash), u32(feeBp), optSym(cluster), u64(fillDeadline)],
  commit: (member: string, poolId: bigint, units: number) => [addr(member), u64(poolId), u32(units)],
  withdraw: (member: string, poolId: bigint) => [addr(member), u64(poolId)],
  closeEarly: (organizer: string, poolId: bigint) => [addr(organizer), u64(poolId)],
  accept: (supplier: string, poolId: bigint, advanceBp: number) => [addr(supplier), u64(poolId), u32(advanceBp)],
  reject: (supplier: string, poolId: bigint) => [addr(supplier), u64(poolId)],
  dispatch: (supplier: string, poolId: bigint, waybillHash?: string) => [addr(supplier), u64(poolId), optBytes32(waybillHash)],
  confirmDelivery: (organizer: string, poolId: bigint, received: number, evidence: string) => [addr(organizer), u64(poolId), u32(received), bytes32(evidence)],
  memberConfirm: (member: string, poolId: bigint) => [addr(member), u64(poolId)],
  pickup: (member: string, poolId: bigint) => [addr(member), u64(poolId)],
  claimRefund: (member: string, poolId: bigint) => [addr(member), u64(poolId)],
  poolOnly: (poolId: bigint) => [u64(poolId)],
  poolBatch: (poolId: bigint, max: number) => [u64(poolId), u32(max)],
  disputeOpen: (opener: string, poolId: bigint, r: DisputeReason, units: number, evidence: string) => [addr(opener), u64(poolId), reason(r), u32(units), bytes32(evidence)],
  disputeEvidence: (party: string, id: bigint, evidence: string) => [addr(party), u64(id), bytes32(evidence)],
  disputeResolve: (arbiter: string, id: bigint, o: Outcome, reasoningHash: string) => [addr(arbiter), u64(id), outcome(o), bytes32(reasoningHash)],
  disputeTimeout: (id: bigint) => [u64(id)],
  bondAmount: (supplier: string, amount: bigint) => [addr(supplier), i128(amount)],
};
