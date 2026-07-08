import { rpcPort } from './runners.js';

describe('rpcPort', () => {
  it('asks the RPC for endLedger + 1 because the RPC treats endLedger as exclusive', async () => {
    const seen: Record<string, unknown>[] = [];
    const server = {
      getLatestLedger: async () => ({ sequence: 100 }),
      getHealth: async () => ({ oldestLedger: 1 }),
      getEvents: async (req: Record<string, unknown>) => {
        seen.push(req);
        return { events: [], cursor: '' };
      },
    } as never;
    await rpcPort(server).getEvents(10, 20, ['C1']);
    expect(seen[0]).toMatchObject({ startLedger: 10, endLedger: 21 });
  });

  it('splits more than five contracts into separate filters (an RPC limit)', async () => {
    const seen: { filters: { contractIds: string[] }[] }[] = [];
    const server = {
      getLatestLedger: async () => ({ sequence: 1 }),
      getHealth: async () => ({ oldestLedger: 1 }),
      getEvents: async (req: { filters: { contractIds: string[] }[] }) => {
        seen.push(req);
        return { events: [], cursor: '' };
      },
    } as never;
    await rpcPort(server).getEvents(1, 2, ['A', 'B', 'C', 'D', 'E', 'F']);
    expect(seen[0]!.filters.map((f) => f.contractIds.length)).toEqual([5, 1]);
  });
});
