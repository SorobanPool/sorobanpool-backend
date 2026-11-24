import { Keypair } from '@stellar/stellar-sdk';
import { startHarness, PHONE_ADMIN, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); }, 60_000);
afterAll(async () => { await h.close(); });

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let phoneN = 90;
const newPhone = () => `+23480300000${String(phoneN++).padStart(2, '0')}`;

const offerBody = (images: string[], validDays: number = 7) => ({
  title: 'Mama Gold Rice 50kg', brand: 'Mama Gold', branded: true, description: 'Parboiled long grain rice', unitLabel: '50kg bag', category: 'rice',
  perishable: false, images, tiersNgn: [{ minUnits: 100, priceNgn: '75000' }, { minUnits: 200, priceNgn: '72000' }],
  moq: 100, maxUnits: 500, maxPerMember: 250, leadTimeHours: 72, deliveryAreas: [{ state: 'FCT', lga: 'Abuja Municipal' }],
  validUntil: new Date(Date.now() + validDays * 86400_000).toISOString(),
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

async function uploadProductImage(token: string, userId: string): Promise<string> {
  // Create a 1x1 pixel WebP image
  const signResponse = await h.http().post('/v1/uploads/sign').set(auth(token)).send({
    kind: 'PRODUCT',
    mime: 'image/webp',
    size: 100,
  }).expect(201);
  
  const imageBytes = Buffer.from('UklGRiYAAABXRUJQVlA4IBoAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64');
  
  // Upload the image
  const uploadUrl = signResponse.body.uploadUrl.replace('/v1/uploads/put', '');
  const urlParams = new URLSearchParams(uploadUrl.substring(1));
  await h.http()
    .put(`/v1/uploads/put${uploadUrl}`)
    .send(imageBytes)
    .expect(200);
  
  return signResponse.body.evidenceId;
}

describe('Issue #70: Require at least two product images', () => {
  it('allows drafts with fewer than 2 images', async () => {
    const s = await approvedSupplier();
    const img1 = await uploadProductImage(s.token, s.userId);
    
    const draft = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody([img1])).expect(201);
    expect(draft.body.status).toBe('DRAFT');
  });

  it('rejects publishing with 0 images', async () => {
    const s = await approvedSupplier();
    const draft = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody([])).expect(201);
    
    const pub = await h.http().post(`/v1/offers/${draft.body.id}/publish`).set(auth(s.token)).expect(400);
    expect(pub.body.error).toBe('OFFER_INVALID');
    expect(pub.body.issues.join()).toMatch(/at least 2 photos are required/);
  });

  it('rejects publishing with 1 image', async () => {
    const s = await approvedSupplier();
    const img1 = await uploadProductImage(s.token, s.userId);
    const draft = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody([img1])).expect(201);
    
    const pub = await h.http().post(`/v1/offers/${draft.body.id}/publish`).set(auth(s.token)).expect(400);
    expect(pub.body.error).toBe('OFFER_INVALID');
    expect(pub.body.issues.join()).toMatch(/at least 2 photos are required/);
  });

  it('allows publishing with 2 images', async () => {
    const s = await approvedSupplier();
    const img1 = await uploadProductImage(s.token, s.userId);
    const img2 = await uploadProductImage(s.token, s.userId);
    
    const draft = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody([img1, img2])).expect(201);
    const pub = await h.http().post(`/v1/offers/${draft.body.id}/publish`).set(auth(s.token)).expect(200);
    expect(pub.body.status).toBe('LIVE');
  });

  it('rejects publishing with foreign image keys', async () => {
    const s1 = await approvedSupplier();
    const s2 = await approvedSupplier();
    
    const img1 = await uploadProductImage(s1.token, s1.userId);
    const img2 = await uploadProductImage(s2.token, s2.userId); // Different supplier
    
    const draft = await h.http().post('/v1/offers').set(auth(s1.token)).send(offerBody([img1, img2])).expect(201);
    const pub = await h.http().post(`/v1/offers/${draft.body.id}/publish`).set(auth(s1.token)).expect(400);
    expect(pub.body.error).toBe('INVALID_IMAGE');
    expect(pub.body.message).toMatch(/not owned by you/);
  });
});

