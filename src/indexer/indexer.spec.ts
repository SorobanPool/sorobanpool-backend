import { readFileSync } from 'node:fs';
import { nativeToScVal, xdr, Address, Keypair } from '@stellar/stellar-sdk';
import { decodeEvent, type RawEvent } from './decode.js';
import { HANDLERS, IGNORED_EVENTS, Projector } from './projector.js';
import { MemoryReadStore } from './read-model.js';
import { Indexer, type CursorStore, type EventSink, type RpcPort } from './indexer.service.js';

const events: { contract: string; event: string }[] = JSON.parse(
  readFileSync(new URL('../chain/artifacts/events.json', import.meta.url), 'utf8'),
);

const addr = () => Keypair.random().publicKey();
const sym = (s: string) => xdr.ScVal.scvSymbol(s).toXDR('base64');
const bytes32 = (b: number) => Buffer.alloc(32, b);
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const a = (s: string) => new Address(s).toScVal();
const tup = (...v: xdr.ScVal[]) => xdr.ScVal.scvVec(v);

let n = 0;
function raw(contract: string, event: string, key: xdr.ScVal, data: xdr.ScVal, ledger = 100): RawEvent {
  return {
    id: `ev-${++n}`, ledger, ledgerClosedAt: new Date(1_760_000_000_000 + ledger * 5000).toISOString(), contractId: 'C' + contract,
    topic: [sym(contract), sym(event), key.toXDR('base64')], value: data.toXDR('base64'),
  };
}

describe('every documented event is handled', () => {
  it('has a projector handler or an explicit ignore for each event in events.json', () => {
    const missing = events
      .map((e) => `${e.contract}.${e.event}`)
      .filter((name) => !HANDLERS[name] && !IGNORED_EVENTS.has(name));
    expect(missing).toEqual([]);
  });
  it('has no handler for an event the contracts do not emit', () => {
    const known = new Set(events.map((e) => `${e.contract}.${e.event}`));
    // group_buy emits "committed" and "commit_up" through one documented row; both must be known.
    const stale = Object.keys(HANDLERS).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });
});

describe('Projector', () => {
  const supplier = addr();
  const organizer = addr();
  const m1 = addr();
  const m2 = addr();

  async function fullLifecycle() {
    const store = new MemoryReadStore();
    const p = new Projector(store);
    const apply = async (r: RawEvent) => p.apply(decodeEvent(r)!);
    const id = u64(1n);
    await apply(raw('group_buy', 'pool_new', id, tup(a(organizer), a(supplier), nativeToScVal(bytes32(7)), nativeToScVal(bytes32(3)))));
    await apply(raw('group_buy', 'committed', id, tup(a(m1), u32(60), i128(600n))));
    await apply(raw('group_buy', 'committed', id, tup(a(m2), u32(60), i128(600n))));
    await apply(raw('group_buy', 'tier_up', id, tup(u32(1), u32(120))));
    await apply(raw('group_buy', 'commit_up', id, tup(a(m1), u32(10), i128(100n))));
    await apply(raw('group_buy', 'filled', id, tup(u32(130), i128(8n))));
    return { store, apply, id };
  }

  it('projects commitments and pool state through to settlement', async () => {
    const { store, apply, id } = await fullLifecycle();
    expect(store.pools.get(1n)).toMatchObject({
      state: 'Filled', totalUnits: 130, finalUnitPrice: 8n, currentTierIdx: 1, escrowBalance: 1300n,
      hubHash: '03'.repeat(32), offerHash: '07'.repeat(32),
    });
    expect(store.pools.get(1n)!.filledAt).toBeInstanceOf(Date);
    expect(store.commitments.get(`1:${m1}`)).toMatchObject({ units: 70, paid: 700n });
    await apply(raw('group_buy', 'accepted', id, a(supplier)));
    await apply(raw('group_buy', 'dispatch', id, xdr.ScVal.scvVoid()));
    await apply(raw('group_buy', 'delivered', id, tup(u32(120), nativeToScVal(bytes32(5)))));
    expect(store.pools.get(1n)).toMatchObject({ state: 'Delivered', receivedUnits: 120, allocationPending: true });
    await apply(raw('group_buy', 'alloc_ok', id, u32(120)));
    expect(store.pools.get(1n)!.allocationPending).toBe(false);
    await apply(raw('group_buy', 'pickup', id, a(m1)));
    expect(store.pools.get(1n)!.pickedUnits).toBe(70);
    await apply(raw('group_buy', 'settled', id, tup(i128(900n), i128(15n), i128(9n))));
    await apply(raw('group_buy', 'refund', id, tup(a(m1), i128(100n))));
    expect(store.pools.get(1n)).toMatchObject({ state: 'Settled', escrowBalance: 1300n - 924n - 100n });
    expect(store.commitments.get(`1:${m1}`)).toMatchObject({ pickedUp: true, refundClaimed: 100n });
  });

  it('is idempotent: replaying an event changes nothing', async () => {
    const { store, apply, id } = await fullLifecycle();
    const dup = raw('group_buy', 'committed', id, tup(a(m2), u32(5), i128(50n)));
    expect(await apply(dup)).toBe(true);
    expect(await apply(dup)).toBe(false);
    expect(store.commitments.get(`1:${m2}`)!.units).toBe(65);
  });

  it('tracks withdrawals, disputes and bonds', async () => {
    const { store, apply, id } = await fullLifecycle();
    await apply(raw('group_buy', 'withdrawn', id, tup(a(m2), i128(600n))));
    expect(store.pools.get(1n)!.totalUnits).toBe(70);
    await apply(raw('disputes', 'd_open', u64(9n), tup(u64(1n), a(m1), i128(80n))));
    expect(store.pools.get(1n)!.frozenAmount).toBe(80n);
    await apply(raw('disputes', 'd_resolve', u64(9n), tup(a(addr()), nativeToScVal(bytes32(4)))));
    expect(store.disputes.get(9n)!.state).toBe('RESOLVED');
    expect(store.pools.get(1n)!.frozenAmount).toBe(0n);
    await apply(raw('bond', 'deposit', a(supplier), i128(500n)));
    await apply(raw('bond', 'slashed', a(supplier), i128(120n)));
    expect(store.bonds.get(supplier)!.total).toBe(380n);
  });

  it('ignores config/registry events without error and rejects unknown ones', async () => {
    const store = new MemoryReadStore();
    const p = new Projector(store);
    expect(await p.apply(decodeEvent(raw('registry', 'user_reg', a(m1), xdr.ScVal.scvVoid()))!)).toBe(false);
    await expect(p.apply(decodeEvent(raw('group_buy', 'brand_new_event', u64(1n), xdr.ScVal.scvVoid()))!)).rejects.toThrow(/no projector handler/);
  });

  it('refuses events for pools it has never seen', async () => {
    const p = new Projector(new MemoryReadStore());
    await expect(p.apply(decodeEvent(raw('group_buy', 'accepted', u64(77n), a(supplier)))!)).rejects.toThrow(/unknown pool/);
  });
});

