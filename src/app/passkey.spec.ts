import { SoftAuthenticator } from '../../test/authenticator.js';
import { startHarness, type Harness } from '../../test/harness.js';

describe('passkey sign-in', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });
  const rp = 'localhost';
  const origin = 'http://localhost:3001';
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function register(token: string, a: SoftAuthenticator) {
    const o = await h.http().post('/v1/auth/passkey/register/options').set(auth(token)).send({});
    expect(o.status).toBe(200);
    return h.http().post('/v1/auth/passkey/register/verify').set(auth(token)).send({ challengeId: o.body.challengeId, response: a.register(o.body.options.challenge) });
  }
  const loginOptions = () => h.http().post('/v1/auth/passkey/login/options').send({});

  it('registers while signed in, then signs in without an SMS and keeps roles', async () => {
    const me = await h.login('+2348031000001');
    const a = new SoftAuthenticator(rp, origin);
    expect((await register(me.token, a)).body).toEqual({ registered: true });

    const o = await loginOptions();
    const r = await h.http().post('/v1/auth/passkey/login/verify').send({ challengeId: o.body.challengeId, response: a.assert(o.body.options.challenge) });
    expect(r.status).toBe(200);
    expect(r.body.user.id).toBe(me.userId);
    expect(r.body.roles).toContain('TRADER');
    const who = await h.http().get('/v1/me').set(auth(r.body.accessToken));
    expect(who.status).toBe(200);
    expect((await h.s.prisma.passkey.findFirstOrThrow({ where: { userId: me.userId } })).counter).toBe(1);
  });

  it('rejects a replayed challenge, a wrong origin, an unknown passkey and registration without a session', async () => {
    const me = await h.login('+2348031000002');
    const a = new SoftAuthenticator(rp, origin);
    await register(me.token, a);

    const o = await loginOptions();
    const bad = await h.http().post('/v1/auth/passkey/login/verify').send({ challengeId: o.body.challengeId, response: a.assert(o.body.options.challenge, { origin: 'https://evil.example' }) });
    expect(bad.status).toBe(401);
    // the failed attempt burned the challenge: even a correct assertion cannot reuse it
    const replay = await h.http().post('/v1/auth/passkey/login/verify').send({ challengeId: o.body.challengeId, response: a.assert(o.body.options.challenge) });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('PASSKEY_CHALLENGE_INVALID');

    const o2 = await loginOptions();
    const stranger = new SoftAuthenticator(rp, origin);
    const unknown = await h.http().post('/v1/auth/passkey/login/verify').send({ challengeId: o2.body.challengeId, response: stranger.assert(o2.body.options.challenge) });
    expect(unknown.status).toBe(401);
    expect((await h.http().post('/v1/auth/passkey/register/options').send({})).status).toBe(401);
  });

  it("will not let one user complete another user's registration challenge", async () => {
    const alice = await h.login('+2348031000003');
    const bob = await h.login('+2348031000004');
    const o = await h.http().post('/v1/auth/passkey/register/options').set(auth(alice.token)).send({});
    const r = await h.http().post('/v1/auth/passkey/register/verify').set(auth(bob.token)).send({ challengeId: o.body.challengeId, response: new SoftAuthenticator(rp, origin).register(o.body.options.challenge) });
    expect(r.status).toBe(401);
  });

  it('rejects an expired challenge', async () => {
    const o = await loginOptions();
    await h.s.prisma.passkeyChallenge.update({ where: { id: o.body.challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await h.http().post('/v1/auth/passkey/login/verify').send({ challengeId: o.body.challengeId, response: new SoftAuthenticator(rp, origin).assert(o.body.options.challenge) });
    expect(r.body.error).toBe('PASSKEY_CHALLENGE_INVALID');
  });
});
