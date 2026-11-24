import type { Tier } from '../pools/pricing.js';

export const MAX_TIERS = 5;
export const MAX_VALIDITY_DAYS = 14;
export const MIN_PHOTOS = 2;
/** Prices more than this multiple away from the category median are flagged for human review. */
export const PRICE_OUTLIER_FACTOR = 3;

export interface CategoryInfo {
  id: string;
  nameEn: string;
  namePcm: string;
  perishable: boolean;
}

export const CATEGORIES: readonly CategoryInfo[] = [
  { id: 'rice', nameEn: 'Rice', namePcm: 'Rice', perishable: false },
  { id: 'beans', nameEn: 'Beans', namePcm: 'Beans', perishable: false },
  { id: 'garri', nameEn: 'Garri', namePcm: 'Garri', perishable: false },
  { id: 'oil', nameEn: 'Cooking Oil', namePcm: 'Cooking Oil', perishable: false },
  { id: 'sugar', nameEn: 'Sugar', namePcm: 'Sugar', perishable: false },
  { id: 'noodles', nameEn: 'Noodles', namePcm: 'Noodles', perishable: false },
  { id: 'seasoning', nameEn: 'Seasoning', namePcm: 'Seasoning', perishable: false },
  { id: 'beverage', nameEn: 'Beverages', namePcm: 'Drink', perishable: true },
  { id: 'toiletry', nameEn: 'Toiletries', namePcm: 'Toiletry', perishable: false },
  { id: 'fabric', nameEn: 'Fabric & Textiles', namePcm: 'Cloth', perishable: false },
  { id: 'phoneacc', nameEn: 'Phone Accessories', namePcm: 'Phone Tin', perishable: false },
  { id: 'stationery', nameEn: 'Stationery', namePcm: 'Book & Pen', perishable: false },
  { id: 'cement', nameEn: 'Cement', namePcm: 'Cement', perishable: false },
  { id: 'roofing', nameEn: 'Roofing Materials', namePcm: 'Roof Tin', perishable: false },
  { id: 'packaging', nameEn: 'Packaging Materials', namePcm: 'Package Tin', perishable: false },
] as const;

export const ALLOWED_CATEGORIES = CATEGORIES.map((c) => c.id);

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
  // Normalize: lowercase, reduce 2+ repeated chars to 1, collapse whitespace
  const normalized = text.toLowerCase()
    .replace(/(.)\1+/g, '$1')       // reduce any repeated char to single
    .replace(/\s+/g, ' ');          // normalize whitespace
  
  for (const keyword of BANNED_KEYWORDS) {
    // Normalize the keyword the same way for matching
    const normalizedKeyword = keyword.toLowerCase().replace(/(.)\1+/g, '$1').replace(/\s+/g, ' ');
    // Build pattern that handles optional spaces within words
    const pattern = new RegExp(`\\b${normalizedKeyword.replace(/ /g, '\\s*')}s?\\b`, 'i');
    if (pattern.test(normalized)) {
      return keyword;
    }
  }
  return undefined;
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
  if (banned) errors.push(`"${banned}" is not allowed: regulated goods are excluded from the marketplace`);

  if (categoryMedianPrice && draft.tiers[0]) {
    const p = draft.tiers[0].unitPrice;
    const med = categoryMedianPrice;
    if (p > med * BigInt(PRICE_OUTLIER_FACTOR) || p * BigInt(PRICE_OUTLIER_FACTOR) < med) {
      flags.push('price is far from the category median');
    }
  }
  return { errors, flags };
}
