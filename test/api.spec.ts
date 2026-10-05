import { Keypair, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import sharp from 'sharp';
import { startHarness, PHONE_ADMIN, PHONE_ARBITER, type Harness } from './harness.js';
import { StaticFxProvider } from '../src/app/services.js';
import { Projector } from '../src/indexer/projector.js';
import { PrismaReadStore } from '../src/persistence/prisma-stores.js';
import { decodeEvent } from '../src/indexer/decode.js';
import { a, bytes, i128, raw, tup, u32, u64 } from './events.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); }, 60_000);
afterAll(async () => { await h.close(); });

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let phoneN = 10;
const newPhone = () => `+23480300000${String(phoneN++).padStart(2, '0')}`;

const offerBody = () => ({
  title: 'Mama Gold Rice 50kg', brand: 'Mama Gold', branded: true, description: 'Parboiled long grain rice', unitLabel: '50kg bag', category: 'rice',
  perishable: false, images: ['a.webp', 'b.webp'], tiersNgn: [{ minUnits: 100, priceNgn: '75000' }, { minUnits: 200, priceNgn: '72000' }, { minUnits: 400, priceNgn: '70000' }],
  moq: 100, maxUnits: 500, maxPerMember: 250, leadTimeHours: 72, deliveryAreas: [{ state: 'FCT', lga: 'Abuja Municipal' }], validUntil: new Date(Date.now() + 7 * 86400_000).toISOString(),
});

async function approvedSupplier() {
  const s = await h.login(newPhone());
  const kp = Keypair.random();
  await h.bindWallet(s.token, kp);
  await h.http().post('/v1/suppliers/apply').set(auth(s.token)).send({
    businessName: 'Tunde Foods Ltd', cacNumber: 'RC1234567', address: '12 Market Rd', state: 'FCT', lga: 'Abuja Municipal', categories: ['rice'], deliveryAreas: [{ state: 'FCT' }],
  }).expect(200);
  const admin = await h.login(PHONE_ADMIN);
  await h.http().post(`/v1/admin/suppliers/${s.userId}/decision`).set(auth(admin.token)).send({ approve: true }).expect(200);
  const fresh = await h.http().post('/v1/auth/otp/request').send({ phone: (await h.db.prisma.user.findUniqueOrThrow({ where: { id: s.userId } })).phone });
  const login = await h.http().post('/v1/auth/otp/verify').send({ phone: fresh.body.phone, code: fresh.body.devCode });
  return { ...s, kp, token: login.body.accessToken as string, adminToken: admin.token };
}

describe('auth', () => {
  it('logs in by OTP, rotates refresh tokens, and rejects missing or wrong-role tokens', async () => {
    const u = await h.login(newPhone());
    expect(u.roles).toEqual(['TRADER']);
    await h.http().get('/v1/me').expect(401);
    const me = await h.http().get('/v1/me').set(auth(u.token)).expect(200);
    expect(me.body.roles).toEqual(['TRADER']);
    await h.http().get('/v1/admin/audit').set(auth(u.token)).expect(403);
    const r1 = await h.http().post('/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(u.refreshToken);
    await h.http().post('/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(401); // replay is refused
    await h.http().post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401); // and kills the family
  });

  it('refuses bad phones and wrong codes', async () => {
    await h.http().post('/v1/auth/otp/request').send({ phone: '12345' }).expect(400);
    const p = newPhone();
    await h.http().post('/v1/auth/otp/request').send({ phone: p }).expect(200);
    await h.http().post('/v1/auth/otp/verify').send({ phone: p, code: '000000' }).expect(401);
  });

  it('grants bootstrap roles only to configured phones', async () => {
    expect((await h.login(PHONE_ADMIN)).roles).toContain('ADMIN');
    expect((await h.login(PHONE_ARBITER)).roles).toContain('ARBITER');
  });

  it('refuses dev-only settings in production', async () => {
    await expect(startHarness({ NODE_ENV: 'production', OTP_DEV_ECHO: 'true' })).rejects.toThrow(/development-only/);
  });
});

describe('wallets', () => {
  it('binds a wallet only with a valid signature over the challenge, once per account', async () => {
    const u = await h.login(newPhone());
    const kp = Keypair.random();
    const c = await h.http().get('/v1/wallets/challenge').set(auth(u.token));
    const bad = Buffer.from(Keypair.random().sign(Buffer.from(c.body.challenge))).toString('base64');
    await h.http().post('/v1/wallets').set(auth(u.token)).send({ address: kp.publicKey(), signature: bad }).expect(401);
    await h.bindWallet(u.token, kp);
    const other = await h.login(newPhone());
    const c2 = await h.http().get('/v1/wallets/challenge').set(auth(other.token));
    const sig = Buffer.from(kp.sign(Buffer.from(c2.body.challenge))).toString('base64');
    await h.http().post('/v1/wallets').set(auth(other.token)).send({ address: kp.publicKey(), signature: sig }).expect(401); // wallet already taken
    await h.http().post('/v1/wallets').set(auth(other.token)).send({ address: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526', signature: sig }).expect(401); // smart wallet not yet supported
  });
});

describe('suppliers and catalog', () => {
  it('only an approved supplier can publish; approval writes an attestation signed by the attestor key', async () => {
    const s = await approvedSupplier();
    const att = h.chain.calls.filter((c) => c.fn === 'attest').at(-1)!;
    expect(att.contract).toBe('registry');
    expect(att.signers).toEqual([h.attestor.publicKey()]);
    expect(att.args![2]).toEqual(['Supplier']);

    const created = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody()).expect(201);
    const pub = await h.http().post(`/v1/offers/${created.body.id}/publish`).set(auth(s.token)).expect(200);
    expect(pub.body.status).toBe('LIVE');
    expect(pub.body.offerHash).toMatch(/^[0-9a-f]{64}$/);
    // 75,000 NGN at a median of 1502.5 NGN/USD is 49.9168 USDC, rounded down to a stroop
    expect(BigInt(pub.body.tiersUsdc[0].unitPrice)).toBe((75000n * 10_000_000n * 1_000_000n) / 1_502_500_000n);
    const listed = await h.http().get('/v1/offers?category=rice&state=FCT').expect(200);
    expect(listed.body.some((o: { id: string }) => o.id === created.body.id)).toBe(true);
    expect((await h.http().get('/v1/offers?category=fabric')).body).toEqual([]);
  });

  it('refuses unverified suppliers, invalid offers and divergent FX', async () => {
    const u = await h.login(newPhone());
    await h.bindWallet(u.token, Keypair.random());
    await h.http().post('/v1/suppliers/apply').set(auth(u.token)).send({ businessName: 'New Co', cacNumber: 'RC7654321', address: '1 Road', state: 'FCT', lga: 'Bwari', categories: ['rice'], deliveryAreas: [{ state: 'FCT' }] }).expect(200);
    const login = await h.http().post('/v1/auth/otp/request').send({ phone: (await h.db.prisma.user.findUniqueOrThrow({ where: { id: u.userId } })).phone });
    const token = (await h.http().post('/v1/auth/otp/verify').send({ phone: login.body.phone, code: login.body.devCode })).body.accessToken as string;
    const o = await h.http().post('/v1/offers').set(auth(token)).send(offerBody()).expect(201);
    await h.http().post(`/v1/offers/${o.body.id}/publish`).set(auth(token)).expect(403); // KYB pending

    const s = await approvedSupplier();
    const bad = await h.http().post('/v1/offers').set(auth(s.token)).send({ ...offerBody(), title: 'Cold beer crate', images: ['one.webp'] }).expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/banned keyword/);
    expect(JSON.stringify(bad.body)).toMatch(/photos/);

    const good = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody()).expect(201);
    const original = h.s.fx;
    h.s.fx = new StaticFxProvider([1500, 1600]);
    const r = await h.http().post(`/v1/offers/${good.body.id}/publish`).set(auth(s.token)).expect(400);
    expect(r.body.error).toBe('FX_DIVERGENCE');
    h.s.fx = original;
    await h.http().post(`/v1/offers/${good.body.id}/publish`).set(auth(s.token)).expect(200);
    await h.http().post(`/v1/offers/${good.body.id}/refresh-fx`).set(auth(s.token)).send({ validUntil: new Date(Date.now() + 30 * 86400_000).toISOString() }).expect(400); // over 14 days
  });
});

describe('pools', () => {
  async function livePool() {
    const s = await approvedSupplier();
    const offer = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody());
    await h.http().post(`/v1/offers/${offer.body.id}/publish`).set(auth(s.token));
    const org = await h.login(newPhone());
    const orgKp = Keypair.random();
    await h.bindWallet(org.token, orgKp);
    await h.http().post(`/v1/admin/users/${org.userId}/roles`).set(auth(s.adminToken)).send({ role: 'ORGANIZER' }).expect(200);
    const orgLogin = await h.http().post('/v1/auth/otp/request').send({ phone: (await h.db.prisma.user.findUniqueOrThrow({ where: { id: org.userId } })).phone });
    const orgToken = (await h.http().post('/v1/auth/otp/verify').send({ phone: orgLogin.body.phone, code: orgLogin.body.devCode })).body.accessToken as string;
    const prep = await h.http().post('/v1/pools/prepare').set(auth(orgToken)).send({
      offerId: offer.body.id, fillDeadline: new Date(Date.now() + 3 * 86400_000).toISOString(), hub: { address: 'Wuse Market Gate B', contact: '08031234567' },
      pickupWindow: { from: 'Mon 9am', to: 'Mon 5pm' }, organizerFeeBp: 50, clusterOnly: false,
    }).expect(201);
    return { s, offerId: offer.body.id as string, org, orgKp, orgToken, prep: prep.body };
  }

  it('prepares create_pool with the offer snapshot and records the hub under a unique hash', async () => {
    const p = await livePool();
    const call = h.chain.calls.filter((c) => c.fn === 'create_pool').at(-1)!;
    const terms = call.args![1] as Record<string, unknown>;
    expect(call.args![0]).toBe(p.orgKp.publicKey());
    expect(terms.moq).toBe(100);
    expect((terms.tiers as unknown[]).length).toBe(3);
    expect(terms.lead_time_secs).toBe(72n * 3600n);
    expect(call.args![3]).toBe(50);
    const pending = await h.db.prisma.pendingPool.findUniqueOrThrow({ where: { hubHash: p.prep.hubHash } });
    expect(pending.hubAddress).toBe('Wuse Market Gate B');
    expect(Buffer.from(call.args![2] as Uint8Array).toString('hex')).toBe(p.prep.hubHash);
    await h.http().post('/v1/pools/prepare').set(auth(p.s.token)).send({}).expect(403); // a plain supplier is not an organizer
  });

  it('serves quotes, a public preview and a share card once the pool is indexed', async () => {
    const p = await livePool();
    const proj = new Projector(new PrismaReadStore(h.db.prisma));
    const offer = await h.db.prisma.offer.findUniqueOrThrow({ where: { id: p.offerId } });
    const id = BigInt(Date.now()) * 10n;
    const apply = (r: ReturnType<typeof raw>) => proj.apply(decodeEvent(r)!);
    await apply(raw('group_buy', 'pool_new', u64(id), tup(a(p.orgKp.publicKey()), a((await h.db.prisma.user.findUniqueOrThrow({ where: { id: offer.supplierId } })).walletAddress!), bytes(7), nativeToScVal(Buffer.from(p.prep.hubHash, 'hex'))), 10));
    await apply(raw('group_buy', 'committed', u64(id), tup(a(Keypair.random().publicKey()), u32(150), i128(1_000_000_000n)), 11));

    const preview = await h.http().get(`/v1/p/${p.prep.shareSlug}`).expect(200);
    expect(preview.body).toMatchObject({ state: 'Open', totalUnits: 150, moq: 100, hub: { address: 'Wuse Market Gate B' } });
    expect(preview.body.nextBreak.unitsToGo).toBe(50); // 200 - 150
    expect(preview.body.trustMessage).toMatch(/held safely/);
    expect(preview.body.currentUnitPriceNaira).toMatch(/^[\d,]+$/);

    const t = await h.login(newPhone());
    const q = await h.http().get(`/v1/pools/${id}/quote?units=60`).set(auth(t.token)).expect(200);
    expect(q.body.amountNowUsdc).toBe((60n * BigInt(offer.tiersUsdc ? (offer.tiersUsdc as { unitPrice: string }[])[0]!.unitPrice : '0')).toString()); // tier-1 ceiling price
    expect(q.body.nextBreak).toBeTruthy();
    await h.http().get(`/v1/pools/${id}/quote?units=0`).set(auth(t.token)).expect(400);

    const png = await h.http().get(`/v1/pools/${id}/sharecard.png`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    const meta = await sharp(png.body as Buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 1200, 630]);
  });

  it('maps pool actions to the right contract calls for the signed-in wallet', async () => {
    const p = await livePool();
    const t = await h.login(newPhone());
    const kp = Keypair.random();
    await h.bindWallet(t.token, kp);
    await h.http().post('/v1/pools/5/commit/prepare').set(auth(t.token)).send({ units: 30 }).expect(201);
    const c = h.chain.calls.at(-1)!;
    expect([c.contract, c.fn, c.args![0], c.args![1], c.args![2]]).toEqual(['group_buy', 'commit', kp.publicKey(), 5n, 30]);
    const n = await h.http().post('/v1/pools/5/commit/prepare').set(auth(t.token)).send({ units: 30, method: 'NGN' }).expect(400);
    expect(n.body.error).toBe('NOT_IMPLEMENTED');
    await h.http().post('/v1/pools/5/nonsense/prepare').set(auth(t.token)).send({}).expect(404);
    await h.http().post('/v1/pools/5/delivery/prepare').set(auth(p.orgToken)).send({ receivedUnits: 10, evidenceIds: ['nope'] }).expect(400);
  });
});