describe('Indexer', () => {
  function harness(opts: { latest: number; oldest?: number; events?: RawEvent[]; cursor?: number }) {
    let cursor = opts.cursor;
    const saved: RawEvent[] = [];
    const rpc: RpcPort = {
      latestLedger: async () => opts.latest,
      oldestLedger: async () => opts.oldest ?? 1,
      getEvents: async (from, to) => (opts.events ?? []).filter((e) => e.ledger >= from && e.ledger <= to),
    };
    const cur: CursorStore = { get: async () => cursor, set: async (l) => void (cursor = l) };
    const sink: EventSink = { saveRaw: async (r) => void saved.push(r) };
    const store = new MemoryReadStore();
    const idx = new Indexer(rpc, cur, sink, new Projector(store), ['Cx'], 1, 50);
    return { idx, saved, store, cursor: () => cursor };
  }

  it('stores raw events, projects them, advances the cursor in batches and reports lag', async () => {
    const ev = raw('group_buy', 'pool_new', u64(1n), tup(a(organizer()), a(addr()), nativeToScVal(bytes32(1)), nativeToScVal(bytes32(2))), 40);
    const h = harness({ latest: 70, events: [ev] });
    expect(await h.idx.tick()).toEqual({ processed: 1 }); // ledgers 1..50
    expect(h.saved).toHaveLength(1);
    expect(h.cursor()).toBe(50);
    expect(h.idx.metrics.lag).toBe(20);
    expect(h.idx.shouldAlert).toBe(false); // exactly 20 is still within tolerance
    expect(h.store.pools.has(1n)).toBe(true);
    expect((await h.idx.tick()).processed).toBe(0); // ledgers 51..70, nothing new
    expect(h.cursor()).toBe(70);
    expect(h.idx.metrics.lag).toBe(0);
  });

  it('alerts when lag exceeds 20 ledgers and errors when behind the retention window', async () => {
    const lagging = harness({ latest: 500, cursor: 100 });
    await lagging.idx.tick(); // batch of 50 only
    expect(lagging.idx.metrics.lag).toBe(350);
    expect(lagging.idx.shouldAlert).toBe(true);
    const behind = harness({ latest: 500, cursor: 100, oldest: 300 });
    await expect(behind.idx.tick()).rejects.toThrow(/retention/);
    expect(behind.idx.shouldAlert).toBe(true);
  });

  function organizer() { return addr(); }
});
