import { MemoryOtpStore, MemorySessionStore } from './memory-stores.js';
import { AuthError, OtpService, OTP_TTL_MS } from './otp.service.js';
import { TokenService } from './token.service.js';
import { normalizeNgPhone } from './phone.js';

const SECRET = 's'.repeat(32);

function otp(clock: { t: Date }, code = 908172, resendCooldownMs?: number, hourlyLimit?: number, maxAttempts?: number) {
  const sms: { phone: string; text: string }[] = [];
  const store = new MemoryOtpStore();
  const svc = new OtpService(store, { send: async (phone, text) => void sms.push({ phone, text }) }, SECRET, () => clock.t, () => code, resendCooldownMs, hourlyLimit, maxAttempts);
  return { svc, sms, store };
}

describe('phone normalisation', () => {
  describe('valid formats normalize to E.164', () => {
    it.each([
      // Local format with leading zero
      ['08031234567', '+2348031234567', 'MTN standard format'],
      ['07012345678', '+2347012345678', 'Airtel standard format'],
      ['09031234567', '+2349031234567', 'Glo standard format'],
      ['08151234567', '+2348151234567', 'Etisalat/9mobile format'],
      
      // With spaces (various patterns)
      ['0803 123 4567', '+2348031234567', 'spaces after prefix and mid'],
      ['0803 1234567', '+2348031234567', 'space after prefix only'],
      ['080 312 345 67', '+2348031234567', 'multiple spaces'],
      ['0 803 123 4567', '+2348031234567', 'space after leading zero'],
      
      // With dashes (various patterns)
      ['0803-123-4567', '+2348031234567', 'dashes standard'],
      ['0803-1234567', '+2348031234567', 'single dash after prefix'],
      ['080-31-23-45-67', '+2348031234567', 'multiple dashes'],
      
      // With dots
      ['0803.123.4567', '+2348031234567', 'dots separator'],
      
      // With parentheses (common international style)
      ['(0803) 123 4567', '+2348031234567', 'parentheses around prefix'],
      ['0(803)1234567', '+2348031234567', 'parentheses in middle'],
      
      // International format with +234
      ['+2348031234567', '+2348031234567', 'full international with plus'],
      ['+234 803 123 4567', '+2348031234567', 'international with spaces'],
      ['+234-803-123-4567', '+2348031234567', 'international with dashes'],
      ['+234 (803) 123 4567', '+2348031234567', 'international with parens'],
      ['+234.803.123.4567', '+2348031234567', 'international with dots'],
      
      // International format without + (234)
      ['2348031234567', '+2348031234567', 'international no plus'],
      ['234 803 123 4567', '+2348031234567', 'international no plus with spaces'],
      ['234-803-123-4567', '+2348031234567', 'international no plus with dashes'],
      
      // All valid mobile prefixes (7xx, 8xx, 9xx)
      ['07012345678', '+2347012345678', 'prefix 70x'],
      ['08031234567', '+2348031234567', 'prefix 80x'],
      ['09031234567', '+2349031234567', 'prefix 90x'],
      ['07112345678', '+2347112345678', 'prefix 71x'],
      ['08141234567', '+2348141234567', 'prefix 81x'],
      ['09151234567', '+2349151234567', 'prefix 91x'],
      
      // Mixed separators
      ['0803-123 4567', '+2348031234567', 'mixed dash and space'],
      ['+234 803-123-4567', '+2348031234567', 'international mixed separators'],
    ])('normalizes %s to %s (%s)', (input, expected) => {
      expect(normalizeNgPhone(input)).toBe(expected);
    });
  });

  describe('invalid formats are rejected', () => {
    it.each([
      // Too short
      ['0803', 'too short - 4 digits'],
      ['08031234', 'too short - 8 digits'],
      ['080312345', 'too short - 9 digits'],
      ['0803123456', 'too short - 10 digits total'],
      
      // Too long
      ['08031234567890', 'too long - 14 digits'],
      ['080312345678', 'too long - 12 digits'],
      
      // Landline numbers (02 prefix for Lagos, 01 for some areas)
      ['02031234567', 'landline - Lagos 020 prefix'],
      ['01231234567', 'landline - 012 prefix'],
      ['09031234567890', 'landline - too many digits'],
      
      // Invalid mobile prefixes (0-6)
      ['00031234567', 'invalid prefix 00x'],
      ['01031234567', 'invalid prefix 01x'],
      ['02031234567', 'invalid prefix 02x (landline)'],
      ['03031234567', 'invalid prefix 03x'],
      ['04031234567', 'invalid prefix 04x'],
      ['05031234567', 'invalid prefix 05x'],
      ['06031234567', 'invalid prefix 06x'],
      
      // Non-Nigerian country codes
      ['+1555123456', 'US number'],
      ['+44 20 1234 5678', 'UK number'],
      ['+27 82 123 4567', 'South African number'],
      ['+254 712 345678', 'Kenyan number'],
      ['+233 24 123 4567', 'Ghanaian number (similar code)'],
      
      // Invalid characters
      ['abc', 'alphabetic characters'],
      ['080312345ab', 'mixed alphanumeric'],
      ['0803123456!', 'special character'],
      ['', 'empty string'],
      
      // Malformed international format
      ['+234', 'country code only'],
      ['+234803', 'incomplete international'],
      ['234', 'country code without enough digits'],
      
      // Extra zeros or characters
      ['008031234567', 'double leading zero'],
      ['0008031234567', 'triple leading zero'],
      
      // Valid length but non-mobile
      ['01234567890', '01x prefix with 11 digits'],
      ['02345678901', '02x prefix with 11 digits'],
      
    ])('rejects %s (%s)', (input) => {
      expect(normalizeNgPhone(input)).toBeNull();
    });
  });

  describe('edge cases and consistency', () => {
    it('same number in different formats normalizes to same E.164', () => {
      const formats = [
        '08031234567',
        '0803 123 4567',
        '0803-123-4567',
        '+2348031234567',
        '+234 803 123 4567',
        '2348031234567',
        '234 803 123 4567',
        '(0803) 123 4567',
        '+234-803-123-4567',
      ];
      
      const normalized = formats.map(f => normalizeNgPhone(f));
      const expected = '+2348031234567';
      
      // All should normalize to the same value
      normalized.forEach(n => expect(n).toBe(expected));
      
      // All should be equal to each other
      const unique = new Set(normalized);
      expect(unique.size).toBe(1);
    });

    it('handles excessive whitespace', () => {
      expect(normalizeNgPhone('  0803 123 4567  ')).toBe('+2348031234567');
      expect(normalizeNgPhone('0803   123   4567')).toBe('+2348031234567');
    });

    it('handles multiple separator types in one input', () => {
      expect(normalizeNgPhone('0803-123.4567')).toBe('+2348031234567');
      expect(normalizeNgPhone('(0803) 123-4567')).toBe('+2348031234567');
      expect(normalizeNgPhone('+234 (803)-123.4567')).toBe('+2348031234567');
    });

    it('distinguishes between similar but different numbers', () => {
      expect(normalizeNgPhone('08031234567')).not.toBe(normalizeNgPhone('08031234568'));
      expect(normalizeNgPhone('08031234567')).not.toBe(normalizeNgPhone('08041234567'));
    });
  });
});