describe('transaction submission', () => {
  async function prepared() {
    const u = await h.login(newPhone());
    const kp = Keypair.random();
    await h.bindWallet(u.token, kp);
    const p = await h.http().post('/v1/pools/9/commit/prepare').set(auth(u.token)).send({ units: 5 }).expect(201);
    return { u, kp, p: p.body };
  }

  it('submits once per idempotency key and replays the stored result', async () => {
    const { u, p } = await prepared();
    const before = h.chain.calls.filter((c) => c.kind === 'submit').length;
    const body = { txXdr: p.txXdr, signedAuthEntries: p.authEntries, idempotencyKey: 'key-' + u.userId };
    const r1 = await h.http().post('/v1/tx/submit').set(auth(u.token)).send(body).expect(200);
    const r2 = await h.http().post('/v1/tx/submit').set(auth(u.token)).send(body).expect(200);
    expect(r2.body).toEqual(r1.body);
    expect(r1.body).toMatchObject({ hash: 'ab'.repeat(32), fn: 'commit', returnValue: '7' });
    expect(h.chain.calls.filter((c) => c.kind === 'submit').length).toBe(before + 1);
    const other = await h.login(newPhone());
    await h.http().post('/v1/tx/submit').set(auth(other.token)).send(body).expect(400); // someone else's key
  });

  it('refuses a transaction for another wallet and does not spend sponsorship on it', async () => {
    const { p } = await prepared();
    const stranger = await h.login(newPhone());
    await h.bindWallet(stranger.token, Keypair.random());
    const r = await h.http().post('/v1/tx/submit').set(auth(stranger.token)).send({ txXdr: p.txXdr, signedAuthEntries: p.authEntries, idempotencyKey: 'stolen-' + stranger.userId }).expect(403);
    expect(r.body.error).toBe('WRONG_SIGNER');
  });

  it('frees the idempotency key when the chain call fails so the client can retry', async () => {
    const { u, p } = await prepared();
    h.chain.failNextSubmit = new Error('HostError: Error(Contract, #310)');
    const body = { txXdr: p.txXdr, signedAuthEntries: p.authEntries, idempotencyKey: 'retry-' + u.userId };
    const fail = await h.http().post('/v1/tx/submit').set(auth(u.token)).send(body).expect(422);
    expect(fail.body).toMatchObject({ error: 'CONTRACT_ERROR', contractCode: 310 });
    await h.http().post('/v1/tx/submit').set(auth(u.token)).send(body).expect(200);
  });
});

