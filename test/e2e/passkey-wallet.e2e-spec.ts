import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Address, authorizeEntry, Keypair, rpc, xdr } from '@stellar/stellar-sdk';
import request from 'supertest';
import { AppModule } from '../../src/app/app.module.js';
import { buildServices, type Services } from '../../src/app/services.js';
import { ChainService, signAuthEntries } from '../../src/chain/chain.service.js';
import { CONTRACT_NAMES, loadDeployments } from '../../src/chain/deployments.js';
import { loadEnv } from '../../src/config/env.js';
import { LocalObjectStore } from '../../src/evidence/store.js';
import { Indexer } from '../../src/indexer/indexer.service.js';
import { Projector } from '../../src/indexer/projector.js';
import { PrismaCursorStore, PrismaEventSink, PrismaReadStore } from '../../src/persistence/prisma-stores.js';
import { rpcPort } from '../../src/workers/runners.js';
import { SoftAuthenticator } from '../authenticator.js';
import { startTestDb, type TestDb } from '../pg.js';

/**
 * Passkey smart wallet on live testnet (contracts ADR 0006): a trader with NO classic account and NO XLM gets a
 * wallet deployed by the sponsor, receives test USDC, registers on-chain and commits money to a pool. Every user
 * action is authorised only by a WebAuthn assertion, verified on-chain by the wallet's __check_auth.
 * Run: E2E_TESTNET=1 SPONSOR_SECRET=S... pnpm exec vitest run --config vitest.config.e2e.ts test/e2e/passkey-wallet.e2e-spec.ts
 */
