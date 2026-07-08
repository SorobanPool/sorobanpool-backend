import type { Tier } from '../pools/pricing.js';

export const MAX_TIERS = 5;
export const MAX_VALIDITY_DAYS = 14;
export const MIN_PHOTOS = 2;
/** Prices more than this multiple away from the category median are flagged for human review. */
export const PRICE_OUTLIER_FACTOR = 3;

export const ALLOWED_CATEGORIES = [
  'rice', 'beans', 'garri', 'oil', 'sugar', 'noodles', 'seasoning',
  'beverage', 'toiletry', 'fabric', 'phoneacc', 'stationery', 'cement', 'roofing', 'packaging',
] as const;

/** v1 excludes regulated goods; keep this list conservative and reviewed by ops. */
export const BANNED_KEYWORDS = [
  'alcohol', 'beer', 'wine', 'spirit', 'whisky', 'vodka', 'gin', 'cigarette', 'tobacco', 'snuff',
  'drug', 'tramadol', 'codeine', 'paracetamol', 'antibiotic', 'pesticide', 'herbicide', 'agrochemical',
  'formula milk', 'infant formula', 'baby formula', 'gun', 'firearm', 'ammunition', 'explosive',
];

export interface OfferDraft {
  title: string;
  description: string;
  brand?: string;
  branded: boolean;
  unitLabel: string;
  category: string;
  images: string[];
  tiers: Tier[];
  moq: number;
  maxUnits: number;
  maxPerMember: number;
  leadTimeHours: number;
  validUntil: Date;
}

export interface ValidationResult {
  errors: string[];
  /** Not blocking, but routed to moderation. */
  flags: string[];
}

export function validateTiers(tiers: readonly Tier[], moq: number, maxUnits: number): string[] {
  const errors: string[] = [];
  if (tiers.length < 1 || tiers.length > MAX_TIERS) errors.push(`tiers must have 1 to ${MAX_TIERS} entries`);
  tiers.forEach((t, i) => {
    if (t.unitPrice <= 0n) errors.push(`tier ${i + 1}: price must be positive`);
    if (t.minUnits <= 0) errors.push(`tier ${i + 1}: minUnits must be positive`);
    const prev = tiers[i - 1];
    if (prev && t.minUnits <= prev.minUnits) errors.push(`tier ${i + 1}: minUnits must increase`);
    if (prev && t.unitPrice >= prev.unitPrice) errors.push(`tier ${i + 1}: price must strictly decrease`);
  });
  if (tiers[0] && tiers[0].minUnits !== moq) errors.push('moq must equal the first tier minUnits');
  if (maxUnits < moq) errors.push('maxUnits must be at least moq');
  return errors;
}

export function findBannedKeyword(text: string): string | undefined {
  const lower = text.toLowerCase();
  return BANNED_KEYWORDS.find((k) => new RegExp(`\\b${k.replace(/ /g, '\\s+')}(?:s|es)?\\b`, 'i').test(lower));
}

export function validateOffer(
  draft: OfferDraft,
  now: Date,
  categoryMedianPrice?: bigint,
): ValidationResult {
  const errors = validateTiers(draft.tiers, draft.moq, draft.maxUnits);
  const flags: string[] = [];

  if (!(ALLOWED_CATEGORIES as readonly string[]).includes(draft.category)) {
    errors.push(`category "${draft.category}" is not allowed in v1`);
  }
  if (draft.images.length < MIN_PHOTOS) errors.push(`at least ${MIN_PHOTOS} photos are required`);
  if (!draft.unitLabel.trim()) errors.push('unit label is required (e.g. "50kg bag")');
  if (draft.branded && !draft.brand?.trim()) errors.push('brand is required for branded goods');
  if (draft.leadTimeHours <= 0) errors.push('lead time must be positive');
  if (draft.maxPerMember <= 0 || draft.maxPerMember > draft.maxUnits) {
    errors.push('maxPerMember must be between 1 and maxUnits');
  }
  const days = (draft.validUntil.getTime() - now.getTime()) / 86_400_000;
  if (days <= 0) errors.push('validUntil must be in the future');
  if (days > MAX_VALIDITY_DAYS) errors.push(`offers are valid for at most ${MAX_VALIDITY_DAYS} days`);

  const banned = findBannedKeyword(`${draft.title} ${draft.description} ${draft.brand ?? ''}`);
  if (banned) errors.push(`banned keyword "${banned}": regulated goods are not allowed in v1`);

  if (categoryMedianPrice && draft.tiers[0]) {
    const p = draft.tiers[0].unitPrice;
    const med = categoryMedianPrice;
    if (p > med * BigInt(PRICE_OUTLIER_FACTOR) || p * BigInt(PRICE_OUTLIER_FACTOR) < med) {
      flags.push('price is far from the category median');
    }
  }
  return { errors, flags };
}