describe('OtpService', () => {
  it('sends a code, never stores it in plain text, and accepts it once', async () => {
    const clock = { t: new Date('2026-10-05T10:00:00Z') };
    const { svc, sms, store } = otp(clock);
    await svc.request('08031234567');
    expect(sms[0]!.text).toContain('908172');
    expect(JSON.stringify(store.rows)).not.toContain('908172');
    await expect(svc.verify('08031234567', '908172')).resolves.toBe('+2348031234567');
    await expect(svc.verify('08031234567', '908172')).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('expires after five minutes', async () => {
    const clock = { t: new Date('2026-10-05T10:00:00Z') };
    const { svc } = otp(clock);
    await svc.request('08031234567');
    clock.t = new Date(clock.t.getTime() + OTP_TTL_MS + 1);
    await expect(svc.verify('08031234567', '908172')).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('locks after five wrong attempts, even if the right code follows', async () => {
    const clock = { t: new Date('2026-10-05T10:00:00Z') };
    const { svc } = otp(clock);
    await svc.request('08031234567');
    for (let i = 0; i < 5; i++) await expect(svc.verify('08031234567', '000000')).rejects.toMatchObject({ code: 'OTP_WRONG' });
    // After max attempts, should return the same OTP_WRONG error (not OTP_LOCKED) to avoid revealing lockout
    await expect(svc.verify('08031234567', '908172')).rejects.toMatchObject({ code: 'OTP_WRONG' });
  });

  describe('configurable max attempts', () => {
    it('respects custom max attempts limit (3 instead of default 5)', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc } = otp(clock, 908172, undefined, undefined, 3);
      await svc.request('08031234567');
      
      // Make 3 wrong attempts (the custom limit)
      for (let i = 0; i < 3; i++) {
        await expect(svc.verify('08031234567', '000000')).rejects.toMatchObject({ code: 'OTP_WRONG' });
      }
      
      // 4th attempt should fail even with correct code
      await expect(svc.verify('08031234567', '908172')).rejects.toMatchObject({ code: 'OTP_WRONG' });
    });

    it('allows correct code before reaching max attempts', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc } = otp(clock, 908172, undefined, undefined, 5);
      await svc.request('08031234567');
      
      // Make 4 wrong attempts (one less than limit)
      for (let i = 0; i < 4; i++) {
        await expect(svc.verify('08031234567', '000000')).rejects.toMatchObject({ code: 'OTP_WRONG' });
      }
      
      // 5th attempt with correct code should succeed
      await expect(svc.verify('08031234567', '908172')).resolves.toBe('+2348031234567');
    });

    it('tracks attempts independently per challenge', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc } = otp(clock, 908172, 100, undefined, 3);
      
      // First challenge - exhaust attempts
      await svc.request('08031234567');
      for (let i = 0; i < 3; i++) {
        await expect(svc.verify('08031234567', '000000')).rejects.toMatchObject({ code: 'OTP_WRONG' });
      }
      await expect(svc.verify('08031234567', '908172')).rejects.toMatchObject({ code: 'OTP_WRONG' });
      
      // Request new challenge after cooldown
      clock.t = new Date(clock.t.getTime() + 200);
      await svc.request('08031234567');
      
      // New challenge should have fresh attempt counter
      await expect(svc.verify('08031234567', '908172')).resolves.toBe('+2348031234567');
    });

    it('returns indistinguishable error after max attempts (security feature)', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc } = otp(clock, 908172, undefined, undefined, 3);
      await svc.request('08031234567');
      
      // Make wrong attempts up to limit
      for (let i = 0; i < 3; i++) {
        await expect(svc.verify('08031234567', '000000')).rejects.toMatchObject({ code: 'OTP_WRONG' });
      }
      
      // Error after max attempts
      const errorAfterLock = await svc.verify('08031234567', '908172').catch(e => e);
      
      // Error for a plain wrong code (fresh challenge)
      await svc.request('08041234567');
      const errorWrongCode = await svc.verify('08041234567', '000000').catch(e => e);
      
      // Both errors should be identical
      expect(errorAfterLock.code).toBe('OTP_WRONG');
      expect(errorWrongCode.code).toBe('OTP_WRONG');
      expect(errorAfterLock.message).toBe(errorWrongCode.message);
    });

    it('increments attempt counter on each wrong verification', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc, store } = otp(clock, 908172, undefined, undefined, 5);
      await svc.request('08031234567');
      
      // Check initial attempts
      let record = await store.latestOpen('+2348031234567');
      expect(record?.attempts).toBe(0);
      
      // Make wrong attempts and check counter increments
      await svc.verify('08031234567', '000000').catch(() => {});
      record = await store.latestOpen('+2348031234567');
      expect(record?.attempts).toBe(1);
      
      await svc.verify('08031234567', '000000').catch(() => {});
      record = await store.latestOpen('+2348031234567');
      expect(record?.attempts).toBe(2);
      
      await svc.verify('08031234567', '000000').catch(() => {});
      record = await store.latestOpen('+2348031234567');
      expect(record?.attempts).toBe(3);
    });

    it('does not increment counter after correct verification', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc, store } = otp(clock);
      await svc.request('08031234567');
      
      // Verify with correct code
      await svc.verify('08031234567', '908172');
      
      // Challenge should be consumed, not locked
      const record = await store.latestOpen('+2348031234567');
      expect(record).toBeNull(); // latestOpen returns null for consumed challenges
    });

    it('with max attempts of 1, locks immediately after first wrong attempt', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc } = otp(clock, 908172, undefined, undefined, 1);
      await svc.request('08031234567');
      
      // First wrong attempt exhausts the limit
      await expect(svc.verify('08031234567', '000000')).rejects.toMatchObject({ code: 'OTP_WRONG' });
      
      // Now locked
      await expect(svc.verify('08031234567', '908172')).rejects.toMatchObject({ code: 'OTP_WRONG' });
    });
  });

  it('rate limits requests per phone and rejects invalid numbers', async () => {
    const clock = { t: new Date('2026-10-05T10:00:00Z') };
    const { svc } = otp(clock, 908172, 100); // Short cooldown for testing
    // Make 3 requests (the 15-minute limit) with cooldown satisfied
    for (let i = 0; i < 3; i++) {
      await svc.request('08031234567');
      clock.t = new Date(clock.t.getTime() + 200); // Move past 100ms cooldown
    }
    await expect(svc.request('08031234567')).rejects.toMatchObject({ code: 'OTP_RATE_LIMITED' });
    await expect(svc.request('12345')).rejects.toBeInstanceOf(AuthError);
    clock.t = new Date(clock.t.getTime() + 16 * 60_000);
    await expect(svc.request('08031234567')).resolves.toBeDefined();
  });

  it('pads codes with leading zeros', async () => {
    const clock = { t: new Date() };
    const { svc, sms } = otp(clock, 42);
    await svc.request('08031234567');
    expect(sms[0]!.text).toContain('000042');
  });

  describe('OTP resend cooldown', () => {
    it('enforces a 30-second cooldown between requests for the same phone', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc } = otp(clock, 908172, 30_000);
      await svc.request('08031234567');
      
      // Immediate retry should fail with cooldown error
      await expect(svc.request('08031234567')).rejects.toMatchObject({ 
        code: 'OTP_COOLDOWN', 
        retryAfterSecs: 30 
      });
      
      // After 15 seconds, still in cooldown
      clock.t = new Date(clock.t.getTime() + 15_000);
      await expect(svc.request('08031234567')).rejects.toMatchObject({ 
        code: 'OTP_COOLDOWN', 
        retryAfterSecs: 15 
      });
      
      // After 30 seconds, should succeed
      clock.t = new Date('2026-10-05T10:00:30Z');
      await expect(svc.request('08031234567')).resolves.toMatchObject({ phone: '+2348031234567' });
    });

    it('enforces hourly limit of 5 requests per phone', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc } = otp(clock, 908172, 30_000, 5);
      
      // Make 3 requests in first batch (to stay under 15-min limit of 3)
      for (let i = 0; i < 3; i++) {
        await svc.request('08031234567');
        clock.t = new Date(clock.t.getTime() + 31_000); // Move past cooldown each time
      }
      
      // Wait 15 minutes to reset the 15-minute window
      clock.t = new Date(clock.t.getTime() + 15 * 60_000);
      
      // Make 2 more requests (now we have 5 total in the hour)
      for (let i = 0; i < 2; i++) {
        await svc.request('08031234567');
        clock.t = new Date(clock.t.getTime() + 31_000);
      }
      
      // 6th request within the hour should fail
      await expect(svc.request('08031234567')).rejects.toMatchObject({ 
        code: 'OTP_RATE_LIMITED',
        retryAfterSecs: 3600
      });
      
      // After an hour from the first request, should succeed
      clock.t = new Date('2026-10-05T11:00:00Z');
      await expect(svc.request('08031234567')).resolves.toMatchObject({ phone: '+2348031234567' });
    });

    it('tracks cooldown independently per phone number', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc } = otp(clock, 908172, 30_000);
      
      await svc.request('08031234567');
      
      // Different phone should not be affected by first phone's cooldown
      await expect(svc.request('08041234567')).resolves.toMatchObject({ phone: '+2348041234567' });
      
      // Original phone still in cooldown
      await expect(svc.request('08031234567')).rejects.toMatchObject({ code: 'OTP_COOLDOWN' });
    });

    it('calculates retryAfterSecs correctly as time progresses', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc } = otp(clock, 908172, 30_000);
      
      await svc.request('08031234567');
      
      // At 0 seconds: 30 seconds remaining
      await expect(svc.request('08031234567')).rejects.toMatchObject({ retryAfterSecs: 30 });
      
      // At 10 seconds: 20 seconds remaining
      clock.t = new Date(clock.t.getTime() + 10_000);
      await expect(svc.request('08031234567')).rejects.toMatchObject({ retryAfterSecs: 20 });
      
      // At 29 seconds: 1 second remaining
      clock.t = new Date('2026-10-05T10:00:29Z');
      await expect(svc.request('08031234567')).rejects.toMatchObject({ retryAfterSecs: 1 });
      
      // At 30 seconds: should succeed
      clock.t = new Date('2026-10-05T10:00:30Z');
      await expect(svc.request('08031234567')).resolves.toBeDefined();
    });

    it('allows requests when no previous request exists', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc } = otp(clock, 908172, 30_000);
      
      // First request for a new phone should always succeed
      await expect(svc.request('08031234567')).resolves.toMatchObject({ phone: '+2348031234567' });
    });

    it('cooldown never reveals whether phone is registered', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc } = otp(clock, 908172, 30_000);
      
      // Request for first phone
      await svc.request('08031234567');
      
      // Cooldown error is the same regardless of whether user exists
      const error1 = await svc.request('08031234567').catch(e => e);
      
      // Request for second phone
      await svc.request('08041234567');
      const error2 = await svc.request('08041234567').catch(e => e);
      
      // Both errors should be identical in structure
      expect(error1.code).toBe('OTP_COOLDOWN');
      expect(error2.code).toBe('OTP_COOLDOWN');
      expect(error1.message).toBe(error2.message);
    });

    it('original 15-minute rate limit still applies', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc } = otp(clock, 908172, 1000, 10); // Short cooldown, high hourly limit
      
      // Make 3 requests (the 15-minute limit) with cooldown satisfied
      for (let i = 0; i < 3; i++) {
        await svc.request('08031234567');
        clock.t = new Date(clock.t.getTime() + 2000); // Move past 1s cooldown
      }
      
      // 4th request within 15 minutes should still fail
      await expect(svc.request('08031234567')).rejects.toMatchObject({ code: 'OTP_RATE_LIMITED' });
    });

    it('hourly window slides correctly', async () => {
      const clock = { t: new Date('2026-10-05T10:00:00Z') };
      const { svc } = otp(clock, 908172, 100, 5);
      
      // Make 5 requests over 10 minutes
      for (let i = 0; i < 5; i++) {
        await svc.request('08031234567');
        clock.t = new Date(clock.t.getTime() + 2 * 60_000); // 2 minutes apart
      }
      
      // At 10:10, we've hit the limit
      await expect(svc.request('08031234567')).rejects.toMatchObject({ code: 'OTP_RATE_LIMITED' });
      
      // At 11:01 (61 minutes after first request), oldest request is outside window
      clock.t = new Date('2026-10-05T11:01:00Z');
      await expect(svc.request('08031234567')).resolves.toBeDefined();
    });
  });
});

