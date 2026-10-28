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

async function adminToken() {
  await seedUser('ADMIN', 'admin@buchardo.gob.ar');
  return loginAs('admin@buchardo.gob.ar');
}

async function seedProduct(
  code: string,
  productType: 'WATER_REFILL' | 'CONTAINER' | 'DISPENSER' | 'OTHER',
  basePriceMinor: number,
) {
  return Product.create({
    code,
    name: code,
    productType,
    basePriceMinor,
    tracksStock: false,
    active: true,
  });
}

async function seedClient(
  clientType: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL',
) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Client.create({
    firstName: 'Test',
    lastName: clientType + idx.toString(),
    documentType: 'DNI',
    documentNumber: idx.toString(),
    clientType,
    address: { street: 'Av', number: '123', locality: 'Buchardo' },
    userId: null,
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
}) {
  return PricingRule.create({
    name: args.name,
    clientType: args.clientType,
    scope: args.scope,
    productType: args.productType ?? null,
    productId: args.productId ?? null,
    adjustmentType: 'PERCENTAGE',
    adjustmentValue: args.adjustmentValue,
    priority: 0,
    active: true,
  });
}

describe('Precio fijo por tipo de cliente — motor de precios', () => {
  it('el precio fijo gana sobre la regla de porcentaje', async () => {
    const product = await seedProduct('BIDON', 'CONTAINER', 1_000_000);
    await seedRule({
      name: 'Jubilados',
      clientType: 'JUBILADO',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -50,
    });
    product.clientTypePrices = [
      {
        clientType: 'JUBILADO',
        priceMinor: 650_000,
        basePriceMinorAtSet: 1_000_000,
      },
    ];
    await product.save();

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('JUBILADO');
    const result = await buildQuote(client._id.toString(), [
      { productId: product._id.toString(), quantity: 1 },
    ]);

    const line = result.items[0];
    expect(line.unitFinalPriceMinor).toBe(650_000);
    expect(line.priceSource).toBe('FIXED');
    expect(line.appliedRule).toBeNull();
    // Margen equivalente: (650.000 - 1.000.000) / 1.000.000 = -35%
    expect(line.adjustmentPercentage).toBe(-35);
    expect(result.totals.finalMinor).toBe(650_000);
    expect(result.totals.baseMinor).toBe(1_000_000);
  });

  it('el precio fijo se aplica aunque no haya ninguna regla', async () => {
    const product = await seedProduct('BIDON', 'CONTAINER', 1_000_000);
    product.clientTypePrices = [
      {
        clientType: 'NO_LOCAL',
        priceMinor: 1_234_567,
        basePriceMinorAtSet: 1_000_000,
      },
    ];
    await product.save();

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('NO_LOCAL');
    const result = await buildQuote(client._id.toString(), [
      { productId: product._id.toString(), quantity: 1 },
    ]);

    expect(result.items[0].unitFinalPriceMinor).toBe(1_234_567);
    expect(result.items[0].priceSource).toBe('FIXED');
    expect(result.items[0].adjustmentPercentage).toBe(23);
  });

  it('el precio fijo de un tipo de cliente no afecta a los demás', async () => {
    const product = await seedProduct('BIDON', 'CONTAINER', 1_000_000);
    await seedRule({
      name: 'Jubilados',
      clientType: 'JUBILADO',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -50,
    });
    await seedRule({
      name: 'No local',
      clientType: 'NO_LOCAL',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: 40,
    });
    product.clientTypePrices = [
      {
        clientType: 'JUBILADO',
        priceMinor: 650_000,
        basePriceMinorAtSet: 1_000_000,
      },
    ];
    await product.save();

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const noLocal = await seedClient('NO_LOCAL');
    const result = await buildQuote(noLocal._id.toString(), [
      { productId: product._id.toString(), quantity: 1 },
    ]);

    expect(result.items[0].unitFinalPriceMinor).toBe(1_400_000);
    expect(result.items[0].priceSource).toBe('PERCENTAGE');
  });

  it('un precio fijo de $0 se respeta (no lo pisa la regla -100%)', async () => {
    const product = await seedProduct('BIDON', 'CONTAINER', 1_000_000);
    await seedRule({
      name: 'Ayuda social',
      clientType: 'AYUDA_SOCIAL',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -100,
    });
    product.clientTypePrices = [
      {
        clientType: 'AYUDA_SOCIAL',
        priceMinor: 0,
        basePriceMinorAtSet: 1_000_000,
      },
    ];
    await product.save();

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('AYUDA_SOCIAL');
    const result = await buildQuote(client._id.toString(), [
      { productId: product._id.toString(), quantity: 1 },
    ]);

    expect(result.items[0].unitFinalPriceMinor).toBe(0);
    expect(result.items[0].priceSource).toBe('FIXED');
  });
});