describe('Issue #69: Enforce 14-day maximum validity', () => {
  it('accepts offers valid for exactly 14 days', async () => {
    const s = await approvedSupplier();
    const img1 = await uploadProductImage(s.token, s.userId);
    const img2 = await uploadProductImage(s.token, s.userId);
    
    const draft = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody([img1, img2], 14)).expect(201);
    const pub = await h.http().post(`/v1/offers/${draft.body.id}/publish`).set(auth(s.token)).expect(200);
    expect(pub.body.status).toBe('LIVE');
  });

  it('rejects offers valid for more than 14 days', async () => {
    const s = await approvedSupplier();
    const img1 = await uploadProductImage(s.token, s.userId);
    const img2 = await uploadProductImage(s.token, s.userId);
    
    const response = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody([img1, img2], 15)).expect(400);
    expect(response.body.error).toBe('OFFER_INVALID');
    expect(response.body.issues.join()).toMatch(/at most 14 days/);
  });

  it('rejects refresh-fx with validUntil beyond 14 days', async () => {
    const s = await approvedSupplier();
    const img1 = await uploadProductImage(s.token, s.userId);
    const img2 = await uploadProductImage(s.token, s.userId);
    
    const draft = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody([img1, img2], 7)).expect(201);
    await h.http().post(`/v1/offers/${draft.body.id}/publish`).set(auth(s.token)).expect(200);
    
    const refreshResponse = await h.http().post(`/v1/offers/${draft.body.id}/refresh-fx`).set(auth(s.token))
      .send({ validUntil: new Date(Date.now() + 15 * 86400_000).toISOString() })
      .expect(400);
    expect(refreshResponse.body.error).toBe('BAD_VALIDITY');
    expect(refreshResponse.body.message).toMatch(/within 14 days/);
  });
});

describe('Issue #68: ETag and conditional GET', () => {
  it('returns ETag header on GET /offers', async () => {
    const response = await h.http().get('/v1/offers').expect(200);
    expect(response.headers['etag']).toBeDefined();
    expect(response.headers['etag']).toMatch(/^"[a-f0-9]+"$/);
  });

  it('returns 304 when If-None-Match matches ETag on GET /offers', async () => {
    const first = await h.http().get('/v1/offers').expect(200);
    const etag = first.headers['etag'];
    
    const second = await h.http().get('/v1/offers').set('If-None-Match', etag).expect(304);
    expect(second.body).toEqual({});
  });

  it('returns ETag header on GET /offers/:id', async () => {
    const s = await approvedSupplier();
    const img1 = await uploadProductImage(s.token, s.userId);
    const img2 = await uploadProductImage(s.token, s.userId);
    
    const draft = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody([img1, img2])).expect(201);
    await h.http().post(`/v1/offers/${draft.body.id}/publish`).set(auth(s.token)).expect(200);
    
    const response = await h.http().get(`/v1/offers/${draft.body.id}`).expect(200);
    expect(response.headers['etag']).toBeDefined();
  });

  it('returns 304 when If-None-Match matches on GET /offers/:id', async () => {
    const s = await approvedSupplier();
    const img1 = await uploadProductImage(s.token, s.userId);
    const img2 = await uploadProductImage(s.token, s.userId);
    
    const draft = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody([img1, img2])).expect(201);
    await h.http().post(`/v1/offers/${draft.body.id}/publish`).set(auth(s.token)).expect(200);
    
    const first = await h.http().get(`/v1/offers/${draft.body.id}`).expect(200);
    const etag = first.headers['etag'];
    
    const second = await h.http().get(`/v1/offers/${draft.body.id}`).set('If-None-Match', etag).expect(304);
    expect(second.body).toEqual({});
  });

  it('returns new ETag when offer changes', async () => {
    const s = await approvedSupplier();
    const img1 = await uploadProductImage(s.token, s.userId);
    const img2 = await uploadProductImage(s.token, s.userId);
    
    const draft = await h.http().post('/v1/offers').set(auth(s.token)).send(offerBody([img1, img2])).expect(201);
    await h.http().post(`/v1/offers/${draft.body.id}/publish`).set(auth(s.token)).expect(200);
    
    const first = await h.http().get(`/v1/offers/${draft.body.id}`).expect(200);
    const etag1 = first.headers['etag'];
    
    // Refresh to change the offer
    await h.http().post(`/v1/offers/${draft.body.id}/refresh-fx`).set(auth(s.token))
      .send({ validUntil: new Date(Date.now() + 10 * 86400_000).toISOString() })
      .expect(200);
    
    const second = await h.http().get(`/v1/offers/${draft.body.id}`).expect(200);
    const etag2 = second.headers['etag'];
    
    expect(etag1).not.toBe(etag2);
  });
});

