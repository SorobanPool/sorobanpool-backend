import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { formatUsdc, toStroops } from '../common/money.js';
import { ceilingPrice, type Tier } from '../pools/pricing.js';
import { bigintOrUndefined, decodeEvent, eventPoolId, type RawEvent } from '../indexer/decode.js';
import type { CursorStore, EventSink } from '../indexer/indexer.service.js';
import type { ActivityEventRow, BondRow, CommitmentRow, DisputeRow, PoolRow, PoolState, ReadStore, ReputationTierRow } from '../indexer/read-model.js';
import type { OtpRecord, OtpStore } from '../auth/otp.service.js';
import type { SessionRecord, SessionStore } from '../auth/token.service.js';
import type { UsageStore } from '../relayer/allowlist.js';
import { traceOperation } from '../observability/tracing.js';
import type { Tracer } from '../observability/tracing.js';

type Db = PrismaClient | Prisma.TransactionClient;

export function createPrisma(connectionString: string, maxConnections?: number, tracer?: Tracer): PrismaClient {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, ...(maxConnections ? { max: maxConnections } : {}) }) });
  if (!tracer) return prisma;
  return prisma.$extends({
    query: {
      $allOperations({ model, operation, args, query }) {
        return traceOperation(tracer, 'prisma.query', { 'db.system': 'postgresql', 'db.operation.name': operation, ...(model ? { 'db.collection.name': model } : {}) }, () => query(args));
      },
    },
  }) as PrismaClient;
}

/** Money is stored as USDC decimals (Decimal(38,7)); the app works in stroops (bigint). */
export const toDec = (stroops: bigint): string => formatUsdc(stroops);
export const fromDec = (d: Prisma.Decimal | string | number): bigint => toStroops(d.toString());

export class PrismaOtpStore implements OtpStore {
  constructor(private readonly db: Db) {}
  async insert(r: Omit<OtpRecord, 'id'>): Promise<OtpRecord> {
    return this.db.otpChallenge.create({ data: r });
  }
  async latestOpen(phone: string): Promise<OtpRecord | null> {
    return this.db.otpChallenge.findFirst({ where: { phone, consumed: false }, orderBy: { createdAt: 'desc' } });
  }
  async countSince(phone: string, since: Date): Promise<number> {
    return this.db.otpChallenge.count({ where: { phone, createdAt: { gte: since } } });
  }
  async update(id: string, patch: Partial<Pick<OtpRecord, 'attempts' | 'consumed'>>): Promise<void> {
    await this.db.otpChallenge.update({ where: { id }, data: patch });
  }
  async lastRequestTime(phone: string): Promise<Date | null> {
    const record = await this.db.otpChallenge.findFirst({ where: { phone }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    return record?.createdAt ?? null;
  }
}

export class PrismaSessionStore implements SessionStore {
  constructor(private readonly db: Db) {}
  async insert(r: Omit<SessionRecord, 'id' | 'revokedAt'>): Promise<SessionRecord> {
    return this.db.session.create({ data: r });
  }
  async findByHash(hash: string): Promise<SessionRecord | null> {
    return this.db.session.findUnique({ where: { refreshHash: hash } });
  }
  async findById(id: string): Promise<SessionRecord | null> {
    return this.db.session.findUnique({ where: { id } });
  }
  async revoke(id: string, at: Date): Promise<void> {
    await this.db.session.update({ where: { id }, data: { revokedAt: at } });
  }
  async revokeAllForUser(userId: string, at: Date): Promise<void> {
    await this.db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: at } });
  }
}

export class PrismaUsageStore implements UsageStore {
  constructor(private readonly db: Db) {}
  /** Atomic upsert-increment so concurrent requests cannot exceed the cap. */
  async increment(userId: string, day: string): Promise<number> {
    const row = await this.db.sponsorUsage.upsert({
      where: { userId_day: { userId, day } },
      create: { userId, day, count: 1 },
      update: { count: { increment: 1 } },
    });
    return row.count;
  }
}

