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
import { AccountMovement } from '../src/modules/accounts/account-movements.model';
import { CashMovement } from '../src/modules/cash/cash-movements.model';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

let documentCounter = 0;

async function seedClient(opts: {
  userId?: Types.ObjectId | null;
  clientType?: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';
  documentNumber?: string;
} = {}) {
  documentCounter += 1;
  return Client.create({
    firstName: 'Test',
    lastName: `Cliente${documentCounter}`,
    documentType: 'DNI',
    documentNumber: opts.documentNumber ?? String(80_000 + documentCounter),
    clientType: opts.clientType ?? 'LOCAL',
    address: baseAddress,
    userId: opts.userId ?? null,
    active: true,
    zona: null,
  });
}

async function seedProduct(opts: { basePriceMinor?: number } = {}) {
  documentCounter += 1;
  return Product.create({
    code: `P${documentCounter}`,
    name: 'Recarga de agua',
    productType: 'WATER_REFILL',
    basePriceMinor: opts.basePriceMinor ?? 1_000_000,
    tracksStock: false,
    active: true,
  });
}

/**
 * Registers a delivery the way the repartidor does at the client's door:
 * a direct-order, born DELIVERED and settled with `paymentMethod`.
 */
async function createDirectDelivery(opts: {
  driverToken: string;
  clientId: string;
  productId: string;
  paymentMethod?: 'ACCOUNT' | 'CASH';
}) {
  const res = await request(app)
    .post('/api/delivery/me/direct-order')
    .set('Authorization', `Bearer ${opts.driverToken}`)
    .send({
      clientId: opts.clientId,
      items: [{ productId: opts.productId, quantity: 1 }],
      paymentMethod: opts.paymentMethod ?? 'ACCOUNT',
    });
  expect(res.status).toBe(201);
  return res.body.data.order as { id: string; status: string; paymentMethod: string };
}

// ===========================================================================
// Anulación de una entrega ya realizada
// ===========================================================================

