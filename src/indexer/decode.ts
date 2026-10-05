import { scValToNative, xdr } from '@stellar/stellar-sdk';

/** A raw event as returned by Soroban RPC `getEvents` (topics and value are base64 XDR). */
export interface RawEvent {
  id: string;
  ledger: number;
  /** ISO time the ledger closed (from getEvents). */
  ledgerClosedAt: string;
  contractId: string;
  topic: string[];
  value: string;
}

export interface DecodedEvent {
  id: string;
  ledger: number;
  closedAt: Date;
  contractId: string;
  /** Contract symbol, e.g. group_buy. */
  contract: string;
  /** Event symbol, e.g. committed. */
  event: string;
  /** Third topic: pool id (bigint), dispute id, address or symbol. */
  key: unknown;
  data: unknown;
}

const native = (b64: string): unknown => scValToNative(xdr.ScVal.fromXDR(b64, 'base64'));

export function decodeEvent(raw: RawEvent): DecodedEvent | null {
  if (raw.topic.length < 3) return null; // not one of ours
  const [contract, event, key] = raw.topic.map(native);
  if (typeof contract !== 'string' || typeof event !== 'string') return null;
  return { id: raw.id, ledger: raw.ledger, closedAt: new Date(raw.ledgerClosedAt), contractId: raw.contractId, contract, event, key, data: native(raw.value) };
}