describe('uploads and evidence', () => {
  it('stores evidence with a server-computed hash, limits access, and serves short-lived links', async () => {
    const u = await h.login(newPhone());
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#0a0' } }).png().toBuffer();
    const sign = await h.http().post('/v1/uploads/sign').set(auth(u.token)).send({ kind: 'DISPUTE', mime: 'image/png', size: png.length, poolId: '7' }).expect(201);
    await h.http().put(sign.body.uploadUrl.replace(/s=[^&]+/, 's=forged')).set('Content-Type', 'image/png').send(png).expect(401); // forged signature
    await h.http().get(sign.body.uploadUrl).expect(404); // an upload link is not a read link
    const put = await h.http().put(sign.body.uploadUrl).set('Content-Type', 'image/png').send(png).expect(200);
    const { createHash } = await import('node:crypto');
    expect(put.body.sha256).toBe(createHash('sha256').update(png).digest('hex'));
    await h.http().put(sign.body.uploadUrl).set('Content-Type', 'image/png').send(png).expect(400); // slot already used

    const url = await h.http().get(`/v1/evidence/${sign.body.evidenceId}/url`).set(auth(u.token)).expect(200);
    const file = await h.http().get(url.body.url).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect((file.body as Buffer).equals(png)).toBe(true);

    const stranger = await h.login(newPhone());
    await h.http().get(`/v1/evidence/${sign.body.evidenceId}/url`).set(auth(stranger.token)).expect(403);
    await h.http().get(url.body.url.replace(/s=[^&]+/, 's=forged')).expect(401);
    await h.http().post('/v1/uploads/sign').set(auth(u.token)).send({ kind: 'DISPUTE', mime: 'application/x-msdownload', size: 10 }).expect(400);
  });
});