describe('Repartidor — anulación de entrega realizada', () => {
  it('anula una entrega cobrada en cuenta corriente y revierte el cargo', async () => {
    await seedUser('REPARTIDOR', 'annul-driver@buchardo.gob.ar');
    const client = await seedClient();
    const product = await seedProduct();
    const driverToken = await loginAs('annul-driver@buchardo.gob.ar');

    const order = await createDirectDelivery({
      driverToken,
      clientId: client._id.toString(),
      productId: product._id.toString(),
      paymentMethod: 'ACCOUNT',
    });

    const res = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ reason: 'Se cobró en cuenta corriente pero pagó en efectivo' });

    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('CANCELLED');
    expect(res.body.data.order.cancellationReason).toBe(
      'Se cobró en cuenta corriente pero pagó en efectivo',
    );
    expect(res.body.data.order.cancelledAt).toBeTruthy();

    // The DEBIT was reversed with a CREDIT and the order no longer points
    // at an active charge.
    const movements = await AccountMovement.find({ clientId: client._id })
      .sort({ occurredAt: 1 })
      .lean();
    expect(movements).toHaveLength(2);
    expect(movements[0].direction).toBe('DEBIT');
    expect(movements[0].movementType).toBe('ORDER_CHARGE');
    expect(movements[1].direction).toBe('CREDIT');
    expect(movements[1].movementType).toBe('REVERSAL');

    const persisted = await Order.findById(order.id).lean();
    expect(persisted?.status).toBe('CANCELLED');
    expect(persisted?.accountMovementId).toBeNull();
    expect(persisted?.cancellationMovementId?.toString()).toBe(
      movements[1]._id.toString(),
    );
  });

  it('anula una entrega cobrada en efectivo y descuenta el efectivo del repartidor', async () => {
    await seedUser('REPARTIDOR', 'annul-cash-driver@buchardo.gob.ar');
    const client = await seedClient();
    const product = await seedProduct();
    const driverToken = await loginAs('annul-cash-driver@buchardo.gob.ar');

    const order = await createDirectDelivery({
      driverToken,
      clientId: client._id.toString(),
      productId: product._id.toString(),
      paymentMethod: 'CASH',
    });

    const before = await request(app)
      .get('/api/cash/driver/me/summary')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(before.status).toBe(200);
    expect(before.body.data.summary.totalCollectedMinor).toBe(1_000_000);

    const res = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ reason: 'El cliente devolvió la mercadería' });

    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('CANCELLED');

    // The cash collection was compensated with a CASH_REVERSAL.
    const cashMovements = await CashMovement.find({ clientId: client._id })
      .sort({ occurredAt: 1 })
      .lean();
    expect(cashMovements).toHaveLength(2);
    expect(cashMovements[0].movementType).toBe('CASH_COLLECTION');
    expect(cashMovements[1].movementType).toBe('CASH_REVERSAL');

    // The driver's collected cash is back to zero.
    const after = await request(app)
      .get('/api/cash/driver/me/summary')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(after.status).toBe(200);
    expect(after.body.data.summary.totalCollectedMinor).toBe(0);

    const persisted = await Order.findById(order.id).lean();
    expect(persisted?.cashMovementId).toBeNull();
  });

  it('no permite anular una entrega de otro repartidor', async () => {
    const otherDriver = await seedUser(
      'REPARTIDOR',
      'other-driver@buchardo.gob.ar',
    );
    const driver = await seedUser('REPARTIDOR', 'annul-owner@buchardo.gob.ar');
    const client = await seedClient();
    const product = await seedProduct();
    const driverToken = await loginAs('annul-owner@buchardo.gob.ar');

    const order = await createDirectDelivery({
      driverToken,
      clientId: client._id.toString(),
      productId: product._id.toString(),
    });

    const res = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ reason: 'no es mía' });

    expect(res.status).toBe(200);
    expect(otherDriver.role).toBe('REPARTIDOR');

    // A second driver cannot annul it.
    const intruder = await seedUser('REPARTIDOR', 'intruder@buchardo.gob.ar');
    const intruderToken = await loginAs('intruder@buchardo.gob.ar');
    const res2 = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ reason: 'no es mía' });

    expect(res2.status).toBe(403);
    expect(intruder._id.toString()).not.toBe(driver._id.toString());
  });

  it('exige el motivo de anulación', async () => {
    await seedUser('REPARTIDOR', 'annul-reason-driver@buchardo.gob.ar');
    const client = await seedClient();
    const product = await seedProduct();
    const driverToken = await loginAs('annul-reason-driver@buchardo.gob.ar');

    const order = await createDirectDelivery({
      driverToken,
      clientId: client._id.toString(),
      productId: product._id.toString(),
    });

    const res = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ reason: '   ' });

    expect(res.status).toBe(400);
  });

  it('no permite anular dos veces la misma entrega', async () => {
    await seedUser('REPARTIDOR', 'annul-twice-driver@buchardo.gob.ar');
    const client = await seedClient();
    const product = await seedProduct();
    const driverToken = await loginAs('annul-twice-driver@buchardo.gob.ar');

    const order = await createDirectDelivery({
      driverToken,
      clientId: client._id.toString(),
      productId: product._id.toString(),
    });

    const first = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ reason: 'primera anulación' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ reason: 'segunda anulación' });
    expect(second.status).toBe(409);
  });

  it('no permite anular una entrega que todavía no se entregó', async () => {
    const citizen = await seedUser('CIUDADANO', 'annul-citizen@buchardo.gob.ar');
    const driver = await seedUser('REPARTIDOR', 'annul-pending-driver@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const product = await seedProduct();
    const driverToken = await loginAs('annul-pending-driver@buchardo.gob.ar');
    const citizenToken = await loginAs('annul-citizen@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });
    expect(created.status).toBe(201);
    const orderId = created.body.data.order.id;

    // The repartidor took the order but has not delivered it yet.
    await Order.updateOne(
      { _id: orderId },
      {
        $set: {
          status: 'ASSIGNED',
          assignedTo: driver._id,
          assignedAt: new Date(),
        },
      },
    );

    const res = await request(app)
      .post(`/api/delivery/me/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ reason: 'todavía no la entregué' });

    expect(res.status).toBe(409);
    expect(driver.role).toBe('REPARTIDOR');
  });

  it('anula una entrega que ya había sido corregida a efectivo sin intentar revertir el cargo dos veces', async () => {
    await seedUser('REPARTIDOR', 'annul-corrected-driver@buchardo.gob.ar');
    const client = await seedClient();
    const product = await seedProduct();
    const driverToken = await loginAs('annul-corrected-driver@buchardo.gob.ar');

    const order = await createDirectDelivery({
      driverToken,
      clientId: client._id.toString(),
      productId: product._id.toString(),
      paymentMethod: 'ACCOUNT',
    });

    const correction = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/payment-method`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ paymentMethod: 'CASH', reason: 'pagó en efectivo' });
    expect(correction.status).toBe(200);
    expect(correction.body.data.order.paymentMethod).toBe('CASH');

    const annul = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ reason: 'se devolvió la mercadería' });
    expect(annul.status).toBe(200);
    expect(annul.body.data.order.status).toBe('CANCELLED');

    // One DEBIT, one reversal of it and one cash collection + its reversal.
    const accountMovements = await AccountMovement.find({
      clientId: client._id,
    }).lean();
    expect(accountMovements).toHaveLength(2);
    expect(
      accountMovements.filter((m) => m.movementType === 'REVERSAL'),
    ).toHaveLength(1);

    const cashMovements = await CashMovement.find({ clientId: client._id }).lean();
    expect(cashMovements).toHaveLength(2);
    expect(
      cashMovements.filter((m) => m.movementType === 'CASH_REVERSAL'),
    ).toHaveLength(1);
  });
});

