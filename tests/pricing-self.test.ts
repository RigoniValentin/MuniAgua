import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { setupTestDb, teardownTestDb, clearTestDb } from './setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import { ROLES, defaultPermissionsForRole } from '../src/modules/users/users.types';
import { signAccessToken } from '../src/modules/auth/auth.tokens';
import { Client } from '../src/modules/clients/clients.model';
import { Product } from '../src/modules/products/products.model';
import { PricingRule } from '../src/modules/pricing/pricing.rules.model';

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

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

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

const baseAddress = { street: 'Av. San Martín', number: '123', locality: 'Buchardo' };

async function seedClient(opts: {
  userId?: mongoose.Types.ObjectId | null;
  clientType?: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';
  active?: boolean;
} = {}) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Client.create({
    firstName: 'Test',
    lastName: `Client${idx}`,
    documentType: 'DNI',
    documentNumber: idx.toString(),
    clientType: opts.clientType ?? 'LOCAL',
    address: baseAddress,
    userId: opts.userId ?? null,
    active: opts.active ?? true,
  });
}

async function seedProduct(opts: {
  code?: string;
  name?: string;
  productType?: 'WATER_REFILL' | 'CONTAINER' | 'DISPENSER' | 'OTHER';
  basePriceMinor?: number;
  active?: boolean;
} = {}) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Product.create({
    code: opts.code ?? `P${idx}`,
    name: opts.name ?? 'Bidón 20L',
    description: null,
    productType: opts.productType ?? 'WATER_REFILL',
    basePriceMinor: opts.basePriceMinor ?? 1_000_000,
    tracksStock: false,
    active: opts.active ?? true,
  });
}

async function seedRule(opts: {
  name?: string;
  clientType: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';
  scope?: 'ALL_PRODUCTS' | 'PRODUCT_TYPE' | 'PRODUCT';
  productType?: 'WATER_REFILL' | 'CONTAINER' | 'DISPENSER' | 'OTHER' | null;
  productId?: mongoose.Types.ObjectId | null;
  adjustmentValue: number;
  priority?: number;
  active?: boolean;
}) {
  return PricingRule.create({
    name: opts.name ?? `Rule ${opts.adjustmentValue}%`,
    clientType: opts.clientType,
    scope: opts.scope ?? 'ALL_PRODUCTS',
    productType: opts.productType ?? null,
    productId: opts.productId ?? null,
    adjustmentType: 'PERCENTAGE',
    adjustmentValue: opts.adjustmentValue,
    priority: opts.priority ?? 0,
    active: opts.active ?? true,
  });
}

// ===========================================================================
// Self quote
// ===========================================================================

describe('POST /api/pricing/me/quote', () => {
  it('returns the personalized price for a linked JUBILADO with -50% rule', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient({ userId: citizen._id, clientType: 'JUBILADO' });
    const product = await seedProduct({ basePriceMinor: 1_000_000 });
    await seedRule({ clientType: 'JUBILADO', adjustmentValue: -50 });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/pricing/me/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.data.totals.finalMinor).toBe(500_000);
    expect(res.body.data.items[0].unitFinalPriceMinor).toBe(500_000);
    expect(res.body.data.items[0].adjustmentPercentage).toBe(-50);
    void client;
  });

  it('returns 404 CLIENT_NOT_LINKED when the user has no Client', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const product = await seedProduct();
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/pricing/me/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CLIENT_NOT_LINKED');
  });

  it('rejects inactive client for quote (4xx)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id, active: false });
    const product = await seedProduct();

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/pricing/me/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });

    expect([400, 422]).toContain(res.status);
  });

  it('rejects inactive product (4xx)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const product = await seedProduct({ active: false });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/pricing/me/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });

    expect([400, 422]).toContain(res.status);
  });

  it('rejects clientId in the body (strict schema)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const product = await seedProduct();

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/pricing/me/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clientId: new mongoose.Types.ObjectId().toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
      });
    expect(res.status).toBe(400);
  });

  it('rejects empty items (min 1)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/pricing/me/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [] });
    expect(res.status).toBe(400);
  });

  it('reflects rule changes dynamically (no code changes)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id, clientType: 'JUBILADO' });
    const product = await seedProduct({ basePriceMinor: 1_000_000 });
    const rule = await seedRule({ clientType: 'JUBILADO', adjustmentValue: -50 });

    const token = await loginAs('vecino@buchardo.gob.ar');

    const before = await request(app)
      .post('/api/pricing/me/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });
    expect(before.body.data.totals.finalMinor).toBe(500_000);

    rule.adjustmentValue = -25;
    await rule.save();

    const after = await request(app)
      .post('/api/pricing/me/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });
    expect(after.body.data.totals.finalMinor).toBe(750_000);
  });

  it('computes batch quote (multiple items)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id, clientType: 'JUBILADO' });
    const p1 = await seedProduct({ basePriceMinor: 1_000_000 });
    const p2 = await seedProduct({ basePriceMinor: 2_000_000 });
    await seedRule({ clientType: 'JUBILADO', adjustmentValue: -50 });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/pricing/me/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          { productId: p1._id.toString(), quantity: 2 },
          { productId: p2._id.toString(), quantity: 1 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    // p1 = $10.000 x 2 = $20.000 → $10.000
    // p2 = $20.000 x 1 = $20.000 → $10.000
    expect(res.body.data.totals.finalMinor).toBe(2_000_000);
  });

  it('CIUDADANO A cannot get the quote for CIUDADANO B\'s client', async () => {
    const a = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const b = await seedUser('CIUDADANO', 'other@buchardo.gob.ar');
    await seedClient({ userId: a._id, clientType: 'JUBILADO' });
    const clientB = await seedClient({ userId: b._id, clientType: 'LOCAL' });
    const product = await seedProduct();

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/pricing/me/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });

    // The /me endpoint resolves to A's client, never B's.
    expect(res.status).toBe(200);
    expect(res.body.data.client.id).not.toBe(clientB._id.toString());
  });

  it('no adjustment rule: returns base price unchanged', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id, clientType: 'LOCAL' });
    const product = await seedProduct({ basePriceMinor: 1_500_000 });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/pricing/me/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });

    expect(res.body.data.totals.finalMinor).toBe(1_500_000);
    expect(res.body.data.items[0].adjustmentPercentage).toBe(0);
  });
});

// ===========================================================================
// Self-quote does NOT require CIUDADANO. Any role with `pricing.quote` works.
// But the client must be linked.
// ===========================================================================

describe('POST /api/pricing/me/quote — cross-role', () => {
  it('ADMIN without linked client: 404 CLIENT_NOT_LINKED', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const product = await seedProduct();
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/pricing/me/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CLIENT_NOT_LINKED');
  });
});