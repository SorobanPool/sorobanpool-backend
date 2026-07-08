import type { DecodedEvent } from './decode.js';
import type { PoolRow, PoolState, ReadStore } from './read-model.js';

type Handler = (ev: DecodedEvent, s: ReadStore) => Promise<void>;

const asBig = (v: unknown): bigint => BigInt(v as bigint | number | string);
const asNum = (v: unknown): number => Number(v);
const tuple = (v: unknown): unknown[] => v as unknown[];

async function mustPool(s: ReadStore, key: unknown): Promise<PoolRow> {
  const p = await s.pool(asBig(key));
  if (!p) throw new Error(`event for unknown pool ${String(key)}`);
  return p;
}

const setState = (state: PoolState, patch?: (p: PoolRow, ev: DecodedEvent) => Partial<PoolRow>): Handler => async (ev, s) => {
  const p = await mustPool(s, ev.key);
  await s.savePool({ ...p, state, ...patch?.(p, ev) });
};

export const HANDLERS: Record<string, Handler> = {
  'group_buy.pool_new': async (ev, s) => {
    const [organizer, supplier, offerHash, hubHash] = tuple(ev.data);
    const hex = (b: unknown) => Buffer.from(b as Uint8Array).toString('hex');
    await s.savePool({
      id: asBig(ev.key), organizer: String(organizer), supplier: String(supplier),
      offerHash: hex(offerHash), hubHash: hex(hubHash), state: 'Open', totalUnits: 0,
      receivedUnits: null, currentTierIdx: 0, finalUnitPrice: 0n, escrowBalance: 0n, frozenAmount: 0n,
      advancePaid: 0n, filledAt: null, acceptedAt: null, dispatchedAt: null, deliveredAt: null,
      pickedUnits: 0, allocationPending: false, refundsPushed: false, lastEventLedger: ev.ledger,
    });
  },
  'group_buy.committed': commit,
  'group_buy.commit_up': commit,
  'group_buy.withdrawn': async (ev, s) => {
    const [member, refund] = tuple(ev.data);
    const p = await mustPool(s, ev.key);
    const c = await s.commitment(p.id, String(member));
    if (!c) throw new Error('withdrawal for unknown commitment');
    await s.savePool({ ...p, totalUnits: p.totalUnits - c.units, escrowBalance: p.escrowBalance - asBig(refund) });
    await s.saveCommitment({ ...c, units: 0, paid: 0n });
  },
  'group_buy.tier_up': async (ev, s) => {
    const p = await mustPool(s, ev.key);
    await s.savePool({ ...p, currentTierIdx: asNum(tuple(ev.data)[0]) });
  },
  'group_buy.filled': async (ev, s) => {
    const [total, price] = tuple(ev.data);
    const p = await mustPool(s, ev.key);
    await s.savePool({ ...p, state: 'Filled', totalUnits: asNum(total), finalUnitPrice: asBig(price), filledAt: ev.closedAt });
  },
  'group_buy.expired': setState('Expired'),
  'group_buy.cancelled': setState('Cancelled'),
  'group_buy.accepted': setState('Accepted', (_, ev) => ({ acceptedAt: ev.closedAt })),
  'group_buy.rejected': setState('Failed'),
  'group_buy.failed': setState('Failed'),
  'group_buy.dispatch': setState('Dispatched', (_, ev) => ({ dispatchedAt: ev.closedAt })),
  'group_buy.advance': async (ev, s) => {
    const p = await mustPool(s, ev.key);
    const a = asBig(ev.data);
    await s.savePool({ ...p, advancePaid: a, escrowBalance: p.escrowBalance - a });
  },
  'group_buy.delivered': async (ev, s) => {
    const p = await mustPool(s, ev.key);
    const received = asNum(tuple(ev.data)[0]);
    await s.savePool({
      ...p, state: 'Delivered', receivedUnits: received, deliveredAt: ev.closedAt,
      allocationPending: received < p.totalUnits,
    });
  },
  'group_buy.shortfall': async () => {}, // implied by delivered.receivedUnits < totalUnits
  'group_buy.alloc_ok': async (ev, s) => {
    const p = await mustPool(s, ev.key);
    await s.savePool({ ...p, allocationPending: false });
  },
  'group_buy.pickup': async (ev, s) => {
    const p = await mustPool(s, ev.key);
    const c = await s.commitment(p.id, String(ev.data));
    if (c && !c.pickedUp) {
      await s.saveCommitment({ ...c, pickedUp: true });
      await s.savePool({ ...p, pickedUnits: p.pickedUnits + c.units });
    }
  },
  'group_buy.settled': async (ev, s) => {
    const [supplierNet, platform, organizer] = tuple(ev.data).map(asBig) as [bigint, bigint, bigint];
    const p = await mustPool(s, ev.key);
    await s.savePool({ ...p, state: 'Settled', escrowBalance: p.escrowBalance - supplierNet - platform - organizer });
  },
  'group_buy.refund': async (ev, s) => {
    const [member, amount] = tuple(ev.data);
    const p = await mustPool(s, ev.key);
    const c = await s.commitment(p.id, String(member));
    if (c) await s.saveCommitment({ ...c, refundClaimed: c.refundClaimed + asBig(amount) });
    await s.savePool({ ...p, escrowBalance: p.escrowBalance - asBig(amount) });
  },
  'disputes.d_open': async (ev, s) => {
    const [poolId, opener, amount] = tuple(ev.data);
    await s.saveDispute({ id: asBig(ev.key), poolId: asBig(poolId), opener: String(opener), claimedAmount: asBig(amount), openedAt: ev.closedAt, state: 'OPEN' });
    const p = await mustPool(s, poolId);
    await s.savePool({ ...p, frozenAmount: p.frozenAmount + asBig(amount) });
  },
  'disputes.d_resolve': async (ev, s) => {
    const [arbiter, hash] = tuple(ev.data);
    const d = await s.dispute(asBig(ev.key));
    if (!d) throw new Error('resolution for unknown dispute');
    await s.saveDispute({ ...d, state: 'RESOLVED', arbiter: String(arbiter), reasoningHash: Buffer.from(hash as Uint8Array).toString('hex') });
    await releaseFrozen(s, d.poolId, d.claimedAmount);
  },
  'disputes.d_timeout': async (ev, s) => {
    const d = await s.dispute(asBig(ev.key));
    if (!d) throw new Error('timeout for unknown dispute');
    await s.saveDispute({ ...d, state: 'TIMED_OUT' });
    await releaseFrozen(s, d.poolId, d.claimedAmount);
  },
  'supplier_bond.deposit': async (ev, s) => bondDelta(ev, s, asBig(ev.data)),
  'supplier_bond.withdraw': async (ev, s) => bondDelta(ev, s, -asBig(ev.data)),
  'supplier_bond.slashed': async (ev, s) => bondDelta(ev, s, -asBig(ev.data)),
};

