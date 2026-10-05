import { canonicalJson, sha256Hex } from '../common/canonical-json.js';
import type { Tier } from '../pools/pricing.js';

export interface OfferTerms {
  supplierAddress: string;
  title: string;
  brand?: string;
  unitLabel: string;
  category: string;
  perishable: boolean;
  tiers: Tier[];
  moq: number;
  maxUnits: number;
  maxPerMember: number;
  leadTimeHours: number;
  validUntil: Date;
}

/** offer_hash = sha256(canonical offer JSON), stored on-chain with the pool snapshot. */
export function offerHash(offer: OfferTerms): string {
  return sha256Hex(canonicalJson(offer));
}

export const unitLabelHash = (label: string): string => sha256Hex(label.trim());