describe('TokenService', () => {
  const setup = () => {
    const sessions = new MemorySessionStore();
    const clock = { t: new Date('2026-10-05T10:00:00Z') };
    return { sessions, clock, svc: new TokenService(SECRET, [], sessions, undefined, () => clock.t) };
  };

  it('issues a verifiable access token and a hashed refresh token', async () => {
    const { svc, sessions } = setup();
    const pair = await svc.issue('u1', ['TRADER']);
    expect(await svc.verifyAccess(pair.accessToken)).toMatchObject({ sub: 'u1', roles: ['TRADER'] });
    expect(sessions.rows[0]!.refreshHash).not.toBe(pair.refreshToken);
    await expect(svc.verifyAccess(pair.accessToken + 'x')).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('rotates refresh tokens and revokes everything when an old one is replayed', async () => {
    const { svc, sessions } = setup();
    const first = await svc.issue('u1', ['TRADER']);
    const second = await svc.refresh(first.refreshToken, async () => ['TRADER']);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(svc.refresh(first.refreshToken, async () => [])).rejects.toMatchObject({ code: 'REFRESH_REUSED' });
    expect(sessions.rows.every((r) => r.revokedAt)).toBe(true); // the stolen-token family is dead
    await expect(svc.refresh(second.refreshToken, async () => [])).rejects.toMatchObject({ code: 'REFRESH_REUSED' });
  });

  it('invalidates access and refresh tokens for all sessions without affecting another user', async () => {
    const { svc, sessions, clock } = setup();
    const first = await svc.issue('u1', ['TRADER']);
    const second = await svc.issue('u1', ['TRADER']);
    const other = await svc.issue('u2', ['TRADER']);

    expect(await svc.verifyAccess(first.accessToken)).toMatchObject({ sub: 'u1' });
    expect(await svc.verifyAccess(second.accessToken)).toMatchObject({ sub: 'u1' });
    await sessions.revokeAllForUser('u1', clock.t);

    await expect(svc.verifyAccess(first.accessToken)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    await expect(svc.verifyAccess(second.accessToken)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    await expect(svc.refresh(first.refreshToken, async () => [])).rejects.toMatchObject({ code: 'REFRESH_REUSED' });
    await expect(svc.refresh(second.refreshToken, async () => [])).rejects.toMatchObject({ code: 'REFRESH_REUSED' });
    await expect(svc.verifyAccess(other.accessToken)).resolves.toMatchObject({ sub: 'u2' });
    expect(sessions.rows.find((r) => r.userId === 'u2')?.revokedAt).toBeNull();
  });

  it('rejects expired refresh tokens and supports logout', async () => {
    const { svc, clock } = setup();
    const p = await svc.issue('u1', []);
    await svc.logout(p.refreshToken);
    await expect(svc.refresh(p.refreshToken, async () => [])).rejects.toBeInstanceOf(AuthError);
    const q = await svc.issue('u1', []);
    clock.t = new Date(clock.t.getTime() + 31 * 24 * 3600_000);
    await expect(svc.refresh(q.refreshToken, async () => [])).rejects.toMatchObject({ code: 'REFRESH_INVALID' });
  });
});