describe('disputes and arbiter', () => {
  it('requires uploaded evidence to open a dispute, and arbiter role to resolve one', async () => {
    const u = await h.login(newPhone());
    await h.bindWallet(u.token, Keypair.random());
    await h.http().post('/v1/disputes/prepare').set(auth(u.token)).send({ poolId: '7', reason: 'Damaged', claimedUnits: 2, evidenceIds: ['missing'] }).expect(400);
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#a00' } }).png().toBuffer();
    const sign = await h.http().post('/v1/uploads/sign').set(auth(u.token)).send({ kind: 'DISPUTE', mime: 'image/png', size: png.length, poolId: '7' });
    await h.http().put(sign.body.uploadUrl).set('Content-Type', 'image/png').send(png);
    await h.http().post('/v1/disputes/prepare').set(auth(u.token)).send({ poolId: '7', reason: 'Damaged', claimedUnits: 2, evidenceIds: [sign.body.evidenceId] }).expect(201);
    expect(h.chain.calls.at(-1)).toMatchObject({ contract: 'disputes', fn: 'open' });

    await h.http().get('/v1/arbiter/queue').set(auth(u.token)).expect(403);
    const arb = await h.login(PHONE_ARBITER);
    await h.bindWallet(arb.token, Keypair.random());
    const proj = new Projector(new PrismaReadStore(h.db.prisma));
    const poolId = BigInt(Date.now()) * 10n + 1n;
    await proj.apply(decodeEvent(raw('group_buy', 'pool_new', u64(poolId), tup(a(Keypair.random().publicKey()), a(Keypair.random().publicKey()), bytes(1), bytes(2)), 20))!);
    await proj.apply(decodeEvent(raw('disputes', 'd_open', u64(77n), tup(u64(poolId), a(Keypair.random().publicKey()), i128(5_000_000n)), 21))!);
    const q = await h.http().get('/v1/arbiter/queue').set(auth(arb.token)).expect(200);
    expect(q.body.map((d: { id: string }) => d.id)).toContain('77');
    const res = await h.http().post('/v1/arbiter/disputes/77/resolve/prepare').set(auth(arb.token)).send({ outcome: { kind: 'Split', bp: 2500 }, reasoning: 'Photos show partial damage; split 25/75.' }).expect(201);
    expect(res.body.reasoningHash).toMatch(/^[0-9a-f]{64}$/);
    const call = h.chain.calls.at(-1)!;
    expect(call).toMatchObject({ contract: 'disputes', fn: 'resolve' });
    expect(call.args![2]).toEqual(['Split', 2500]);
    await h.http().post('/v1/arbiter/disputes/77/resolve/prepare').set(auth(arb.token)).send({ outcome: { kind: 'Split', bp: 99999 }, reasoning: 'too large bp value here' }).expect(400);
    const log = await h.db.prisma.auditLog.findFirstOrThrow({ where: { action: 'dispute.reasoning', target: '77' } });
    expect((log.data as { hash: string }).hash).toBe(res.body.reasoningHash);
    expect(scValToNative(nativeToScVal(1))).toBeDefined();
  });
});

