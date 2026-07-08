import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';

export const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024;
export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf'] as const;
export const SIGNED_URL_TTL_SECONDS = 300;

export function validateUpload(mime: string, sizeBytes: number): string | null {
  if (!(ALLOWED_MIME as readonly string[]).includes(mime)) return `file type ${mime} is not allowed`;
  if (sizeBytes <= 0 || sizeBytes > MAX_EVIDENCE_BYTES) return `file must be between 1 byte and ${MAX_EVIDENCE_BYTES / 1024 / 1024} MB`;
  return null;
}

/** sha256 of the stored bytes; the hash goes on-chain, the bytes stay in access-controlled storage. */
export const evidenceHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Who may read a piece of evidence: pool participants, the assigned arbiter, and admins. */
export interface EvidenceAccess {
  userId: string;
  roles: string[];
  isPoolParticipant: boolean;
  assignedArbiterFor?: bigint;
  disputeId?: bigint | null;
}

export function canReadEvidence(a: EvidenceAccess): boolean {
  if (a.roles.includes('ADMIN')) return true;
  if (a.isPoolParticipant) return true;
  return a.roles.includes('ARBITER') && a.disputeId != null && a.assignedArbiterFor === a.disputeId;
}

/** Short-lived HMAC-signed read URL for local/dev storage; S3 deployments use native presigned URLs instead. */
export function signUrl(secret: string, objectKey: string, userId: string, now = Date.now()): { url: string; expires: number } {
  const expires = Math.floor(now / 1000) + SIGNED_URL_TTL_SECONDS;
  const sig = createHmac('sha256', secret).update(`${objectKey}|${userId}|${expires}`).digest('base64url');
  return { url: `/v1/evidence/file?key=${encodeURIComponent(objectKey)}&u=${encodeURIComponent(userId)}&e=${expires}&s=${sig}`, expires };
}

export function verifySignedUrl(secret: string, p: { key: string; u: string; e: number; s: string }, now = Date.now()): boolean {
  if (p.e < Math.floor(now / 1000)) return false;
  const expected = createHmac('sha256', secret).update(`${p.key}|${p.u}|${p.e}`).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(p.s);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Public product images: resize to a low-bandwidth WebP and drop all metadata (EXIF GPS included). */
export async function toPublicThumbnail(input: Uint8Array, width = 640): Promise<Buffer> {
  return sharp(input).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
}
