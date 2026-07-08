import { Account, BASE_FEE, Contract, Keypair, Operation, rpc, SorobanDataBuilder, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { CONTRACT_NAMES, type ContractName, type Deployments } from './deployments.js';

/** ~5s ledgers. Extend when less than 20 days remain; extend by 60 days. */
export const EXTEND_BELOW_LEDGERS = 345_600;
export const EXTEND_TO_LEDGERS = 1_036_800;

export interface TtlKey {
  contract: ContractName;
  kind: 'instance' | 'code';
  key: xdr.LedgerKey;
}

/** Instance and code ledger keys of every contract. The code key comes from the deployment's wasm hash. */
export function instanceAndCodeKeys(d: Deployments): TtlKey[] {
  return CONTRACT_NAMES.flatMap((name) => [
    { contract: name, kind: 'instance' as const, key: new Contract(d.contracts[name].id).getFootprint() },
    { contract: name, kind: 'code' as const, key: xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(d.contracts[name].wasmHash, 'hex') })) },
  ]);
}

export interface TtlStatus {
  contract: ContractName;
  kind: 'instance' | 'code';
  remaining: number | null; // null = entry not found (archived or wrong hash): page someone
}

export async function ttlStatus(server: Pick<rpc.Server, 'getLedgerEntries' | 'getLatestLedger'>, keys: TtlKey[]): Promise<TtlStatus[]> {
  const latest = (await server.getLatestLedger()).sequence;
  const res = await server.getLedgerEntries(...keys.map((k) => k.key));
  return keys.map((k) => {
    const hit = res.entries.find((e) => e.key.toXDR('base64') === k.key.toXDR('base64'));
    return { contract: k.contract, kind: k.kind, remaining: hit?.liveUntilLedgerSeq !== undefined ? hit.liveUntilLedgerSeq - latest : null };
  });
}

/** Which keys need extending now. Missing entries are reported, never silently skipped. */
export function needsExtension(status: TtlStatus[], below = EXTEND_BELOW_LEDGERS): { extend: TtlStatus[]; missing: TtlStatus[] } {
  return { extend: status.filter((s) => s.remaining !== null && s.remaining < below), missing: status.filter((s) => s.remaining === null) };
}

/** One ExtendFootprintTtl transaction for all given keys, paid by the sponsor. */
export async function extendTtl(
  server: rpc.Server, sponsor: Keypair, passphrase: string, keys: xdr.LedgerKey[], extendTo = EXTEND_TO_LEDGERS,
): Promise<string> {
  const acct = await server.getAccount(sponsor.publicKey());
  const tx = new TransactionBuilder(new Account(acct.accountId(), acct.sequenceNumber()), { fee: BASE_FEE, networkPassphrase: passphrase })
    .setSorobanData(new SorobanDataBuilder().setReadOnly(keys).build())
    .addOperation(Operation.extendFootprintTtl({ extendTo }))
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`ttl simulation failed: ${sim.error}`);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(sponsor);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error('ttl extend submit failed');
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`ttl extend ${sent.hash} ${done.status}`);
  return sent.hash;
}
