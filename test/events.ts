import { Keypair, nativeToScVal, xdr, Address } from '@stellar/stellar-sdk';
import type { RawEvent } from '../src/indexer/decode.js';

export const addr = (): string => Keypair.random().publicKey();
export const bytes32 = (b: number): Buffer => Buffer.alloc(32, b);
export const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
export const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
export const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
export const a = (s: string) => new Address(s).toScVal();
export const tup = (...v: xdr.ScVal[]) => xdr.ScVal.scvVec(v);
export const bytes = (b: number) => nativeToScVal(bytes32(b));
const sym = (s: string) => xdr.ScVal.scvSymbol(s).toXDR('base64');

let n = 0;
/** Builds a raw RPC event the way the contracts emit it. */
export function raw(contract: string, event: string, key: xdr.ScVal, data: xdr.ScVal, ledger = 100): RawEvent {
  return {
    id: `ev-${++n}`, ledger, ledgerClosedAt: new Date(1_760_000_000_000 + ledger * 5000).toISOString(),
    contractId: `C${contract}`, topic: [sym(contract), sym(event), key.toXDR('base64')], value: data.toXDR('base64'),
  };
}
