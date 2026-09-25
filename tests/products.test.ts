import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { setupTestDb, teardownTestDb, clearTestDb } from './setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import { ROLES, defaultPermissionsForRole } from '../src/modules/users/users.types';
import { signAccessToken } from '../src/modules/auth/auth.tokens';

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await setupTestDb();
  loadEnv();
  app = createApp();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearTestDb();
});

async function seedUser(role: keyof typeof ROLES, email: string) {
  return createUser({
    firstName: role,
    lastName: 'Test',
    email,
    password: 'Password123',
    role: ROLES[role],
  });
}

async function loginAs(email: string) {
  const { User } = await import('../src/modules/users/users.model');
  const user = await User.findOne({ email });
  if (!user) throw new Error(`User not found: ${email}`);
  return signAccessToken({
    sub: user._id.toString(),
    role: user.role,
    permissions: defaultPermissionsForRole(user.role),
  });
}

function validProductBody(overrides: Record<string, unknown> = {}) {
  return {
    code: 'AGUA_RECARGA',
    name: 'Recarga de agua',
    description: 'Recarga de agua 20L',
    productType: 'WATER_REFILL',
    basePriceMinor: 1_000_000,
    tracksStock: false,
    active: true,
    ...overrides,
  };
}

describe('POST /api/products', () => {
  it('creates a valid product as ADMIN', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send(validProductBody());

    expect(res.status).toBe(201);
    expect(res.body.data.product).toMatchObject({
      code: 'AGUA_RECARGA',
      name: 'Recarga de agua',
      productType: 'WATER_REFILL',
      basePriceMinor: 1_000_000,
      tracksStock: false,
      active: true,
    });
    expect(res.body.data.product.id).toBeDefined();
  });

  it('normalizes product code to uppercase and underscore', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send(validProductBody({ code: 'agua recarga' }));

    expect(res.status).toBe(201);
    expect(res.body.data.product.code).toBe('AGUA_RECARGA');
  });

  it('rejects duplicate code with 409', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send(validProductBody({ code: 'AGUA_RECARGA' }));

    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send(validProductBody({ code: 'AGUA_RECARGA', name: 'Otro' }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects creation without products.create permission', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send(validProductBody());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects non-integer basePriceMinor', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send(validProductBody({ basePriceMinor: 12.5 }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects negative basePriceMinor', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send(validProductBody({ basePriceMinor: -1 }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/products', () => {
  it('lists products as REPARTIDOR', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it('returns 403 for CIUDADANO only if no products.read (currently has it)', async () => {
    // CIUDADANO has products.read by policy in FASE 3 (will request from frontend).
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/products/:id', () => {
  it('returns a product by id', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const created = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send(validProductBody());
    const id = created.body.data.product.id;

    const res = await request(app)
      .get(`/api/products/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.product.id).toBe(id);
  });

  it('returns 400 for invalid id format', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/products/not-a-valid-id')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for non-existent product', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/products/507f1f77bcf86cd799439011')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /api/products/:id', () => {
  it('updates a product partially', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const created = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send(validProductBody());
    const id = created.body.data.product.id;

    const res = await request(app)
      .patch(`/api/products/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ basePriceMinor: 2_000_000 });

    expect(res.status).toBe(200);
    expect(res.body.data.product.basePriceMinor).toBe(2_000_000);
  });

  it('deactivates a product', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const created = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send(validProductBody());
    const id = created.body.data.product.id;

    const res = await request(app)
      .patch(`/api/products/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ active: false });

    expect(res.status).toBe(200);
    expect(res.body.data.product.active).toBe(false);
  });
});

describe('GET /api/products — filters and pagination', () => {
  async function seedThree(token: string) {
    const bodies = [
      validProductBody({
        code: 'AGUA_RECARGA',
        name: 'Recarga de agua',
        productType: 'WATER_REFILL',
        tracksStock: false,
        active: true,
      }),
      validProductBody({
        code: 'BIDON',
        name: 'Bidón',
        productType: 'CONTAINER',
        tracksStock: true,
        active: true,
      }),
      validProductBody({
        code: 'DISPENSER',
        name: 'Dispenser',
        productType: 'DISPENSER',
        tracksStock: true,
        active: false,
      }),
    ];
    for (const body of bodies) {
      const r = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(r.status).toBe(201);
    }
  }

  it('filters by productType', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    await seedThree(token);

    const res = await request(app)
      .get('/api/products?productType=CONTAINER')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].productType).toBe('CONTAINER');
  });

  it('filters by active=false', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    await seedThree(token);

    const res = await request(app)
      .get('/api/products?active=false')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].code).toBe('DISPENSER');
  });

  it('searches by code', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    await seedThree(token);

    const res = await request(app)
      .get('/api/products?search=bidon')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].code).toBe('BIDON');
  });

  it('searches by name', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    await seedThree(token);

    const res = await request(app)
      .get('/api/products?search=dispenser')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].code).toBe('DISPENSER');
  });
});
