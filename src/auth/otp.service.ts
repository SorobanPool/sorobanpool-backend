import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { normalizeNgPhone } from './phone.js';

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_REQUESTS = 3;
export const OTP_REQUEST_WINDOW_MS = 15 * 60_000;

export interface OtpRecord {
  id: string;
  phone: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumed: boolean;
  createdAt: Date;
}

export interface OtpStore {
  insert(r: Omit<OtpRecord, 'id'>): Promise<OtpRecord>;
  latestOpen(phone: string): Promise<OtpRecord | null>;
  countSince(phone: string, since: Date): Promise<number>;
  update(id: string, patch: Partial<Pick<OtpRecord, 'attempts' | 'consumed'>>): Promise<void>;
}

export interface SmsSender {
  send(phone: string, text: string): Promise<void>;
}

export class AuthError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export class OtpService {
  constructor(
    private readonly store: OtpStore,
    private readonly sms: SmsSender,
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = () => randomInt(0, 1_000_000),
  ) {}

  private hash(phone: string, code: string): string {
    return createHmac('sha256', this.secret).update(`${phone}:${code}`).digest('hex');
  }

  async request(rawPhone: string): Promise<{ phone: string }> {
    const phone = normalizeNgPhone(rawPhone);
    if (!phone) throw new AuthError('INVALID_PHONE', 'Enter a valid Nigerian mobile number');
    const now = this.now();
    const recent = await this.store.countSince(phone, new Date(now.getTime() - OTP_REQUEST_WINDOW_MS));
    if (recent >= OTP_MAX_REQUESTS) throw new AuthError('OTP_RATE_LIMITED', 'Too many codes requested. Try again later');
    const code = this.random().toString().padStart(6, '0');
    await this.store.insert({
      phone,
      codeHash: this.hash(phone, code),
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      attempts: 0,
      consumed: false,
      createdAt: now,
    });
    await this.sms.send(phone, `Your SorobanPool code is ${code}. It expires in 5 minutes. Never share it.`);
    return { phone };
  }

  /** Returns the normalised phone when the code is right; the code is single use. */
  async verify(rawPhone: string, code: string): Promise<string> {
    const phone = normalizeNgPhone(rawPhone);
    if (!phone) throw new AuthError('INVALID_PHONE', 'Enter a valid Nigerian mobile number');
    const rec = await this.store.latestOpen(phone);
    if (!rec || rec.consumed || rec.expiresAt <= this.now()) throw new AuthError('OTP_EXPIRED', 'Code expired. Request a new one');
    if (rec.attempts >= OTP_MAX_ATTEMPTS) throw new AuthError('OTP_LOCKED', 'Too many wrong attempts. Request a new code');
    const a = Buffer.from(this.hash(phone, code));
    const b = Buffer.from(rec.codeHash);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      await this.store.update(rec.id, { attempts: rec.attempts + 1 });
      throw new AuthError('OTP_WRONG', 'Wrong code');
    }
    await this.store.update(rec.id, { consumed: true });
    return phone;
  }
}
