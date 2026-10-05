import {
  Account, Address, Contract, Keypair, Networks, Operation, StrKey, TransactionBuilder, xdr, nativeToScVal,
} from '@stellar/stellar-sdk';
import { inspectUserTx, TxRejected, type InspectRules } from './inspect.js';

const sponsor = Keypair.random();
const user = Keypair.random();
const stranger = Keypair.random();
const GB = StrKey.encodeContract(Buffer.alloc(32, 1));
const OTHER = StrKey.encodeContract(Buffer.alloc(32, 2));
const rules: InspectRules = { sponsor: sponsor.publicKey(), passphrase: Networks.TESTNET, userWallet: user.publicKey(), maxFeeStroops: 10_000_000 };

function authEntry(who: string, contract = GB, fn = 'commit', kind: 'v1' | 'v2' = 'v1'): xdr.SorobanAuthorizationEntry {
  const addressCreds = (a: string) =>
    new xdr.SorobanAddressCredentials({ address: new Address(a).toScAddress(), nonce: 1n, signatureExpirationLedger: 100, signature: xdr.ScVal.scvVoid() });
  const credentials =
    who === 'source'
      ? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
      : kind === 'v2'
        ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCreds(who))
        : xdr.SorobanCredentials.sorobanCredentialsAddress(addressCreds(who));
  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args: [] }),
      ),
      subInvocations: [],
    }),
  });
}

function build(opts: { source?: string; fee?: string; auth?: xdr.SorobanAuthorizationEntry[]; ops?: number; contract?: string; fn?: string } = {}): string {
  const callOp = new Contract(opts.contract ?? GB).call(opts.fn ?? 'commit', nativeToScVal(1, { type: 'u32' }));
  const hostFn = (callOp.body as unknown as { invokeHostFunctionOp: { hostFunction: xdr.HostFunction } }).invokeHostFunctionOp.hostFunction;
  const b = new TransactionBuilder(new Account(opts.source ?? sponsor.publicKey(), '1'), { fee: opts.fee ?? '100', networkPassphrase: Networks.TESTNET });
  for (let i = 0; i < (opts.ops ?? 1); i++) b.addOperation(Operation.invokeHostFunction({ func: hostFn, auth: opts.auth ?? [authEntry(user.publicKey())] }));
  return b.setTimeout(60).build().toXDR();
}

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof TxRejected ? e.code : `other:${(e as Error).message}`;
  }
  return 'accepted';
};

describe('inspectUserTx', () => {
  it('accepts one contract call authorised by the user and reports what it is', () => {
    const r = inspectUserTx(build(), rules);
    expect([r.contractId, r.fn, r.authAddresses]).toEqual([GB, 'commit', [user.publicKey()]]);
  });
  it('refuses source-account authorisation: it would act as the sponsor', () => {
    expect(code(() => inspectUserTx(build({ auth: [authEntry('source')] }), rules))).toBe('SPONSOR_AUTH');
  });
  it('refuses authorisation entries that name the sponsor or another account', () => {
    expect(code(() => inspectUserTx(build({ auth: [authEntry(sponsor.publicKey())] }), rules))).toBe('SPONSOR_AUTH');
    expect(code(() => inspectUserTx(build({ auth: [authEntry(stranger.publicKey())] }), rules))).toBe('WRONG_SIGNER');
  });
  it('refuses a transaction whose source is not the sponsor', () => {
    expect(code(() => inspectUserTx(build({ source: user.publicKey() }), rules))).toBe('BAD_SOURCE');
  });
  it('refuses inflated fees and multi-operation transactions', () => {
    expect(code(() => inspectUserTx(build({ fee: '99999999' }), rules))).toBe('FEE_TOO_HIGH');
    expect(code(() => inspectUserTx(build({ ops: 2 }), { ...rules, maxFeeStroops: 10_000_000 }))).toBe('BAD_OPS');
  });
  it('refuses an auth entry for a different function than the one invoked', () => {
    expect(code(() => inspectUserTx(build({ auth: [authEntry(user.publicKey(), OTHER, 'commit')] }), rules))).toBe('AUTH_MISMATCH');
    expect(code(() => inspectUserTx(build({ auth: [authEntry(user.publicKey(), GB, 'settle')] }), rules))).toBe('AUTH_MISMATCH');
  });
  it('accepts V2 address credentials but refuses delegated or unknown ones', () => {
    expect(code(() => inspectUserTx(build({ auth: [authEntry(user.publicKey(), GB, 'commit', 'v2')] }), rules))).toBe('accepted');
    const base = authEntry(user.publicKey());
    const inner = (base.credentials as xdr.SorobanCredentialsAddress).address;
    const delegated = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
        new xdr.SorobanAddressCredentialsWithDelegates({ addressCredentials: inner, delegates: [] }),
      ),
      rootInvocation: base.rootInvocation,
    });
    expect(code(() => inspectUserTx(build({ auth: [delegated] }), rules))).toBe('UNSUPPORTED_CREDENTIALS');
  });
  it('refuses non-invocation operations', () => {
    const pay = new TransactionBuilder(new Account(sponsor.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.bumpSequence({ bumpTo: '10' })).setTimeout(60).build().toXDR();
    expect(code(() => inspectUserTx(pay, rules))).toBe('BAD_OP_TYPE');
  });
});