describe('GET /api/pricing/price-matrix', () => {
  it('devuelve una celda por tipo de cliente con el origen del precio', async () => {
    const token = await adminToken();
    const product = await seedProduct('BIDON', 'CONTAINER', 1_000_000);
    await seedRule({
      name: 'Jubilados',
      clientType: 'JUBILADO',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -50,
    });

    const res = await request(app)
      .get('/api/pricing/price-matrix')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const row = res.body.data.items.find(
      (r: { productId: string }) => r.productId === product._id.toString(),
    );
    expect(row).toBeDefined();
    expect(row.cells.map((c: { clientType: string }) => c.clientType)).toEqual([
      'LOCAL',
      'JUBILADO',
      'NO_LOCAL',
      'AYUDA_SOCIAL',
    ]);

    const local = row.cells.find((c: { clientType: string }) => c.clientType === 'LOCAL');
    expect(local.priceMinor).toBe(1_000_000);
    expect(local.source).toBe('BASE');

    const jubilado = row.cells.find(
      (c: { clientType: string }) => c.clientType === 'JUBILADO',
    );
    expect(jubilado.priceMinor).toBe(500_000);
    expect(jubilado.source).toBe('PERCENTAGE');
    expect(jubilado.impliedPercentage).toBe(-50);
    expect(jubilado.ruleName).toBe('Jubilados');
    expect(jubilado.hasFixedPrice).toBe(false);
    expect(jubilado.stale).toBe(false);
  });

  it('marca como desactualizado el precio fijo cuyo precio base cambió', async () => {
    const token = await adminToken();
    const product = await seedProduct('BIDON', 'CONTAINER', 1_000_000);
    product.clientTypePrices = [
      {
        clientType: 'JUBILADO',
        priceMinor: 650_000,
        basePriceMinorAtSet: 1_000_000,
      },
    ];
    await product.save();
    product.basePriceMinor = 1_200_000;
    await product.save();

    const res = await request(app)
      .get('/api/pricing/price-matrix')
      .set('Authorization', `Bearer ${token}`);

    const row = res.body.data.items.find(
      (r: { productId: string }) => r.productId === product._id.toString(),
    );
    const jubilado = row.cells.find(
      (c: { clientType: string }) => c.clientType === 'JUBILADO',
    );
    expect(jubilado.hasFixedPrice).toBe(true);
    expect(jubilado.priceMinor).toBe(650_000);
    expect(jubilado.source).toBe('FIXED');
    expect(jubilado.impliedPercentage).toBe(-46);
    expect(jubilado.stale).toBe(true);
  });

  it('requiere pricing.read', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/pricing/price-matrix')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/pricing/price-matrix', () => {
  it('carga un precio exacto para un tipo de cliente', async () => {
    const token = await adminToken();
    const product = await seedProduct('BIDON', 'CONTAINER', 1_000_000);
    await seedRule({
      name: 'Jubilados',
      clientType: 'JUBILADO',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -50,
    });

    const res = await request(app)
      .patch('/api/pricing/price-matrix')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          {
            productId: product._id.toString(),
            clientType: 'JUBILADO',
            priceMinor: 650_000,
          },
        ],
      });

    expect(res.status).toBe(200);
    const stored = await Product.findById(product._id);
    expect(stored?.clientTypePrices).toHaveLength(1);
    expect(stored?.clientTypePrices?.[0]?.priceMinor).toBe(650_000);
    expect(stored?.clientTypePrices?.[0]?.basePriceMinorAtSet).toBe(1_000_000);
  });

  it('la columna LOCAL actualiza el precio base del producto', async () => {
    const token = await adminToken();
    const product = await seedProduct('BIDON', 'CONTAINER', 1_000_000);

    const res = await request(app)
      .patch('/api/pricing/price-matrix')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          {
            productId: product._id.toString(),
            clientType: 'LOCAL',
            priceMinor: 1_200_000,
          },
        ],
      });

    expect(res.status).toBe(200);
    const stored = await Product.findById(product._id);
    expect(stored?.basePriceMinor).toBe(1_200_000);
  });

  it('un precio exacto y el precio base en la misma operación se sellan con el base nuevo', async () => {
    const token = await adminToken();
    const product = await seedProduct('BIDON', 'CONTAINER', 1_000_000);

    const res = await request(app)
      .patch('/api/pricing/price-matrix')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          {
            productId: product._id.toString(),
            clientType: 'JUBILADO',
            priceMinor: 650_000,
          },
          {
            productId: product._id.toString(),
            clientType: 'LOCAL',
            priceMinor: 1_200_000,
          },
        ],
      });

    expect(res.status).toBe(200);
    const stored = await Product.findById(product._id);
    expect(stored?.basePriceMinor).toBe(1_200_000);
    expect(stored?.clientTypePrices?.[0]?.basePriceMinorAtSet).toBe(1_200_000);
  });

  it('borrar el precio exacto (null) vuelve al porcentaje de la regla', async () => {
    const token = await adminToken();
    const product = await seedProduct('BIDON', 'CONTAINER', 1_000_000);
    product.clientTypePrices = [
      {
        clientType: 'JUBILADO',
        priceMinor: 650_000,
        basePriceMinorAtSet: 1_000_000,
      },
    ];
    await product.save();
    await seedRule({
      name: 'Jubilados',
      clientType: 'JUBILADO',
      scope: 'ALL_PRODUCTS',
      adjustmentValue: -50,
    });

    const res = await request(app)
      .patch('/api/pricing/price-matrix')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          {
            productId: product._id.toString(),
            clientType: 'JUBILADO',
            priceMinor: null,
          },
        ],
      });

    expect(res.status).toBe(200);
    const stored = await Product.findById(product._id);
    expect(stored?.clientTypePrices).toHaveLength(0);

    const { buildQuote } = await import('../src/modules/pricing/pricing.engine');
    const client = await seedClient('JUBILADO');
    const quote = await buildQuote(client._id.toString(), [
      { productId: product._id.toString(), quantity: 1 },
    ]);
    expect(quote.items[0].unitFinalPriceMinor).toBe(500_000);
    expect(quote.items[0].priceSource).toBe('PERCENTAGE');
  });

  it('cambiar el precio base no mueve los precios exactos que no se tocaron', async () => {
    const token = await adminToken();
    const product = await seedProduct('BIDON', 'CONTAINER', 1_000_000);
    product.clientTypePrices = [
      {
        clientType: 'JUBILADO',
        priceMinor: 650_000,
        basePriceMinorAtSet: 1_000_000,
      },
    ];
    await product.save();

    const res = await request(app)
      .patch('/api/pricing/price-matrix')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          {
            productId: product._id.toString(),
            clientType: 'LOCAL',
            priceMinor: 1_200_000,
          },
        ],
      });

    expect(res.status).toBe(200);
    const stored = await Product.findById(product._id);
    expect(stored?.basePriceMinor).toBe(1_200_000);
    expect(stored?.clientTypePrices?.[0]?.priceMinor).toBe(650_000);
    expect(stored?.clientTypePrices?.[0]?.basePriceMinorAtSet).toBe(1_000_000);
  });

  it('rechaza un precio negativo', async () => {
    const token = await adminToken();
    const product = await seedProduct('BIDON', 'CONTAINER', 1_000_000);
    const res = await request(app)
      .patch('/api/pricing/price-matrix')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          {
            productId: product._id.toString(),
            clientType: 'JUBILADO',
            priceMinor: -1,
          },
        ],
      });
    expect(res.status).toBe(400);
  });

  it('rechaza vaciar el precio base (LOCAL con null)', async () => {
    const token = await adminToken();
    const product = await seedProduct('BIDON', 'CONTAINER', 1_000_000);
    const res = await request(app)
      .patch('/api/pricing/price-matrix')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          {
            productId: product._id.toString(),
            clientType: 'LOCAL',
            priceMinor: null,
          },
        ],
      });
    expect(res.status).toBe(400);
  });

  it('devuelve 404 para un producto inexistente', async () => {
    const token = await adminToken();
    const res = await request(app)
      .patch('/api/pricing/price-matrix')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          {
            productId: new mongoose.Types.ObjectId().toString(),
            clientType: 'JUBILADO',
            priceMinor: 650_000,
          },
        ],
      });
    expect(res.status).toBe(404);
  });

  it('requiere pricing.manage', async () => {
    await seedUser('OPERADOR', 'operador@buchardo.gob.ar');
    const token = await loginAs('operador@buchardo.gob.ar');
    const product = await seedProduct('BIDON', 'CONTAINER', 1_000_000);
    const res = await request(app)
      .patch('/api/pricing/price-matrix')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          {
            productId: product._id.toString(),
            clientType: 'JUBILADO',
            priceMinor: 650_000,
          },
        ],
      });
    expect(res.status).toBe(403);
  });
});
