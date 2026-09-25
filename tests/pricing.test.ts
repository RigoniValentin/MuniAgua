import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { setupTestDb, teardownTestDb, clearTestDb } from './setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import { ROLES, defaultPermissionsForRole } from '../src/modules/users/users.types';
import { signAccessToken } from '../src/modules/auth/auth.tokens';
import { Product } from '../src/modules/products/products.model';
import { Client } from '../src/modules/clients/clients.model';
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

async function seedProduct(
  code: string,
  productType: 'WATER_REFILL' | 'CONTAINER' | 'DISPENSER' | 'OTHER',
  basePriceMinor: number,
  tracksStock = false,
) {
  return Product.create({
    code,
    name: code,
    productType,
    basePriceMinor,
    tracksStock,
    active: true,
  });
}

async function seedClient(
  clientType: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL',
  userId?: mongoose.Types.ObjectId | null,
) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Client.create({
    firstName: 'Test',
    lastName: clientType + idx.toString(),
    documentType: 'DNI',
    documentNumber: idx.toString(),
    clientType,
    address: { street: 'Av', number: '123', locality: 'Buchardo' },
    userId: userId ?? null,
    active: true,
  });
}

async function seedRule(args: {
  name: string;
  clientType: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';
  scope: 'ALL_PRODUCTS' | 'PRODUCT_TYPE' | 'PRODUCT';
  productType?: 'WATER_REFILL' | 'CONTAINER' | 'DISPENSER' | 'OTHER';
  productId?: mongoose.Types.ObjectId;
  adjustmentValue: number;
  priority?: number;
  active?: boolean;
}) {
  return PricingRule.create({
    name: args.name,
    clientType: args.clientType,
    scope: args.scope,
    productType: args.productType ?? null,
    productId: args.productId ?? null,
    adjustmentType: 'PERCENTAGE',
    adjustmentValue: args.adjustmentValue,
    priority: args.priority ?? 0,
    active: args.active ?? true,
  });
}

const baseAddress = { street: 'Av', number: '123', locality: 'Buchardo' };

describe('Pricing engine — base percentages', () => {
  it('applies LOCAL 0% (price unchanged)', async () => {
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    await seedRule({
      name: 'Local 0',
      clientType: 'LOCAL',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: 0,
    });

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('LOCAL');
    const result = await buildQuote(client._id.toString(), [
      { productId: product._id.toString(), quantity: 1 },
    ]);

    expect(result.items[0].unitBasePriceMinor).toBe(1_000_000);
    expect(result.items[0].unitFinalPriceMinor).toBe(1_000_000);
    expect(result.items[0].appliedRule?.name).toBe('Local 0');
    expect(result.totals.finalMinor).toBe(1_000_000);
  });

  it('applies JUBILADO -50%', async () => {
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    await seedRule({
      name: 'Jubilados',
      clientType: 'JUBILADO',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -50,
    });

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('JUBILADO');
    const result = await buildQuote(client._id.toString(), [
      { productId: product._id.toString(), quantity: 1 },
    ]);

    expect(result.items[0].unitFinalPriceMinor).toBe(500_000);
    expect(result.totals.finalMinor).toBe(500_000);
  });

  it('applies NO_LOCAL +40%', async () => {
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    await seedRule({
      name: 'No local',
      clientType: 'NO_LOCAL',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: 40,
    });

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('NO_LOCAL');
    const result = await buildQuote(client._id.toString(), [
      { productId: product._id.toString(), quantity: 1 },
    ]);

    expect(result.items[0].unitFinalPriceMinor).toBe(1_400_000);
  });

  it('applies AYUDA_SOCIAL -100% (final = 0)', async () => {
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    await seedRule({
      name: 'Ayuda social',
      clientType: 'AYUDA_SOCIAL',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -100,
    });

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('AYUDA_SOCIAL');
    const result = await buildQuote(client._id.toString(), [
      { productId: product._id.toString(), quantity: 1 },
    ]);

    expect(result.items[0].unitFinalPriceMinor).toBe(0);
    expect(result.items[0].subtotalFinalMinor).toBe(0);
    expect(result.totals.finalMinor).toBe(0);
  });

  it('multiplies by quantity 2 for JUBILADO (-50%)', async () => {
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    await seedRule({
      name: 'Jubilados',
      clientType: 'JUBILADO',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -50,
    });

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('JUBILADO');
    const result = await buildQuote(client._id.toString(), [
      { productId: product._id.toString(), quantity: 2 },
    ]);

    expect(result.items[0].subtotalBaseMinor).toBe(2_000_000);
    expect(result.items[0].subtotalFinalMinor).toBe(1_000_000);
    expect(result.totals.finalMinor).toBe(1_000_000);
  });

  it('returns base price when no rule applies', async () => {
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('LOCAL');
    const result = await buildQuote(client._id.toString(), [
      { productId: product._id.toString(), quantity: 1 },
    ]);

    expect(result.items[0].appliedRule).toBeNull();
    expect(result.items[0].unitFinalPriceMinor).toBe(1_000_000);
  });
});