describe('trader profile and pool cards', () => {
  it('stores the market and derives a cluster slug', async () => {
    const u = await h.login(newPhone());
    await h.http().get('/v1/me/profile').set(auth(u.token)).expect(200);
    const r = await h.http().put('/v1/me/profile').set(auth(u.token)).send({ market: "Wuse Market, Zone 4", state: 'FCT', lga: 'Abuja Municipal' }).expect(200);
    expect(r.body).toMatchObject({ market: 'Wuse Market, Zone 4', cluster: 'wuse_market_zone_4' });
    await h.http().put('/v1/me/profile').set(auth(u.token)).send({ market: 'x' }).expect(400);
    expect((await h.http().get('/v1/me/profile').set(auth(u.token))).body.cluster).toBe('wuse_market_zone_4');
  });
});

describe('dev faucet', () => {
  it('is registered off mainnet in development and absent in production and on mainnet', async () => {
    const { AppModule } = await import('../src/app/app.module.js');
    const { DevController } = await import('../src/app/dev.controller.js');
    const has = (env: Partial<typeof h.s.env>) => (AppModule.forRoot({ ...h.s, env: { ...h.s.env, ...env } } as never).controllers ?? []).includes(DevController);
    expect(has({ NODE_ENV: 'development', STELLAR_NETWORK: 'testnet' })).toBe(true);
    expect(has({ NODE_ENV: 'production', STELLAR_NETWORK: 'testnet' })).toBe(false);
    expect(has({ NODE_ENV: 'development', STELLAR_NETWORK: 'mainnet' })).toBe(false);
  });
  it('requires a signed-in user with a wallet', async () => {
    await h.http().post('/v1/dev/faucet/start').expect(401);
    const u = await h.login(newPhone());
    await h.http().post('/v1/dev/faucet/start').set(auth(u.token)).expect(400); // no wallet bound yet
  });
});

describe('role changes take effect immediately', () => {
  it('lets a newly granted role work with the existing token, and a revoked role stop working', async () => {
    const u = await h.login(newPhone());
    await h.http().get('/v1/arbiter/queue').set(auth(u.token)).expect(403);
    await h.db.prisma.userRole.create({ data: { userId: u.userId, role: 'ARBITER' } });
    await h.http().get('/v1/arbiter/queue').set(auth(u.token)).expect(200); // same token, no re-login needed
    await h.db.prisma.userRole.delete({ where: { userId_role: { userId: u.userId, role: 'ARBITER' } } });
    await h.http().get('/v1/arbiter/queue').set(auth(u.token)).expect(403); // revoked: effective at once
  });
});
