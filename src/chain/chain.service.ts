import {
  Account, Asset, authorizeEntry, BASE_FEE, Contract, Keypair, Operation, rpc, scValToNative, Transaction,
  TransactionBuilder, xdr,
} from '@stellar/stellar-sdk';
import { type ContractName, contractId, type Deployments } from './deployments.js';
import { credentialAddress, inspectUserTx } from './inspect.js';
import { extendTtl, instanceAndCodeKeys, needsExtension, ttlStatus } from './ttl.js';

export const MAX_FEE_STROOPS = 50_000_000; // 5 XLM: a hard ceiling per sponsored transaction
const AUTH_VALID_LEDGERS = 60; // ~5 minutes

export interface PreparedTx {
  txXdr: string;
  /** Unsigned authorization entries (base64 XDR) the user must sign with their wallet. */
  authEntries: string[];
  validUntilLedger: number;
}

export interface TxResult {
  hash: string;
  returnValue: unknown;
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface ChainOptions {
  rpcUrl: string;
  horizonUrl?: string;
  passphrase: string;
  sponsor: Keypair;
  deployments: Deployments;
}

/**
 * Builds, authorises and submits Soroban transactions. The sponsor account is the transaction source and
 * pays all fees, so users never hold XLM; users only sign Soroban authorisation entries.
 * Sequence numbers are serialised through one mutex; scale-out needs several sponsor channel accounts.
 */
export class ChainService {
  readonly server: rpc.Server;
  private readonly lock = new Mutex();

  constructor(private readonly o: ChainOptions) {
    this.server = new rpc.Server(o.rpcUrl, { allowHttp: o.rpcUrl.startsWith('http://') });
  }