// ===========================================================================
// Corrección de la forma de pago
// ===========================================================================

describe('Repartidor — corrección de forma de pago', () => {
  it('corrige de cuenta corriente a efectivo: revierte el cargo y registra el efectivo', async () => {
    await seedUser('REPARTIDOR', 'fix-cash-driver@buchardo.gob.ar');
    const client = await seedClient();
    const product = await seedProduct();
    const driverToken = await loginAs('fix-cash-driver@buchardo.gob.ar');

    const order = await createDirectDelivery({
      driverToken,
      clientId: client._id.toString(),
      productId: product._id.toString(),
      paymentMethod: 'ACCOUNT',
    });

    const res = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/payment-method`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ paymentMethod: 'CASH', reason: 'El cliente pagó en efectivo' });

    expect(res.status).toBe(200);
    expect(res.body.data.order.paymentMethod).toBe('CASH');
    expect(res.body.data.order.paymentMethodChangedAt).toBeTruthy();
    expect(res.body.data.order.paymentMethodChangeReason).toBe(
      'El cliente pagó en efectivo',
    );

    const accountMovements = await AccountMovement.find({
      clientId: client._id,
    }).lean();
    expect(accountMovements).toHaveLength(2);
    expect(
      accountMovements.filter((m) => m.movementType === 'REVERSAL'),
    ).toHaveLength(1);

    const cashMovements = await CashMovement.find({ clientId: client._id }).lean();
    expect(cashMovements).toHaveLength(1);
    expect(cashMovements[0].movementType).toBe('CASH_COLLECTION');
    expect(cashMovements[0].amountMinor).toBe(1_000_000);

    const persisted = await Order.findById(order.id).lean();
    expect(persisted?.accountMovementId).toBeNull();
    expect(persisted?.cashMovementId?.toString()).toBe(
      cashMovements[0]._id.toString(),
    );
  });

  it('corrige de efectivo a cuenta corriente: revierte el efectivo y carga la cuenta', async () => {
    await seedUser('REPARTIDOR', 'fix-account-driver@buchardo.gob.ar');
    const client = await seedClient();
    const product = await seedProduct();
    const driverToken = await loginAs('fix-account-driver@buchardo.gob.ar');

    const order = await createDirectDelivery({
      driverToken,
      clientId: client._id.toString(),
      productId: product._id.toString(),
      paymentMethod: 'CASH',
    });

    const res = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/payment-method`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ paymentMethod: 'ACCOUNT' });

    expect(res.status).toBe(200);
    expect(res.body.data.order.paymentMethod).toBe('ACCOUNT');

    const cashMovements = await CashMovement.find({ clientId: client._id }).lean();
    expect(cashMovements).toHaveLength(2);
    expect(
      cashMovements.filter((m) => m.movementType === 'CASH_REVERSAL'),
    ).toHaveLength(1);

    const accountMovements = await AccountMovement.find({
      clientId: client._id,
    }).lean();
    expect(accountMovements).toHaveLength(1);
    expect(accountMovements[0].direction).toBe('DEBIT');
    expect(accountMovements[0].movementType).toBe('ORDER_CHARGE');

    const persisted = await Order.findById(order.id).lean();
    expect(persisted?.cashMovementId).toBeNull();
    expect(persisted?.accountMovementId?.toString()).toBe(
      accountMovements[0]._id.toString(),
    );
  });

  it('permite corregir de forma ida y vuelta sin duplicar movimientos', async () => {
    await seedUser('REPARTIDOR', 'fix-roundtrip-driver@buchardo.gob.ar');
    const client = await seedClient();
    const product = await seedProduct();
    const driverToken = await loginAs('fix-roundtrip-driver@buchardo.gob.ar');

    const order = await createDirectDelivery({
      driverToken,
      clientId: client._id.toString(),
      productId: product._id.toString(),
      paymentMethod: 'ACCOUNT',
    });

    const toCash = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/payment-method`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ paymentMethod: 'CASH' });
    expect(toCash.status).toBe(200);
    expect(toCash.body.data.order.paymentMethod).toBe('CASH');

    const toAccount = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/payment-method`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ paymentMethod: 'ACCOUNT' });
    expect(toAccount.status).toBe(200);
    expect(toAccount.body.data.order.paymentMethod).toBe('ACCOUNT');

    const toCashAgain = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/payment-method`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ paymentMethod: 'CASH' });
    expect(toCashAgain.status).toBe(200);
    expect(toCashAgain.body.data.order.paymentMethod).toBe('CASH');

    // Two charges posted (the original + the one from the last correction)
    // and two cash collections, each one reversed once.
    const accountMovements = await AccountMovement.find({
      clientId: client._id,
    }).lean();
    expect(
      accountMovements.filter((m) => m.movementType === 'ORDER_CHARGE'),
    ).toHaveLength(2);
    expect(
      accountMovements.filter((m) => m.movementType === 'REVERSAL'),
    ).toHaveLength(2);

    const cashMovements = await CashMovement.find({ clientId: client._id }).lean();
    expect(
      cashMovements.filter((m) => m.movementType === 'CASH_COLLECTION'),
    ).toHaveLength(2);
    expect(
      cashMovements.filter((m) => m.movementType === 'CASH_REVERSAL'),
    ).toHaveLength(1);
  });

  it('no permite corregir a la misma forma de pago', async () => {
    await seedUser('REPARTIDOR', 'fix-same-driver@buchardo.gob.ar');
    const client = await seedClient();
    const product = await seedProduct();
    const driverToken = await loginAs('fix-same-driver@buchardo.gob.ar');

    const order = await createDirectDelivery({
      driverToken,
      clientId: client._id.toString(),
      productId: product._id.toString(),
      paymentMethod: 'ACCOUNT',
    });

    const res = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/payment-method`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ paymentMethod: 'ACCOUNT' });

    expect(res.status).toBe(400);
  });

  it('no permite corregir la forma de pago de una entrega de otro repartidor', async () => {
    await seedUser('REPARTIDOR', 'fix-owner-driver@buchardo.gob.ar');
    await seedUser('REPARTIDOR', 'fix-intruder-driver@buchardo.gob.ar');
    const client = await seedClient();
    const product = await seedProduct();
    const ownerToken = await loginAs('fix-owner-driver@buchardo.gob.ar');
    const intruderToken = await loginAs('fix-intruder-driver@buchardo.gob.ar');

    const order = await createDirectDelivery({
      driverToken: ownerToken,
      clientId: client._id.toString(),
      productId: product._id.toString(),
      paymentMethod: 'ACCOUNT',
    });

    const res = await request(app)
      .post(`/api/delivery/me/orders/${order.id}/payment-method`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ paymentMethod: 'CASH' });

    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Protección del estado CANCELLED
// ===========================================================================

describe('Anulación — permisos y estados', () => {
  it('el ciudadano no puede anular su propia entrega ya realizada', async () => {
    const citizen = await seedUser('CIUDADANO', 'citizen-annul@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });
    const product = await seedProduct();
    const citizenToken = await loginAs('citizen-annul@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });
    expect(created.status).toBe(201);
    const orderId = created.body.data.order.id;

    // Force the order to DELIVERED (the citizen path never gets there on
    // its own without a repartidor).
    await Order.updateOne(
      { _id: orderId },
      { $set: { status: 'DELIVERED', deliveredAt: new Date() } },
    );

    const res = await request(app)
      .post(`/api/orders/me/${orderId}/cancel`)
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ reason: 'me equivoqué' });

    expect(res.status).toBe(409);

    const persisted = await Order.findById(orderId).lean();
    expect(persisted?.status).toBe('DELIVERED');
  });

  it('la administración sí puede anular una entrega ya realizada', async () => {
    await seedUser('ADMIN', 'admin-annul@buchardo.gob.ar');
    const driver = await seedUser('REPARTIDOR', 'admin-annul-driver@buchardo.gob.ar');
    const client = await seedClient();
    const product = await seedProduct();
    const driverToken = await loginAs('admin-annul-driver@buchardo.gob.ar');
    const adminToken = await loginAs('admin-annul@buchardo.gob.ar');

    const order = await createDirectDelivery({
      driverToken,
      clientId: client._id.toString(),
      productId: product._id.toString(),
      paymentMethod: 'ACCOUNT',
    });

    const res = await request(app)
      .post(`/api/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Corrección de la administración' });

    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('CANCELLED');
    expect(res.body.data.order.cancellationReason).toBe(
      'Corrección de la administración',
    );

    const movements = await AccountMovement.find({ clientId: client._id }).lean();
    expect(movements).toHaveLength(2);
    expect(driver.role).toBe('REPARTIDOR');
  });
});
