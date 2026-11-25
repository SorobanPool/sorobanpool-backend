import { Keypair } from '@stellar/stellar-sdk';
import { startHarness, type Harness, PHONE_ADMIN } from './harness.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); }, 60_000);
afterAll(async () => { await h.close(); });

describe('offer revision history', () => {
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  let phoneCounter = 1000;
  const newPhone = () => `+234803100${String(phoneCounter++).padStart(4, '0')}`;

  async function setupSupplier() {
    const supplier = await h.login(newPhone());
    const kp = Keypair.random();
    await h.bindWallet(supplier.token, kp);
    await h.http().post('/v1/suppliers/apply').set(auth(supplier.token)).send({
      businessName: 'Test Foods Ltd',
      cacNumber: 'RC9999999',
      address: '123 Test St',
      state: 'Lagos',
      lga: 'Ikeja',
      categories: ['GRAINS'],
      deliveryAreas: [{ state: 'Lagos' }],
    });
    return { ...supplier, kp };
  }

  async function approveSupplier(userId: string) {
    const admin = await h.login(PHONE_ADMIN);
    await h.http().post(`/v1/admin/suppliers/${userId}/decision`).set(auth(admin.token)).send({ approve: true });
  }

  const createDraftOffer = async (token: string) => {
    const offerData = {
      title: 'Test Product',
      brand: 'Test Brand',
      branded: false,
      description: 'A test product for revision tracking',
      unitLabel: 'kg',
      category: 'GRAINS',
      perishable: false,
      images: ['test-image-1', 'test-image-2'],
      tiersNgn: [{ minUnits: 10, priceNgn: '5000' }],
      moq: 10,
      maxUnits: 1000,
      maxPerMember: 100,
      leadTimeHours: 48,
      deliveryAreas: [{ state: 'Lagos', lga: 'Ikeja' }],
      validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    };
    return h.http().post('/v1/offers').set(auth(token)).send(offerData);
  };

  it('creates a revision on offer creation', async () => {
    const supplier = await setupSupplier();
    const response = await createDraftOffer(supplier.token);
    expect(response.status).toBe(201);
    const offerId = response.body.id;

    // Fetch revisions
    const revisions = await h.http().get(`/v1/offers/${offerId}/revisions`).set(auth(supplier.token));
    expect(revisions.status).toBe(200);
    expect(revisions.body.revisions).toHaveLength(1);
    
    const revision = revisions.body.revisions[0];
    expect(revision.action).toBe('CREATE');
    expect(revision.actorId).toBe(supplier.userId);
    expect(revision.snapshot).toBeDefined();
    expect(revision.snapshot.id).toBe(offerId);
    expect(revision.snapshot.status).toBe('DRAFT');
  });

  it('creates a revision on offer update', async () => {
    const supplier = await setupSupplier();
    const createResponse = await createDraftOffer(supplier.token);
    const offerId = createResponse.body.id;

    // Update the offer
    const updateData = {
      title: 'Updated Test Product',
      brand: 'Updated Brand',
      branded: false,
      description: 'An updated test product',
      unitLabel: 'kg',
      category: 'GRAINS',
      perishable: false,
      images: ['test-image-1', 'test-image-2'],
      tiersNgn: [{ minUnits: 10, priceNgn: '6000' }],
      moq: 10,
      maxUnits: 1000,
      maxPerMember: 100,
      leadTimeHours: 48,
      deliveryAreas: [{ state: 'Lagos', lga: 'Ikeja' }],
      validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    };
    const updateResponse = await h.http().patch(`/v1/offers/${offerId}`).set(auth(supplier.token)).send(updateData);
    expect(updateResponse.status).toBe(200);

    // Fetch revisions
    const revisions = await h.http().get(`/v1/offers/${offerId}/revisions`).set(auth(supplier.token));
    expect(revisions.status).toBe(200);
    expect(revisions.body.revisions).toHaveLength(2);
    
    // Check revisions are in chronological order
    expect(revisions.body.revisions[0].action).toBe('CREATE');
    expect(revisions.body.revisions[1].action).toBe('UPDATE');
    expect(revisions.body.revisions[1].snapshot.title).toBe('Updated Test Product');
    expect(new Date(revisions.body.revisions[0].createdAt).getTime()).toBeLessThan(
      new Date(revisions.body.revisions[1].createdAt).getTime()
    );
  });

  it('creates a revision on offer publish', async () => {
    const supplier = await setupSupplier();
    await approveSupplier(supplier.userId);
    
    const createResponse = await createDraftOffer(supplier.token);
    const offerId = createResponse.body.id;

    // Mock product images
    await h.s.prisma.evidence.createMany({
      data: [
        { id: 'test-image-1', ownerId: supplier.userId, poolId: null, disputeId: null, kind: 'PRODUCT', objectKey: 'test1.jpg', sha256: 'abc123', mime: 'image/jpeg' },
        { id: 'test-image-2', ownerId: supplier.userId, poolId: null, disputeId: null, kind: 'PRODUCT', objectKey: 'test2.jpg', sha256: 'def456', mime: 'image/jpeg' },
      ],
    });

    // Publish the offer
    const publishResponse = await h.http().post(`/v1/offers/${offerId}/publish`).set(auth(supplier.token)).send();
    expect(publishResponse.status).toBe(200);

    // Fetch revisions
    const revisions = await h.http().get(`/v1/offers/${offerId}/revisions`).set(auth(supplier.token));
    expect(revisions.status).toBe(200);
    expect(revisions.body.revisions).toHaveLength(2);
    
    expect(revisions.body.revisions[0].action).toBe('CREATE');
    expect(revisions.body.revisions[1].action).toBe('PUBLISH');
    expect(revisions.body.revisions[1].snapshot.status).toBe('LIVE');
  });

  it('enforces access control: only owner can view revisions', async () => {
    const supplier1 = await setupSupplier();
    const supplier2 = await setupSupplier();
    
    const createResponse = await createDraftOffer(supplier1.token);
    const offerId = createResponse.body.id;

    // Supplier 2 should not be able to view supplier 1's revisions
    const forbidden = await h.http().get(`/v1/offers/${offerId}/revisions`).set(auth(supplier2.token));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.message).toBe('not your offer');

    // Supplier 1 should be able to view their own revisions
    const allowed = await h.http().get(`/v1/offers/${offerId}/revisions`).set(auth(supplier1.token));
    expect(allowed.status).toBe(200);
  });

  it('enforces access control: admins can view any revisions', async () => {
    const supplier = await setupSupplier();
    const admin = await h.login(PHONE_ADMIN);
    
    const createResponse = await createDraftOffer(supplier.token);
    const offerId = createResponse.body.id;

    // Admin should be able to view any supplier's revisions
    const adminResponse = await h.http().get(`/v1/offers/${offerId}/revisions`).set(auth(admin.token));
    expect(adminResponse.status).toBe(200);
    expect(adminResponse.body.revisions).toHaveLength(1);
  });

  it('requires authentication to view revisions', async () => {
    const supplier = await setupSupplier();
    const createResponse = await createDraftOffer(supplier.token);
    const offerId = createResponse.body.id;

    // Unauthenticated request should fail
    const unauthenticated = await h.http().get(`/v1/offers/${offerId}/revisions`);
    expect(unauthenticated.status).toBe(401);
  });

  it('returns 404 for non-existent offer revisions', async () => {
    const supplier = await setupSupplier();
    const notFound = await h.http().get('/v1/offers/non-existent-id/revisions').set(auth(supplier.token));
    expect(notFound.status).toBe(404);
  });

  it('maintains revisions in chronological order', async () => {
    const supplier = await setupSupplier();
    const createResponse = await createDraftOffer(supplier.token);
    const offerId = createResponse.body.id;

    // Make multiple updates
    for (let i = 0; i < 3; i++) {
      const updateData = {
        title: `Update ${i + 1}`,
        brand: 'Test Brand',
        branded: false,
        description: `Description update ${i + 1}`,
        unitLabel: 'kg',
        category: 'GRAINS',
        perishable: false,
        images: ['test-image-1', 'test-image-2'],
        tiersNgn: [{ minUnits: 10, priceNgn: `${5000 + i * 1000}` }],
        moq: 10,
        maxUnits: 1000,
        maxPerMember: 100,
        leadTimeHours: 48,
        deliveryAreas: [{ state: 'Lagos', lga: 'Ikeja' }],
        validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      };
      await h.http().patch(`/v1/offers/${offerId}`).set(auth(supplier.token)).send(updateData);
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // Fetch revisions
    const revisions = await h.http().get(`/v1/offers/${offerId}/revisions`).set(auth(supplier.token));
    expect(revisions.status).toBe(200);
    expect(revisions.body.revisions).toHaveLength(4); // 1 CREATE + 3 UPDATE

    // Verify chronological order
    for (let i = 0; i < revisions.body.revisions.length - 1; i++) {
      const current = new Date(revisions.body.revisions[i].createdAt).getTime();
      const next = new Date(revisions.body.revisions[i + 1].createdAt).getTime();
      expect(current).toBeLessThanOrEqual(next);
    }
  });

  it('ensures revisions are immutable (append-only)', async () => {
    const supplier = await setupSupplier();
    const createResponse = await createDraftOffer(supplier.token);
    const offerId = createResponse.body.id;

    // Get initial revisions
    const initialRevisions = await h.http().get(`/v1/offers/${offerId}/revisions`).set(auth(supplier.token));
    const firstRevision = initialRevisions.body.revisions[0];

    // Update the offer
    const updateData = {
      title: 'Modified Title',
      brand: 'Test Brand',
      branded: false,
      description: 'Modified description',
      unitLabel: 'kg',
      category: 'GRAINS',
      perishable: false,
      images: ['test-image-1', 'test-image-2'],
      tiersNgn: [{ minUnits: 10, priceNgn: '7000' }],
      moq: 10,
      maxUnits: 1000,
      maxPerMember: 100,
      leadTimeHours: 48,
      deliveryAreas: [{ state: 'Lagos', lga: 'Ikeja' }],
      validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    };
    await h.http().patch(`/v1/offers/${offerId}`).set(auth(supplier.token)).send(updateData);

    // Get revisions again
    const updatedRevisions = await h.http().get(`/v1/offers/${offerId}/revisions`).set(auth(supplier.token));
    expect(updatedRevisions.body.revisions).toHaveLength(2);
    
    // Verify first revision is unchanged (immutable)
    const unchangedFirstRevision = updatedRevisions.body.revisions[0];
    expect(unchangedFirstRevision.id).toBe(firstRevision.id);
    expect(unchangedFirstRevision.action).toBe(firstRevision.action);
    expect(unchangedFirstRevision.createdAt).toBe(firstRevision.createdAt);
    expect(unchangedFirstRevision.snapshot).toEqual(firstRevision.snapshot);
  });

  it('records complete snapshot including all offer fields', async () => {
    const supplier = await setupSupplier();
    const createResponse = await createDraftOffer(supplier.token);
    const offerId = createResponse.body.id;

    const revisions = await h.http().get(`/v1/offers/${offerId}/revisions`).set(auth(supplier.token));
    const snapshot = revisions.body.revisions[0].snapshot;

    // Verify snapshot contains all important fields
    expect(snapshot).toHaveProperty('id');
    expect(snapshot).toHaveProperty('supplierId');
    expect(snapshot).toHaveProperty('title');
    expect(snapshot).toHaveProperty('description');
    expect(snapshot).toHaveProperty('unitLabel');
    expect(snapshot).toHaveProperty('category');
    expect(snapshot).toHaveProperty('tiersNgn');
    expect(snapshot).toHaveProperty('moq');
    expect(snapshot).toHaveProperty('maxUnits');
    expect(snapshot).toHaveProperty('deliveryAreas');
    expect(snapshot).toHaveProperty('validUntil');
    expect(snapshot).toHaveProperty('status');
    expect(snapshot).toHaveProperty('createdAt');
    expect(snapshot).toHaveProperty('updatedAt');
  });
});
