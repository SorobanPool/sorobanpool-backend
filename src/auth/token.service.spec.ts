import { vi } from 'vitest';
import { TokenService, type SessionStore, type SessionRecord } from './token.service.js';
import { AuthError } from './otp.service.js';

class MockSessionStore implements SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private hashIndex = new Map<string, string>();
  public replayLogs: Array<{ userId: string; sessionId: string; at: Date }> = [];

  async insert(r: Omit<SessionRecord, 'id' | 'revokedAt'>): Promise<SessionRecord> {
    const id = `sess-${Math.random()}`;
    const record = { ...r, id, revokedAt: null };
    this.sessions.set(id, record);
    this.hashIndex.set(r.refreshHash, id);
    return record;
  }

  async findByHash(hash: string): Promise<SessionRecord | null> {
    const id = this.hashIndex.get(hash);
    return id ? this.sessions.get(id) ?? null : null;
  }

  async findById(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async revoke(id: string, at: Date): Promise<void> {
    const sess = this.sessions.get(id);
    if (sess) {
      sess.revokedAt = at;
      this.sessions.set(id, sess);
    }
  }

  async revokeAllForUser(userId: string, at: Date): Promise<void> {
    for (const [id, sess] of this.sessions) {
      if (sess.userId === userId && !sess.revokedAt) {
        sess.revokedAt = at;
        this.sessions.set(id, sess);
      }
    }
  }

  async logReplayAttempt(userId: string, sessionId: string, at: Date): Promise<void> {
    this.replayLogs.push({ userId, sessionId, at });
  }
}

describe('TokenService', () => {
  const now = new Date('2026-11-24T00:00:00Z');
  const secret1 = 'x'.repeat(32);
  const secret2 = 'y'.repeat(32);
  const secret3 = 'z'.repeat(32);

  it('issues tokens with kid header', async () => {
    const store = new MockSessionStore();
    const service = new TokenService({ id: 'key-1', secret: secret1 }, [], store, undefined, () => now);
    const pair = await service.issue('user1', ['USER']);
    expect(pair.accessToken).toBeTruthy();
    expect(pair.refreshToken).toBeTruthy();
    expect(pair.expiresIn).toBe(15 * 60);
    // Decode header to check kid
    const parts = pair.accessToken.split('.');
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
    expect(header.kid).toBe('key-1');
  });

  it('verifies tokens signed with current key', async () => {
    const store = new MockSessionStore();
    const service = new TokenService({ id: 'key-1', secret: secret1 }, [], store, undefined, () => now);
    const pair = await service.issue('user1', ['USER']);
    const claims = await service.verifyAccess(pair.accessToken);
    expect(claims.sub).toBe('user1');
    expect(claims.roles).toEqual(['USER']);
  });

  it('verifies tokens signed with previous key', async () => {
    const store = new MockSessionStore();
    const oldService = new TokenService({ id: 'key-1', secret: secret1 }, [], store, undefined, () => now);
    const pair = await oldService.issue('user1', ['USER']);

    // Rotate key: secret2 is now current, secret1 is previous
    const newService = new TokenService(
      { id: 'key-2', secret: secret2 },
      [{ id: 'key-1', secret: secret1 }],
      store,
      undefined,
      () => now
    );
    const claims = await newService.verifyAccess(pair.accessToken);
    expect(claims.sub).toBe('user1');
  });

  it('fails verification when old key is removed', async () => {
    const store = new MockSessionStore();
    const oldService = new TokenService({ id: 'key-1', secret: secret1 }, [], store, undefined, () => now);
    const pair = await oldService.issue('user1', ['USER']);

    // Rotate and remove old key
    const newService = new TokenService({ id: 'key-3', secret: secret3 }, [], store, undefined, () => now);
    await expect(newService.verifyAccess(pair.accessToken)).rejects.toThrow(AuthError);
  });

  it('issues new tokens with current key after rotation', async () => {
    const store = new MockSessionStore();
    const service = new TokenService(
      { id: 'key-2', secret: secret2 },
      [{ id: 'key-1', secret: secret1 }],
      store,
      undefined,
      () => now
    );
    const pair = await service.issue('user2', ['ADMIN']);
    const parts = pair.accessToken.split('.');
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
    expect(header.kid).toBe('key-2');
    const claims = await service.verifyAccess(pair.accessToken);
    expect(claims.sub).toBe('user2');
  });

  it('supports backward-compatible single-string secret', async () => {
    const store = new MockSessionStore();
    const service = new TokenService(secret1, [], store, undefined, () => now);
    const pair = await service.issue('user1', ['USER']);
    const claims = await service.verifyAccess(pair.accessToken);
    expect(claims.sub).toBe('user1');
  });

  it('supports backward-compatible previous secrets as strings', async () => {
    const store = new MockSessionStore();
    const oldService = new TokenService(secret1, [], store, undefined, () => now);
    const pair = await oldService.issue('user1', ['USER']);

    const newService = new TokenService(secret2, [secret1], store, undefined, () => now);
    const claims = await newService.verifyAccess(pair.accessToken);
    expect(claims.sub).toBe('user1');
  });

  it('logs replay attempts and increments counter', async () => {
    const store = new MockSessionStore();
    const mockMetrics = { inc: vi.fn() };
    const service = new TokenService(secret1, [], store, mockMetrics, () => now);
    
    const pair = await service.issue('user1', ['USER']);
    await service.refresh(pair.refreshToken, async () => ['USER']);
    
    // Replay the same token
    try {
      await service.refresh(pair.refreshToken, async () => ['USER']);
      throw new Error('Expected error not thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).code).toBe('REFRESH_REUSED');
    }
    
    // Check audit log
    expect(store.replayLogs).toHaveLength(1);
    expect(store.replayLogs[0]!.userId).toBe('user1');
    
    // Check metrics
    expect(mockMetrics.inc).toHaveBeenCalledWith('auth_refresh_replay_total');
  });
});