describe('Pricing engine — specificity', () => {
  it('PRODUCT scope beats ALL_PRODUCTS', async () => {
    const water = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    const dispenser = await seedProduct('DISPENSER', 'DISPENSER', 3_500_000);
    await seedRule({
      name: 'Jubilado global',
      clientType: 'JUBILADO',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -50,
    });
    await seedRule({
      name: 'Jubilado dispenser',
      clientType: 'JUBILADO',
      scope: 'PRODUCT',
      productId: dispenser._id,
      adjustmentValue: -20,
    });

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('JUBILADO');
    const result = await buildQuote(client._id.toString(), [
      { productId: water._id.toString(), quantity: 1 },
      { productId: dispenser._id.toString(), quantity: 1 },
    ]);

    const waterLine = result.items.find((i) => i.productCode === 'AGUA');
    const dispenserLine = result.items.find((i) => i.productCode === 'DISPENSER');

    expect(waterLine?.unitFinalPriceMinor).toBe(500_000); // -50%
    expect(waterLine?.appliedRule?.name).toBe('Jubilado global');

    expect(dispenserLine?.unitFinalPriceMinor).toBe(2_800_000); // -20%
    expect(dispenserLine?.appliedRule?.name).toBe('Jubilado dispenser');
  });

  it('PRODUCT_TYPE scope beats ALL_PRODUCTS', async () => {
    const dispenser = await seedProduct('DISPENSER', 'DISPENSER', 1_000_000);
    await seedRule({
      name: 'Jubilado global',
      clientType: 'JUBILADO',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -50,
    });
    await seedRule({
      name: 'Jubilado dispenser type',
      clientType: 'JUBILADO',
      scope: 'PRODUCT_TYPE',
      productType: 'DISPENSER',
      adjustmentValue: -10,
    });

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('JUBILADO');
    const result = await buildQuote(client._id.toString(), [
      { productId: dispenser._id.toString(), quantity: 1 },
    ]);

    expect(result.items[0].unitFinalPriceMinor).toBe(900_000);
    expect(result.items[0].appliedRule?.scope).toBe('PRODUCT_TYPE');
  });

  it('PRODUCT scope beats PRODUCT_TYPE', async () => {
    const dispenser = await seedProduct('DISPENSER', 'DISPENSER', 1_000_000);
    await seedRule({
      name: 'Jubilado dispenser type',
      clientType: 'JUBILADO',
      scope: 'PRODUCT_TYPE',
      productType: 'DISPENSER',
      adjustmentValue: -10,
    });
    await seedRule({
      name: 'Jubilado dispenser product',
      clientType: 'JUBILADO',
      scope: 'PRODUCT',
      productId: dispenser._id,
      adjustmentValue: -25,
    });

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('JUBILADO');
    const result = await buildQuote(client._id.toString(), [
      { productId: dispenser._id.toString(), quantity: 1 },
    ]);

    expect(result.items[0].unitFinalPriceMinor).toBe(750_000);
    expect(result.items[0].appliedRule?.scope).toBe('PRODUCT');
  });

  it('higher priority wins at same specificity', async () => {
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    await seedRule({
      name: 'Jubilado low',
      clientType: 'JUBILADO',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -10,
      priority: 0,
    });
    await seedRule({
      name: 'Jubilado high',
      clientType: 'JUBILADO',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -40,
      priority: 100,
    });

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('JUBILADO');
    const result = await buildQuote(client._id.toString(), [
      { productId: product._id.toString(), quantity: 1 },
    ]);

    expect(result.items[0].unitFinalPriceMinor).toBe(600_000);
    expect(result.items[0].appliedRule?.name).toBe('Jubilado high');
  });

  it('returned value reflects the actual rule (-33% proves no hardcode)', async () => {
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    await seedRule({
      name: 'Jubilado custom',
      clientType: 'JUBILADO',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -33,
    });

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('JUBILADO');
    const result = await buildQuote(client._id.toString(), [
      { productId: product._id.toString(), quantity: 1 },
    ]);

    expect(result.items[0].unitFinalPriceMinor).toBe(670_000);
    expect(result.items[0].appliedRule?.adjustmentValue).toBe(-33);
  });
});

