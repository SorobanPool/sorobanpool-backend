import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Application-layer encryption for personal data at rest (brief 7.3: KYC results, bank details). AES-256-GCM with
 * a random 96-bit IV per value; the auth tag makes any tampering fail decryption. The key comes from the secret
 * manager (`ENCRYPTION_KEY_ID`) as base64 of 32 bytes and is never stored with the data.
 */
export interface Sealed {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

export class PiiCipher {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('ENCRYPTION_KEY_ID must resolve to base64 of exactly 32 bytes (AES-256)');
  }

  seal(value: unknown): Sealed {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }

  open<T = unknown>(s: Sealed): T {
    if (s?.v !== 1) throw new Error('unsupported sealed value');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(s.iv, 'base64'));
    d.setAuthTag(Buffer.from(s.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]).toString('utf8')) as T;
  }
}

/** Shows only the last 4 characters of an identifier (BVN, NIN, account number) for display and logs. */
export const mask = (id: string): string => (id.length <= 4 ? '****' : `${'*'.repeat(id.length - 4)}${id.slice(-4)}`);