describe('Issue #65: Price sanity checks', () => {
  it('flags price outliers on publish', async () => {
    const s = await approvedSupplier();
    
    // Create a few normal offers first to establish median
    for (let i = 0; i < 3; i++) {
      const img1 = await uploadProductImage(s.token, s.userId);
      const img2 = await uploadProductImage(s.token, s.userId);
      const normalOffer = {
        ...offerBody([img1, img2]),
        tiersNgn: [{ minUnits: 100, priceNgn: '70000' }],
      };
      const draft = await h.http().post('/v1/offers').set(auth(s.token)).send(normalOffer).expect(201);
      await h.http().post(`/v1/offers/${draft.body.id}/publish`).set(auth(s.token)).expect(200);
    }
    
    // Now create an outlier (10x the median)
    const img1 = await uploadProductImage(s.token, s.userId);
    const img2 = await uploadProductImage(s.token, s.userId);
    const outlierOffer = {
      ...offerBody([img1, img2]),
      tiersNgn: [{ minUnits: 100, priceNgn: '700000' }],
    };
    
    const draft = await h.http().post('/v1/offers').set(auth(s.token)).send(outlierOffer).expect(201);
    const pub = await h.http().post(`/v1/offers/${draft.body.id}/publish`).set(auth(s.token)).expect(200);
    
    expect(pub.body.priceOutlierFlag).toBe(true);
    
    // Verify the flag is stored
    const offer = await h.db.prisma.offer.findUnique({ where: { id: draft.body.id } });
    expect(offer?.priceOutlierFlag).toBe(true);
  });

  it('allows publishing price outliers (non-blocking)', async () => {
    const s = await approvedSupplier();
    
    // Create normal offers
    for (let i = 0; i < 2; i++) {
      const img1 = await uploadProductImage(s.token, s.userId);
      const img2 = await uploadProductImage(s.token, s.userId);
      const normalOffer = {
        ...offerBody([img1, img2]),
        tiersNgn: [{ minUnits: 100, priceNgn: '50000' }],
      };
      const draft = await h.http().post('/v1/offers').set(auth(s.token)).send(normalOffer).expect(201);
      await h.http().post(`/v1/offers/${draft.body.id}/publish`).set(auth(s.token)).expect(200);
    }
    
    // Outlier should still publish successfully
    const img1 = await uploadProductImage(s.token, s.userId);
    const img2 = await uploadProductImage(s.token, s.userId);
    const outlierOffer = {
      ...offerBody([img1, img2]),
      tiersNgn: [{ minUnits: 100, priceNgn: '500000' }], // 10x higher
    };
    
    const draft = await h.http().post('/v1/offers').set(auth(s.token)).send(outlierOffer).expect(201);
    const pub = await h.http().post(`/v1/offers/${draft.body.id}/publish`).set(auth(s.token)).expect(200);
    
    expect(pub.body.status).toBe('LIVE');
    expect(pub.body.priceOutlierFlag).toBe(true);
  });

  it('shows priceOutlierFlag in admin offer list', async () => {
    const s = await approvedSupplier();
    
    // Create normal offer
    const img1 = await uploadProductImage(s.token, s.userId);
    const img2 = await uploadProductImage(s.token, s.userId);
    const normalOffer = {
      ...offerBody([img1, img2]),
      tiersNgn: [{ minUnits: 100, priceNgn: '60000' }],
    };
    const normalDraft = await h.http().post('/v1/offers').set(auth(s.token)).send(normalOffer).expect(201);
    await h.http().post(`/v1/offers/${normalDraft.body.id}/publish`).set(auth(s.token)).expect(200);
    
    // Create outlier
    const img3 = await uploadProductImage(s.token, s.userId);
    const img4 = await uploadProductImage(s.token, s.userId);
    const outlierOffer = {
      ...offerBody([img3, img4]),
      tiersNgn: [{ minUnits: 100, priceNgn: '600000' }],
    };
    const outlierDraft = await h.http().post('/v1/offers').set(auth(s.token)).send(outlierOffer).expect(201);
    await h.http().post(`/v1/offers/${outlierDraft.body.id}/publish`).set(auth(s.token)).expect(200);
    
    // Check admin list
    const admin = await h.login(PHONE_ADMIN);
    const list = await h.http().get('/v1/admin/offers?priceOutlier=true').set(auth(admin.token)).expect(200);
    
    const outlierInList = list.body.find((o: { id: string }) => o.id === outlierDraft.body.id);
    expect(outlierInList).toBeDefined();
    expect(outlierInList.priceOutlierFlag).toBe(true);
  });
});
