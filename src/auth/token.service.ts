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
  findById(id: string): Promise<SessionRecord | null>;
  revoke(id: string, at: Date): Promise<void>;
  revokeAllForUser(userId: string, at: Date): Promise<void>;
  logReplayAttempt(userId: string, sessionId: string, at: Date): Promise<void>;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AccessClaims {
  sub: string;
  roles: string[];
  sid: string;
}

export interface JwtKey {
  id: string;
  secret: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class TokenService {
  private readonly currentKey: JwtKey;
  private readonly previousKeys: JwtKey[];
  private readonly jwt: JwtService;
  
  constructor(
    secret: string | JwtKey,
    previousSecrets: string[] | JwtKey[] = [],
    private readonly sessions: SessionStore,
    private readonly metrics?: { inc(name: string, labels?: Record<string, string>, by?: number): void },
    private readonly now: () => Date = () => new Date(),
  ) {
    // Support both old single-secret format and new key-with-id format
    if (typeof secret === 'string') {
      this.currentKey = { id: 'default', secret };
    } else {
      this.currentKey = secret;
    }
    
    this.previousKeys = previousSecrets.map((s, i) =>
      typeof s === 'string' ? { id: `prev-${i}`, secret: s } : s
    );
    
    this.jwt = new JwtService({ 
      secret: this.currentKey.secret, 
      signOptions: { expiresIn: ACCESS_TTL_SECONDS } 
    });
  }

  async issue(userId: string, roles: string[]): Promise<TokenPair> {
    const refreshToken = randomBytes(32).toString('base64url');
    const session = await this.sessions.insert({
      userId,
      refreshHash: sha(refreshToken),
      expiresAt: new Date(this.now().getTime() + REFRESH_TTL_MS),
    });
    // Access tokens carry the key id and are bound to their session
    const accessToken = await this.jwt.signAsync(
      { sub: userId, roles, sid: session.id },
      { header: { kid: this.currentKey.id } }
    );
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS };
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      // First try current key
      const claims = await this.jwt.verifyAsync<AccessClaims>(token);
      if (!claims.sid) throw new Error('Missing session identifier');
      const session = await this.sessions.findById(claims.sid);
      if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt <= this.now()) {
        throw new Error('Session revoked or expired');
      }
      return claims;
    } catch (currentErr) {
      // Try previous keys
      for (const key of this.previousKeys) {
        try {
          const prevJwt = new JwtService({ secret: key.secret });
          const claims = await prevJwt.verifyAsync<AccessClaims>(token);
          if (!claims.sid) throw new Error('Missing session identifier');
          const session = await this.sessions.findById(claims.sid);
          if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt <= this.now()) {
            throw new Error('Session revoked or expired');
          }
          return claims;
        } catch {
          continue;
        }
      }
      throw new AuthError('TOKEN_INVALID', 'Invalid or expired token');
    }
  }

  /** Rotates the refresh token. Presenting an already-used token revokes every session of that user. */
  async refresh(refreshToken: string, rolesFor: (userId: string) => Promise<string[]>): Promise<TokenPair> {
    const rec = await this.sessions.findByHash(sha(refreshToken));
    const now = this.now();
    if (!rec || rec.expiresAt <= now) throw new AuthError('REFRESH_INVALID', 'Please sign in again');
    if (rec.revokedAt) {
      // Replay detected: log it and revoke all sessions
      await this.sessions.logReplayAttempt(rec.userId, rec.id, now);
      await this.sessions.revokeAllForUser(rec.userId, now);
      this.metrics?.inc('auth_refresh_replay_total');
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