  get sponsorAddress(): string {
    return this.o.sponsor.publicKey();
  }
  id(name: ContractName): string {
    return contractId(this.o.deployments, name);
  }
  /** Native (XLM) balance of the sponsor in stroops, read from Horizon; the sponsor pays every user's fee. */
  async sponsorBalance(): Promise<bigint> {
    if (!this.o.horizonUrl) throw new Error('horizonUrl not configured');
    const res = await fetch(`${this.o.horizonUrl.replace(/\/$/, '')}/accounts/${this.sponsorAddress}`);
    if (!res.ok) throw new Error(`horizon ${res.status}`);
    const body = (await res.json()) as { balances: { asset_type: string; balance: string }[] };
    const native = body.balances.find((b) => b.asset_type === 'native')?.balance ?? '0';
    const [whole, frac = ''] = native.split('.');
    return BigInt(whole!) * 10_000_000n + BigInt(frac.padEnd(7, '0').slice(0, 7));
  }
  async latestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  private async build(contract: string, fn: string, args: xdr.ScVal[], auth?: xdr.SorobanAuthorizationEntry[]): Promise<Transaction> {
    const acct = await this.server.getAccount(this.sponsorAddress);
    const tmp = new TransactionBuilder(new Account(acct.accountId(), acct.sequenceNumber()), {
      fee: BASE_FEE, networkPassphrase: this.o.passphrase,
    }).addOperation(new Contract(contract).call(fn, ...args)).setTimeout(120).build();
    let tx = tmp;
    if (auth) {
      const hostFn = (tmp.operations[0] as Operation.InvokeHostFunction).func;
      tx = TransactionBuilder.cloneFrom(tmp, { fee: BASE_FEE, networkPassphrase: this.o.passphrase })
        .clearOperations()
        .addOperation(Operation.invokeHostFunction({ func: hostFn, auth }))
        .build();
    }
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed for ${fn}: ${sim.error}`);
    return rpc.assembleTransaction(tx, sim).build();
  }

  /** Read-only call (simulated, never submitted). */
  async view<T = unknown>(name: ContractName, fn: string, args: xdr.ScVal[] = []): Promise<T> {
    return this.viewAt<T>(this.id(name), fn, args);
  }

  /** Read-only call against any contract id (e.g. the USDC token). */
  async viewAt<T = unknown>(contract: string, fn: string, args: xdr.ScVal[] = []): Promise<T> {
    const acct = await this.server.getAccount(this.sponsorAddress);
    const tx = new TransactionBuilder(new Account(acct.accountId(), acct.sequenceNumber()), {
      fee: BASE_FEE, networkPassphrase: this.o.passphrase,
    }).addOperation(new Contract(contract).call(fn, ...args)).setTimeout(60).build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`view ${fn} failed: ${sim.error}`);
    const ret = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    return (ret === undefined ? undefined : scValToNative(ret)) as T;
  }

  /** Step 1 for a user action: returns the transaction and the authorisation entries to sign. */
  async prepareUser(name: ContractName, fn: string, args: xdr.ScVal[]): Promise<PreparedTx> {
    const tx = await this.build(this.id(name), fn, args);
    const op = tx.operations[0] as Operation.InvokeHostFunction;
    return {
      txXdr: tx.toXDR(),
      authEntries: (op.auth ?? []).map((e) => e.toXDR('base64')),
      validUntilLedger: (await this.latestLedger()) + AUTH_VALID_LEDGERS,
    };
  }

  /** Step 2: validates the user's signed entries, re-simulates, signs as sponsor and submits. */
  async submitUser(txXdr: string, signedAuth: string[], userWallet: string): Promise<TxResult> {
    const base = inspectUserTx(txXdr, { sponsor: this.sponsorAddress, passphrase: this.o.passphrase, userWallet, maxFeeStroops: MAX_FEE_STROOPS });
    const entries = signedAuth.map((e) => xdr.SorobanAuthorizationEntry.fromXDR(e, 'base64'));
    const op = base.tx.operations[0] as Operation.InvokeHostFunction;
    if (op.func.type !== 'hostFunctionTypeInvokeContract') throw new Error('unexpected host function');
    const scArgs = op.func.invokeContract.args;
    // The sponsor's sequence number is read when a transaction is built, so build+send must be one critical
    // section: otherwise two concurrent submissions read the same sequence and one fails with txBAD_SEQ.
    return this.lock.run(async () => {
      const rebuilt = await this.build(base.contractId, base.fn, scArgs, entries);
      inspectUserTx(rebuilt.toXDR(), { sponsor: this.sponsorAddress, passphrase: this.o.passphrase, userWallet, maxFeeStroops: MAX_FEE_STROOPS });
      return this.sendNow(rebuilt);
    });
  }

  /** Server-initiated call (keeper, attestor). `signers` authorise any `require_auth` addresses. */
  async invokeServer(name: ContractName, fn: string, args: xdr.ScVal[], signers: Keypair[] = []): Promise<TxResult> {
    return this.lock.run(async () => {
      let tx = await this.build(this.id(name), fn, args);
      if (signers.length) {
        const op = tx.operations[0] as Operation.InvokeHostFunction;
        const validUntil = (await this.latestLedger()) + AUTH_VALID_LEDGERS;
        const signed: xdr.SorobanAuthorizationEntry[] = [];
        for (const e of op.auth ?? []) {
          const who = credentialAddress(e.credentials);
          if (who !== null) {
            const kp = signers.find((k) => k.publicKey() === who);
            if (!kp) throw new Error(`no signer available for ${who}`);
            signed.push(await authorizeEntry(e, kp, validUntil, this.o.passphrase));
          } else signed.push(e);
        }
        tx = await this.build(this.id(name), fn, args, signed);
      }
      return this.sendNow(tx);
    });
  }

  /**
   * Testnet/dev only: pays test USDC (issued by the admin account) to a wallet that already trusts the asset. It spends the
   * same account as the fee sponsor, so it runs inside the same lock: two transactions must never share a sequence number.
   */
  async payUsdc(destination: string, stroops: bigint): Promise<void> {
    if (stroops <= 0n) throw new Error('payout must be positive');
    const asset = new Asset('USDC', this.o.deployments.admin);
    const amount = `${stroops / 10_000_000n}.${(stroops % 10_000_000n).toString().padStart(7, '0')}`;
    await this.lock.run(async () => {
      const acct = await this.server.getAccount(this.sponsorAddress);
      const tx = new TransactionBuilder(new Account(acct.accountId(), acct.sequenceNumber()), { fee: '10000', networkPassphrase: this.o.passphrase })
        .addOperation(Operation.payment({ destination, asset, amount })).setTimeout(120).build();
      tx.sign(this.o.sponsor);
      const sent = await this.server.sendTransaction(tx);
      if (sent.status === 'ERROR') throw new Error('payout submit failed');
      const done = await this.server.pollTransaction(sent.hash, { attempts: 30 });
      if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`payout ${sent.hash} ${done.status}`);
    });
  }

  /**
   * Keeps every contract's instance and code alive (ADR 0005). Extends only entries with under ~20 days left,
   * and reports entries the RPC cannot find: those are archived or misconfigured and need a human.
   */
  async keepAlive(): Promise<{ extended: string[]; missing: string[]; txHash?: string }> {
    const keys = instanceAndCodeKeys(this.o.deployments);
    const { extend, missing } = needsExtension(await ttlStatus(this.server, keys));
    const label = (s: { contract: string; kind: string }) => `${s.contract}.${s.kind}`;
    if (!extend.length) return { extended: [], missing: missing.map(label) };
    const wanted = new Set(extend.map(label));
    const txHash = await this.lock.run(() =>
      extendTtl(this.server, this.o.sponsor, this.o.passphrase, keys.filter((k) => wanted.has(label(k))).map((k) => k.key)),
    );
    return { extended: [...wanted], missing: missing.map(label), txHash };
  }

  /** Signs, submits and waits. Callers hold the lock (see submitUser). */
  private async sendNow(tx: Transaction): Promise<TxResult> {
    tx.sign(this.o.sponsor);
    const sent = await this.server.sendTransaction(tx);
    if (sent.status === 'ERROR') throw new Error(`submit failed: ${sent.errorResult?.toXDR('base64') ?? 'unknown'}`);
    const done = await this.server.pollTransaction(sent.hash, { attempts: 30 });
    if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`transaction ${sent.hash} ${done.status}`);
    return { hash: sent.hash, returnValue: done.returnValue ? scValToNative(done.returnValue) : undefined };
  }
}

/** Client-side helper (used by tests and the reference E2E script): signs the user's auth entries. */
export async function signAuthEntries(
  entries: string[], signer: Keypair, validUntilLedger: number, passphrase: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const e of entries) {
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(e, 'base64');
    if (credentialAddress(entry.credentials) === signer.publicKey()) {
      out.push((await authorizeEntry(entry, signer, validUntilLedger, passphrase)).toXDR('base64'));
    } else out.push(e);
  }
  return out;
}
