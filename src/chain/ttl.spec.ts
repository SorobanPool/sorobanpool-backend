import { StrKey } from '@stellar/stellar-sdk';
import { CONTRACT_NAMES, type Deployments } from './deployments.js';
import { EXTEND_BELOW_LEDGERS, instanceAndCodeKeys, needsExtension, ttlStatus } from './ttl.js';

const d: Deployments = {
  network: 't', usdc: 'x', admin: 'x',
  contracts: Object.fromEntries(
    CONTRACT_NAMES.map((n, i) => [n, { id: StrKey.encodeContract(Buffer.alloc(32, i + 1)), wasmHash: Buffer.alloc(32, i + 101).toString('hex') }]),
  ) as Deployments['contracts'],
};

describe('instanceAndCodeKeys', () => {
  it('has one instance key and one code key per contract, distinct from each other', () => {
    const keys = instanceAndCodeKeys(d);
    expect(keys).toHaveLength(CONTRACT_NAMES.length * 2);
    expect(keys.filter((k) => k.kind === 'instance')).toHaveLength(CONTRACT_NAMES.length);
    expect(new Set(keys.map((k) => k.key.toXDR('base64'))).size).toBe(keys.length);
  });
});

describe('needsExtension', () => {
  it('extends only entries under the threshold and reports missing ones', () => {
    const status = [
      { contract: 'config' as const, kind: 'instance' as const, remaining: EXTEND_BELOW_LEDGERS - 1 },
      { contract: 'config' as const, kind: 'code' as const, remaining: EXTEND_BELOW_LEDGERS },
      { contract: 'registry' as const, kind: 'code' as const, remaining: null },
    ];
    const r = needsExtension(status);
    expect(r.extend.map((s) => `${s.contract}.${s.kind}`)).toEqual(['config.instance']);
    expect(r.missing.map((s) => `${s.contract}.${s.kind}`)).toEqual(['registry.code']);
  });

  it('reads remaining life from liveUntilLedgerSeq and treats unreturned entries as missing, not healthy', async () => {
    const keys = instanceAndCodeKeys(d);
    const server = {
      getLatestLedger: async () => ({ sequence: 1000 }),
      getLedgerEntries: async () => ({ entries: [{ key: keys[0]!.key, liveUntilLedgerSeq: 1500 }], latestLedger: 1000 }),
    } as never;
    const st = await ttlStatus(server, keys.slice(0, 2));
    expect(st[0]!.remaining).toBe(500);
    expect(st[1]!.remaining).toBeNull();
  });
});
