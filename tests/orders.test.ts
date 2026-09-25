import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import {
  setupReplSetTestDb,
  teardownReplSetTestDb,
  clearReplSetTestDb,
} from './payments-setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import { ROLES, defaultPermissionsForRole } from '../src/modules/users/users.types';
import { signAccessToken } from '../src/modules/auth/auth.tokens';
import { Client } from '../src/modules/clients/clients.model';
import { Product } from '../src/modules/products/products.model';
import { PricingRule } from '../src/modules/pricing/pricing.rules.model';
import { AccountMovement } from '../src/modules/accounts/account-movements.model';
import { Order } from '../src/modules/orders/orders.model';

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await setupReplSetTestDb();
  loadEnv();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await teardownReplSetTestDb();
});

beforeEach(async () => {
  await clearReplSetTestDb();
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

const baseAddress = {
  street: 'Av. San Martín',
  number: '123',
  locality: 'Buchardo',
};

async function seedClient(opts: {
  userId?: Types.ObjectId | null;
  clientType?: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';
  active?: boolean;
  firstName?: string;
  lastName?: string;
  documentNumber?: string;
  zona?: string | null;
} = {}) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Client.create({
    firstName: opts.firstName ?? 'Test',
    lastName: opts.lastName ?? `Client${idx}`,
    documentType: 'DNI',
    documentNumber: opts.documentNumber ?? idx.toString(),
    clientType: opts.clientType ?? 'LOCAL',
    address: baseAddress,
    userId: opts.userId ?? null,
    active: opts.active ?? true,
    zona: opts.zona ?? null,
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
    name: opts.name ?? 'Recarga de agua',
    productType: opts.productType ?? 'WATER_REFILL',
    basePriceMinor: opts.basePriceMinor ?? 1_000_000,
    tracksStock: false,
    active: opts.active ?? true,
  });
}

async function seedPricingRule(opts: {
  clientType: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';
  adjustmentValue: number;
  scope?: 'ALL_PRODUCTS' | 'PRODUCT_TYPE' | 'PRODUCT';
  productType?: 'WATER_REFILL' | 'CONTAINER' | 'DISPENSER' | 'OTHER';
  productId?: Types.ObjectId;
  priority?: number;
}) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return PricingRule.create({
    name: `Rule ${idx}`,
    clientType: opts.clientType,
    scope: opts.scope ?? 'ALL_PRODUCTS',
    productType: opts.productType ?? null,
    productId: opts.productId ?? null,
    adjustmentType: 'PERCENTAGE',
    adjustmentValue: opts.adjustmentValue,
    priority: opts.priority ?? 0,
    active: true,
  });
}

// ===========================================================================
// CIUDADANO
// ===========================================================================

describe('Ciudadano — pedidos', () => {
  it('crea pedido, congela snapshot, genera DEBIT', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient({ userId: citizen._id });
    const refill = await seedProduct({
      basePriceMinor: 1_000_000,
      productType: 'WATER_REFILL',
    });
    const container = await seedProduct({
      basePriceMinor: 1_500_000,
      productType: 'CONTAINER',
    });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          { productId: refill._id.toString(), quantity: 1 },
          { productId: container._id.toString(), quantity: 1 },
        ],
        customerNote: 'Timbre 2',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    // Citizen without zona → CONFIRMED (waiting for the day to roll).
    expect(res.body.data.order.status).toBe('CONFIRMED');
    expect(res.body.data.order.origin).toBe('CITIZEN');
    expect(res.body.data.order.items).toHaveLength(2);
    expect(res.body.data.order.totalBaseMinor).toBe(2_500_000);
    expect(res.body.data.order.totalFinalMinor).toBe(2_500_000);
    // Citizen must NOT see raw ledger ids.
    expect(res.body.data.order.accountMovementId).toBeUndefined();
    expect(res.body.data.order.cancellationMovementId).toBeUndefined();

    // Ledger must have a single DEBIT.
    const movements = await AccountMovement.find({ clientId: client._id }).lean();
    expect(movements).toHaveLength(1);
    expect(movements[0].direction).toBe('DEBIT');
    expect(movements[0].amountMinor).toBe(2_500_000);
    expect(movements[0].movementType).toBe('ORDER_CHARGE');
    expect(movements[0].idempotencyKey).toBe(
      `ORDER:${res.body.data.order.id}:CHARGE`,
    );
  });

  it('pedido AYUDA_SOCIAL con regla -100% → total $0 → no genera DEBIT', async () => {
    const citizen = await seedUser('CIUDADANO', 'social@buchardo.gob.ar');
    const client = await seedClient({
      userId: citizen._id,
      clientType: 'AYUDA_SOCIAL',
    });
    await seedPricingRule({ clientType: 'AYUDA_SOCIAL', adjustmentValue: -100 });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const token = await loginAs('social@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.order.totalFinalMinor).toBe(0);
    expect(res.body.data.order.accountMovementId).toBeUndefined();

    const movements = await AccountMovement.find({ clientId: client._id }).lean();
    expect(movements).toHaveLength(0);
  });

  it('rechaza intento de enviar precios o clientId', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          {
            productId: refill._id.toString(),
            quantity: 1,
            unitFinalPriceMinor: 1, // not allowed
          },
        ],
        totalFinalMinor: 1, // not allowed
        clientId: '507f1f77bcf86cd799439011', // not allowed
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('lista solo sus pedidos', async () => {
    const a = await seedUser('CIUDADANO', 'a@buchardo.gob.ar');
    const b = await seedUser('CIUDADANO', 'b@buchardo.gob.ar');
    await seedClient({ userId: a._id, documentNumber: '111' });
    await seedClient({ userId: b._id, documentNumber: '222' });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const tokenA = await loginAs('a@buchardo.gob.ar');
    const tokenB = await loginAs('b@buchardo.gob.ar');

    await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });

    const resA = await request(app)
      .get('/api/orders/me')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(resA.body.data.items).toHaveLength(1);
    expect(resA.body.data.pagination.total).toBe(1);
  });

  it('ciudadano no puede ver pedido ajeno (IDOR → 404)', async () => {
    const a = await seedUser('CIUDADANO', 'a@buchardo.gob.ar');
    const b = await seedUser('CIUDADANO', 'b@buchardo.gob.ar');
    await seedClient({ userId: a._id, documentNumber: '111' });
    await seedClient({ userId: b._id, documentNumber: '222' });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const tokenA = await loginAs('a@buchardo.gob.ar');
    const tokenB = await loginAs('b@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    const id = created.body.data.order.id;

    const res = await request(app)
      .get(`/api/orders/me/${id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('cancela pedido CONFIRMED y revierte DEBIT', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    const id = created.body.data.order.id;

    const res = await request(app)
      .post(`/api/orders/me/${id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'me equivoqué' });
    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('CANCELLED');
    expect(res.body.data.order.cancellationReason).toBe('me equivoqué');

    // Ledger: DEBIT + REVERSAL
    const movements = await AccountMovement.find({ clientId: client._id }).lean();
    expect(movements).toHaveLength(2);
    const reversal = movements.find((m) => m.movementType === 'REVERSAL');
    expect(reversal?.amountMinor).toBe(1_000_000);
    expect(reversal?.direction).toBe('CREDIT');
  });

  it('no permite cancelar pedido ASSIGNED', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const driver = await seedUser('REPARTIDOR', 'driver@buchardo.gob.ar');
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    const id = created.body.data.order.id;

    // Manually flip to ASSIGNED for this test
    await Order.updateOne(
      { _id: id },
      {
        $set: {
          status: 'ASSIGNED',
          assignedTo: driver._id,
          assignedAt: new Date(),
        },
      },
    );

    const res = await request(app)
      .post(`/api/orders/me/${id}/cancel`)
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ reason: 'no quiero' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});