export class PrismaCursorStore implements CursorStore {
  constructor(private readonly db: Db, private readonly id = 'main') {}
  async get(): Promise<number | undefined> {
    return (await this.db.indexerCursor.findUnique({ where: { id: this.id } }))?.lastLedger;
  }
  async set(ledger: number): Promise<void> {
    await this.db.indexerCursor.upsert({ where: { id: this.id }, create: { id: this.id, lastLedger: ledger }, update: { lastLedger: ledger } });
  }
}

export class PrismaEventSink implements EventSink {
  constructor(private readonly db: Db) {}
  /** Idempotent: re-polling the same ledgers never duplicates or resets a processed event. */
  async saveRaw(raw: RawEvent): Promise<void> {
    const topic = raw.topic[1] ?? '';
    const ev = decodeEvent(raw);
    let poolId = ev ? eventPoolId(ev) : undefined;
    if (ev?.contract === 'disputes' && poolId === undefined) {
      const disputeId = bigintOrUndefined(ev.key);
      const dispute = disputeId === undefined
        ? undefined
        : await this.db.dispute.findUnique({ where: { id: disputeId }, select: { poolId: true } });
      poolId = dispute?.poolId;
    }
    // An event that can affect a pool but whose pool we cannot identify must never be pruned (#90).
    const protectedEvent = poolId === undefined && (!ev || ev.contract === 'group_buy' || ev.contract === 'disputes');
    await this.db.chainEvent.upsert({
      where: { id: raw.id },
      create: {
        id: raw.id, ledger: raw.ledger, contract: raw.contractId, topic,
        payload: raw as unknown as Prisma.InputJsonValue, closedAt: new Date(raw.ledgerClosedAt), poolId, protected: protectedEvent,
      },
      update: {},
    });
  }
}

const tiersFromJson = (j: unknown): Tier[] =>
  (j as { minUnits: number; unitPrice: string }[]).map((t) => ({ minUnits: t.minUnits, unitPrice: BigInt(t.unitPrice) }));

export class PrismaReadStore implements ReadStore {
  constructor(private readonly db: Db) {}

