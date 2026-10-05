import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Address, Asset, Keypair, Operation, rpc, TransactionBuilder } from '@stellar/stellar-sdk';
import request from 'supertest';
import sharp from 'sharp';
import { AppModule } from '../../src/app/app.module.js';
import { buildServices, type Services } from '../../src/app/services.js';
import { ChainService, signAuthEntries } from '../../src/chain/chain.service.js';
import { CONTRACT_NAMES, loadDeployments } from '../../src/chain/deployments.js';
import { loadEnv } from '../../src/config/env.js';
import { LocalObjectStore } from '../../src/evidence/store.js';
import { Indexer } from '../../src/indexer/indexer.service.js';
import { Projector } from '../../src/indexer/projector.js';
import { PrismaCursorStore, PrismaEventSink, PrismaReadStore } from '../../src/persistence/prisma-stores.js';
import { keeperTick, rpcPort } from '../../src/workers/runners.js';
import { startTestDb, type TestDb } from '../pg.js';
import { toStroops } from '../../src/common/money.js';

/**
 * M2 acceptance: onboard a supplier and 5 traders, publish an offer, create a pool, commit across a price
 * break, fill, accept, dispatch, deliver with a shortfall, settle and refund, all through the API on testnet.
 * Run: E2E_TESTNET=1 SPONSOR_SECRET=S... pnpm exec vitest run --config vitest.config.e2e.ts test/e2e/m2-flow.e2e-spec.ts
 */