// ===========================================================================
// ADMIN
// ===========================================================================

describe('Admin — pedidos', () => {
  it('lista pedidos con paginación', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');

    await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 2 }] });

    const res = await request(app)
      .get('/api/orders?page=1&limit=10')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.pagination.total).toBe(1);
  });

  it('driver toma (claim) pedido PENDING con zona que reparte hoy → ASSIGNED', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const driver = await seedUser('REPARTIDOR', 'claim-admin-driver@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'claim-admin-citizen@buchardo.gob.ar');
    const client = await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });

    // Crear PENDING directo con zonaSnapshot null (los drivers ven PENDING
    // en su pool siempre que no haya zona que bloquee).
    const order = await Order.create({
      clientId: client._id,
      origin: 'CITIZEN',
      status: 'PENDING',
      items: [
        {
          productId: refill._id,
          productCode: 'TEST',
          productName: 'Test',
          productType: 'WATER_REFILL',
          quantity: 1,
          unitBasePriceMinor: 1_000_000,
          adjustmentPercentage: 0,
          unitFinalPriceMinor: 1_000_000,
          subtotalBaseMinor: 1_000_000,
          subtotalFinalMinor: 1_000_000,
          appliedRuleId: null,
          appliedRuleName: null,
        },
      ],
      totalBaseMinor: 1_000_000,
      totalFinalMinor: 1_000_000,
      deliveryAddressSnapshot: baseAddress,
      zonaSnapshot: null,
      customerNote: null,
      createdBy: citizen._id,
    });
    const driverToken = await loginAs('claim-admin-driver@buchardo.gob.ar');
    const res = await request(app)
      .post(`/api/delivery/me/orders/${order._id.toString()}/claim`)
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('ASSIGNED');
    expect(res.body.data.order.assignedTo).toBe(driver._id.toString());
    expect(res.body.data.order.assignedAt).toBeTruthy();
  });

  it('admin cancela PENDING (pedido todavía en el pool) y revierte deuda', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'cancel-pending-admin@buchardo.gob.ar');
    const client = await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });

    // DEBIT primero para que la cancelación tenga algo que revertir.
    const debit = await AccountMovement.create({
      clientId: client._id,
      direction: 'DEBIT',
      amountMinor: 1_000_000,
      movementType: 'ORDER_CHARGE',
      description: 'Pedido pendiente',
      sourceType: 'ORDER',
      sourceId: null,
      idempotencyKey: 'demo:test:cancel-pending-admin',
      createdBy: citizen._id,
    });

    const order = await Order.create({
      clientId: client._id,
      origin: 'CITIZEN',
      status: 'PENDING',
      items: [
        {
          productId: refill._id,
          productCode: 'TEST',
          productName: 'Test',
          productType: 'WATER_REFILL',
          quantity: 1,
          unitBasePriceMinor: 1_000_000,
          adjustmentPercentage: 0,
          unitFinalPriceMinor: 1_000_000,
          subtotalBaseMinor: 1_000_000,
          subtotalFinalMinor: 1_000_000,
          appliedRuleId: null,
          appliedRuleName: null,
        },
      ],
      totalBaseMinor: 1_000_000,
      totalFinalMinor: 1_000_000,
      deliveryAddressSnapshot: baseAddress,
      zonaSnapshot: null,
      customerNote: null,
      createdBy: citizen._id,
      accountMovementId: debit._id,
    });

    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post(`/api/orders/${order._id.toString()}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'cliente pidió anular' });
    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('CANCELLED');

    const movements = await AccountMovement.find({ clientId: client._id }).lean();
    const reversal = movements.find((m) => m.movementType === 'REVERSAL');
    expect(reversal).toBeTruthy();
  });
});

// ===========================================================================
// REPARTIDOR
// ===========================================================================

describe('Repartidor — entregas', () => {
  it('solo ve pedidos asignados a él (no otros)', async () => {
    const driverA = await seedUser('REPARTIDOR', 'a@buchardo.gob.ar');
    const driverB = await seedUser('REPARTIDOR', 'b@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');

    const a = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    const b = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    await Order.updateOne(
      { _id: a.body.data.order.id },
      { $set: { status: 'ASSIGNED', assignedTo: driverA._id, assignedAt: new Date() } },
    );
    await Order.updateOne(
      { _id: b.body.data.order.id },
      { $set: { status: 'ASSIGNED', assignedTo: driverB._id, assignedAt: new Date() } },
    );

    const tokenA = await loginAs('a@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/delivery/me/orders')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].id).toBe(a.body.data.order.id);
  });

  it('start ASSIGNED → OUT_FOR_DELIVERY', async () => {
    const driver = await seedUser('REPARTIDOR', 'driver@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const driverToken = await loginAs('driver@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    const id = created.body.data.order.id;

    await Order.updateOne(
      { _id: id },
      { $set: { status: 'ASSIGNED', assignedTo: driver._id, assignedAt: new Date() } },
    );

    const res = await request(app)
      .post(`/api/delivery/me/orders/${id}/start`)
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('OUT_FOR_DELIVERY');
    expect(res.body.data.order.startedDeliveryAt).toBeTruthy();
  });

  it('deliver OUT_FOR_DELIVERY → DELIVERED', async () => {
    const driver = await seedUser('REPARTIDOR', 'driver@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const driverToken = await loginAs('driver@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    const id = created.body.data.order.id;

    await Order.updateOne(
      { _id: id },
      {
        $set: {
          status: 'OUT_FOR_DELIVERY',
          assignedTo: driver._id,
          assignedAt: new Date(),
          startedDeliveryAt: new Date(),
        },
      },
    );

    const res = await request(app)
      .post(`/api/delivery/me/orders/${id}/deliver`)
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('DELIVERED');
    expect(res.body.data.order.deliveredAt).toBeTruthy();

    // No new ledger movement (the original DEBIT remains).
    const movements = await AccountMovement.find({}).lean();
    expect(movements.filter((m) => m.movementType === 'ORDER_CHARGE')).toHaveLength(1);
  });

  it('no permite deliver sin start previo', async () => {
    const driver = await seedUser('REPARTIDOR', 'driver@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const driverToken = await loginAs('driver@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    const id = created.body.data.order.id;

    await Order.updateOne(
      { _id: id },
      { $set: { status: 'ASSIGNED', assignedTo: driver._id, assignedAt: new Date() } },
    );

    const res = await request(app)
      .post(`/api/delivery/me/orders/${id}/deliver`)
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('no permite ver pedido asignado a otro repartidor', async () => {
    const driverA = await seedUser('REPARTIDOR', 'a@buchardo.gob.ar');
    await seedUser('REPARTIDOR', 'b@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    const id = created.body.data.order.id;

    await Order.updateOne(
      { _id: id },
      { $set: { status: 'ASSIGNED', assignedTo: driverA._id, assignedAt: new Date() } },
    );

    const tokenB = await loginAs('b@buchardo.gob.ar');
    const res = await request(app)
      .get(`/api/delivery/me/orders/${id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  it('direct-order genera Order + DEBIT y arranca en OUT_FOR_DELIVERY', async () => {
    const driver = await seedUser('REPARTIDOR', 'driver@buchardo.gob.ar');
    const client = await seedClient({ documentNumber: '999' });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const container = await seedProduct({
      basePriceMinor: 1_500_000,
      productType: 'CONTAINER',
    });
    const driverToken = await loginAs('driver@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/delivery/me/direct-order')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        clientId: client._id.toString(),
        items: [
          { productId: refill._id.toString(), quantity: 1 },
          { productId: container._id.toString(), quantity: 1 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.data.order.origin).toBe('STAFF');
    expect(res.body.data.order.status).toBe('OUT_FOR_DELIVERY');
    expect(res.body.data.order.assignedTo).toBe(driver._id.toString());
    expect(res.body.data.order.totalFinalMinor).toBe(2_500_000);

    const movements = await AccountMovement.find({ clientId: client._id }).lean();
    expect(movements).toHaveLength(1);
    expect(movements[0].amountMinor).toBe(2_500_000);
    expect(movements[0].movementType).toBe('ORDER_CHARGE');
  });

  it('direct-order con AYUDA_SOCIAL -100% → total 0 → no DEBIT', async () => {
    await seedUser('REPARTIDOR', 'driver@buchardo.gob.ar');
    const client = await seedClient({
      clientType: 'AYUDA_SOCIAL',
      documentNumber: '888',
    });
    await seedPricingRule({ clientType: 'AYUDA_SOCIAL', adjustmentValue: -100 });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const driverToken = await loginAs('driver@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/delivery/me/direct-order')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        clientId: client._id.toString(),
        items: [{ productId: refill._id.toString(), quantity: 1 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.data.order.totalFinalMinor).toBe(0);
    const movements = await AccountMovement.find({ clientId: client._id }).lean();
    expect(movements).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Zones-aware driver delivery
// ---------------------------------------------------------------------------

describe('Repartidor — filtro por zona', () => {
  /**
   * Snapshots "today" as seen by the API, derived from the app timezone
   * (AR). Tests branch on whether the API sees a weekday where ZONA 1 or
   * ZONA 2 is active so we run assertions in both directions.
   */
  async function todayZones() {
    const { getAppToday } = await import('../src/shared/app-date');
    return getAppToday();
  }

  /**
   * Seeds an Order directly in the DB already in ASSIGNED state for the
   * given driver. Avoids the citizen POST flow because we don't care
   * about pricing here — just the zone filter behaviour.
   */
  async function seedAssignedDelivery(opts: {
    driverId: Types.ObjectId;
    zonaSnapshot: string | null;
    clientId: Types.ObjectId;
    refProductId: Types.ObjectId;
  }) {
    const created = await Order.create({
      clientId: opts.clientId,
      origin: 'STAFF',
      status: 'ASSIGNED',
      assignedTo: opts.driverId,
      assignedAt: new Date(),
      items: [
        {
          productId: opts.refProductId,
          productCode: 'TEST',
          productName: 'Test',
          productType: 'WATER_REFILL',
          quantity: 1,
          unitBasePriceMinor: 0,
          adjustmentPercentage: 0,
          unitFinalPriceMinor: 0,
          subtotalBaseMinor: 0,
          subtotalFinalMinor: 0,
          appliedRuleId: null,
          appliedRuleName: null,
        },
      ],
      totalBaseMinor: 0,
      totalFinalMinor: 0,
      deliveryAddressSnapshot: baseAddress,
      zonaSnapshot: opts.zonaSnapshot,
      customerNote: null,
      createdBy: opts.driverId,
    });
    return created._id.toString();
  }

  /**
   * Seeds an Order in PENDING state (no driver assigned) — exercises the
   * PENDING branch of the driver list (zone-filtered).
   */
  async function seedPendingDelivery(opts: {
    zonaSnapshot: string | null;
    clientId: Types.ObjectId;
    refProductId: Types.ObjectId;
  }) {
    const created = await Order.create({
      clientId: opts.clientId,
      origin: 'CITIZEN',
      status: 'PENDING',
      items: [
        {
          productId: opts.refProductId,
          productCode: 'TEST',
          productName: 'Test',
          productType: 'WATER_REFILL',
          quantity: 1,
          unitBasePriceMinor: 0,
          adjustmentPercentage: 0,
          unitFinalPriceMinor: 0,
          subtotalBaseMinor: 0,
          subtotalFinalMinor: 0,
          appliedRuleId: null,
          appliedRuleName: null,
        },
      ],
      totalBaseMinor: 0,
      totalFinalMinor: 0,
      deliveryAddressSnapshot: baseAddress,
      zonaSnapshot: opts.zonaSnapshot,
      customerNote: null,
      createdBy: opts.clientId,
    });
    return created._id.toString();
  }

  async function loginDriver(email: string) {
    return loginAs(email);
  }

  async function loginCitizen(email: string) {
    return loginAs(email);
  }

  it('createOrder congela zonaSnapshot desde Client.zona (trim + upper)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino-zona@buchardo.gob.ar');
    const client = await Client.create({
      firstName: 'Cliente',
      lastName: 'ConZona',
      documentType: 'DNI',
      documentNumber: '70001',
      clientType: 'LOCAL',
      address: baseAddress,
      userId: citizen._id,
      active: true,
      zona: '  zona 2  ',
    });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const token = await loginCitizen('vecino-zona@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.order.zona).toBe('ZONA 2');

    const persisted = await Order.findById(res.body.data.order.id).lean();
    expect(persisted?.zonaSnapshot).toBe('ZONA 2');

    // Even if the client's zona changes later, the order keeps its snapshot.
    await Client.updateOne({ _id: client._id }, { $set: { zona: 'ZONA 1' } });
    const after = await Order.findById(res.body.data.order.id).lean();
    expect(after?.zonaSnapshot).toBe('ZONA 2');
  });

  it('listMyDeliveries filtra PENDING por zona; assigned-to-me siempre visible', async () => {
    const driver = await seedUser(
      'REPARTIDOR',
      'zone-driver@buchardo.gob.ar',
    );
    const citizen = await seedUser(
      'CIUDADANO',
      'zone-citizen@buchardo.gob.ar',
    );
    const client = await seedClient({
      userId: citizen._id,
      documentNumber: '70010',
    });
    const refill = await seedProduct({
      code: 'ZREFILL',
      basePriceMinor: 1_000_000,
    });
    const driverToken = await loginDriver('zone-driver@buchardo.gob.ar');

    const today = await todayZones();
    const knownZones: string[] = ['ZONA 1', 'ZONA 2'];
    const inZone = knownZones[today.zones.length > 0 ? (today.zones[0] === 'ZONA 1' ? 0 : 1) : 0];
    const otherZone = inZone === 'ZONA 1' ? 'ZONA 2' : 'ZONA 1';

    // Tres pedidos PENDING en distintas zonas (sin asignar a nadie).
    const idOnDuty = await seedPendingDelivery({
      clientId: client._id,
      refProductId: refill._id,
      zonaSnapshot: inZone,
    });
    const idOtherZone = await seedPendingDelivery({
      clientId: client._id,
      refProductId: refill._id,
      zonaSnapshot: otherZone,
    });
    const idNoZone = await seedPendingDelivery({
      clientId: client._id,
      refProductId: refill._id,
      zonaSnapshot: null,
    });

    const res = await request(app)
      .get('/api/delivery/me/orders')
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.today).toBeDefined();
    expect(res.body.data.today.weekday).toBe(today.weekday);

    const returnedIds = res.body.data.items.map((o: { id: string }) => o.id);
    expect(returnedIds).toContain(idOnDuty);
    expect(returnedIds).toContain(idNoZone);
    expect(returnedIds).not.toContain(idOtherZone);
  });

  it('listMyDeliveries muestra assigned-to-me sin importar la zona', async () => {
    const driver = await seedUser(
      'REPARTIDOR',
      'owned-driver@buchardo.gob.ar',
    );
    const citizen = await seedUser(
      'CIUDADANO',
      'owned-citizen@buchardo.gob.ar',
    );
    const client = await seedClient({
      userId: citizen._id,
      documentNumber: '70011',
    });
    const refill = await seedProduct({
      code: 'ZREFILL2',
      basePriceMinor: 1_000_000,
    });
    const driverToken = await loginDriver('owned-driver@buchardo.gob.ar');

    const today = await todayZones();
    const otherZone: 'ZONA 1' | 'ZONA 2' =
      today.zones[0] === 'ZONA 1' || today.zones.length === 0
        ? 'ZONA 2'
        : 'ZONA 1';

    const idMineOtherZone = await seedAssignedDelivery({
      driverId: driver._id,
      clientId: client._id,
      refProductId: refill._id,
      zonaSnapshot: otherZone,
    });

    const res = await request(app)
      .get('/api/delivery/me/orders')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(200);
    const returnedIds = res.body.data.items.map((o: { id: string }) => o.id);
    expect(returnedIds).toContain(idMineOtherZone);
  });

  it('listMyDeliveries en domingo devuelve listado vacío y today.weekday=0', async () => {
    const driver = await seedUser(
      'REPARTIDOR',
      'sunday-driver@buchardo.gob.ar',
    );
    const citizen = await seedUser(
      'CIUDADANO',
      'sunday-citizen@buchardo.gob.ar',
    );
    const client = await seedClient({
      userId: citizen._id,
      documentNumber: '70020',
    });
    const refill = await seedProduct({
      code: 'SREFILL',
      basePriceMinor: 1_000_000,
    });
    const driverToken = await loginDriver('sunday-driver@buchardo.gob.ar');

    const today = await todayZones();
    // Skip the assertion on Sunday because there's no in-zone to assign.
    if (today.weekday !== 0) {
      // Force a "Sunday" zoneFilter by setting zonaSnapshot to null on all
      // candidates; with includeNull=true they would still be returned in
      // a non-Sunday today, so we instead inspect the response shape:
      const id = await seedAssignedDelivery({
        driverId: driver._id,
        clientId: client._id,
        refProductId: refill._id,
        zonaSnapshot: null,
      });
      const res = await request(app)
        .get('/api/delivery/me/orders')
        .set('Authorization', `Bearer ${driverToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.today.zones).toEqual(today.zones);
      // Whether returned depends on whether today is Sunday; on non-Sunday
      // days the order is included.
      if (today.weekday === 0) {
        expect(res.body.data.items).toHaveLength(0);
      } else {
        expect(res.body.data.items.map((o: { id: string }) => o.id)).toContain(id);
      }
    } else {
      // We're actually running on Sunday: every order is filtered out.
      await seedAssignedDelivery({
        driverId: driver._id,
        clientId: client._id,
        refProductId: refill._id,
        zonaSnapshot: 'ZONA 1',
      });
      await seedAssignedDelivery({
        driverId: driver._id,
        clientId: client._id,
        refProductId: refill._id,
        zonaSnapshot: 'ZONA 2',
      });
      const res = await request(app)
        .get('/api/delivery/me/orders')
        .set('Authorization', `Bearer ${driverToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.today.weekday).toBe(0);
      expect(res.body.data.today.weekdayLabel).toBe('Domingo');
      expect(res.body.data.today.zones).toEqual([]);
      expect(res.body.data.items).toHaveLength(0);
    }
  });

  it('createDirectOrder bloquea con ZONE_NOT_DELIVERING_TODAY si la zona del cliente no reparte hoy', async () => {
    await seedUser('REPARTIDOR', 'block-driver@buchardo.gob.ar');
    const refill = await seedProduct({
      code: 'BREFILL',
      basePriceMinor: 1_000_000,
    });
    const driverToken = await loginDriver('block-driver@buchardo.gob.ar');

    const today = await todayZones();
    const offZone: 'ZONA 1' | 'ZONA 2' =
      today.zones[0] === 'ZONA 1' || today.zones.length === 0
        ? 'ZONA 2'
        : 'ZONA 1';

    const offZoneClient = await seedClient({
      documentNumber: '70030',
      zona: offZone,
    });

    const res = await request(app)
      .post('/api/delivery/me/direct-order')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        clientId: offZoneClient._id.toString(),
        items: [{ productId: refill._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details?.code).toBe('ZONE_NOT_DELIVERING_TODAY');

    // No order or movement should have leaked.
    const leaked = await Order.find({ clientId: offZoneClient._id }).lean();
    expect(leaked).toHaveLength(0);
    const movements = await AccountMovement.find({
      clientId: offZoneClient._id,
    }).lean();
    expect(movements).toHaveLength(0);
  });

  it('createDirectOrder permite la zona del cliente cuando sí reparte hoy', async () => {
    await seedUser('REPARTIDOR', 'allow-driver@buchardo.gob.ar');
    const refill = await seedProduct({
      code: 'AREFILL',
      basePriceMinor: 1_000_000,
    });
    const driverToken = await loginDriver('allow-driver@buchardo.gob.ar');

    const today = await todayZones();
    const onZone: 'ZONA 1' | 'ZONA 2' | null = (() => {
      if (today.zones.includes('ZONA 1')) return 'ZONA 1';
      if (today.zones.includes('ZONA 2')) return 'ZONA 2';
      return null;
    })();

    const client = await seedClient({
      documentNumber: '70040',
      zona: onZone,
    });

    const res = await request(app)
      .post('/api/delivery/me/direct-order')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        clientId: client._id.toString(),
        items: [{ productId: refill._id.toString(), quantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.order.zona).toBe(onZone);
  });
});

// ===========================================================================
// SNAPSHOT
// ===========================================================================

describe('Snapshot de precios', () => {
  it('cambiar regla NO afecta pedidos históricos', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient({
      userId: citizen._id,
      clientType: 'JUBILADO',
    });
    const refill = await seedProduct({
      basePriceMinor: 1_000_000,
      productType: 'WATER_REFILL',
    });
    const rule = await seedPricingRule({
      clientType: 'JUBILADO',
      adjustmentValue: -50,
      productType: 'WATER_REFILL',
    });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const old = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    expect(old.body.data.order.totalFinalMinor).toBe(500_000);
    expect(old.body.data.order.items[0].adjustmentPercentage).toBe(-50);

    // Change the rule.
    rule.adjustmentValue = -20;
    await rule.save();

    // New order should reflect -20%.
    const fresh = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    expect(fresh.body.data.order.totalFinalMinor).toBe(800_000);

    // The old order must STILL hold -50%.
    const oldRes = await request(app)
      .get(`/api/orders/me/${old.body.data.order.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(oldRes.body.data.order.totalFinalMinor).toBe(500_000);
    expect(oldRes.body.data.order.items[0].adjustmentPercentage).toBe(-50);

    // Ledger summary must be $1.300.000 ($500k + $800k) — only $0 orders skip.
    const movements = await AccountMovement.find({ clientId: client._id }).lean();
    expect(movements.reduce((acc, m) => acc + m.amountMinor, 0)).toBe(1_300_000);
  });
});

// ===========================================================================
// AUTORIZACIÓN
// ===========================================================================

describe('Autorización', () => {
  it('sin token → 401', async () => {
    const res = await request(app).get('/api/orders/me');
    expect(res.status).toBe(401);
  });

  it('OPERADOR no tiene orders.self', async () => {
    await seedUser('OPERADOR', 'operador@buchardo.gob.ar');
    const token = await loginAs('operador@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/orders/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('REPARTIDOR no usa el endpoint de asignación (ya no existe)', async () => {
    const driver = await seedUser('REPARTIDOR', 'driver@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const driverToken = await loginAs('driver@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });

    const res = await request(app)
      .post(`/api/orders/${created.body.data.order.id}/assign`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ userId: driver._id.toString() });
    expect(res.status).toBe(404);
  });

  it('CIUDADANO no usa el endpoint de asignación (ya no existe)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const token = await loginAs('vecino@buchardo.gob.ar');
    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    const res = await request(app)
      .post(`/api/orders/${created.body.data.order.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: '507f1f77bcf86cd799439011' });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// TRANSICIONES
// ===========================================================================

describe('Transiciones de estado', () => {
  it('DELIVERED es terminal: no se puede volver a empezar', async () => {
    await seedUser('REPARTIDOR', 'driver@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const driverToken = await loginAs('driver@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/delivery/me/direct-order')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        clientId: (
          await seedClient({ documentNumber: '1234' })
        )._id.toString(),
        items: [{ productId: refill._id.toString(), quantity: 1 }],
      });
    const id = created.body.data.order.id;

    await request(app)
      .post(`/api/delivery/me/orders/${id}/deliver`)
      .set('Authorization', `Bearer ${driverToken}`);

    const second = await request(app)
      .post(`/api/delivery/me/orders/${id}/start`)
      .set('Authorization', `Bearer ${driverToken}`);
    expect(second.status).toBe(409);
  });

it('CANCELLED es terminal: cancel staff sobre cancelado → 409', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    const id = created.body.data.order.id;

    await request(app)
      .post(`/api/orders/me/${id}/cancel`)
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({});

    const second = await request(app)
      .post(`/api/orders/${id}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'ya estaba cancelado' });
    expect(second.status).toBe(409);
  });
});

// ===========================================================================
// FLUJO DRIVER-CENTRIC: CONFIRMED → PENDING → ASSIGNED → DELIVERED
// ===========================================================================

describe('Flujo driver-céntrico (zona → PENDING → claim → entregar)', () => {
  async function todayZones() {
    const { getAppToday } = await import('../src/shared/app-date');
    return getAppToday();
  }

  it('ciudadano con zona que reparte hoy → pedido arranca en PENDING', async () => {
    const citizen = await seedUser('CIUDADANO', 'zone-on@buchardo.gob.ar');
    const today = await todayZones();
    const onZone: 'ZONA 1' | 'ZONA 2' | null =
      today.zones[0] === 'ZONA 1'
        ? 'ZONA 1'
        : today.zones[0] === 'ZONA 2'
          ? 'ZONA 2'
          : null;
    if (onZone === null) {
      // Sunday: la regla nunca es "zona reparte hoy"; skip.
      return;
    }
    await seedClient({ userId: citizen._id, zona: onZone });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const token = await loginAs('zone-on@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.order.status).toBe('PENDING');
    expect(res.body.data.order.zona).toBe(onZone);
  });

  it('ciudadano con zona que NO reparte hoy → pedido arranca en CONFIRMED', async () => {
    const citizen = await seedUser('CIUDADANO', 'zone-off@buchardo.gob.ar');
    const today = await todayZones();
    const offZone: 'ZONA 1' | 'ZONA 2' =
      today.zones[0] === 'ZONA 1' || today.zones.length === 0
        ? 'ZONA 2'
        : 'ZONA 1';
    await seedClient({ userId: citizen._id, zona: offZone });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const token = await loginAs('zone-off@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.order.status).toBe('CONFIRMED');
    expect(res.body.data.order.zona).toBe(offZone);
  });

  it('promoteConfirmedToPendingOnDayRoll promueve CONFIRMED→PENDING en zonas que reparten hoy', async () => {
    const citizen = await seedUser('CIUDADANO', 'sweep@buchardo.gob.ar');
    const today = await todayZones();
    const onZone: 'ZONA 1' | 'ZONA 2' | null =
      today.zones[0] === 'ZONA 1'
        ? 'ZONA 1'
        : today.zones[0] === 'ZONA 2'
          ? 'ZONA 2'
          : null;
    if (onZone === null) return; // Sunday: nada que barrer.
    const client = await seedClient({
      userId: citizen._id,
      documentNumber: '999001',
      zona: onZone,
    });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const token = await loginAs('sweep@buchardo.gob.ar');

    // Forzar la creación como CONFIRMED con zona que SÍ reparte hoy.
    await Order.create({
      clientId: client._id,
      origin: 'CITIZEN',
      status: 'CONFIRMED',
      items: [
        {
          productId: refill._id,
          productCode: 'TEST',
          productName: 'Test',
          productType: 'WATER_REFILL',
          quantity: 1,
          unitBasePriceMinor: 1_000_000,
          adjustmentPercentage: 0,
          unitFinalPriceMinor: 1_000_000,
          subtotalBaseMinor: 1_000_000,
          subtotalFinalMinor: 1_000_000,
          appliedRuleId: null,
          appliedRuleName: null,
        },
      ],
      totalBaseMinor: 1_000_000,
      totalFinalMinor: 1_000_000,
      deliveryAddressSnapshot: baseAddress,
      zonaSnapshot: onZone,
      customerNote: null,
      createdBy: citizen._id,
    });

    const before = await Order.countDocuments({
      clientId: client._id,
      status: 'CONFIRMED',
    });
    expect(before).toBe(1);

    const { promoteConfirmedToPendingOnDayRoll } = await import(
      '../src/modules/orders/orders.service'
    );
    const result = await promoteConfirmedToPendingOnDayRoll();
    expect(result.promoted).toBeGreaterThanOrEqual(1);

    const after = await Order.countDocuments({
      clientId: client._id,
      status: 'PENDING',
    });
    expect(after).toBe(1);

    // Idempotente.
    const second = await promoteConfirmedToPendingOnDayRoll();
    expect(second.promoted).toBe(0);

    void token;
  });

  it('driver toma (claim) un pedido PENDING → ASSIGNED a sí mismo', async () => {
    const driver = await seedUser('REPARTIDOR', 'claim-driver@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'claim-citizen@buchardo.gob.ar');
    const client = await seedClient({
      userId: citizen._id,
      documentNumber: '888001',
    });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });

    // Seed PENDING directamente (sin pasar por /orders/me).
    const order = await Order.create({
      clientId: client._id,
      origin: 'CITIZEN',
      status: 'PENDING',
      items: [
        {
          productId: refill._id,
          productCode: 'TEST',
          productName: 'Test',
          productType: 'WATER_REFILL',
          quantity: 1,
          unitBasePriceMinor: 1_000_000,
          adjustmentPercentage: 0,
          unitFinalPriceMinor: 1_000_000,
          subtotalBaseMinor: 1_000_000,
          subtotalFinalMinor: 1_000_000,
          appliedRuleId: null,
          appliedRuleName: null,
        },
      ],
      totalBaseMinor: 1_000_000,
      totalFinalMinor: 1_000_000,
      deliveryAddressSnapshot: baseAddress,
      zonaSnapshot: null,
      customerNote: null,
      createdBy: citizen._id,
    });
    const driverToken = await loginAs('claim-driver@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/delivery/me/orders/${order._id.toString()}/claim`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('ASSIGNED');
    expect(res.body.data.order.assignedTo).toBe(driver._id.toString());
    expect(res.body.data.order.assignedAt).toBeTruthy();
  });

  it('driver no puede tomar un pedido CONFIRMED (transición inválida)', async () => {
    await seedUser('REPARTIDOR', 'no-claim@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'no-claim-citizen@buchardo.gob.ar');
    const client = await seedClient({
      userId: citizen._id,
      documentNumber: '888002',
    });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });

    const order = await Order.create({
      clientId: client._id,
      origin: 'CITIZEN',
      status: 'CONFIRMED',
      items: [
        {
          productId: refill._id,
          productCode: 'TEST',
          productName: 'Test',
          productType: 'WATER_REFILL',
          quantity: 1,
          unitBasePriceMinor: 1_000_000,
          adjustmentPercentage: 0,
          unitFinalPriceMinor: 1_000_000,
          subtotalBaseMinor: 1_000_000,
          subtotalFinalMinor: 1_000_000,
          appliedRuleId: null,
          appliedRuleName: null,
        },
      ],
      totalBaseMinor: 1_000_000,
      totalFinalMinor: 1_000_000,
      deliveryAddressSnapshot: baseAddress,
      zonaSnapshot: null,
      customerNote: null,
      createdBy: citizen._id,
    });
    const driverToken = await loginAs('no-claim@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/delivery/me/orders/${order._id.toString()}/claim`)
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('driver no puede tomar un pedido PENDING de una zona que no reparte hoy', async () => {
    await seedUser(
      'REPARTIDOR',
      'zone-block-driver@buchardo.gob.ar',
    );
    const citizen = await seedUser(
      'CIUDADANO',
      'zone-block-citizen@buchardo.gob.ar',
    );
    const today = await todayZones();
    const offZone: 'ZONA 1' | 'ZONA 2' =
      today.zones[0] === 'ZONA 1' || today.zones.length === 0
        ? 'ZONA 2'
        : 'ZONA 1';
    const client = await seedClient({
      userId: citizen._id,
      documentNumber: '888003',
      zona: offZone,
    });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const created = await Order.create({
      clientId: client._id,
      origin: 'CITIZEN',
      status: 'PENDING',
      items: [
        {
          productId: refill._id,
          productCode: 'TEST',
          productName: 'Test',
          productType: 'WATER_REFILL',
          quantity: 1,
          unitBasePriceMinor: 1_000_000,
          adjustmentPercentage: 0,
          unitFinalPriceMinor: 1_000_000,
          subtotalBaseMinor: 1_000_000,
          subtotalFinalMinor: 1_000_000,
          appliedRuleId: null,
          appliedRuleName: null,
        },
      ],
      totalBaseMinor: 1_000_000,
      totalFinalMinor: 1_000_000,
      deliveryAddressSnapshot: baseAddress,
      zonaSnapshot: offZone,
      customerNote: null,
      createdBy: citizen._id,
    });
    const driverToken = await loginAs('zone-block-driver@buchardo.gob.ar');
    const res = await request(app)
      .post(`/api/delivery/me/orders/${created._id.toString()}/claim`)
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(409);
  });

  it('ciudadano puede cancelar un pedido PENDING (mientras nadie lo tomó)', async () => {
    const citizen = await seedUser('CIUDADANO', 'cancel-pending@buchardo.gob.ar');
    const client = await seedClient({
      userId: citizen._id,
      documentNumber: '888004',
    });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });

    const order = await Order.create({
      clientId: client._id,
      origin: 'CITIZEN',
      status: 'PENDING',
      items: [
        {
          productId: refill._id,
          productCode: 'TEST',
          productName: 'Test',
          productType: 'WATER_REFILL',
          quantity: 1,
          unitBasePriceMinor: 1_000_000,
          adjustmentPercentage: 0,
          unitFinalPriceMinor: 1_000_000,
          subtotalBaseMinor: 1_000_000,
          subtotalFinalMinor: 1_000_000,
          appliedRuleId: null,
          appliedRuleName: null,
        },
      ],
      totalBaseMinor: 1_000_000,
      totalFinalMinor: 1_000_000,
      deliveryAddressSnapshot: baseAddress,
      zonaSnapshot: null,
      customerNote: null,
      createdBy: citizen._id,
    });
    const citizenToken = await loginAs('cancel-pending@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/orders/me/${order._id.toString()}/cancel`)
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ reason: 'me arrepentí' });
    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('CANCELLED');
  });

  it('admin ya no puede asignar pedidos (endpoint removido)', async () => {
    await seedUser('ADMIN', 'no-assign-admin@buchardo.gob.ar');
    const driver = await seedUser('REPARTIDOR', 'no-assign-driver@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'no-assign-citizen@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const citizenToken = await loginAs('no-assign-citizen@buchardo.gob.ar');
    const adminToken = await loginAs('no-assign-admin@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    const id = created.body.data.order.id;

    const res = await request(app)
      .post(`/api/orders/${id}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: driver._id.toString() });
    expect(res.status).toBe(404);
  });

  it('ADMIN ya no lista repartidores (available-drivers removido)', async () => {
    await seedUser('ADMIN', 'no-drivers-admin@buchardo.gob.ar');
    await seedUser('REPARTIDOR', 'no-drivers-driver@buchardo.gob.ar');
    const adminToken = await loginAs('no-drivers-admin@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/orders/available-drivers')
      .set('Authorization', `Bearer ${adminToken}`);
    // Express matchea la ruta como /orders/:id, que devuelve 400 al no
    // ser un ObjectId válido. Lo importante: NO hay un listado de
    // repartidores en la respuesta.
    expect(res.status).toBe(400);
    expect(res.body.data?.drivers).toBeUndefined();
  });

  it('ADMIN no tiene el permiso ORDERS_ASSIGN', async () => {
    const { defaultPermissionsForRole } = await import(
      '../src/modules/users/users.types'
    );
    const perms = defaultPermissionsForRole('ADMIN');
    expect(perms).not.toContain('orders.assign');
  });

  it('REPARTIDOR tiene el permiso delivery.claim', async () => {
    const { defaultPermissionsForRole } = await import(
      '../src/modules/users/users.types'
    );
    const perms = defaultPermissionsForRole('REPARTIDOR');
    expect(perms).toContain('delivery.claim');
  });
});