describe('Pricing engine — error handling', () => {
  it('rejects inactive client', async () => {
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    const client = await Client.create({
      firstName: 'I',
      lastName: 'N',
      documentType: 'DNI',
      documentNumber: '12312312',
      clientType: 'LOCAL',
      address: baseAddress,
      active: false,
    });
    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    await expect(
      buildQuote(client._id.toString(), [
        { productId: product._id.toString(), quantity: 1 },
      ]),
    ).rejects.toThrow(/inactivo/i);
  });

  it('rejects inactive product', async () => {
    const product = await Product.create({
      code: 'X',
      name: 'X',
      productType: 'WATER_REFILL',
      basePriceMinor: 1_000_000,
      tracksStock: false,
      active: false,
    });
    const client = await seedClient('LOCAL');
    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    await expect(
      buildQuote(client._id.toString(), [
        { productId: product._id.toString(), quantity: 1 },
      ]),
    ).rejects.toThrow(/inactivo/i);
  });

  it('rejects non-existent client', async () => {
    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      buildQuote(fakeId, [
        { productId: new mongoose.Types.ObjectId().toString(), quantity: 1 },
      ]),
    ).rejects.toThrow();
  });

  it('rejects non-existent product', async () => {
    const client = await seedClient('LOCAL');
    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    await expect(
      buildQuote(client._id.toString(), [
        { productId: new mongoose.Types.ObjectId().toString(), quantity: 1 },
      ]),
    ).rejects.toThrow();
  });

  it('clamps the final price to 0 (never negative)', async () => {
    const product = await seedProduct('AGUA', 'WATER_REFILL', 100);
    await seedRule({
      name: 'Over-discount',
      clientType: 'LOCAL',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -100,
    });
    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('LOCAL');
    const result = await buildQuote(client._id.toString(), [
      { productId: product._id.toString(), quantity: 3 },
    ]);
    expect(result.items[0].unitFinalPriceMinor).toBe(0);
    expect(result.items[0].subtotalFinalMinor).toBe(0);
    expect(result.totals.finalMinor).toBe(0);
  });
});

