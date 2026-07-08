import type { OtpRecord, OtpStore } from './otp.service.js';
import type { SessionRecord, SessionStore } from './token.service.js';

/** In-memory stores for tests and local development without a database. */
export class MemoryOtpStore implements OtpStore {
  rows: OtpRecord[] = [];
  private n = 0;
  async insert(r: Omit<OtpRecord, 'id'>): Promise<OtpRecord> {
    const row = { ...r, id: String(++this.n) };
    this.rows.push(row);
    return row;
  }
  async latestOpen(phone: string): Promise<OtpRecord | null> {
    return [...this.rows].reverse().find((r) => r.phone === phone && !r.consumed) ?? null;
  }
  async countSince(phone: string, since: Date): Promise<number> {
    return this.rows.filter((r) => r.phone === phone && r.createdAt >= since).length;
  }
  async update(id: string, patch: Partial<Pick<OtpRecord, 'attempts' | 'consumed'>>): Promise<void> {
    Object.assign(this.rows.find((r) => r.id === id)!, patch);
  }
}

export class MemorySessionStore implements SessionStore {
  rows: SessionRecord[] = [];
  private n = 0;
  async insert(r: Omit<SessionRecord, 'id' | 'revokedAt'>): Promise<SessionRecord> {
    const row = { ...r, id: String(++this.n), revokedAt: null };
    this.rows.push(row);
    return row;
  }
  async findByHash(hash: string): Promise<SessionRecord | null> {
    return this.rows.find((r) => r.refreshHash === hash) ?? null;
  }
  async revoke(id: string, at: Date): Promise<void> {
    this.rows.find((r) => r.id === id)!.revokedAt = at;
  }
  async revokeAllForUser(userId: string, at: Date): Promise<void> {
    this.rows.filter((r) => r.userId === userId).forEach((r) => (r.revokedAt ??= at));
  }
}
