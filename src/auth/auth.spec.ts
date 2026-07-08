import { MemoryOtpStore, MemorySessionStore } from './memory-stores.js';
import { AuthError, OtpService, OTP_TTL_MS } from './otp.service.js';
import { TokenService } from './token.service.js';
import { normalizeNgPhone } from './phone.js';

const SECRET = 's'.repeat(32);

function otp(clock: { t: Date }, code = 908172) {
  const sms: { phone: string; text: string }[] = [];
  const store = new MemoryOtpStore();
  const svc = new OtpService(store, { send: async (phone, text) => void sms.push({ phone, text }) }, SECRET, () => clock.t, () => code);
  return { svc, sms, store };
}

describe('phone normalisation', () => {
  it.each([
    ['08031234567', '+2348031234567'],
    ['+234 803 123 4567', '+2348031234567'],
    ['2347012345678', '+2347012345678'],
  ])('%s -> %s', (i, o) => expect(normalizeNgPhone(i)).toBe(o));
  it.each(['0123', '+1555123456', '08031234', '02031234567', 'abc'])('rejects %s', (i) => expect(normalizeNgPhone(i)).toBeNull());
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
    await expect(svc.verify('08031234567', '908172')).rejects.toMatchObject({ code: 'OTP_LOCKED' });
  });

  it('rate limits requests per phone and rejects invalid numbers', async () => {
    const clock = { t: new Date('2026-10-05T10:00:00Z') };
    const { svc } = otp(clock);
    for (let i = 0; i < 3; i++) await svc.request('08031234567');
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
});

describe('TokenService', () => {
  const setup = () => {
    const sessions = new MemorySessionStore();
    const clock = { t: new Date('2026-10-05T10:00:00Z') };
    return { sessions, clock, svc: new TokenService(SECRET, sessions, () => clock.t) };
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
