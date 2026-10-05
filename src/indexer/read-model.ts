export type PoolState =
  | 'Open' | 'Filled' | 'Accepted' | 'Dispatched' | 'Delivered' | 'Settled' | 'Expired' | 'Failed' | 'Cancelled';

export interface PoolRow {
  id: bigint;
  organizer: string;
  supplier: string;
  offerHash: string;
  state: PoolState;
  totalUnits: number;
  receivedUnits: number | null;
  currentTierIdx: number;
  /** Final unit price once Filled, else unset (0n). */
  finalUnitPrice: bigint;
  escrowBalance: bigint;
  frozenAmount: bigint;
  advancePaid: bigint;
  lastEventLedger: number;
}

export interface CommitmentRow {
  poolId: bigint;
  member: string;
  units: number;
  paid: bigint;
  refundClaimed: bigint;
  pickedUp: boolean;
}

export interface DisputeRow {
  id: bigint;
  poolId: bigint;
  opener: string;
  claimedAmount: bigint;
  state: 'OPEN' | 'RESOLVED' | 'TIMED_OUT';
  arbiter?: string;
  reasoningHash?: string;
}

export interface BondRow {
  supplier: string;
  total: bigint;
}

/** Persistence port for the projector. The Prisma implementation maps these onto the schema. */
export interface ReadStore {
  pool(id: bigint): Promise<PoolRow | undefined>;
  savePool(row: PoolRow): Promise<void>;
  commitment(poolId: bigint, member: string): Promise<CommitmentRow | undefined>;
  saveCommitment(row: CommitmentRow): Promise<void>;
  dispute(id: bigint): Promise<DisputeRow | undefined>;
  saveDispute(row: DisputeRow): Promise<void>;
  bond(supplier: string): Promise<BondRow | undefined>;
  saveBond(row: BondRow): Promise<void>;
  /** True if the event id was already processed; marks it processed otherwise (atomic). */
  markProcessed(eventId: string): Promise<boolean>;
}

export class MemoryReadStore implements ReadStore {
  pools = new Map<bigint, PoolRow>();
  commitments = new Map<string, CommitmentRow>();
  disputes = new Map<bigint, DisputeRow>();
  bonds = new Map<string, BondRow>();
  processed = new Set<string>();
  async pool(id: bigint) { return this.pools.get(id); }
  async savePool(r: PoolRow) { this.pools.set(r.id, { ...r }); }
  async commitment(p: bigint, m: string) { return this.commitments.get(`${p}:${m}`); }
  async saveCommitment(r: CommitmentRow) { this.commitments.set(`${r.poolId}:${r.member}`, { ...r }); }
  async dispute(id: bigint) { return this.disputes.get(id); }
  async saveDispute(r: DisputeRow) { this.disputes.set(r.id, { ...r }); }
  async bond(s: string) { return this.bonds.get(s); }
  async saveBond(r: BondRow) { this.bonds.set(r.supplier, { ...r }); }
  async markProcessed(id: string) {
    if (this.processed.has(id)) return true;
    this.processed.add(id);
    return false;
  }
}