const enabled = !!process.env.E2E_TESTNET;
const PASSPHRASE = 'Test SDF Network ; September 2015';
const RPC = 'https://soroban-testnet.stellar.org';
const ORIGIN = 'http://localhost:3001';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)('passkey smart wallet on testnet', () => {
  let db: TestDb;
  let app: NestExpressApplication;
  let s: Services;
  let chain: ChainService;
  let indexer: Indexer;
  const server = new rpc.Server(RPC);
  const deployments = loadDeployments(process.env.DEPLOYMENTS_FILE ?? '../sorobanpool-contracts/deployments/testnet.json');
  const http = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  let phoneN = 0;
  const phone = () => `+23480399${String(Date.now() % 1000).padStart(3, '0')}${String(phoneN++).padStart(2, '0')}`;

  beforeAll(async () => {
    db = await startTestDb();
    const env = loadEnv({
      DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://x', S3_ENDPOINT: 'http://x', S3_BUCKET_PUBLIC: 'p', S3_BUCKET_EVIDENCE: 'e', S3_ACCESS_KEY_REF: 'a', S3_SECRET_KEY_REF: 'b',
      JWT_SECRET: 'j'.repeat(32), JWT_REFRESH_SECRET: 'r'.repeat(32), OTP_HMAC_SECRET: 'o'.repeat(32), ENCRYPTION_KEY_ID: 'literal:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=', RPC_URL: RPC, HORIZON_URL: 'https://horizon-testnet.stellar.org',
      NETWORK_PASSPHRASE: PASSPHRASE, SPONSOR_SECRET_REF: 'env:SPONSOR_SECRET', ATTESTOR_SECRET_REF: 'env:SPONSOR_SECRET', WEBAUTHN_RP_ID: 'localhost',
      WEBAUTHN_ORIGIN: ORIGIN, PUBLIC_APP_URL: ORIGIN, OTP_DEV_ECHO: 'true', BOOTSTRAP_ADMIN_PHONES: '+2348000000001', FX_STATIC: '1500,1505', STELLAR_NETWORK: 'testnet',
    } as NodeJS.ProcessEnv);
    s = buildServices(env, db.prisma, deployments, { store: new LocalObjectStore(mkdtempSync(join(tmpdir(), 'sp-pk-'))) });
    chain = s.chain as ChainService;
    app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(s), { logger: false });
    app.setGlobalPrefix('v1');
    await app.init();
    const start = (await server.getLatestLedger()).sequence;
    indexer = new Indexer(rpcPort(server), new PrismaCursorStore(db.prisma), new PrismaEventSink(db.prisma), new Projector(new PrismaReadStore(db.prisma)), CONTRACT_NAMES.map((n) => deployments.contracts[n].id), start, 500);
  }, 120_000);
  afterAll(async () => { await app?.close(); await db?.close(); });

  async function login(p: string) {
    const r1 = await http().post('/v1/auth/otp/request').send({ phone: p }).expect(200);
    const r2 = await http().post('/v1/auth/otp/verify').send({ phone: p, code: r1.body.devCode }).expect(200);
    return { token: r2.body.accessToken as string, userId: r2.body.user.id as string };
  }

  /** Exactly what the frontend does: the Soroban payload is the WebAuthn challenge; the struct is the signature. */
  async function passkeySign(entries: string[], wallet: string, a: SoftAuthenticator, validUntil: number): Promise<string[]> {
    const out: string[] = [];
    for (const e of entries) {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(e, 'base64');
      const c = entry.credentials;
      const who = c.type === 'sorobanCredentialsAddressV2' ? Address.fromScAddress(c.addressV2.address).toString() : c.type === 'sorobanCredentialsAddress' ? Address.fromScAddress(c.address.address).toString() : null;
      if (who !== wallet) { out.push(e); continue; }
      const signed = await authorizeEntry(entry, async (_pre, payload) => {
        const r = a.assertForWallet(payload);
        const field = (k: string, v: Buffer) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: xdr.ScVal.scvBytes(v) });
        return { signatureScVal: xdr.ScVal.scvMap([field('authenticator_data', r.authenticatorData), field('client_data', r.clientDataJSON), field('credential_id', r.credentialId), field('signature', r.signature)]) };
      }, validUntil, PASSPHRASE);
      out.push(signed.toXDR('base64'));
    }
    return out;
  }

  async function submit(token: string, prep: { txXdr: string; validUntilLedger: number }, signed: string[]) {
    const r = await http().post('/v1/tx/submit').set(auth(token)).send({ txXdr: prep.txXdr, signedAuthEntries: signed, idempotencyKey: `pk-${Date.now()}-${Math.random()}` });
    expect(r.status, `submit: ${JSON.stringify(r.body)}`).toBe(200);
    return r.body;
  }

  async function classicActor(label: string) {
    const kp = Keypair.random();
    let funded = false;
    for (let i = 0; i < 5 && !funded; i++) {
      try { funded = (await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`)).ok; } catch { await sleep(2000 * (i + 1)); }
    }
    expect(funded, `friendbot for ${label}`).toBe(true);
    const p = phone();
    const { token, userId } = await login(p);
    const c = await http().get('/v1/wallets/challenge').set(auth(token)).expect(200);
    await http().post('/v1/wallets').set(auth(token)).send({ address: kp.publicKey(), signature: Buffer.from(kp.sign(Buffer.from(c.body.challenge))).toString('base64') }).expect(200);
    return { kp, token, userId, phone: p };
  }

  async function sync(until: () => Promise<boolean>, what: string) {
    const end = Date.now() + 90_000;
    for (;;) {
      await indexer.tick();
      if (await until()) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(3000);
    }
  }

  it('deploys a passkey wallet, funds it, registers and commits to a pool with passkey signatures only', async () => {
    // ---- the trader: phone + passkey, nothing else ----
    const trader = await login(phone());
    const a = new SoftAuthenticator('localhost', ORIGIN);
    const o = await http().post('/v1/auth/passkey/register/options').set(auth(trader.token)).send({}).expect(200);
    const reg = await http().post('/v1/auth/passkey/register/verify').set(auth(trader.token)).send({ challengeId: o.body.challengeId, response: a.register(o.body.options.challenge) }).expect(200);
    const w = await http().post('/v1/wallets/passkey').set(auth(trader.token)).send({ passkeyId: reg.body.passkeyId });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    const wallet = w.body.walletAddress as string;
    expect(wallet).toMatch(/^C[A-Z2-7]{55}$/);
    // On-chain, the wallet's signer is the passkey's public key.
    const onChainKey = await chain.viewAt<Buffer>(wallet, 'public_key', [xdr.ScVal.scvBytes(a.credentialId)]);
    expect(Buffer.from(onChainKey).equals(a.publicKey65)).toBe(true);
    expect((await http().post('/v1/wallets/passkey').set(auth(trader.token)).send({ passkeyId: reg.body.passkeyId })).body.created).toBe(false);

    await http().post('/v1/dev/faucet/start').set(auth(trader.token)).send({}).expect(200);
    const balance = async () => BigInt(await chain.viewAt<bigint>(deployments.usdc, 'balance', [new Address(wallet).toScVal()]));
    expect(await balance()).toBe(100n * 10_000_000n);

    // ---- registry.register authorised by the passkey ----
    const rp = await http().post('/v1/registry/register/prepare').set(auth(trader.token)).send({ role: 'Trader' });
    expect(rp.status, JSON.stringify(rp.body)).toBe(201);
    await submit(trader.token, rp.body, await passkeySign(rp.body.authEntries, wallet, a, rp.body.validUntilLedger));

    // A forged assertion (another passkey claiming this wallet) is rejected on-chain.
    const thief = new SoftAuthenticator('localhost', ORIGIN);
    Object.assign(thief, { credentialId: a.credentialId });
    const again = await http().post('/v1/registry/register/prepare').set(auth(trader.token)).send({ role: 'Organizer' });
    const forged = await http().post('/v1/tx/submit').set(auth(trader.token)).send({ txXdr: again.body.txXdr, signedAuthEntries: await passkeySign(again.body.authEntries, wallet, thief, again.body.validUntilLedger), idempotencyKey: `forged-${Date.now()}` });
    expect(forged.status).not.toBe(200);

    // ---- a pool to join: supplier and organizer use classic keys here, set up by the admin ----
    const admin = await login('+2348000000001');
    const supplier = await classicActor('supplier');
    const organizer = await classicActor('organizer');
    for (const [who, role] of [[supplier, 'Supplier'], [organizer, 'Organizer']] as const) {
      const p = await http().post('/v1/registry/register/prepare').set(auth(who.token)).send({ role });
      await submit(who.token, p.body, await signAuthEntries(p.body.authEntries, who.kp, p.body.validUntilLedger, PASSPHRASE));
    }
    await http().post('/v1/suppliers/apply').set(auth(supplier.token)).send({ businessName: 'Passkey Foods Ltd', cacNumber: 'RC7654321', address: '3 Gate Rd', state: 'FCT', lga: 'Abuja Municipal', categories: ['rice'], deliveryAreas: [{ state: 'FCT' }] }).expect(200);
    await http().post(`/v1/admin/suppliers/${supplier.userId}/decision`).set(auth(admin.token)).send({ approve: true }).expect(200);
    await http().post(`/v1/admin/users/${organizer.userId}/roles`).set(auth(admin.token)).send({ role: 'ORGANIZER' }).expect(200);
    await http().post(`/v1/admin/users/${organizer.userId}/attest`).set(auth(admin.token)).send({ role: 'Organizer', level: 1 }).expect(200);
    supplier.token = (await login(supplier.phone)).token;
    organizer.token = (await login(organizer.phone)).token;
    const offer = await http().post('/v1/offers').set(auth(supplier.token)).send({
      title: 'Golden Penny Rice 25kg', brand: 'Golden Penny', branded: true, description: 'Long grain', unitLabel: '25kg bag', category: 'rice', perishable: false,
      images: ['a.webp', 'b.webp'], tiersNgn: [{ minUnits: 10, priceNgn: '1500' }, { minUnits: 20, priceNgn: '1400' }],
      moq: 10, maxUnits: 40, maxPerMember: 20, leadTimeHours: 72, deliveryAreas: [{ state: 'FCT' }], validUntil: new Date(Date.now() + 5 * 86400_000).toISOString(),
    }).expect(201);
    await http().post(`/v1/offers/${offer.body.id}/publish`).set(auth(supplier.token)).expect(200);
    const prep = await http().post('/v1/pools/prepare').set(auth(organizer.token)).send({
      offerId: offer.body.id, fillDeadline: new Date(Date.now() + 3600_000).toISOString(), hub: { address: 'Garki Market', contact: '08030000000' }, pickupWindow: { from: 'Tue 9am', to: 'Tue 5pm' }, organizerFeeBp: 0, clusterOnly: false,
    });
    expect(prep.status, JSON.stringify(prep.body)).toBe(201);
    await submit(organizer.token, prep.body, await signAuthEntries(prep.body.authEntries, organizer.kp, prep.body.validUntilLedger, PASSPHRASE));
    await sync(async () => !!(await db.prisma.pool.findFirst({ where: { hubHash: prep.body.hubHash } })), 'pool indexed');
    const pool = await db.prisma.pool.findFirstOrThrow({ where: { hubHash: prep.body.hubHash } });

    // ---- the money move: commit, authorised (root call + nested USDC transfer) by one passkey assertion ----
    const before = await balance();
    const cp = await http().post(`/v1/pools/${pool.id}/commit/prepare`).set(auth(trader.token)).send({ units: 5 });
    expect(cp.status, JSON.stringify(cp.body)).toBe(201);
    await submit(trader.token, cp.body, await passkeySign(cp.body.authEntries, wallet, a, cp.body.validUntilLedger));
    const spent = before - (await balance());
    expect(spent > 0n).toBe(true);
    await sync(async () => (await db.prisma.commitment.findFirst({ where: { poolId: pool.id, memberAddress: wallet } }))?.units === 5, 'commitment indexed');

    // The relayer never let the sponsor's own authority be used, and the trader never held XLM.
    const acct = await fetch(`https://horizon-testnet.stellar.org/accounts/${wallet}`);
    expect([400, 404]).toContain(acct.status); // a contract wallet is not a classic account at all (Horizon: 400)
  }, 15 * 60_000);
});
