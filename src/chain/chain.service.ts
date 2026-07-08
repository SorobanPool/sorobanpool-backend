import {
  Account, authorizeEntry, BASE_FEE, Contract, Keypair, Operation, rpc, scValToNative, Transaction,
  TransactionBuilder, xdr,
} from '@stellar/stellar-sdk';
import { type ContractName, contractId, type Deployments } from './deployments.js';
import { credentialAddress, inspectUserTx } from './inspect.js';

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
    const acct = await this.server.getAccount(this.sponsorAddress);
    const tx = new TransactionBuilder(new Account(acct.accountId(), acct.sequenceNumber()), {
      fee: BASE_FEE, networkPassphrase: this.o.passphrase,
    }).addOperation(new Contract(this.id(name)).call(fn, ...args)).setTimeout(60).build();
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
    // Re-inspect with the signed entries attached, then rebuild so footprint and fees are fresh.
    const rebuilt = await this.build(base.contractId, base.fn, scArgs, entries);
    inspectUserTx(rebuilt.toXDR(), { sponsor: this.sponsorAddress, passphrase: this.o.passphrase, userWallet, maxFeeStroops: MAX_FEE_STROOPS });
    return this.send(rebuilt);
  }

  /** Server-initiated call (keeper, attestor). `signers` authorise any `require_auth` addresses. */
  async invokeServer(name: ContractName, fn: string, args: xdr.ScVal[], signers: Keypair[] = []): Promise<TxResult> {
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
    return this.send(tx);
  }

  private send(tx: Transaction): Promise<TxResult> {
    return this.lock.run(async () => {
      tx.sign(this.o.sponsor);
      const sent = await this.server.sendTransaction(tx);
      if (sent.status === 'ERROR') throw new Error(`submit failed: ${sent.errorResult?.toXDR('base64') ?? 'unknown'}`);
      const done = await this.server.pollTransaction(sent.hash, { attempts: 30 });
      if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`transaction ${sent.hash} ${done.status}`);
      return { hash: sent.hash, returnValue: done.returnValue ? scValToNative(done.returnValue) : undefined };
    });
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