  async atomically<T>(fn: (s: ReadStore) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) {
      return (this.db as PrismaClient).$transaction((tx) => fn(new PrismaReadStore(tx)));
    }
    return fn(this); // already inside a transaction
  }

  async markProcessed(id: string, ev: { ledger: number; contract: string; topic: string }): Promise<boolean> {
    const done = await this.db.chainEvent.updateMany({ where: { id, processedAt: null }, data: { processedAt: new Date() } });
    if (done.count === 1) return false;
    if (await this.db.chainEvent.findUnique({ where: { id } })) return true; // already processed
    await this.db.chainEvent.create({
      data: { id, ledger: ev.ledger, contract: ev.contract, topic: ev.topic, payload: {}, processedAt: new Date() },
    });
    return false;
  }

  private toRow(p: Prisma.PoolGetPayload<object>): PoolRow {
    return {
      id: p.id, organizer: p.organizerAddress, supplier: p.supplierAddress, offerHash: p.offerHash, hubHash: p.hubHash,
      state: p.state as PoolState, totalUnits: p.totalUnits, receivedUnits: p.receivedUnits, currentTierIdx: p.currentTierIdx,
      finalUnitPrice: p.finalUnitPrice ? fromDec(p.finalUnitPrice) : 0n, escrowBalance: fromDec(p.escrowBalance),
      frozenAmount: fromDec(p.frozenAmount), advancePaid: fromDec(p.advancePaid), filledAt: p.filledAt,
      acceptedAt: p.acceptedAt, dispatchedAt: p.dispatchedAt, deliveredAt: p.deliveredAt, pickedUnits: p.pickedUnits,
      supplierNet: fromDec(p.supplierNet), platformFee: fromDec(p.platformFee), organizerFee: fromDec(p.organizerFee), endedAt: p.endedAt,
      allocationPending: p.allocationPending, refundsPushed: p.refundsPushed, lastEventLedger: p.lastEventLedger,
    };
  }

  async pool(id: bigint): Promise<PoolRow | undefined> {
    const p = await this.db.pool.findUnique({ where: { id } });
    return p ? this.toRow(p) : undefined;
  }

  async savePool(r: PoolRow): Promise<void> {
    const existing = await this.db.pool.findUnique({ where: { id: r.id } });
    const data = {
      state: r.state, totalUnits: r.totalUnits, receivedUnits: r.receivedUnits, currentTierIdx: r.currentTierIdx,
      finalUnitPrice: r.finalUnitPrice > 0n ? toDec(r.finalUnitPrice) : null, escrowBalance: toDec(r.escrowBalance),
      frozenAmount: toDec(r.frozenAmount), advancePaid: toDec(r.advancePaid), filledAt: r.filledAt, acceptedAt: r.acceptedAt,
      dispatchedAt: r.dispatchedAt, deliveredAt: r.deliveredAt, pickedUnits: r.pickedUnits,
      supplierNet: toDec(r.supplierNet), platformFee: toDec(r.platformFee), organizerFee: toDec(r.organizerFee), endedAt: r.endedAt,
      allocationPending: r.allocationPending, refundsPushed: r.refundsPushed, lastEventLedger: r.lastEventLedger,
    };
    const offerId = existing?.offerId;
    if (existing) {
      const price = await this.currentPrice(offerId!, r);
      await this.db.pool.update({ where: { id: r.id }, data: { ...data, currentUnitPrice: price } });
      return;
    }
    // First sighting: link the off-chain hub details recorded when the pool was prepared.
    const pending = await this.db.pendingPool.findUnique({ where: { hubHash: r.hubHash } });
    const price = pending ? await this.currentPrice(pending.offerId, r) : '0';
    const offer = pending ? await this.db.offer.findUnique({ where: { id: pending.offerId }, select: { category: true, deliveryAreas: true } }) : undefined;
    const areas = Array.isArray(offer?.deliveryAreas) ? offer.deliveryAreas as { state?: string; lga?: string }[] : [];
    const area = areas[0];
    await this.db.pool.create({
      data: {
        id: r.id, offerId: pending?.offerId ?? 'unknown', organizerAddress: r.organizer, supplierAddress: r.supplier,
        hubAddress: pending?.hubAddress ?? '', hubContact: pending?.hubContact ?? '', hubHash: r.hubHash,
        pickupWindow: (pending?.pickupWindow ?? {}) as Prisma.InputJsonValue, offerHash: r.offerHash,
        fillDeadline: pending?.fillDeadline ?? new Date(0), shareSlug: pending?.shareSlug ?? `p${r.id}`,
        category: offer?.category ?? null, deliveryState: area?.state ?? null, deliveryLga: area?.lga ?? null,
        cluster: pending?.cluster ?? null,
        currentUnitPrice: price, ...data,
      },
    });
  }

  /** Price per unit at the current fill level, from the offer's USDC tiers. */
  private async currentPrice(offerId: string, r: PoolRow): Promise<string> {
    if (r.finalUnitPrice > 0n) return toDec(r.finalUnitPrice);
    const offer = await this.db.offer.findUnique({ where: { id: offerId } });
    if (!offer) return '0';
    const tiers = tiersFromJson(offer.tiersUsdc);
    // An offer without USDC tiers (never published) must not crash the indexer: one odd pool cannot stall everyone else's.
    return tiers.length ? toDec(ceilingPrice(tiers, r.totalUnits)) : '0';
  }

  async commitment(poolId: bigint, member: string): Promise<CommitmentRow | undefined> {
    const c = await this.db.commitment.findUnique({ where: { poolId_memberAddress: { poolId, memberAddress: member } } });
    if (!c) return undefined;
    return {
      poolId, member, units: c.units, paid: fromDec(c.paid), pickedUp: c.pickedUp, refundClaimed: fromDec(c.refundClaimed),
    };
  }

  async saveCommitment(r: CommitmentRow): Promise<void> {
    const data = { units: r.units, paid: toDec(r.paid), pickedUp: r.pickedUp, refundClaimed: toDec(r.refundClaimed) };
    await this.db.commitment.upsert({
      where: { poolId_memberAddress: { poolId: r.poolId, memberAddress: r.member } },
      create: { poolId: r.poolId, memberAddress: r.member, ...data },
      update: data,
    });
  }

  async dispute(id: bigint): Promise<DisputeRow | undefined> {
    const d = await this.db.dispute.findUnique({ where: { id } });
    if (!d) return undefined;
    const o = (d.outcome ?? {}) as { reasoningHash?: string };
    return {
      id, poolId: d.poolId, opener: d.openerAddress, claimedAmount: fromDec(d.claimedAmount), openedAt: d.openedAt,
      state: d.state as DisputeRow['state'], evidenceCount: d.evidenceCount, closedAt: d.closedAt,
      arbiter: d.arbiterAddress ?? undefined, reasoningHash: o.reasoningHash,
    };
  }

  async saveDispute(r: DisputeRow): Promise<void> {
    const sla = 5 * 24 * 3600_000; // default arbitration SLA; the keeper reads the live parameter from config
    const data = {
      state: r.state, evidenceCount: r.evidenceCount, closedAt: r.closedAt,
      arbiterAddress: r.arbiter ?? null, outcome: r.reasoningHash ? { reasoningHash: r.reasoningHash } : Prisma.JsonNull,
    };
    await this.db.dispute.upsert({
      where: { id: r.id },
      create: {
        id: r.id, poolId: r.poolId, openerAddress: r.opener, reason: 'UNKNOWN', claimedUnits: 0,
        claimedAmount: toDec(r.claimedAmount), openedAt: r.openedAt, slaDueAt: new Date(r.openedAt.getTime() + sla),
        ...data,
      },
      update: data,
    });
  }

  async bond(supplier: string): Promise<BondRow | undefined> {
    const b = await this.db.bond.findUnique({ where: { supplierAddress: supplier } });
    return b ? {
      supplier, total: fromDec(b.total), reserved: fromDec(b.reserved),
      slashRequested: fromDec(b.slashRequested), slashActual: fromDec(b.slashActual), lastEventLedger: b.lastEventLedger,
    } : undefined;
  }

  async saveBond(r: BondRow): Promise<void> {
    const data = {
      total: toDec(r.total), reserved: toDec(r.reserved),
      slashRequested: toDec(r.slashRequested), slashActual: toDec(r.slashActual), lastEventLedger: r.lastEventLedger,
    };
    await this.db.bond.upsert({
      where: { supplierAddress: r.supplier },
      create: { supplierAddress: r.supplier, ...data },
      update: data,
    });
  }

  async reputationTier(subject: string, role: string): Promise<ReputationTierRow | undefined> {
    const r = await this.db.reputationTier.findUnique({ where: { subject_role: { subject, role } } });
    return r ? { subject: r.subject, role: r.role, tier: r.tier } : undefined;
  }

  async saveReputationTier(r: ReputationTierRow): Promise<void> {
    await this.db.reputationTier.upsert({
      where: { subject_role: { subject: r.subject, role: r.role } },
      create: { subject: r.subject, role: r.role, tier: r.tier },
      update: { tier: r.tier },
    });
  }

  async saveActivity(r: ActivityEventRow): Promise<void> {
    await this.db.poolActivity.create({
      data: {
        poolId: r.poolId, type: r.type, actor: r.actor ?? null, units: r.units ?? null, tier: r.tier ?? null,
        ledger: r.ledger, occurredAt: r.occurredAt, aggregate: r.aggregate,
      },
    });
  }
}
