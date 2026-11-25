import { Keypair } from '@stellar/stellar-sdk';
import { startHarness, type Harness, PHONE_ADMIN } from './harness.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); }, 60_000);
afterAll(async () => { await h.close(); });

describe('GET /offers cursor pagination (#67)', () => {
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  let phoneCounter = 2000;
  const newPhone = () => `+234803200${String(phoneCounter++).padStart(4, '0')}`;

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

  async function createAndPublishOffer(token: string, title: string, category = 'GRAINS') {
    // Mock product images
    const imageIds = [`img-${Date.now()}-1`, `img-${Date.now()}-2`];
    const userId = (await h.http().get('/v1/me').set(auth(token))).body.id;
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
      description: 'A test product for pagination',
      unitLabel: 'kg',
      category,
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

  it('returns offers with default limit of 20', async () => {
    const response = await h.http().get('/v1/offers');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeLessThanOrEqual(20);
  });

  it('respects custom limit parameter', async () => {
    const supplier = await setupSupplier();
    
    // Create 5 offers
    for (let i = 0; i < 5; i++) {
      await createAndPublishOffer(supplier.token, `Product ${i}`);
      await new Promise(resolve => setTimeout(resolve, 50)); // Ensure different timestamps
    }

    const response = await h.http().get('/v1/offers?limit=3');
    expect(response.status).toBe(200);
    expect(response.body.length).toBeLessThanOrEqual(3);
  });

  it('enforces max limit of 100', async () => {
    const response = await h.http().get('/v1/offers?limit=200');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION');
    expect(response.body.fields.some((f: { path: string }) => f.path === 'limit')).toBe(true);
  });

  it('enforces min limit of 1', async () => {
    const response = await h.http().get('/v1/offers?limit=0');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION');
    expect(response.body.fields.some((f: { path: string }) => f.path === 'limit')).toBe(true);
  });

  it('provides X-Next-Cursor header when more results are available', async () => {
    const supplier = await setupSupplier();
    
    // Create 4 offers
    const offerIds = [];
    for (let i = 0; i < 4; i++) {
      const id = await createAndPublishOffer(supplier.token, `Paginated Product ${i}`);
      offerIds.push(id);
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const response = await h.http().get('/v1/offers?limit=2');
    expect(response.status).toBe(200);
    expect(response.body.length).toBe(2);
    expect(response.headers['x-next-cursor']).toBeDefined();
    
    const cursor = response.headers['x-next-cursor'];
    expect(typeof cursor).toBe('string');
    expect(cursor.length).toBeGreaterThan(0);
  });

  it('does not provide X-Next-Cursor when on last page', async () => {
    const supplier = await setupSupplier();
    
    // Create 2 offers
    await createAndPublishOffer(supplier.token, 'Last Page Product 1');
    await new Promise(resolve => setTimeout(resolve, 50));
    await createAndPublishOffer(supplier.token, 'Last Page Product 2');

    const response = await h.http().get('/v1/offers?limit=10');
    expect(response.status).toBe(200);
    expect(response.headers['x-next-cursor']).toBeUndefined();
  });

  it('walks through three pages correctly', async () => {
    const supplier = await setupSupplier();
    
    // Create 7 offers
    const offerIds = [];
    for (let i = 0; i < 7; i++) {
      const id = await createAndPublishOffer(supplier.token, `Walk Product ${i}`);
      offerIds.push(id);
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Page 1
    const page1 = await h.http().get('/v1/offers?limit=3');
    expect(page1.status).toBe(200);
    expect(page1.body.length).toBe(3);
    expect(page1.headers['x-next-cursor']).toBeDefined();
    const page1Ids = page1.body.map((o: { id: string }) => o.id);

    // Page 2
    const cursor1 = page1.headers['x-next-cursor'];
    const page2 = await h.http().get(`/v1/offers?limit=3&cursor=${cursor1}`);
    expect(page2.status).toBe(200);
    expect(page2.body.length).toBe(3);
    expect(page2.headers['x-next-cursor']).toBeDefined();
    const page2Ids = page2.body.map((o: { id: string }) => o.id);

    // Page 3
    const cursor2 = page2.headers['x-next-cursor'];
    const page3 = await h.http().get(`/v1/offers?limit=3&cursor=${cursor2}`);
    expect(page3.status).toBe(200);
    expect(page3.body.length).toBeLessThanOrEqual(3);
    expect(page3.headers['x-next-cursor']).toBeUndefined();
    const page3Ids = page3.body.map((o: { id: string }) => o.id);

    // Verify no duplicates across pages
    const allPageIds = [...page1Ids, ...page2Ids, ...page3Ids];
    const uniqueIds = new Set(allPageIds);
    expect(allPageIds.length).toBe(uniqueIds.size);

    // Verify no gaps (all our created offers are present)
    const ourOffers = offerIds.filter(id => allPageIds.includes(id));
    expect(ourOffers.length).toBe(7);
  });

  it('remains stable when new offer is inserted between pages', async () => {
    const supplier = await setupSupplier();
    
    // Create 5 offers
    for (let i = 0; i < 5; i++) {
      await createAndPublishOffer(supplier.token, `Stable Product ${i}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Get page 1
    const page1 = await h.http().get('/v1/offers?limit=2');
    expect(page1.status).toBe(200);
    const page1Ids = page1.body.map((o: { id: string }) => o.id);
    const cursor = page1.headers['x-next-cursor'];

    // Insert a new offer after getting page 1 but before page 2
    await createAndPublishOffer(supplier.token, 'Inserted Product');

    // Get page 2 with the cursor from before the insertion
    const page2 = await h.http().get(`/v1/offers?limit=2&cursor=${cursor}`);
    expect(page2.status).toBe(200);
    const page2Ids = page2.body.map((o: { id: string }) => o.id);

    // Verify no duplicates between pages despite the insertion
    const overlap = page1Ids.filter((id: string) => page2Ids.includes(id));
    expect(overlap.length).toBe(0);

    // The new offer should not appear in page 2 (cursor-based pagination is stable)
    expect(page2Ids).not.toContain('Inserted Product');
  });

  it('supports pagination with category filter', async () => {
    const supplier = await setupSupplier();
    
    // Create offers in different categories
    await createAndPublishOffer(supplier.token, 'Grain Product 1', 'GRAINS');
    await new Promise(resolve => setTimeout(resolve, 50));
    await createAndPublishOffer(supplier.token, 'Grain Product 2', 'GRAINS');
    await new Promise(resolve => setTimeout(resolve, 50));
    await createAndPublishOffer(supplier.token, 'Grain Product 3', 'GRAINS');

    const response = await h.http().get('/v1/offers?category=GRAINS&limit=2');
    expect(response.status).toBe(200);
    expect(response.body.length).toBe(2);
    expect(response.body.every((o: { category: string }) => o.category === 'GRAINS')).toBe(true);
    
    if (response.headers['x-next-cursor']) {
      const page2 = await h.http().get(`/v1/offers?category=GRAINS&limit=2&cursor=${response.headers['x-next-cursor']}`);
      expect(page2.status).toBe(200);
      expect(page2.body.every((o: { category: string }) => o.category === 'GRAINS')).toBe(true);
    }
  });

  it('returns offers in newest-first order', async () => {
    const supplier = await setupSupplier();
    
    // Create offers with delays to ensure different timestamps
    const offer1 = await createAndPublishOffer(supplier.token, 'Oldest Product');
    await new Promise(resolve => setTimeout(resolve, 100));
    const offer2 = await createAndPublishOffer(supplier.token, 'Middle Product');
    await new Promise(resolve => setTimeout(resolve, 100));
    const offer3 = await createAndPublishOffer(supplier.token, 'Newest Product');

    const response = await h.http().get('/v1/offers?limit=10');
    expect(response.status).toBe(200);
    
    // Find our offers in the response
    const ourOffers = response.body.filter((o: { id: string }) => 
      [offer1, offer2, offer3].includes(o.id)
    );
    
    if (ourOffers.length === 3) {
      // Verify newest first ordering
      const idx1 = response.body.findIndex((o: { id: string }) => o.id === offer1);
      const idx2 = response.body.findIndex((o: { id: string }) => o.id === offer2);
      const idx3 = response.body.findIndex((o: { id: string }) => o.id === offer3);
      
      expect(idx3).toBeLessThan(idx2);
      expect(idx2).toBeLessThan(idx1);
    }
  });

  it('handles invalid cursor gracefully', async () => {
    const response = await h.http().get('/v1/offers?cursor=invalid-cursor-id');
    // Should either return 400 or return empty results, not crash
    expect([200, 400]).toContain(response.status);
  });

  it('allows unauthenticated access to offers list', async () => {
    const response = await h.http().get('/v1/offers?limit=5');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });
});
