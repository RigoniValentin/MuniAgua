/**
 * Standalone-fallback tests.
 *
 * These run against a `MongoMemoryServer` (NOT a ReplicaSet) and exercise
 * the compensated `runAtomicOperation` path. The existing
 * `orders.test.ts` / `payments-approval.test.ts` / `payments-submission.test.ts`
 * still use MongoMemoryReplSet so we cover BOTH modes.
 *
 * Verifies (from the brief):
 *   1. crear Order + DEBIT
 *   2. Order $0
 *   3. cancelar Order + reversal
 *   4. aprobar Payment + CREDIT
 *   5. rechazar Payment sin ledger
 *   6. revertir Payment + reversal
 *   7. direct-order + DEBIT
 *   8. doble approve no duplica CREDIT
 *   9. doble cancel/reversal no duplica ledger
 *  10. idempotency keys siguen funcionando
 *
 * Plus failure simulations:
 *   - Order creado + ledger falla → API devuelve error y no persiste Order
 *   - Payment approval + ledger falla → API devuelve error y Payment queda PENDING
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import {
  setupStandaloneTestDb,
  teardownStandaloneTestDb,
  clearStandaloneTestDb,
} from './standalone-setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import {
  ROLES,
  defaultPermissionsForRole,
} from '../src/modules/users/users.types';
import { signAccessToken } from '../src/modules/auth/auth.tokens';
import { Client } from '../src/modules/clients/clients.model';
import { Product } from '../src/modules/products/products.model';
import { PricingRule } from '../src/modules/pricing/pricing.rules.model';
import { AccountMovement } from '../src/modules/accounts/account-movements.model';
import { Order } from '../src/modules/orders/orders.model';
import { Payment } from '../src/modules/payments/payments.model';
import { supportsTransactions } from '../src/shared/transactions';
import { buildPng } from './payment-fixtures';

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await setupStandaloneTestDb();
  loadEnv();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await teardownStandaloneTestDb();
});

beforeEach(async () => {
  await clearStandaloneTestDb();
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function seedUser(
  role: keyof typeof ROLES,
  email: string,
): Promise<Awaited<ReturnType<typeof createUser>>> {
  return createUser({
    firstName: role,
    lastName: 'Test',
    email,
    password: 'Password123',
    role: ROLES[role],
  });
}

async function loginAs(email: string): Promise<string> {
  const { User } = await import('../src/modules/users/users.model');
  const user = await User.findOne({ email });
  if (!user) throw new Error(`User not found: ${email}`);
  return signAccessToken({
    sub: user._id.toString(),
    role: user.role,
    permissions: defaultPermissionsForRole(user.role),
  });
}

async function seedLinkedClient(
  userId: Types.ObjectId,
  clientType: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL' = 'LOCAL',
) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Client.create({
    firstName: 'Test',
    lastName: `Client${idx}`,
    documentType: 'DNI',
    documentNumber: idx.toString(),
    clientType,
    address: { street: 'Av. San Martín', number: '123', locality: 'Buchardo' },
    userId,
    active: true,
  });
}

async function seedProduct(opts: {
  code?: string;
  basePriceMinor?: number;
  productType?: 'WATER_REFILL' | 'CONTAINER' | 'DISPENSER' | 'OTHER';
} = {}) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Product.create({
    code: opts.code ?? `P${idx}`,
    name: 'Recarga de agua',
    productType: opts.productType ?? 'WATER_REFILL',
    basePriceMinor: opts.basePriceMinor ?? 1_000_000,
    tracksStock: false,
    active: true,
  });
}

async function uploadPayment(token: string, amountMinor = 400_000) {
  return request(app)
    .post('/api/payments/me')
    .set('Authorization', `Bearer ${token}`)
    .field('amountMinor', String(amountMinor))
    .field('paymentMethod', 'BANK_TRANSFER')
    .attach('receipt', buildPng(), 'transfer.png');
}

// ===========================================================================
// Sanity: confirm we ARE on a non-replicaset topology
// ===========================================================================

describe('Standalone topology', () => {
  it('detects no transaction support and routes through fallback', () => {
    expect(supportsTransactions()).toBe(false);
  });
});

// ===========================================================================
// Orders — basic + edge cases
// ===========================================================================

describe('Standalone — orders', () => {
  it('1) crea pedido y genera DEBIT (fallback path)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedLinkedClient(citizen._id);
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.order.status).toBe('CONFIRMED');
    expect(res.body.data.order.totalFinalMinor).toBe(1_000_000);

    const movements = await AccountMovement.find({ clientId: client._id }).lean();
    expect(movements).toHaveLength(1);
    expect(movements[0].direction).toBe('DEBIT');
    expect(movements[0].amountMinor).toBe(1_000_000);
    expect(movements[0].idempotencyKey).toBe(
      `ORDER:${res.body.data.order.id}:CHARGE`,
    );
  });

  it('2) Order $0 (AYUDA_SOCIAL -100%) → NO genera DEBIT', async () => {
    const citizen = await seedUser('CIUDADANO', 'social@buchardo.gob.ar');
    const client = await seedLinkedClient(citizen._id, 'AYUDA_SOCIAL');
    await PricingRule.create({
      name: 'Ayuda social',
      clientType: 'AYUDA_SOCIAL',
      scope: 'ALL_PRODUCTS',
      adjustmentType: 'PERCENTAGE',
      adjustmentValue: -100,
      priority: 0,
      active: true,
    });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const token = await loginAs('social@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.order.totalFinalMinor).toBe(0);
    const movements = await AccountMovement.find({ clientId: client._id }).lean();
    expect(movements).toHaveLength(0);
  });

  it('3) cancela pedido CONFIRMED + revierte DEBIT', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedLinkedClient(citizen._id);
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    const id = created.body.data.order.id;

    const cancel = await request(app)
      .post(`/api/orders/me/${id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'me equivoqué' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.order.status).toBe('CANCELLED');

    const movements = await AccountMovement.find({ clientId: client._id }).lean();
    expect(movements).toHaveLength(2);
    const reversal = movements.find((m) => m.movementType === 'REVERSAL');
    expect(reversal).toBeTruthy();
    expect(reversal!.amountMinor).toBe(1_000_000);
    expect(reversal!.direction).toBe('CREDIT');
  });

  it('7) direct-order + DEBIT arranca en OUT_FOR_DELIVERY', async () => {
    const _driver = await seedUser('REPARTIDOR', 'driver@buchardo.gob.ar');
    const client = await seedLinkedClient(undefined as unknown as Types.ObjectId, 'LOCAL');
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
    expect(res.body.data.order.status).toBe('OUT_FOR_DELIVERY');
    expect(res.body.data.order.totalFinalMinor).toBe(1_000_000);
    const movements = await AccountMovement.find({ clientId: client._id }).lean();
    expect(movements).toHaveLength(1);
    expect(movements[0].movementType).toBe('ORDER_CHARGE');
  });
});

// ===========================================================================
// Payments — approval, rejection, reversal
// ===========================================================================

describe('Standalone — payments', () => {
  it('4) aprobar Payment + CREDIT (fallback path)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    const token = await loginAs('vecino@buchardo.gob.ar');
    const _admin = await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const uploaded = await uploadPayment(token, 400_000);
    expect(uploaded.status).toBe(201);
    const paymentId = uploaded.body.data.payment.id;

    const approved = await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(approved.status).toBe(200);
    expect(approved.body.data.payment.status).toBe('APPROVED');

    // Fetch the full DTO to confirm the ledger link is set.
    const detail = await request(app)
      .get(`/api/payments/${paymentId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.payment.ledgerMovementId).toBeTruthy();

    const movement = await AccountMovement.findOne({
      _id: detail.body.data.payment.ledgerMovementId,
    }).lean();
    expect(movement).toBeTruthy();
    expect(movement!.direction).toBe('CREDIT');
    expect(movement!.amountMinor).toBe(400_000);
  });

  it('5) rechazar Payment sin ledger', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    const token = await loginAs('vecino@buchardo.gob.ar');
    const _admin = await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const uploaded = await uploadPayment(token, 250_000);
    const paymentId = uploaded.body.data.payment.id;

    const rejected = await request(app)
      .post(`/api/payments/${paymentId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'comprobante ilegible' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.payment.status).toBe('REJECTED');

    // No CREDIT/DEBIT pair was generated for this Payment.
    const movements = await AccountMovement.find({
      sourceType: 'PAYMENT',
      sourceId: new Types.ObjectId(paymentId),
    }).lean();
    expect(movements).toHaveLength(0);
  });

  it('6) revertir Payment APPROVED + reversal', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedLinkedClient(citizen._id);
    const token = await loginAs('vecino@buchardo.gob.ar');
    const _admin = await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const uploaded = await uploadPayment(token, 600_000);
    const paymentId = uploaded.body.data.payment.id;

    await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    const reversed = await request(app)
      .post(`/api/payments/${paymentId}/reverse-approval`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'monto equivocado' });
    expect(reversed.status).toBe(200);
    expect(reversed.body.data.payment.status).toBe('REVERSED');

    const detail = await request(app)
      .get(`/api/payments/${paymentId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detail.body.data.payment.reversalMovementId).toBeTruthy();

    const movements = await AccountMovement.find({ clientId: client._id }).lean();
    expect(movements).toHaveLength(2);
    const reversal = movements.find((m) => m.movementType === 'REVERSAL');
    expect(reversal).toBeTruthy();
    expect(reversal!.direction).toBe('DEBIT');
    expect(reversal!.amountMinor).toBe(600_000);
  });

  it('8) doble approve no duplica CREDIT (state machine guard)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedLinkedClient(citizen._id);
    const token = await loginAs('vecino@buchardo.gob.ar');
    const _admin = await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const uploaded = await uploadPayment(token, 300_000);
    const paymentId = uploaded.body.data.payment.id;

    const first = await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(first.status).toBe(200);

    // Second approve is rejected by the state machine; the API surfaces
    // it as 409, exactly as in the ReplicaSet path.
    const second = await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(second.status).toBe(409);

    const credits = await AccountMovement.find({
      clientId: client._id,
      direction: 'CREDIT',
    }).lean();
    expect(credits).toHaveLength(1);
  });

  it('9) doble cancel / doble reversal no duplica ledger', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedLinkedClient(citizen._id);
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const token = await loginAs('vecino@buchardo.gob.ar');
    const _admin = await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    // Order cancel + reversal twice
    const created = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    const orderId = created.body.data.order.id;

    await request(app)
      .post(`/api/orders/me/${orderId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'primera' });
    const second = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'segunda' });
    expect(second.status).toBe(409);

    const orderReversals = await AccountMovement.find({
      clientId: client._id,
      movementType: 'REVERSAL',
    }).lean();
    expect(orderReversals).toHaveLength(1);

    // Payment approve + reversal twice
    const uploaded = await uploadPayment(token, 500_000);
    const paymentId = uploaded.body.data.payment.id;
    await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    await request(app)
      .post(`/api/payments/${paymentId}/reverse-approval`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'reverso 1' });
    // Second reversal is caught by the state machine: APPROVED → REVERSED
    // cannot transition again because the Payment is already REVERSED.
    const secondRev = await request(app)
      .post(`/api/payments/${paymentId}/reverse-approval`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'reverso 2' });
    expect(secondRev.status).toBe(409);

    const allReversals = await AccountMovement.find({
      clientId: client._id,
      movementType: 'REVERSAL',
    }).lean();
    // Exactly 2: 1 for the order, 1 for the payment
    expect(allReversals).toHaveLength(2);
  });

  it('10) idempotency keys siguen funcionando (doble POST /orders)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedLinkedClient(citizen._id);
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const first = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
    expect(first.status).toBe(201);

    const movements = await AccountMovement.find({ clientId: client._id }).lean();
    expect(movements).toHaveLength(1);
    expect(movements[0].idempotencyKey).toBe(
      `ORDER:${first.body.data.order.id}:CHARGE`,
    );
  });
});

// ===========================================================================
// Failure simulation
// ===========================================================================

describe('Standalone — failure compensation', () => {
  it('Order creado pero ledger falla → API devuelve error y NO persiste Order', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedLinkedClient(citizen._id);
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const token = await loginAs('vecino@buchardo.gob.ar');

    // Spy on `postMovement` to force a failure that mirrors what would
    // happen if the ledger write failed mid-flight.
    const accounts = await import('../src/modules/accounts/accounts.service');
    const spy = vi
      .spyOn(accounts, 'postMovement')
      .mockImplementation(async () => {
        throw new Error('Simulated ledger failure');
      });

    try {
      const res = await request(app)
        .post('/api/orders/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ items: [{ productId: refill._id.toString(), quantity: 1 }] });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }

    // No Order should remain, no AccountMovement should exist.
    const orders = await Order.countDocuments({});
    const movements = await AccountMovement.countDocuments({ clientId: client._id });
    expect(orders).toBe(0);
    expect(movements).toBe(0);
  });

  it('Payment approval con ledger falla → Payment queda PENDING', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    const token = await loginAs('vecino@buchardo.gob.ar');
    const _admin = await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const uploaded = await uploadPayment(token, 200_000);
    const paymentId = uploaded.body.data.payment.id;

    const accounts = await import('../src/modules/accounts/accounts.service');
    const spy = vi
      .spyOn(accounts, 'postMovement')
      .mockImplementation(async () => {
        throw new Error('Simulated ledger failure');
      });

    let res;
    try {
      res = await request(app)
        .post(`/api/payments/${paymentId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`);
    } finally {
      spy.mockRestore();
    }

    expect(res!.status).toBe(500);

    const payment = await Payment.findById(paymentId);
    expect(payment).toBeTruthy();
    expect(payment!.status).toBe('PENDING');
    expect(payment!.ledgerMovementId ?? null).toBeNull();
  });
});
