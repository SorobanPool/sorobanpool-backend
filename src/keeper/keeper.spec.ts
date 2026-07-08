import { dueActions, runKeeper, type KeeperAction, type KeeperParams, type KeeperPool } from './jobs.js';

const P: KeeperParams = {
  acceptWindowSecs: 86_400, deliveryGraceSecs: 172_800, confirmWindowSecs: 172_800,
  perishableConfirmWindowSecs: 259_200, earlyReleaseWeightBp: 6000, arbitrationSlaSecs: 432_000,
};
const base: KeeperPool = {
  id: 1n, state: 'Open', perishable: false, totalUnits: 100, pickedUnits: 0, leadTimeSecs: 432_000,
  fillDeadline: 1000, filledAt: 1000, acceptedAt: 2000, deliveredAt: 5000, allocationPending: false, hasUnclaimedRefunds: false,
};
const due = (over: Partial<KeeperPool>, now: number) => dueActions([{ ...base, ...over }], [], P, now).map((a) => a.fn);

describe('dueActions', () => {
  it('closes open pools at the deadline, not before', () => {
    expect(due({ state: 'Open' }, 999)).toEqual([]);
    expect(due({ state: 'Open' }, 1000)).toEqual(['close']);
  });
  it('fails acceptance strictly after the window', () => {
    expect(due({ state: 'Filled' }, 1000 + 86_400)).toEqual([]);
    expect(due({ state: 'Filled' }, 1000 + 86_401)).toEqual(['fail_accept']);
  });
  it('fails delivery after lead time plus grace', () => {
    const t = 2000 + 432_000 + 172_800;
    expect(due({ state: 'Dispatched' }, t)).toEqual([]);
    expect(due({ state: 'Dispatched' }, t + 1)).toEqual(['fail_delivery']);
    expect(due({ state: 'Accepted' }, t + 1)).toEqual(['fail_delivery']);
  });
  it('allocates shortfall first, then settles after the window (longer for perishables)', () => {
    expect(due({ state: 'Delivered', allocationPending: true }, 999_999)).toEqual(['allocate_shortfall']);
    expect(due({ state: 'Delivered' }, 5000 + 172_799)).toEqual([]);
    expect(due({ state: 'Delivered' }, 5000 + 172_800)).toEqual(['settle']);
    expect(due({ state: 'Delivered', perishable: true }, 5000 + 172_800)).toEqual([]);
    expect(due({ state: 'Delivered', perishable: true }, 5000 + 259_200)).toEqual(['settle']);
  });
  it('settles early when enough members confirmed pickup', () => {
    expect(due({ state: 'Delivered', pickedUnits: 59 }, 5001)).toEqual([]);
    expect(due({ state: 'Delivered', pickedUnits: 60 }, 5001)).toEqual(['settle']);
  });
  it('pushes refunds for final pools that still owe money', () => {
    for (const state of ['Settled', 'Expired', 'Failed', 'Cancelled'] as const) {
      expect(due({ state, hasUnclaimedRefunds: true }, 1)).toEqual(['push_refunds']);
      expect(due({ state, hasUnclaimedRefunds: false }, 1)).toEqual([]);
    }
  });
  it('times out disputes past the SLA', () => {
    const d = [{ id: 7n, open: true, openedAt: 100 }, { id: 8n, open: false, openedAt: 100 }];
    expect(dueActions([], d, P, 100 + 432_000).map((a) => a.fn)).toEqual([]);
    expect(dueActions([], d, P, 100 + 432_001)).toEqual([{ job: 'dispute-timeout', fn: 'timeout', args: [7n] }]);
  });
});

describe('runKeeper', () => {
  it('keeps going when one action fails and counts outcomes', async () => {
    const actions: KeeperAction[] = [
      { job: 'close-pools', fn: 'close', args: [1n] },
      { job: 'settle', fn: 'settle', args: [2n] },
      { job: 'fail-accept', fn: 'fail_accept', args: [3n] },
    ];
    const errors: bigint[] = [];
    const r = await runKeeper(
      { invoke: async (a) => { if (a.args[0] === 2n) throw new Error('rpc down'); return a.args[0] === 1n; } },
      actions,
      (a) => errors.push(a.args[0]),
    );
    expect(r).toEqual({ ok: 1, refused: 1, errored: 1 });
    expect(errors).toEqual([2n]);
  });
});
