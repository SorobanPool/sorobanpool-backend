import { createHash, randomBytes } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { AuthError } from './otp.service.js';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 3600_000;

export interface SessionRecord {
  id: string;
  userId: string;
  refreshHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface SessionStore {
  insert(r: Omit<SessionRecord, 'id' | 'revokedAt'>): Promise<SessionRecord>;
  findByHash(hash: string): Promise<SessionRecord | null>;
  revoke(id: string, at: Date): Promise<void>;
  revokeAllForUser(userId: string, at: Date): Promise<void>;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AccessClaims {
  sub: string;
  roles: string[];
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class TokenService {
  private readonly jwt: JwtService;
  constructor(
    secret: string,
    private readonly sessions: SessionStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.jwt = new JwtService({ secret, signOptions: { expiresIn: ACCESS_TTL_SECONDS } });
  }

  async issue(userId: string, roles: string[]): Promise<TokenPair> {
    const refreshToken = randomBytes(32).toString('base64url');
    await this.sessions.insert({
      userId,
      refreshHash: sha(refreshToken),
      expiresAt: new Date(this.now().getTime() + REFRESH_TTL_MS),
    });
    const accessToken = await this.jwt.signAsync({ sub: userId, roles });
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS };
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      return await this.jwt.verifyAsync<AccessClaims>(token);
    } catch {
      throw new AuthError('TOKEN_INVALID', 'Invalid or expired token');
    }
  }

  /** Rotates the refresh token. Presenting an already-used token revokes every session of that user. */
  async refresh(refreshToken: string, rolesFor: (userId: string) => Promise<string[]>): Promise<TokenPair> {
    const rec = await this.sessions.findByHash(sha(refreshToken));
    const now = this.now();
    if (!rec || rec.expiresAt <= now) throw new AuthError('REFRESH_INVALID', 'Please sign in again');
    if (rec.revokedAt) {
      await this.sessions.revokeAllForUser(rec.userId, now);
      throw new AuthError('REFRESH_REUSED', 'Please sign in again');
    }
    await this.sessions.revoke(rec.id, now);
    return this.issue(rec.userId, await rolesFor(rec.userId));
  }

  async logout(refreshToken: string): Promise<void> {
    const rec = await this.sessions.findByHash(sha(refreshToken));
    if (rec && !rec.revokedAt) await this.sessions.revoke(rec.id, this.now());
  }
}