const enabled = !!process.env.E2E_TESTNET;
const PASSPHRASE = 'Test SDF Network ; September 2015';
const RPC = 'https://soroban-testnet.stellar.org';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)('M2 acceptance flow on testnet', () => {
  let db: TestDb;
  let app: NestExpressApplication;
  let s: Services;
  let chain: ChainService;
  let indexer: Indexer;
  const server = new rpc.Server(RPC);
  const deployments = loadDeployments(process.env.DEPLOYMENTS_FILE ?? '../sorobanpool-contracts/deployments/testnet.json');
  const adminKp = () => Keypair.fromSecret(process.env.SPONSOR_SECRET!);
  const usdcAsset = () => new Asset('USDC', deployments.admin);
  const http = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  let ledgerStart = 0;

  beforeAll(async () => {
    db = await startTestDb();
    const env = loadEnv({
      DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://x', S3_ENDPOINT: 'http://x', S3_BUCKET_PUBLIC: 'p', S3_BUCKET_EVIDENCE: 'e', S3_ACCESS_KEY_REF: 'a', S3_SECRET_KEY_REF: 'b',
      JWT_SECRET: 'j'.repeat(32), JWT_REFRESH_SECRET: 'r'.repeat(32), OTP_HMAC_SECRET: 'o'.repeat(32), ENCRYPTION_KEY_ID: 'k', RPC_URL: RPC, HORIZON_URL: 'https://horizon-testnet.stellar.org',
      NETWORK_PASSPHRASE: PASSPHRASE, SPONSOR_SECRET_REF: 'env:SPONSOR_SECRET', ATTESTOR_SECRET_REF: 'env:SPONSOR_SECRET', WEBAUTHN_RP_ID: 'localhost',
      WEBAUTHN_ORIGIN: 'http://localhost:3001', PUBLIC_APP_URL: 'http://localhost:3001', OTP_DEV_ECHO: 'true', BOOTSTRAP_ADMIN_PHONES: '+2348000000001', FX_STATIC: '1500,1505', STELLAR_NETWORK: 'testnet',
    } as NodeJS.ProcessEnv);
    s = buildServices(env, db.prisma, deployments, { store: new LocalObjectStore(mkdtempSync(join(tmpdir(), 'sp-e2e-'))) });
    chain = s.chain as ChainService;
    app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(s), { logger: false });
    app.setGlobalPrefix('v1');
    app.useBodyParser('raw', { type: ['image/*'], limit: '16mb' });
    await app.init();
    ledgerStart = (await server.getLatestLedger()).sequence;
    indexer = new Indexer(rpcPort(server), new PrismaCursorStore(db.prisma), new PrismaEventSink(db.prisma), new Projector(new PrismaReadStore(db.prisma)), CONTRACT_NAMES.map((n) => deployments.contracts[n].id), ledgerStart, 500);
  }, 120_000);
  afterAll(async () => { await app?.close(); await db?.close(); });

  async function classic(kp: Keypair, ops: ReturnType<typeof Operation.payment>[]) {
    const acct = await server.getAccount(kp.publicKey());
    const b = new TransactionBuilder(acct, { fee: '10000', networkPassphrase: PASSPHRASE });
    ops.forEach((o) => b.addOperation(o));
    const tx = b.setTimeout(60).build();
    tx.sign(kp);
    const sent = await server.sendTransaction(tx);
    const done = await server.pollTransaction(sent.hash, { attempts: 30 });
    if (done.status !== 'SUCCESS') throw new Error(`classic tx failed: ${done.status}`);
  }

  interface Actor { kp: Keypair; token: string; userId: string; phone: string }
  let phoneN = 20;
  async function login(phone: string): Promise<{ token: string; userId: string }> {
    const r1 = await http().post('/v1/auth/otp/request').send({ phone }).expect(200);
    const r2 = await http().post('/v1/auth/otp/verify').send({ phone, code: r1.body.devCode }).expect(200);
    return { token: r2.body.accessToken, userId: r2.body.user.id };
  }
  async function relogin(phone: string): Promise<string> { return (await login(phone)).token; }

  /** A funded user: friendbot XLM (testnet harness only), USDC trustline, USDC from the admin, bound wallet. */
  async function actor(label: string, usdc: string): Promise<Actor> {
    const kp = Keypair.random();
    let funded = false;
    for (let attempt = 0; attempt < 5 && !funded; attempt++) {
      try {
        funded = (await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`)).ok;
      } catch {
        await sleep(2000 * (attempt + 1)); // transient network errors are common against friendbot
      }
    }
    expect(funded, `friendbot for ${label}`).toBe(true);
    await classic(kp, [Operation.changeTrust({ asset: usdcAsset() })]);
    if (Number(usdc) > 0) await classic(adminKp(), [Operation.payment({ destination: kp.publicKey(), asset: usdcAsset(), amount: usdc })]);
    const phone = `+23480300${String(phoneN++).padStart(5, '0')}`;
    const { token, userId } = await login(phone);
    const c = await http().get('/v1/wallets/challenge').set(auth(token)).expect(200);
    await http().post('/v1/wallets').set(auth(token)).send({ address: kp.publicKey(), signature: Buffer.from(kp.sign(Buffer.from(c.body.challenge))).toString('base64') }).expect(200);
    return { kp, token, userId, phone };
  }

  /** prepare -> sign auth entries with the user's key -> submit. The user never pays a fee. */
  async function act(who: Actor, path: string, body: object): Promise<{ hash: string }> {
    const p = await http().post(path).set(auth(who.token)).send(body);
    expect(p.status, `${path}: ${JSON.stringify(p.body)}`).toBe(201);
    const signed = await signAuthEntries(p.body.authEntries, who.kp, p.body.validUntilLedger, PASSPHRASE);
    const r = await http().post('/v1/tx/submit').set(auth(who.token)).send({ txXdr: p.body.txXdr, signedAuthEntries: signed, idempotencyKey: `${who.userId}-${Date.now()}-${Math.random().toString(36).slice(2)}` });
    expect(r.status, `submit ${path}: ${JSON.stringify(r.body)}`).toBe(200);
    return r.body;
  }

  async function sync(until: () => Promise<boolean>, what: string, timeoutMs = 90_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      await indexer.tick();
      if (await until()) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(3000);
    }
  }
  const usdcBalance = async (addr: string) => BigInt(await chain.viewAt<bigint>(deployments.usdc, 'balance', [new Address(addr).toScVal()]));

  it('keeps every contract instance and code alive (ADR 0005)', async () => {
    const r = await chain.keepAlive();
    expect(r.missing).toEqual([]);
    expect((await chain.keepAlive()).extended).toEqual([]); // a second pass has nothing left to extend
  }, 120_000);

  it('runs the full group-buy lifecycle through the API', async () => {
    // ---- onboarding ----
    const supplier = await actor('supplier', '0');
    const organizer = await actor('organizer', '0');
    const traders: Actor[] = [];
    for (let i = 0; i < 5; i++) traders.push(await actor(`trader${i}`, '100'));
    const admin = await login('+2348000000001');

    // On-chain registration is signed by each user; admin/attestor then verifies.
    await act(supplier, '/v1/registry/register/prepare', { role: 'Supplier' });
    await act(organizer, '/v1/registry/register/prepare', { role: 'Organizer' });
    for (const t of traders) await act(t, '/v1/registry/register/prepare', { role: 'Trader' });
    await http().post('/v1/suppliers/apply').set(auth(supplier.token)).send({
      businessName: 'Tunde Foods Ltd', cacNumber: 'RC1234567', address: '12 Market Rd', state: 'FCT', lga: 'Abuja Municipal', categories: ['rice'], deliveryAreas: [{ state: 'FCT' }],
    }).expect(200);
    await http().post(`/v1/admin/suppliers/${supplier.userId}/decision`).set(auth(admin.token)).send({ approve: true }).expect(200);
    await http().post(`/v1/admin/users/${organizer.userId}/roles`).set(auth(admin.token)).send({ role: 'ORGANIZER' }).expect(200);
    await http().post(`/v1/admin/users/${organizer.userId}/attest`).set(auth(admin.token)).send({ role: 'Organizer', level: 1 }).expect(200);
    for (const t of traders) await http().post(`/v1/admin/users/${t.userId}/attest`).set(auth(admin.token)).send({ role: 'Trader', level: 1 }).expect(200);
    supplier.token = await relogin(supplier.phone);
    organizer.token = await relogin(organizer.phone);

    // ---- catalog ----
    const offer = await http().post('/v1/offers').set(auth(supplier.token)).send({
      title: 'Mama Gold Rice 50kg', brand: 'Mama Gold', branded: true, description: 'Parboiled long grain rice', unitLabel: '50kg bag', category: 'rice', perishable: false,
      images: ['a.webp', 'b.webp'], tiersNgn: [{ minUnits: 50, priceNgn: '1500' }, { minUnits: 100, priceNgn: '1400' }, { minUnits: 150, priceNgn: '1300' }],
      moq: 50, maxUnits: 200, maxPerMember: 60, leadTimeHours: 72, deliveryAreas: [{ state: 'FCT' }], validUntil: new Date(Date.now() + 5 * 86400_000).toISOString(),
    }).expect(201);
    const pub = await http().post(`/v1/offers/${offer.body.id}/publish`).set(auth(supplier.token)).expect(200);
    const tiers = (pub.body.tiersUsdc as { minUnits: number; unitPrice: string }[]).map((t) => ({ minUnits: t.minUnits, price: BigInt(t.unitPrice) }));

    // The group_buy contract is shared by every pool on this deployment; measure what THIS pool leaves behind.
    const escrowBefore = await usdcBalance(deployments.contracts.group_buy.id);

    // ---- pool ----
    const deadline = new Date(Date.now() + 90_000);
    const prep = await http().post('/v1/pools/prepare').set(auth(organizer.token)).send({
      offerId: offer.body.id, fillDeadline: deadline.toISOString(), hub: { address: 'Wuse Market Gate B', contact: '08031234567' }, pickupWindow: { from: 'Mon 9am', to: 'Mon 5pm' }, organizerFeeBp: 100, clusterOnly: false,
    });
    expect(prep.status, JSON.stringify(prep.body)).toBe(201);
    const signed = await signAuthEntries(prep.body.authEntries, organizer.kp, prep.body.validUntilLedger, PASSPHRASE);
    const created = await http().post('/v1/tx/submit').set(auth(organizer.token)).send({ txXdr: prep.body.txXdr, signedAuthEntries: signed, idempotencyKey: `pool-${Date.now()}` });
    expect(created.status, `create_pool submit: ${JSON.stringify(created.body)} | entries=${prep.body.authEntries.length}`).toBe(200);
    await sync(async () => !!(await db.prisma.pool.findFirst({ where: { hubHash: prep.body.hubHash } })), 'pool_new indexed');
    const pool = await db.prisma.pool.findFirstOrThrow({ where: { hubHash: prep.body.hubHash } });
    expect(pool).toMatchObject({ state: 'Open', shareSlug: prep.body.shareSlug, hubAddress: 'Wuse Market Gate B', offerId: offer.body.id });
    const poolId = pool.id.toString();

    // ---- commits across both price breaks ----
    const units = [30, 30, 30, 40, 40]; // running totals 30, 60, 90, 130, 170: crosses the 50, 100 and 150 breaks
    let before = 0;
    for (let i = 0; i < traders.length; i++) {
      // The quote is indicative: it reads the indexed pool, which can lag a commit that just landed.
      await http().get(`/v1/pools/${poolId}/quote?units=${units[i]}`).set(auth(traders[i]!.token)).expect(200);
      await act(traders[i]!, `/v1/pools/${poolId}/commit/prepare`, { units: units[i] });
      before += units[i]!;
    }
    expect(before).toBe(170);
    await sync(async () => (await db.prisma.pool.findUniqueOrThrow({ where: { id: pool.id } })).totalUnits === 170, 'all commitments indexed');
    // Each member pays the ceiling price: the tier the pool was in before their units.
    const commitRows = await db.prisma.commitment.findMany({ where: { poolId: pool.id } });
    const paidBy = new Map(commitRows.map((c) => [c.memberAddress, toStroops(c.paid.toString())]));
    const paid = traders.map((t) => paidBy.get(t.kp.publicKey())!);
    const p1 = tiers[0]!.price;
    const p2 = tiers[1]!.price;
    // 30,30,30,40 units commit while the pool is below 100 units (tier 1 price); the last 40 commit at 130 units (tier 2 price)
    expect(paid.map(String)).toEqual([30n * p1, 30n * p1, 30n * p1, 40n * p1, 40n * p2].map(String));
    const filledView = await db.prisma.pool.findUniqueOrThrow({ where: { id: pool.id } });
    expect(toStroops(filledView.escrowBalance.toString())).toBe(paid.reduce((a, b) => a + b, 0n)); // indexed escrow equals what members paid

    // ---- fill: wait for the deadline, then the keeper closes the pool ----
    await sleep(Math.max(0, deadline.getTime() - Date.now()) + 15_000);
    await sync(async () => { const r = await keeperTick(s); return r.ok > 0 || (await db.prisma.pool.findUniqueOrThrow({ where: { id: pool.id } })).state === 'Filled'; }, 'keeper close');
    await sync(async () => (await db.prisma.pool.findUniqueOrThrow({ where: { id: pool.id } })).state === 'Filled', 'pool Filled');
    const filled = await db.prisma.pool.findUniqueOrThrow({ where: { id: pool.id } });
    const expectedFinal = tiers.filter((t) => t.minUnits <= 170).at(-1)!.price; // 170 units reaches the 150-unit tier
    expect(toStroops(filled.finalUnitPrice!.toString())).toBe(expectedFinal);

    // ---- supplier accepts and dispatches; organizer confirms a short delivery ----
    await act(supplier, `/v1/pools/${poolId}/accept/prepare`, {});
    await act(supplier, `/v1/pools/${poolId}/dispatch/prepare`, {});
    const photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#2a2' } }).png().toBuffer();
    const up = await http().post('/v1/uploads/sign').set(auth(organizer.token)).send({ kind: 'DELIVERY', mime: 'image/png', size: photo.length, poolId }).expect(201);
    await http().put(up.body.uploadUrl).set('Content-Type', 'image/png').send(photo).expect(200);
    const received = 160; // 10 units short of 170
    await act(organizer, `/v1/pools/${poolId}/delivery/prepare`, { receivedUnits: received, evidenceIds: [up.body.evidenceId] });
    await sync(async () => (await db.prisma.pool.findUniqueOrThrow({ where: { id: pool.id } })).state === 'Delivered', 'Delivered');
    expect((await db.prisma.pool.findUniqueOrThrow({ where: { id: pool.id } })).allocationPending).toBe(true);

    // ---- keeper allocates the shortfall ----
    await sync(async () => { await keeperTick(s); return !(await db.prisma.pool.findUniqueOrThrow({ where: { id: pool.id } })).allocationPending; }, 'shortfall allocated');

    // ---- members collect; early release lets the keeper settle ----
    for (const t of traders.slice(0, 4)) await act(t, `/v1/pools/${poolId}/pickup/prepare`, {});
    // Tick the keeper only until the pool is settled: its push-refunds job would otherwise pay everyone before
    // the two members below claim by hand, and we want to exercise both refund paths.
    await sync(async () => {
      if ((await db.prisma.pool.findUniqueOrThrow({ where: { id: pool.id } })).state === 'Settled') return true;
      await keeperTick(s);
      return false;
    }, 'Settled');

    // ---- refunds: two members claim via the API, the keeper pushes the rest ----
    const balBefore = await Promise.all(traders.map((t) => usdcBalance(t.kp.publicKey())));
    await act(traders[0]!, `/v1/pools/${poolId}/refund/prepare`, {});
    await act(traders[1]!, `/v1/pools/${poolId}/refund/prepare`, {});
    await sync(async () => { await keeperTick(s); return (await db.prisma.pool.findUniqueOrThrow({ where: { id: pool.id } })).refundsPushed; }, 'refunds pushed');

    // ---- verify the money on-chain ----
    const gross = BigInt(received) * expectedFinal;
    const platform = (gross * 150n) / 10_000n;
    const orgFee = (gross * 100n) / 10_000n;
    expect(await usdcBalance(supplier.kp.publicKey())).toBe(gross - platform - orgFee);
    expect(await usdcBalance(organizer.kp.publicKey())).toBe(orgFee);
    const totalPaid = paid.reduce((a, b) => a + b, 0n);
    const after = await Promise.all(traders.map((t) => usdcBalance(t.kp.publicKey())));
    const totalRefunds = after.reduce((a, b, i) => a + (b - balBefore[i]!), 0n);
    expect(totalRefunds).toBe(totalPaid - gross); // every stroop of tier difference and shortfall came back
    const leftBehind = (await usdcBalance(deployments.contracts.group_buy.id)) - escrowBefore;
    expect(leftBehind >= 0n && leftBehind < 10n).toBe(true); // this pool leaves nothing in escrow but rounding dust
  }, 900_000);
});
