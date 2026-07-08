import { Address, Transaction, TransactionBuilder, type xdr } from '@stellar/stellar-sdk';

export class TxRejected extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export interface InspectedTx {
  tx: Transaction;
  contractId: string;
  fn: string;
  /** Addresses that signed (or must sign) authorization entries. */
  authAddresses: string[];
}

export interface InspectRules {
  sponsor: string;
  passphrase: string;
  /** The authenticated user's wallet. Every auth entry must belong to it. */
  userWallet: string;
  /** Fee ceiling in stroops; protects the sponsor's balance from inflated resource fees. */
  maxFeeStroops: number;
}

/**
 * Decides whether a client-supplied transaction is safe for the relayer to sponsor. The sponsor is the
 * transaction source, so an entry using *source-account* credentials would authorise as the sponsor
 * itself (e.g. act as an organizer or supplier). Those are refused outright, as is anything that is not
 * exactly one contract invocation authorised by the user's own wallet.
 */
export function inspectUserTx(txXdr: string, rules: InspectRules): InspectedTx {
  const parsed = TransactionBuilder.fromXDR(txXdr, rules.passphrase);
  if (!(parsed instanceof Transaction)) throw new TxRejected('NOT_PLAIN_TX', 'fee-bump transactions are not accepted from clients');
  if (parsed.source !== rules.sponsor) throw new TxRejected('BAD_SOURCE', 'transaction source must be the sponsor account');
  if (Number(parsed.fee) > rules.maxFeeStroops) throw new TxRejected('FEE_TOO_HIGH', `transaction fee ${parsed.fee} stroops exceeds the sponsor limit of ${rules.maxFeeStroops}`);
  if (parsed.operations.length !== 1) throw new TxRejected('BAD_OPS', 'exactly one operation is required');
  const op = parsed.operations[0]!;
  if (op.type !== 'invokeHostFunction') throw new TxRejected('BAD_OP_TYPE', 'only contract invocations are sponsored');
  const func = op.func;
  if (func.type !== 'hostFunctionTypeInvokeContract') throw new TxRejected('BAD_FUNC', 'only contract calls are sponsored');
  const call = func.invokeContract;
  const contractId = Address.fromScAddress(call.contractAddress).toString();
  const fn = String(call.functionName);

  const authAddresses: string[] = [];
  for (const entry of op.auth ?? []) {
    const cred = entry.credentials;
    // Allow-list: plain address credentials (and their V2 form). Source-account credentials would authorise
    // as the sponsor; delegated signers are an unreviewed authority model. Everything else is refused.
    let scAddress;
    if (cred.type === 'sorobanCredentialsAddress') scAddress = cred.address.address;
    else if (cred.type === 'sorobanCredentialsAddressV2') scAddress = cred.addressV2.address;
    else if (cred.type === 'sorobanCredentialsSourceAccount') throw new TxRejected('SPONSOR_AUTH', 'source-account authorisation is never accepted');
    else throw new TxRejected('UNSUPPORTED_CREDENTIALS', 'unsupported authorisation credentials');
    const who = Address.fromScAddress(scAddress).toString();
    if (who === rules.sponsor) throw new TxRejected('SPONSOR_AUTH', 'the sponsor never authorises user actions');
    if (who !== rules.userWallet) throw new TxRejected('WRONG_SIGNER', 'authorisation is for a different account');
    const root = entry.rootInvocation.function;
    if (root.type !== 'sorobanAuthorizedFunctionTypeContractFn') throw new TxRejected('AUTH_MISMATCH', 'authorisation is not for a contract call');
    if (Address.fromScAddress(root.contractFn.contractAddress).toString() !== contractId || String(root.contractFn.functionName) !== fn) {
      throw new TxRejected('AUTH_MISMATCH', 'authorisation does not match the invoked function');
    }
    authAddresses.push(who);
  }
  return { tx: parsed, contractId, fn, authAddresses };
}

/** Address of an address-credential entry (plain or V2), or null for any other credential kind. */
export function credentialAddress(cred: xdr.SorobanCredentials): string | null {
  if (cred.type === 'sorobanCredentialsAddress') return Address.fromScAddress(cred.address.address).toString();
  if (cred.type === 'sorobanCredentialsAddressV2') return Address.fromScAddress(cred.addressV2.address).toString();
  return null;
}

export const authEntriesOf = (tx: Transaction): xdr.SorobanAuthorizationEntry[] => {
  const op = tx.operations[0];
  return op && op.type === 'invokeHostFunction' ? (op.auth ?? []) : [];
};
