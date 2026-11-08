import { Keypair, Networks, StrKey } from '@stellar/stellar-sdk';
import { SoftAuthenticator } from '../../test/authenticator.js';
import { startHarness, type Harness } from '../../test/harness.js';
import { credentialIdBytes, p256PublicKeyFromCose, walletAddress, walletSalt, WalletKeyError } from './smart-wallet.js';

const rp = 'localhost';
const origin = 'http://localhost:3001';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('passkey wallet helpers', () => {
  it('derives a stable contract address from the sponsor and the credential id', () => {
    const sponsor = Keypair.random().publicKey();
    const cred = Buffer.from('credential-1');
    const a = walletAddress(sponsor, walletSalt(cred), Networks.TESTNET);
    expect(StrKey.isValidContract(a)).toBe(true);
    expect(walletAddress(sponsor, walletSalt(cred), Networks.TESTNET)).toBe(a);
    expect(walletAddress(sponsor, walletSalt(Buffer.from('credential-2')), Networks.TESTNET)).not.toBe(a);
    expect(walletAddress(Keypair.random().publicKey(), walletSalt(cred), Networks.TESTNET)).not.toBe(a);
    expect(walletAddress(sponsor, walletSalt(cred), Networks.PUBLIC)).not.toBe(a);
  });

  it('round-trips base64url credential ids to raw bytes', () => {
    const raw = Buffer.from([0, 1, 250, 255, 7]);
    expect(credentialIdBytes(raw.toString('base64url')).equals(raw)).toBe(true);
  });

  it('only accepts ES256 / P-256 keys, which secp256r1_verify can check on-chain', () => {
    // COSE map {1: 2 (EC2), 3: -8 (EdDSA), -1: 6 (Ed25519), -2: 32 bytes}
    const eddsa = Buffer.concat([Buffer.from([0xa4, 0x01, 0x02, 0x03, 0x27, 0x20, 0x06, 0x21, 0x58, 0x20]), Buffer.alloc(32, 1)]);
    expect(() => p256PublicKeyFromCose(eddsa)).toThrow(WalletKeyError);
  });
});

describe('POST /v1/wallets/passkey', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });

  async function withPasskey(phone: string) {
    const me = await h.login(phone);
    const a = new SoftAuthenticator(rp, origin);
    const o = await h.http().post('/v1/auth/passkey/register/options').set(auth(me.token)).send({});
    const r = await h.http().post('/v1/auth/passkey/register/verify').set(auth(me.token)).send({ challengeId: o.body.challengeId, response: a.register(o.body.options.challenge) });
    expect(r.status).toBe(200);
    return { ...me, a, passkeyId: r.body.passkeyId as string };
  }

  it('deploys a wallet controlled by the registered passkey and binds it to the user', async () => {
    const u = await withPasskey('+2348032000001');
    const r = await h.http().post('/v1/wallets/passkey').set(auth(u.token)).send({ passkeyId: u.passkeyId });
    expect(r.status).toBe(200);
    expect(StrKey.isValidContract(r.body.walletAddress)).toBe(true);
    expect(r.body.created).toBe(true);
    const deployed = h.chain.deployed.at(-1)!;
    expect(deployed.publicKey.equals(u.a.publicKey65)).toBe(true); // the key the user's phone holds, not one we made up
    expect(deployed.credentialId.equals(u.a.credentialId)).toBe(true);
    const me = await h.http().get('/v1/me').set(auth(u.token));
    expect(me.body.walletAddress).toBe(r.body.walletAddress);
  });

  it('is idempotent', async () => {
    const u = await withPasskey('+2348032000002');
    const first = await h.http().post('/v1/wallets/passkey').set(auth(u.token)).send({ passkeyId: u.passkeyId });
    const again = await h.http().post('/v1/wallets/passkey').set(auth(u.token)).send({ passkeyId: u.passkeyId });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ walletAddress: first.body.walletAddress, created: false });
  });

  it("refuses someone else's passkey, an unknown passkey and an account that already has a device wallet", async () => {
    const alice = await withPasskey('+2348032000003');
    const bob = await h.login('+2348032000004');
    const stolen = await h.http().post('/v1/wallets/passkey').set(auth(bob.token)).send({ passkeyId: alice.passkeyId });
    expect(stolen.status).toBe(401);
    expect(stolen.body.error).toBe('PASSKEY_NOT_FOUND');
    expect((await h.http().post('/v1/wallets/passkey').set(auth(bob.token)).send({ passkeyId: 'nope' })).body.error).toBe('PASSKEY_NOT_FOUND');

    const carol = await withPasskey('+2348032000005');
    await h.s.prisma.user.update({ where: { id: carol.userId }, data: { walletAddress: Keypair.random().publicKey() } });
    const r = await h.http().post('/v1/wallets/passkey').set(auth(carol.token)).send({ passkeyId: carol.passkeyId });
    expect(r.body.error).toBe('WALLET_EXISTS');
  });

  it('requires user verification when registering, because the wallet only accepts verified assertions', async () => {
    const me = await h.login('+2348032000006');
    const a = new SoftAuthenticator(rp, origin);
    const o = await h.http().post('/v1/auth/passkey/register/options').set(auth(me.token)).send({});
    expect(o.body.options.authenticatorSelection.userVerification).toBe('required');
    expect(o.body.options.pubKeyCredParams).toEqual([{ alg: -7, type: 'public-key' }]);
    const r = await h.http().post('/v1/auth/passkey/register/verify').set(auth(me.token)).send({ challengeId: o.body.challengeId, response: a.register(o.body.options.challenge, { uv: false }) });
    expect(r.status).toBe(401);
  });

  it('pays the testnet faucet straight to a passkey wallet (no trustline needed)', async () => {
    const u = await withPasskey('+2348032000007');
    const w = await h.http().post('/v1/wallets/passkey').set(auth(u.token)).send({ passkeyId: u.passkeyId });
    const r = await h.http().post('/v1/dev/faucet/start').set(auth(u.token)).send({});
    expect(r.body).toEqual({ added: '100' });
    expect(h.chain.paid.at(-1)).toEqual({ wallet: w.body.walletAddress, stroops: 1_000_000_000n });
  });
});
