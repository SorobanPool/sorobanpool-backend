import { Keypair, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import sharp from 'sharp';
import { startHarness, PHONE_ADMIN, PHONE_ARBITER, type Harness } from './harness.js';
import { StaticFxProvider } from '../src/app/services.js';
import { Projector } from '../src/indexer/projector.js';
import { PrismaReadStore } from '../src/persistence/prisma-stores.js';
import { decodeEvent } from '../src/indexer/decode.js';
import { affectedPools } from '../src/workers/runners.js';
import type { Prisma } from '../src/generated/prisma/client.js';
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

async function secondAdmin() {
  const admin = await h.login(newPhone());
  await h.bindWallet(admin.token, Keypair.random());
  await h.db.prisma.userRole.upsert({
    where: { userId_role: { userId: admin.userId, role: 'ADMIN' } },
    create: { userId: admin.userId, role: 'ADMIN' },
    update: {},
  });
  return admin;
}

async function pendingSupplierApproval() {
  const supplier = await h.login(newPhone());
  const kp = Keypair.random();
  await h.bindWallet(supplier.token, kp);
  await h.http().post('/v1/suppliers/apply').set(auth(supplier.token)).send({
    businessName: 'Tunde Foods Ltd', cacNumber: 'RC1234567', address: '12 Market Rd', state: 'FCT', lga: 'Abuja Municipal', categories: ['rice'], deliveryAreas: [{ state: 'FCT' }],
  }).expect(200);
  const admin = await h.login(PHONE_ADMIN);
  const response = await h.http().post(`/v1/admin/suppliers/${supplier.userId}/decision`).set(auth(admin.token)).send({ approve: true }).expect(200);
  return { supplier, kp, admin, actionId: response.body.actionId as string };
}

async function approvedSupplier() {
  const application = await pendingSupplierApproval();
  await h.http().post(`/v1/admin/actions/${application.actionId}/approve`).set(auth((await secondAdmin()).token)).expect(200);
  const fresh = await h.http().post('/v1/auth/otp/request').send({ phone: (await h.db.prisma.user.findUniqueOrThrow({ where: { id: application.supplier.userId } })).phone });
  const login = await h.http().post('/v1/auth/otp/verify').send({ phone: fresh.body.phone, code: fresh.body.devCode });
  return { ...application.supplier, kp: application.kp, token: login.body.accessToken as string, adminToken: application.admin.token };
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

  it('logs out both devices, invalidates their bearer tokens, and records an audit event (#58)', async () => {
    const first = await h.login(newPhone());
    const phone = (await h.db.prisma.user.findUniqueOrThrow({ where: { id: first.userId } })).phone;
    const otp = await h.http().post('/v1/auth/otp/request').send({ phone }).expect(200);
    const second = await h.http().post('/v1/auth/otp/verify').send({ phone, code: otp.body.devCode }).expect(200);
    const other = await h.login(newPhone());

    expect(second.body.accessToken).not.toBe(first.token);
    expect((await h.db.prisma.session.findMany({ where: { userId: first.userId } })).length).toBe(2);
    await h.http().post('/v1/auth/logout-all').expect(401);
    await h.http().get('/v1/me').set(auth(first.token)).expect(200);
    await h.http().get('/v1/me').set(auth(second.body.accessToken)).expect(200);

    await h.http().post('/v1/auth/logout-all').set(auth(first.token)).expect(204);

    const sessions = await h.db.prisma.session.findMany({ where: { userId: first.userId } });
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);
    const audit = await h.db.prisma.auditLog.findFirstOrThrow({
      where: { actorId: first.userId, action: 'auth.logout_all', target: first.userId },
    });
    expect(audit.data).toEqual({ revokedSessions: 2 });

    await h.http().get('/v1/me').set(auth(first.token)).expect(401);
    await h.http().get('/v1/me').set(auth(second.body.accessToken)).expect(401);
    await h.http().post('/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
    await h.http().post('/v1/auth/refresh').send({ refreshToken: second.body.refreshToken }).expect(401);
    await h.http().get('/v1/me').set(auth(other.token)).expect(200);
    await h.http().post('/v1/auth/refresh').send({ refreshToken: other.refreshToken }).expect(200);
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

  it('requires a different admin to approve supplier approval and records both decisions', async () => {
    const pending = await pendingSupplierApproval();
    await h.http().post(`/v1/admin/actions/${pending.actionId}/approve`).set(auth(pending.admin.token)).expect(403);
    expect((await h.db.prisma.pendingAdminAction.findUniqueOrThrow({ where: { id: pending.actionId } })).status).toBe('PENDING');

    const reviewer = await secondAdmin();
    await h.http().post(`/v1/admin/actions/${pending.actionId}/approve`).set(auth(reviewer.token)).expect(200);
    expect((await h.db.prisma.supplierProfile.findUniqueOrThrow({ where: { userId: pending.supplier.userId } })).kybStatus).toBe('APPROVED');
    expect(await h.db.prisma.auditLog.count({ where: { target: pending.actionId } })).toBeGreaterThanOrEqual(1);
  });

  it('expires pending actions and requires a second admin for suspensions', async () => {
    const expired = await pendingSupplierApproval();
    await h.db.prisma.pendingAdminAction.update({ where: { id: expired.actionId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await h.http().post(`/v1/admin/actions/${expired.actionId}/approve`).set(auth((await secondAdmin()).token)).expect(410);
    expect((await h.db.prisma.pendingAdminAction.findUniqueOrThrow({ where: { id: expired.actionId } })).status).toBe('EXPIRED');

    const admin = await h.login(PHONE_ADMIN);
    const target = await h.login(newPhone());
    await h.bindWallet(target.token, Keypair.random());
    const requested = await h.http().post(`/v1/admin/users/${target.userId}/suspend`).set(auth(admin.token)).send({ reason: 'review required' }).expect(200);
    expect(requested.body.status).toBe('PENDING_APPROVAL');
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).status).toBe('ACTIVE');
    const response = await h.http().post(`/v1/admin/actions/${requested.body.actionId}/approve`).set(auth((await secondAdmin()).token)).expect(200);
    expect(response.body.status).toBe('SUSPENDED');
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).status).toBe('SUSPENDED');
    expect(h.chain.calls.at(-1)).toMatchObject({ contract: 'registry', fn: 'suspend' });
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
    expect(preview.body.escrowBalanceUsdc).toMatch(/^\d+$/); // whole stroops, never a decimal string
    expect(preview.body).toHaveProperty('filledAt', null); // set once the pool is filled; the supplier screen counts the accept window from it
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

  it('caches public previews and evicts them when an applied event affects the pool', async () => {
    const p = await livePool();
    const proj = new Projector(new PrismaReadStore(h.db.prisma));
    const offer = await h.db.prisma.offer.findUniqueOrThrow({ where: { id: p.offerId } });
    const supplier = (await h.db.prisma.user.findUniqueOrThrow({ where: { id: offer.supplierId } })).walletAddress!;
    const id = BigInt(Date.now()) * 1_000n + BigInt(phoneN++);
    const apply = (r: ReturnType<typeof raw>) => proj.apply(decodeEvent(r)!);
    await apply(raw('group_buy', 'pool_new', u64(id), tup(a(p.orgKp.publicKey()), a(supplier), bytes(7), nativeToScVal(Buffer.from(p.prep.hubHash, 'hex'))), 10));

    const before = h.s.previewCache.size;
    const first = await h.http().get(`/v1/p/${p.prep.shareSlug}`).expect(200);
    expect(h.s.previewCache.size).toBe(before + 1);
    const second = await h.http().get(`/v1/p/${p.prep.shareSlug}`).expect(200);
    expect(second.body).toEqual(first.body);
    expect(h.s.previewCache.size).toBe(before + 1);

    const event = decodeEvent(raw('group_buy', 'committed', u64(id), tup(a(Keypair.random().publicKey()), u32(120), i128(1_000_000_000n)), 11))!;
    expect(await affectedPools(h.s, event)).toEqual([id]);
    for (const affected of await affectedPools(h.s, event)) h.s.previewCache.evictPool(affected);
    await proj.apply(event);
    const after = await h.http().get(`/v1/p/${p.prep.shareSlug}`).expect(200);
    expect(after.body.totalUnits).toBe(120);
    expect(h.s.previewCache.size).toBe(before + 1);
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

  it('filters and pages the public pool list, and limits anonymous results to Open pools', async () => {
    const p = await livePool();
    const me = await h.http().get('/v1/me').set(auth(p.s.token)).expect(200);
    const tag = `filter-${Date.now()}`;
    const id0 = BigInt(Date.now()) * 1_000n + BigInt(phoneN++);
    const base = {
      offerId: p.offerId, organizerAddress: p.orgKp.publicKey(), supplierAddress: me.body.walletAddress as string,
      hubAddress: 'Gate', hubContact: '0803', pickupWindow: {}, fillDeadline: new Date(),
    };
    const make = (n: number, patch: Partial<Prisma.PoolUncheckedCreateInput>) => h.db.prisma.pool.create({
      data: { ...base, id: id0 + BigInt(n), hubHash: `${tag}-${n}`, shareSlug: `${tag}-${n}`, ...patch } as Prisma.PoolUncheckedCreateInput,
    });
    await make(1, { state: 'Open', category: tag, deliveryState: 'FCT', deliveryLga: 'Abuja Municipal', cluster: `${tag}-cluster` });
    await make(2, { state: 'Open', category: `${tag}-b`, deliveryState: 'Lagos', deliveryLga: 'Ikeja', cluster: `${tag}-cluster` });
    await make(3, { state: 'Settled', category: tag, deliveryState: 'FCT', deliveryLga: 'Abuja Municipal', cluster: `${tag}-cluster` });
    await make(4, { state: 'Open', category: tag, deliveryState: 'Kano', deliveryLga: 'Nassarawa', cluster: `${tag}-other` });

    const filtered = await h.http().get(`/v1/pools?category=${tag}&deliveryState=FCT&lga=Abuja%20Municipal&cluster=${tag}-cluster`).expect(200);
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0]).toMatchObject({ id: (id0 + 1n).toString(), category: tag, deliveryState: 'FCT', deliveryLga: 'Abuja Municipal', cluster: `${tag}-cluster`, members: 0 });
    expect((await h.http().get(`/v1/pools?category=${tag}&deliveryState=Lagos`).expect(200)).body).toEqual([]);
    expect((await h.http().get(`/v1/pools?category=${tag}&state=Settled`).expect(200)).body).toEqual([]); // anonymous

    const trader = await h.login(newPhone());
    const authed = await h.http().get(`/v1/pools?category=${tag}&state=Settled`).set(auth(trader.token)).expect(200);
    expect(authed.body.map((r: { id: string }) => r.id)).toEqual([(id0 + 3n).toString()]);
    const mine = await h.http().get(`/v1/pools?category=${tag}&mine=true`).set(auth(p.orgToken)).expect(200);
    expect(mine.body.map((r: { id: string }) => r.id).sort()).toEqual([(id0 + 1n).toString(), (id0 + 3n).toString(), (id0 + 4n).toString()].sort());

    const first = await h.http().get(`/v1/pools?category=${tag}&limit=1`).expect(200);
    expect(first.body.map((r: { id: string }) => r.id)).toEqual([(id0 + 4n).toString()]);
    const cursor = first.headers['x-next-cursor'];
    expect(cursor).toBe((id0 + 4n).toString());
    const second = await h.http().get(`/v1/pools?category=${tag}&limit=1&cursor=${cursor}`).expect(200);
    expect(second.body.map((r: { id: string }) => r.id)).toEqual([(id0 + 1n).toString()]);
    expect(second.headers['x-next-cursor']).toBeUndefined();
  });

  describe('pool activity feed (#79)', () => {
    let poolId: bigint;
    let organizerToken: string;
    let member: string;
    let proj: Projector;
    let base: number;

    beforeAll(async () => {
      const p = await livePool();
      organizerToken = p.orgToken;
      const offer = await h.db.prisma.offer.findUniqueOrThrow({ where: { id: p.offerId } });
      const supplier = (await h.db.prisma.user.findUniqueOrThrow({ where: { id: offer.supplierId } })).walletAddress!;
      proj = new Projector(new PrismaReadStore(h.db.prisma));
      poolId = BigInt(Date.now()) * 1_000n + BigInt(phoneN++);
      member = Keypair.random().publicKey();
      base = 100;
      const apply = (r: ReturnType<typeof raw>) => proj.apply(decodeEvent(r)!);
      await apply(raw('group_buy', 'pool_new', u64(poolId), tup(a(p.orgKp.publicKey()), a(supplier), bytes(7), nativeToScVal(Buffer.from(p.prep.hubHash, 'hex'))), base));
      await apply(raw('group_buy', 'committed', u64(poolId), tup(a(member), u32(10), i128(1_000_000_000n)), base + 1));
      await apply(raw('group_buy', 'tier_up', u64(poolId), tup(u32(1)), base + 2));
      await apply(raw('group_buy', 'filled', u64(poolId), tup(u32(120), i128(1_000_000n)), base + 3));
      await apply(raw('group_buy', 'dispatch', u64(poolId), tup(), base + 4));
    });

    const types = (body: { events: { type: string }[] }) => body.events.map((e) => e.type);

    it('returns events newest first and pages with a cursor that survives new events', async () => {
      const url = `/v1/pools/${poolId}/activity`;
      const first = await h.http().get(`${url}?limit=2`).set(auth(organizerToken)).expect(200);
      expect(types(first.body)).toEqual(['dispatched', 'filled']);
      expect(first.body.nextCursor).toBe(first.headers['x-next-cursor']);
      const cursor = first.body.nextCursor as string;

      await proj.apply(decodeEvent(raw('group_buy', 'accepted', u64(poolId), tup(), base + 5))!);
      const second = await h.http().get(`${url}?limit=2&cursor=${cursor}`).set(auth(organizerToken)).expect(200);
      expect(types(second.body)).toEqual(['price_break', 'joined']);
      const third = await h.http().get(`${url}?limit=2&cursor=${second.body.nextCursor}`).set(auth(organizerToken)).expect(200);
      expect(types(third.body)).toEqual(['created']);
      expect(third.body.nextCursor).toBeNull();
      expect(third.headers['x-next-cursor']).toBeUndefined();
    });

    it('redacts actor addresses and never returns raw event payloads', async () => {
      const feed = await h.http().get(`/v1/pools/${poolId}/activity`).set(auth(organizerToken)).expect(200);
      const joined = feed.body.events.find((e: { type: string }) => e.type === 'joined');
      expect(joined.actor).toBe(`${member.slice(0, 4)}…${member.slice(-4)}`);
      expect(JSON.stringify(feed.body)).not.toContain(member);
      expect(joined).not.toHaveProperty('payload');
      expect(joined).not.toHaveProperty('member');
    });

    it('shows only aggregate events to the public, and member events to participants', async () => {
      const url = `/v1/pools/${poolId}/activity`;
      const anon = await h.http().get(url).expect(200);
      expect(types(anon.body)).toEqual(expect.arrayContaining(['price_break', 'filled', 'dispatched']));
      expect(types(anon.body)).not.toContain('joined');
      expect(JSON.stringify(anon.body)).not.toContain(member);

      const stranger = await h.login(newPhone());
      expect(types((await h.http().get(url).set(auth(stranger.token)).expect(200)).body)).not.toContain('joined');

      const memberUser = await h.login(newPhone());
      const memberKp = Keypair.random();
      await h.bindWallet(memberUser.token, memberKp);
      await proj.apply(decodeEvent(raw('group_buy', 'committed', u64(poolId), tup(a(memberKp.publicKey()), u32(2), i128(100_000_000n)), base + 6))!);
      const mine = (await h.http().get(url).set(auth(memberUser.token)).expect(200)).body.events.find((e: { type: string }) => e.type === 'joined');
      expect(mine.actor).toBe(`${memberKp.publicKey().slice(0, 4)}…${memberKp.publicKey().slice(-4)}`);
    });

    it('validates the pool id, limit and cursor', async () => {
      await h.http().get(`/v1/pools/${poolId}/activity?limit=0`).expect(400);
      await h.http().get(`/v1/pools/${poolId}/activity?limit=101`).expect(400);
      await h.http().get(`/v1/pools/${poolId}/activity?cursor=nope`).expect(400);
      await h.http().get('/v1/pools/not-a-number/activity').expect(400);
      await h.http().get('/v1/pools/999999999/activity').expect(404);
    });
  });
});

describe('commit pre-sign caps', () => {
  it('rejects each contract cap before building a transaction', async () => {
    const s = await approvedSupplier();
    const me = await h.http().get('/v1/me').set(auth(s.token)).expect(200);
    const offer = await h.http().post('/v1/offers').set(auth(s.token)).send({ ...offerBody(), maxUnits: 1000, maxPerMember: 1000 }).expect(201);
    await h.http().post(`/v1/offers/${offer.body.id}/publish`).set(auth(s.token)).expect(200);
    const t = await h.login(newPhone());
    await h.bindWallet(t.token, Keypair.random());
    const id0 = BigInt(Date.now()) * 1_000n + BigInt(phoneN++);
    const pool = (n: number) => h.db.prisma.pool.create({
      data: {
        id: id0 + BigInt(n), offerId: offer.body.id, organizerAddress: Keypair.random().publicKey(),
        supplierAddress: me.body.walletAddress as string, hubAddress: 'Gate', hubContact: '0803',
        hubHash: `${id0}-${n}`, shareSlug: `cap-${id0}-${n}`, pickupWindow: {}, state: 'Open', fillDeadline: new Date(),
      },
    });
    await Promise.all([pool(1), pool(2), pool(3), pool(4), pool(5)]);
    const commit = async (id: bigint, units: number) => {
      const before = h.chain.calls.filter((c) => c.fn === 'commit').length;
      const r = await h.http().post(`/v1/pools/${id}/commit/prepare`).set(auth(t.token)).send({ units }).expect(400);
      expect(h.chain.calls.filter((c) => c.fn === 'commit').length).toBe(before);
      return r.body;
    };

    expect(await commit(id0 + 1n, 51)).toMatchObject({ error: 'OVER_TIER_CAP', contractCode: 318, limit: '500000000' }); // trader tier 0

    await h.db.prisma.offer.update({ where: { id: offer.body.id }, data: { maxPerMember: 50 } });
    expect(await commit(id0 + 2n, 51)).toMatchObject({ error: 'OVER_MEMBER_LIMIT', contractCode: 315, limit: 50 });

    await h.db.prisma.offer.update({ where: { id: offer.body.id }, data: { maxPerMember: 1000 } });
    await h.db.prisma.commitment.create({ data: { poolId: id0 + 3n, memberAddress: Keypair.random().publicKey(), units: 1, paid: '1' } });
    expect(await commit(id0 + 3n, 501)).toMatchObject({ error: 'OVER_MEMBER_SHARE', contractCode: 316, limit: 500 });

    await h.db.prisma.offer.update({ where: { id: offer.body.id }, data: { maxUnits: 500 } });
    expect(await commit(id0 + 4n, 501)).toMatchObject({ error: 'OVER_POOL_MAX', contractCode: 317, limit: 500 });

    await h.db.prisma.offer.update({ where: { id: offer.body.id }, data: { maxUnits: 1000 } });
    await h.db.prisma.commitment.createMany({ data: Array.from({ length: 200 }, () => ({
      poolId: id0 + 5n, memberAddress: Keypair.random().publicKey(), units: 0, paid: '0',
    })) });
    expect(await commit(id0 + 5n, 1)).toMatchObject({ error: 'TOO_MANY_MEMBERS', contractCode: 319, limit: 200 });
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
    const evForArbiter = sign.body.evidenceId as string;
    await h.bindWallet(arb.token, Keypair.random());
    const proj = new Projector(new PrismaReadStore(h.db.prisma));
    const poolId = BigInt(Date.now()) * 10n + 1n;
    await proj.apply(decodeEvent(raw('group_buy', 'pool_new', u64(poolId), tup(a(Keypair.random().publicKey()), a(Keypair.random().publicKey()), bytes(1), bytes(2)), 20))!);
    await proj.apply(decodeEvent(raw('disputes', 'd_open', u64(77n), tup(u64(poolId), a(Keypair.random().publicKey()), i128(5_000_000n)), 21))!);
    // Evidence the trader uploaded for pool 7 becomes readable by an arbiter only once that pool has an open dispute.
    await h.db.prisma.dispute.create({ data: { id: 78n, poolId: 7n, openerAddress: 'GX', reason: 'Damaged', claimedUnits: 1, claimedAmount: '1', state: 'OPEN', openedAt: new Date(), slaDueAt: new Date(Date.now() + 1e6) } });
    await h.http().get(`/v1/evidence/${evForArbiter}/url`).set(auth(arb.token)).expect(200);
    await h.db.prisma.dispute.update({ where: { id: 78n }, data: { state: 'RESOLVED' } });
    await h.http().get(`/v1/evidence/${evForArbiter}/url`).set(auth(arb.token)).expect(403);
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

  it('shows only open disputes in the arbiter queue, sorted by SLA due time (#88)', async () => {
    const arb = await h.login(PHONE_ARBITER);
    const mk = (id: bigint, state: string, sla: string) => h.db.prisma.dispute.create({ data: {
      id, poolId: 7n, openerAddress: 'GX', reason: 'Damaged', claimedUnits: 1, claimedAmount: '1',
      state, openedAt: new Date(), slaDueAt: new Date(sla),
    } });
    await mk(880101n, 'OPEN', '2026-01-02T00:00:00Z');
    await mk(880102n, 'OPEN', '2026-01-01T00:00:00Z');
    await mk(880103n, 'RESOLVED', '2025-01-01T00:00:00Z');
    await mk(880104n, 'TIMED_OUT', '2025-01-01T00:00:00Z');
    const q = await h.http().get('/v1/arbiter/queue').set(auth(arb.token)).expect(200);
    const ids = q.body.map((d: { id: string; evidenceCount: number }) => d.id);
    expect(ids.indexOf('880102')).toBeLessThan(ids.indexOf('880101'));
    expect(ids).not.toContain('880103');
    expect(ids).not.toContain('880104');
    expect(q.body[0]).toMatchObject({ evidenceCount: 0, closedAt: null });
  });

  it('serves /bonds/me from the read model without an RPC round trip (#89)', async () => {
    const s = await approvedSupplier();
    const before = h.chain.calls.length;
    const blank = await h.http().get('/v1/bonds/me').set(auth(s.token)).expect(200);
    expect(blank.body).toMatchObject({ total: '0', reserved: '0', slashRequested: '0', slashActual: '0' });
    await h.db.prisma.bond.create({
      data: { supplierAddress: s.kp.publicKey(), total: '500', reserved: '50', slashRequested: '120', slashActual: '100' },
    });
    const r = await h.http().get('/v1/bonds/me').set(auth(s.token)).expect(200);
    expect(r.body).toMatchObject({ total: '500', reserved: '50', slashRequested: '120', slashActual: '100' });
    expect(h.chain.calls.length).toBe(before);
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

describe('fx quote', () => {
  it('is public, returns the median rate, and is blocked when sources diverge', async () => {
    const r = await h.http().get('/v1/fx/quote').expect(200);
    expect(r.body).toMatchObject({ ngnPerUsd: 1502.5, sources: 2, ttlSeconds: 60 });
    const original = h.s.fx;
    h.s.fx = new StaticFxProvider([1500, 1700]);
    expect((await h.http().get('/v1/fx/quote').expect(400)).body.error).toBe('FX_DIVERGENCE');
    h.s.fx = original;
  });
});

describe('public product images', () => {
  it('rejects bytes that are not a decodable image with a clear 400', async () => {
    const s = await approvedSupplier();
    const sign = await h.http().post('/v1/uploads/sign').set(auth(s.token)).send({ kind: 'PRODUCT', mime: 'image/png', size: 20 }).expect(201);
    const r = await h.http().put(sign.body.uploadUrl).set('Content-Type', 'image/png').send(Buffer.from('definitely not a png')).expect(400);
    expect(r.body.error).toBe('IMAGE_INVALID');
  });
  it('serves only PRODUCT photos, as WebP, to anyone', async () => {
    const s = await approvedSupplier();
    const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#a60' } }).png().toBuffer();
    const sign = await h.http().post('/v1/uploads/sign').set(auth(s.token)).send({ kind: 'PRODUCT', mime: 'image/png', size: png.length }).expect(201);
    await h.http().put(sign.body.uploadUrl).set('Content-Type', 'image/png').send(png).expect(200);
    const img = await h.http().get(`/v1/images/${sign.body.evidenceId}`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(img.headers['content-type']).toBe('image/webp');
    expect((await sharp(img.body as Buffer).metadata()).width).toBe(640);
    // delivery/dispute evidence is never served this way
    const t = await h.login(newPhone());
    const ev = await h.http().post('/v1/uploads/sign').set(auth(t.token)).send({ kind: 'DISPUTE', mime: 'image/png', size: png.length, poolId: '7' }).expect(201);
    await h.http().put(ev.body.uploadUrl).set('Content-Type', 'image/png').send(png).expect(200);
    await h.http().get(`/v1/images/${ev.body.evidenceId}`).expect(404);
  });
});

let nextSettledId = BigInt(Date.now()) * 10n;

describe('reports: supplier statement and admin risk overview', () => {
  async function settledPoolFor(supplierWallet: string, offerId: string) {
    const proj = new Projector(new PrismaReadStore(h.db.prisma));
    const id = ++nextSettledId; // monotonic: Date.now() repeats within a millisecond
    const hub = Keypair.random().publicKey();
    const apply = (r: ReturnType<typeof raw>) => proj.apply(decodeEvent(r)!);
    await h.db.prisma.pendingPool.create({ data: { hubHash: id.toString(16).padStart(64, '0'), offerId, organizerAddress: hub, hubAddress: 'Gate', hubContact: '0803', pickupWindow: {}, fillDeadline: new Date(), shareSlug: `st${id}` } });
    const hubBytes = nativeToScVal(Buffer.from(id.toString(16).padStart(64, '0'), 'hex'));
    await apply(raw('group_buy', 'pool_new', u64(id), tup(a(hub), a(supplierWallet), bytes(7), hubBytes), 10));
    await apply(raw('group_buy', 'committed', u64(id), tup(a(Keypair.random().publicKey()), u32(100), i128(1_000_000_000n)), 11));
    await apply(raw('group_buy', 'filled', u64(id), tup(u32(100), i128(10_000_000n)), 12));
    await apply(raw('group_buy', 'accepted', u64(id), a(supplierWallet), 13));
    await apply(raw('group_buy', 'delivered', u64(id), tup(u32(100), bytes(5)), 14));
    // 100 units x 1 USDC = 100 USDC: supplier 98.5, platform 1, organizer 0.5
    await apply(raw('group_buy', 'settled', u64(id), tup(i128(985_000_000n), i128(10_000_000n), i128(5_000_000n)), 15));
    return id;
  }

  it('keeps indexing when a pool points at an offer that has no USDC tiers', async () => {
    const s = await approvedSupplier();
    const me = await h.http().get('/v1/me').set(auth(s.token));
    const draft = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody()); // never published: tiersUsdc is empty
    await expect(settledPoolFor(me.body.walletAddress, draft.body.id)).resolves.toBeDefined();
  });

  it('gives a supplier a statement with gross, fees and net, as JSON and CSV, only for their own pools', async () => {
    const s = await approvedSupplier();
    const me = await h.http().get('/v1/me').set(auth(s.token));
    const offer = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody());
    await h.http().post(`/v1/offers/${offer.body.id}/publish`).set(auth(s.token)).expect(200);
    await settledPoolFor(me.body.walletAddress, offer.body.id);

    const j = await h.http().get('/v1/suppliers/statement').set(auth(s.token)).expect(200);
    expect(j.body.lines).toHaveLength(1);
    expect(j.body.lines[0]).toMatchObject({ unitsDelivered: 100, gross: '1000000000', platformFee: '10000000', organizerFee: '5000000', net: '985000000' });
    expect(j.body.total.net).toBe('985000000');
    const csv = await h.http().get('/v1/suppliers/statement?format=csv').set(auth(s.token)).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\n')[0]).toBe('pool_id,product,settled_at,units_delivered,gross_stroops,platform_fee_stroops,organizer_fee_stroops,net_stroops');
    expect(csv.text).toContain('985000000');

    const other = await approvedSupplier();
    expect((await h.http().get('/v1/suppliers/statement').set(auth(other.token)).expect(200)).body.lines).toEqual([]);
    const trader = await h.login(newPhone());
    await h.http().get('/v1/suppliers/statement').set(auth(trader.token)).expect(403);
  });

  it('gives admins the risk overview and lists, and nobody else', async () => {
    const admin = await h.login(PHONE_ADMIN);
    const o = await h.http().get('/v1/admin/risk/overview').set(auth(admin.token)).expect(200);
    expect(BigInt(o.body.gmv)).toBeGreaterThanOrEqual(1_000_000_000n); // the settled pool above: 100 units x 1 USDC
    expect(o.body.poolsByState.Settled).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(o.body.flags)).toBe(true);
    for (const path of ['/v1/admin/disputes', '/v1/admin/offers', '/v1/admin/pools?state=Settled', '/v1/admin/users?q=%2B234', '/v1/admin/actions']) {
      expect((await h.http().get(path).set(auth(admin.token)).expect(200)).body).toBeInstanceOf(Array);
    }
    const trader = await h.login(newPhone());
    for (const path of ['/v1/admin/risk/overview', '/v1/admin/dashboard', '/v1/admin/disputes', '/v1/admin/users']) await h.http().get(path).set(auth(trader.token)).expect(403);
  });

  it('returns indexed dashboard counters for a configurable window and caches results for 60 seconds', async () => {
    const supplier = await approvedSupplier();
    const me = await h.http().get('/v1/me').set(auth(supplier.token)).expect(200);
    const offer = await h.http().post('/v1/offers').set(auth(supplier.token)).send(offerBody()).expect(201);
    await h.db.prisma.pool.updateMany({ data: { escrowBalance: '0' } });
    const poolId = await settledPoolFor(me.body.walletAddress, offer.body.id);
    const now = new Date();
    await h.db.prisma.pool.update({ where: { id: poolId }, data: { deliveredAt: now, endedAt: now, escrowBalance: '12.5' } });
    const failedId = ++nextSettledId;
    const openId = ++nextSettledId;
    const base = {
      offerId: offer.body.id, organizerAddress: Keypair.random().publicKey(), supplierAddress: me.body.walletAddress,
      hubAddress: '', hubContact: '', pickupWindow: {}, fillDeadline: now,
    };
    await h.db.prisma.pool.create({ data: { ...base, id: failedId, hubHash: failedId.toString(16), shareSlug: `dash-failed-${failedId}`, state: 'Failed', endedAt: now } });
    await h.db.prisma.pool.create({ data: { ...base, id: openId, hubHash: openId.toString(16), shareSlug: `dash-open-${openId}`, state: 'Open', escrowBalance: '2' } });
    await h.db.prisma.dispute.create({
      data: { id: openId + 1n, poolId, openerAddress: Keypair.random().publicKey(), reason: 'quality', claimedUnits: 1, claimedAmount: '1', state: 'OPEN', openedAt: now, slaDueAt: new Date(now.getTime() + 86_400_000) },
    });

    const admin = await h.login(PHONE_ADMIN);
    const dashboard = await h.http().get('/v1/admin/dashboard?windowDays=7').set(auth(admin.token)).expect(200);
    expect(dashboard.body).toMatchObject({ windowDays: 7, gmv: '1000000000', escrowHeld: '145000000', failureRate: 0.5, disputeRate: 1 });
    expect(dashboard.body.openPools).toBeGreaterThanOrEqual(1);
    await h.db.prisma.pool.update({ where: { id: poolId }, data: { finalUnitPrice: '99' } });
    expect((await h.http().get('/v1/admin/dashboard?windowDays=7').set(auth(admin.token)).expect(200)).body.gmv).toBe('1000000000');
    await h.http().get('/v1/admin/dashboard?windowDays=0').set(auth(admin.token)).expect(400);
  });
});

describe('naira deposits (mock anchor)', () => {
  async function userWithWallet() {
    const u = await h.login(newPhone());
    await h.bindWallet(u.token, Keypair.random());
    return u;
  }

  it('quotes indicatively, then credits USDC once at the rate in force when the bank transfer is confirmed', async () => {
    const u = await userWithWallet();
    const start = await h.http().post('/v1/anchor/deposit/start').set(auth(u.token)).send({ amountNgn: '150000' }).expect(201);
    expect(start.body).toMatchObject({ anchor: 'mock-anchor', amountNgn: '150000', ngnPerUsd: 1502.5 });
    expect(start.body.instructions.reference).toBe(start.body.transferId);
    const before = h.chain.paid.length;
    expect((await h.http().get(`/v1/anchor/transfers/${start.body.transferId}`).set(auth(u.token)).expect(200)).body.status).toBe('PENDING');

    h.s.fx = new StaticFxProvider([1600, 1610]); // the rate moves before the bank confirms: the final rate wins
    const done = await h.http().post('/v1/dev/anchor/confirm').set(auth(u.token)).send({ transferId: start.body.transferId }).expect(200);
    h.s.fx = new StaticFxProvider([1500, 1505]);
    expect(done.body.status).toBe('COMPLETED');
    expect(h.chain.paid).toHaveLength(before + 1);
    expect(h.chain.paid.at(-1)!.stroops).toBe((150000n * 10_000_000n * 1_000_000n) / 1_605_000_000n); // median 1605, rounded down
    expect(done.body.amountUsdc).toMatch(/^93\.45/);

    await h.http().post('/v1/dev/anchor/confirm').set(auth(u.token)).send({ transferId: start.body.transferId }).expect(200); // duplicate callback
    expect(h.chain.paid).toHaveLength(before + 1); // never paid twice
  });

  it('rejects out-of-range amounts, hides other people\'s transfers, and needs a wallet to be credited', async () => {
    const u = await userWithWallet();
    for (const amountNgn of ['999', '5000001', '12.5', 'abc']) await h.http().post('/v1/anchor/deposit/start').set(auth(u.token)).send({ amountNgn }).expect(400);
    const start = await h.http().post('/v1/anchor/deposit/start').set(auth(u.token)).send({ amountNgn: '5000' }).expect(201);
    const other = await userWithWallet();
    await h.http().get(`/v1/anchor/transfers/${start.body.transferId}`).set(auth(other.token)).expect(404);
    await h.http().post('/v1/dev/anchor/confirm').set(auth(other.token)).send({ transferId: start.body.transferId }).expect(400);
    const bare = await h.login(newPhone()); // no wallet
    const s2 = await h.http().post('/v1/anchor/deposit/start').set(auth(bare.token)).send({ amountNgn: '5000' }).expect(201);
    await h.http().post('/v1/dev/anchor/confirm').set(auth(bare.token)).send({ transferId: s2.body.transferId }).expect(400);
  });

  it('is unavailable (501) when there is no anchor, as on mainnet', async () => {
    const saved = h.s.anchor;
    h.s.anchor = undefined;
    const u = await userWithWallet();
    const r = await h.http().post('/v1/anchor/deposit/start').set(auth(u.token)).send({ amountNgn: '5000' }).expect(501);
    expect(r.body.error).toBe('NOT_AVAILABLE');
    h.s.anchor = saved;
  });
});

describe('admin supplier queue, documents and user lookup (#131-#134)', () => {
  const UNMASKED = /(?<![\d*])\d{10,11}(?!\d)/;

  it('pages the supplier queue with a cursor and filters by state', async () => {
    const admin = await h.login(PHONE_ADMIN);
    for (let i = 0; i < 3; i++) {
      const s = await h.login(newPhone());
      await h.http().post('/v1/suppliers/apply').set(auth(s.token)).send({
        businessName: 'Queue Foods Ltd', cacNumber: 'RC7654321', address: '1 Queue Rd', state: 'Lagos', lga: 'Ikeja', categories: ['rice'], deliveryAreas: [{ state: 'Lagos' }],
      }).expect(200);
    }
    const first = await h.http().get('/v1/admin/suppliers?state=Lagos&limit=2').set(auth(admin.token)).expect(200);
    expect(first.body).toHaveLength(2);
    expect(first.body.every((r: { state: string }) => r.state === 'Lagos')).toBe(true);
    expect(first.body[0].cacNumber).toMatch(/^\*+4321$/);
    const cursor = first.headers['x-next-cursor'];
    expect(cursor).toBeTruthy();
    const next = await h.http().get(`/v1/admin/suppliers?state=Lagos&limit=2&cursor=${cursor}`).set(auth(admin.token)).expect(200);
    expect(next.body.map((r: { userId: string }) => r.userId)).not.toContain(first.body[0].userId);
  });

  it('lets suppliers upload KYB documents and only admins list them', async () => {
    const s = await h.login(newPhone());
    await h.http().post('/v1/uploads/sign').set(auth(s.token)).send({ kind: 'KYB_CAC_CERTIFICATE', mime: 'application/pdf', size: 10 }).expect(403);
    await h.http().post('/v1/suppliers/apply').set(auth(s.token)).send({
      businessName: 'Doc Foods Ltd', cacNumber: 'RC1112223', address: '2 Doc Rd', state: 'FCT', lga: 'Abuja Municipal', categories: ['rice'], deliveryAreas: [{ state: 'FCT' }],
    }).expect(200);
    await h.http().post('/v1/uploads/sign').set(auth(s.token)).send({ kind: 'KYB_CAC_CERTIFICATE', mime: 'video/mp4', size: 10 }).expect(400);
    const signed = await h.http().post('/v1/uploads/sign').set(auth(s.token)).send({ kind: 'KYB_CAC_CERTIFICATE', mime: 'application/pdf', size: 10 }).expect(201);
    await h.http().put(signed.body.uploadUrl).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4 x')).expect(200);
    expect((await h.http().get('/v1/suppliers/documents').set(auth(s.token)).expect(200)).body).toHaveLength(1);
    await h.http().get(`/v1/admin/suppliers/${s.userId}/documents`).set(auth(s.token)).expect(403);
    const admin = await h.login(PHONE_ADMIN);
    const docs = await h.http().get(`/v1/admin/suppliers/${s.userId}/documents`).set(auth(admin.token)).expect(200);
    expect(docs.body[0]).toMatchObject({ kind: 'KYB_CAC_CERTIFICATE' });
    expect(docs.body[0].url).toContain('/v1/evidence/file');
  });

  it('searches users by id or phone suffix, masks phones and audit logs the lookup', async () => {
    const phone = newPhone();
    const u = await h.login(phone);
    const admin = await h.login(PHONE_ADMIN);
    const byPhone = await h.http().get(`/v1/admin/users?q=${phone.slice(-4)}`).set(auth(admin.token)).expect(200);
    const hit = byPhone.body.find((r: { id: string }) => r.id === u.userId);
    expect(hit.phone).toMatch(new RegExp(`^\\*+${phone.slice(-4)}$`));
    expect(hit).not.toHaveProperty('displayName');
    expect((await h.http().get(`/v1/admin/users?q=${u.userId}`).set(auth(admin.token)).expect(200)).body).toHaveLength(1);
    expect(await h.db.prisma.auditLog.findFirst({ where: { action: 'user.search', actorId: admin.userId } })).not.toBeNull();
    expect(JSON.stringify(byPhone.body)).not.toMatch(UNMASKED);
    expect(JSON.stringify(byPhone.body)).not.toContain(phone);
  });
});