/** Events that are recorded in ChainEvent but intentionally do not change a read model. */
export const IGNORED_EVENTS: ReadonlySet<string> = new Set([
  'config.params', 'config.paused', 'config.unpaused', 'config.upgraded',
  'registry.user_reg', 'registry.user_att', 'registry.user_rev', 'registry.user_sus', 'registry.user_uns',
  'reputation.rep_upd', 'disputes.d_evid',
]);

async function commit(ev: DecodedEvent, s: ReadStore): Promise<void> {
  const [member, units, amount] = tuple(ev.data);
  const p = await mustPool(s, ev.key);
  const m = String(member);
  const c = (await s.commitment(p.id, m)) ?? { poolId: p.id, member: m, units: 0, paid: 0n, refundClaimed: 0n, pickedUp: false };
  await s.saveCommitment({ ...c, units: c.units + asNum(units), paid: c.paid + asBig(amount) });
  await s.savePool({ ...p, totalUnits: p.totalUnits + asNum(units), escrowBalance: p.escrowBalance + asBig(amount) });
}

async function releaseFrozen(s: ReadStore, poolId: bigint, amount: bigint): Promise<void> {
  const p = await s.pool(poolId);
  if (p) await s.savePool({ ...p, frozenAmount: p.frozenAmount - amount });
}

async function bondDelta(ev: DecodedEvent, s: ReadStore, delta: bigint): Promise<void> {
  const supplier = String(ev.key);
  const b = (await s.bond(supplier)) ?? { supplier, total: 0n };
  await s.saveBond({ ...b, total: b.total + delta });
}

export class Projector {
  constructor(private readonly store: ReadStore) {}

  /** Applies one event idempotently and atomically: a failing handler leaves no trace (not even the processed mark). */
  async apply(ev: DecodedEvent): Promise<boolean> {
    const name = `${ev.contract}.${ev.event}`;
    const handler = HANDLERS[name];
    if (!handler) {
      if (IGNORED_EVENTS.has(name)) return false;
      throw new Error(`no projector handler for ${name}`);
    }
    return this.store.atomically(async (s) => {
      if (await s.markProcessed(ev.id, { ledger: ev.ledger, contract: ev.contract, topic: ev.event })) return false;
      await handler(ev, s);
      const p = ev.contract === 'group_buy' ? await s.pool(BigInt(ev.key as bigint)) : undefined;
      if (p) await s.savePool({ ...p, lastEventLedger: Math.max(p.lastEventLedger, ev.ledger) });
      return true;
    });
  }
}