describe('Pricing rules API', () => {
  it('creates an ALL_PRODUCTS rule', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/pricing/rules')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Local base',
        clientType: 'LOCAL',
        scope: 'ALL_PRODUCTS',
        adjustmentValue: 0,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.rule.name).toBe('Local base');
  });

  it('rejects PRODUCT scope without productId', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/pricing/rules')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'X',
        clientType: 'LOCAL',
        scope: 'PRODUCT',
        adjustmentValue: -10,
      });
    expect(res.status).toBe(400);
  });

  it('rejects PRODUCT_TYPE scope without productType', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/pricing/rules')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'X',
        clientType: 'LOCAL',
        scope: 'PRODUCT_TYPE',
        adjustmentValue: -10,
      });
    expect(res.status).toBe(400);
  });

  it('rejects rule creation without pricing.manage', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/pricing/rules')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'X',
        clientType: 'LOCAL',
        scope: 'ALL_PRODUCTS',
        adjustmentValue: 0,
      });
    expect(res.status).toBe(403);
  });

  it('returns 409 on equivalent active rule', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    await request(app)
      .post('/api/pricing/rules')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Local base',
        clientType: 'LOCAL',
        scope: 'ALL_PRODUCTS',
        adjustmentValue: 0,
      });
    const res = await request(app)
      .post('/api/pricing/rules')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Local base 2',
        clientType: 'LOCAL',
        scope: 'ALL_PRODUCTS',
        adjustmentValue: 0,
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('deactivates a rule via PATCH active=false', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const created = await request(app)
      .post('/api/pricing/rules')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Local base',
        clientType: 'LOCAL',
        scope: 'ALL_PRODUCTS',
        adjustmentValue: 0,
      });
    const id = created.body.data.rule.id;
    const res = await request(app)
      .patch(`/api/pricing/rules/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.data.rule.active).toBe(false);
  });
});

describe('POST /api/pricing/quote', () => {
  it('returns 400 for quantity 0', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    const client = await seedClient('LOCAL');
    const res = await request(app)
      .post('/api/pricing/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ clientId: client._id.toString(), items: [{ productId: product._id.toString(), quantity: 0 }] });
    expect(res.status).toBe(400);
  });

  it('returns 400 for decimal quantity', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    const client = await seedClient('LOCAL');
    const res = await request(app)
      .post('/api/pricing/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ clientId: client._id.toString(), items: [{ productId: product._id.toString(), quantity: 1.5 }] });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid productId', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient('LOCAL');
    const res = await request(app)
      .post('/api/pricing/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ clientId: client._id.toString(), items: [{ productId: 'invalid', quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid clientId', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    const res = await request(app)
      .post('/api/pricing/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ clientId: 'invalid', items: [{ productId: product._id.toString(), quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent client', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    const res = await request(app)
      .post('/api/pricing/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clientId: new mongoose.Types.ObjectId().toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
      });
    expect(res.status).toBe(404);
  });

  it('REP can quote any client', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    await seedRule({
      name: 'Jubilados',
      clientType: 'JUBILADO',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -50,
    });
    const client = await seedClient('JUBILADO');
    const res = await request(app)
      .post('/api/pricing/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clientId: client._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].unitFinalPriceMinor).toBe(500_000);
  });

  it('OPERADOR without pricing.manage can quote but cannot manage rules', async () => {
    await seedUser('OPERADOR', 'operador@buchardo.gob.ar');
    const token = await loginAs('operador@buchardo.gob.ar');
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    const client = await seedClient('LOCAL');

    // Can quote
    const quoteRes = await request(app)
      .post('/api/pricing/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clientId: client._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
      });
    expect(quoteRes.status).toBe(200);

    // Cannot manage rules
    const ruleRes = await request(app)
      .post('/api/pricing/rules')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'X',
        clientType: 'LOCAL',
        scope: 'ALL_PRODUCTS',
        adjustmentValue: 0,
      });
    expect(ruleRes.status).toBe(403);
  });

  it('CIUDADANO cannot quote another citizen\'s client', async () => {
    const admin = await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const ciudadano = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    const linkedClient = await Client.create({
      firstName: 'Ana',
      lastName: 'Vecina',
      documentType: 'DNI',
      documentNumber: '88888888',
      clientType: 'LOCAL',
      address: baseAddress,
      userId: ciudadano._id,
      active: true,
    });
    const otherClient = await Client.create({
      firstName: 'Otro',
      lastName: 'Vecino',
      documentType: 'DNI',
      documentNumber: '77777777',
      clientType: 'LOCAL',
      address: baseAddress,
      userId: admin._id,
      active: true,
    });

    const token = await loginAs('vecino@buchardo.gob.ar');

    // Self-linked is allowed
    const ok = await request(app)
      .post('/api/pricing/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clientId: linkedClient._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
      });
    expect(ok.status).toBe(200);

    // Other client is forbidden
    const forbidden = await request(app)
      .post('/api/pricing/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clientId: otherClient._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
      });
    expect(forbidden.status).toBe(403);
  });

  it('CIUDADANO cannot quote unlinked client', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    const unlinkedClient = await Client.create({
      firstName: 'Ana',
      lastName: 'Vecina',
      documentType: 'DNI',
      documentNumber: '55555555',
      clientType: 'LOCAL',
      address: baseAddress,
      userId: null,
      active: true,
    });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/pricing/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clientId: unlinkedClient._id.toString(),
        items: [{ productId: product._id.toString(), quantity: 1 }],
      });
    expect(res.status).toBe(403);
  });
});

describe('Inactive rule is ignored by engine', () => {
  it('engine ignores rules with active=false', async () => {
    const product = await seedProduct('AGUA', 'WATER_REFILL', 1_000_000);
    await seedRule({
      name: 'Disabled',
      clientType: 'LOCAL',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -50,
      active: false,
    });
    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('LOCAL');
    const result = await buildQuote(client._id.toString(), [
      { productId: product._id.toString(), quantity: 1 },
    ]);
    expect(result.items[0].appliedRule).toBeNull();
    expect(result.items[0].unitFinalPriceMinor).toBe(1_000_000);
  });
});
