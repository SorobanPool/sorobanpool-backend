import { Keypair } from '@stellar/stellar-sdk';
import { startHarness, type Harness, PHONE_ADMIN } from './harness.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); }, 60_000);
afterAll(async () => { await h.close(); });

describe('POST /admin/offers/:id/takedown (#72)', () => {
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  let phoneCounter = 3000;
  const newPhone = () => `+234803300${String(phoneCounter++).padStart(4, '0')}`;

  async function setupSupplier() {
    const supplier = await h.login(newPhone());
    const kp = Keypair.random();
    await h.bindWallet(supplier.token, kp);
    await h.http().post('/v1/suppliers/apply').set(auth(supplier.token)).send({
      businessName: 'Test Foods Ltd',
      cacNumber: `RC${Math.floor(Math.random() * 1000000)}`,
      address: '123 Test St',
      state: 'Lagos',
      lga: 'Ikeja',
      categories: ['GRAINS'],
      deliveryAreas: [{ state: 'Lagos' }],
    });
    
    const admin = await h.login(PHONE_ADMIN);
    await h.http().post(`/v1/admin/suppliers/${supplier.userId}/decision`).set(auth(admin.token)).send({ approve: true });
    
    return { ...supplier, kp };
  }

  async function createAndPublishOffer(token: string, userId: string, title = 'Test Product') {
    // Mock product images
    const imageIds = [`img-${Date.now()}-1`, `img-${Date.now()}-2`];
    await h.s.prisma.evidence.createMany({
      data: imageIds.map((id, idx) => ({
        id,
        ownerId: userId,
        poolId: null,
        disputeId: null,
        kind: 'PRODUCT',
        objectKey: `${id}.jpg`,
        sha256: `hash${idx}`,
        mime: 'image/jpeg',
      })),
    });

    const offerData = {
      title,
      brand: 'Test Brand',
      branded: false,
      description: 'A test product',
      unitLabel: 'kg',
      category: 'GRAINS',
      perishable: false,
      images: imageIds,
      tiersNgn: [{ minUnits: 10, priceNgn: '5000' }],
      moq: 10,
      maxUnits: 1000,
      maxPerMember: 100,
      leadTimeHours: 48,
      deliveryAreas: [{ state: 'Lagos', lga: 'Ikeja' }],
      validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    };
    
    const createResponse = await h.http().post('/v1/offers').set(auth(token)).send(offerData);
    await h.http().post(`/v1/offers/${createResponse.body.id}/publish`).set(auth(token)).send();
    
    return createResponse.body.id;
  }

  it('enqueues a notification with reason when offer is taken down', async () => {
    const supplier = await setupSupplier();
    const admin = await h.login(PHONE_ADMIN);
    const offerId = await createAndPublishOffer(supplier.token, supplier.userId, 'Problematic Offer');

    // Count notifications before takedown
    const beforeCount = await h.s.prisma.notification.count({ 
      where: { userId: supplier.userId, template: 'offer_taken_down' } 
    });

    // Takedown with reason
    const response = await h.http()
      .post(`/v1/admin/offers/${offerId}/takedown`)
      .set(auth(admin.token))
      .send({ reason: 'Misleading product description' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('TAKEN_DOWN');

    // Verify notification was queued
    const afterCount = await h.s.prisma.notification.count({ 
      where: { userId: supplier.userId, template: 'offer_taken_down' } 
    });
    expect(afterCount).toBe(beforeCount + 1);

    // Verify notification content
    const notification = await h.s.prisma.notification.findFirst({
      where: { userId: supplier.userId, template: 'offer_taken_down' },
      orderBy: { createdAt: 'desc' },
    });

    expect(notification).toBeTruthy();
    expect(notification!.channel).toBe('sms');
    expect(notification!.template).toBe('offer_taken_down');
    expect(notification!.payload).toMatchObject({
      product: 'Problematic Offer',
      reason: 'Misleading product description',
    });
    expect(notification!.status).toBe('PENDING');
  });

  it('uses default reason when none provided', async () => {
    const supplier = await setupSupplier();
    const admin = await h.login(PHONE_ADMIN);
    const offerId = await createAndPublishOffer(supplier.token, supplier.userId, 'Another Offer');

    // Takedown without reason
    const response = await h.http()
      .post(`/v1/admin/offers/${offerId}/takedown`)
      .set(auth(admin.token))
      .send({});

    expect(response.status).toBe(200);

    // Verify notification has default reason
    const notification = await h.s.prisma.notification.findFirst({
      where: { userId: supplier.userId, template: 'offer_taken_down' },
      orderBy: { createdAt: 'desc' },
    });

    expect(notification).toBeTruthy();
    expect(notification!.payload).toMatchObject({
      product: 'Another Offer',
      reason: 'Policy violation',
    });
  });

  it('writes audit log entry unchanged', async () => {
    const supplier = await setupSupplier();
    const admin = await h.login(PHONE_ADMIN);
    const offerId = await createAndPublishOffer(supplier.token, supplier.userId, 'Audit Test Offer');

    const beforeAudit = await h.s.prisma.auditLog.count();

    await h.http()
      .post(`/v1/admin/offers/${offerId}/takedown`)
      .set(auth(admin.token))
      .send({ reason: 'Test reason' });

    const afterAudit = await h.s.prisma.auditLog.count();
    expect(afterAudit).toBe(beforeAudit + 1);

    const auditEntry = await h.s.prisma.auditLog.findFirst({
      where: { action: 'offer.takedown', target: offerId },
      orderBy: { at: 'desc' },
    });

    expect(auditEntry).toBeTruthy();
    expect(auditEntry!.actorId).toBe(admin.userId);
    expect(auditEntry!.data).toMatchObject({ reason: 'Test reason' });
  });

  it('requires ADMIN role', async () => {
    const supplier = await setupSupplier();
    const offerId = await createAndPublishOffer(supplier.token, supplier.userId);

    const response = await h.http()
      .post(`/v1/admin/offers/${offerId}/takedown`)
      .set(auth(supplier.token))
      .send({ reason: 'Test' });

    expect(response.status).toBe(403);
  });

  it('returns 404 for non-existent offer', async () => {
    const admin = await h.login(PHONE_ADMIN);

    const response = await h.http()
      .post('/v1/admin/offers/non-existent-id/takedown')
      .set(auth(admin.token))
      .send({ reason: 'Test' });

    expect(response.status).toBe(404);
  });

  it('validates reason length', async () => {
    const supplier = await setupSupplier();
    const admin = await h.login(PHONE_ADMIN);
    const offerId = await createAndPublishOffer(supplier.token, supplier.userId);

    // Reason too long (> 200 characters)
    const longReason = 'x'.repeat(201);
    const response = await h.http()
      .post(`/v1/admin/offers/${offerId}/takedown`)
      .set(auth(admin.token))
      .send({ reason: longReason });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION');
    expect(response.body.fields.some((f: { path: string }) => f.path === 'reason')).toBe(true);
  });

  it('validates reason is not empty string', async () => {
    const supplier = await setupSupplier();
    const admin = await h.login(PHONE_ADMIN);
    const offerId = await createAndPublishOffer(supplier.token, supplier.userId);

    const response = await h.http()
      .post(`/v1/admin/offers/${offerId}/takedown`)
      .set(auth(admin.token))
      .send({ reason: '' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION');
  });
});
