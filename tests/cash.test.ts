/**
 * Cash module tests — covers the CASH ledger (separate from cta cte).
 */
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
    address: {
      street: 'Av. San Martín',
      number: '123',
      locality: 'Buchardo',
    },
    userId: opts.userId ?? null,
    active: opts.active ?? true,
    zona: opts.zona ?? null,
  });
}

async function seedProduct(opts: {
  basePriceMinor?: number;
  productType?: 'WATER_REFILL' | 'CONTAINER' | 'DISPENSER' | 'OTHER';
} = {}) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Product.create({
    code: `C${idx}`,
    name: 'Recarga de agua',
    productType: opts.productType ?? 'WATER_REFILL',
    basePriceMinor: opts.basePriceMinor ?? 1_000_000,
    tracksStock: false,
    active: true,
  });
}

describe('Cash — cta cte vs cash ledger are independent', () => {
  it('CASH order: cta cte balance unaffected, cash ledger receives the collection', async () => {
    const driver = await seedUser('REPARTIDOR', 'driver@buchardo.gob.ar');
    const client = await seedClient({ documentNumber: 'CASH-001' });
    const refill = await seedProduct({ basePriceMinor: 2_000_000 });
    const driverToken = await loginAs('driver@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/delivery/me/direct-order')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        clientId: client._id.toString(),
        items: [{ productId: refill._id.toString(), quantity: 1 }],
        paymentMethod: 'CASH',
      });
    expect(res.status).toBe(201);

    const accountMovements = await AccountMovement.find({ clientId: client._id })
      .lean();
    expect(accountMovements).toHaveLength(0);

    const cashMovements = await CashMovement.find({ clientId: client._id }).lean();
    expect(cashMovements).toHaveLength(1);
    expect(cashMovements[0].amountMinor).toBe(2_000_000);
  });

  it('citizen sees /cash/me/movements for own cash entries only', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const driver = await seedUser('REPARTIDOR', 'driver@buchardo.gob.ar');
    const client = await seedClient({
      userId: citizen._id,
      documentNumber: 'CASH-CIT-001',
    });
    const refill = await seedProduct({ basePriceMinor: 1_500_000 });
    const driverToken = await loginAs('driver@buchardo.gob.ar');

    // Driver creates a CASH direct-order.
    await request(app)
      .post('/api/delivery/me/direct-order')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        clientId: client._id.toString(),
        items: [{ productId: refill._id.toString(), quantity: 1 }],
        paymentMethod: 'CASH',
      });

    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const summaryRes = await request(app)
      .get('/api/cash/me/summary')
      .set('Authorization', `Bearer ${citizenToken}`);
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.data.summary.totalCollectedMinor).toBe(1_500_000);
    expect(summaryRes.body.data.summary.movementCount).toBe(1);

    const listRes = await request(app)
      .get('/api/cash/me/movements')
      .set('Authorization', `Bearer ${citizenToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.items).toHaveLength(1);
    expect(listRes.body.data.items[0].amountMinor).toBe(1_500_000);
    expect(listRes.body.data.items[0].description).toMatch(/contado/i);
  });

  it('admin sees aggregate by driver', async () => {
    const driver = await seedUser('REPARTIDOR', 'driver@buchardo.gob.ar');
    const driverToken = await loginAs('driver@buchardo.gob.ar');
    await seedUser('ADMIN', 'cashadmin@buchardo.gob.ar');
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });

    // 2 CASH direct-orders for 2 different clients.
    for (const docNumber of ['AGG-1', 'AGG-2']) {
      const client = await seedClient({ documentNumber: docNumber });
      await request(app)
        .post('/api/delivery/me/direct-order')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          clientId: client._id.toString(),
          items: [{ productId: refill._id.toString(), quantity: 1 }],
          paymentMethod: 'CASH',
        });
    }

    const adminToken = await loginAs('cashadmin@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/cash/admin/aggregate/by-driver')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].driverId).toBe(driver._id.toString());
    expect(res.body.data.items[0].totalCollectedMinor).toBe(2_000_000);
    expect(res.body.data.items[0].movementCount).toBe(2);
  });

  it('cancelar un pedido CASH (en estado cancelable) reversa el CashMovement', async () => {
    const driver = await seedUser('REPARTIDOR', 'driver@buchardo.gob.ar');
    await seedUser('ADMIN', 'cashadmin-cancel@buchardo.gob.ar');
    const client = await seedClient({ documentNumber: 'CANCEL-CASH' });
    const refill = await seedProduct({ basePriceMinor: 1_000_000 });
    const driverToken = await loginAs('driver@buchardo.gob.ar');

    // CASH direct-order arranca en OUT_FOR_DELIVERY. Lo rebobinamos a
    // ASSIGNED para que el state-machine permita cancelarlo (el MVP
    // no permite cancelar OUT_FOR_DELIVERY).
    const createRes = await request(app)
      .post('/api/delivery/me/direct-order')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        clientId: client._id.toString(),
        items: [{ productId: refill._id.toString(), quantity: 1 }],
        paymentMethod: 'CASH',
      });
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.data.order.id;

    await Order.updateOne(
      { _id: orderId },
      {
        $set: {
          status: 'ASSIGNED',
          assignedTo: driver._id,
        },
      },
    );

    const cashBefore = await CashMovement.find({ clientId: client._id }).lean();
    expect(cashBefore).toHaveLength(1);

    const adminToken = await loginAs('cashadmin-cancel@buchardo.gob.ar');
    const cancelRes = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Cliente no estaba' });
    expect(cancelRes.status).toBe(200);

    // La colección original queda; se agrega un movimiento CASH_REVERSAL
    // con el mismo monto (la compensación es semántica, no numérica).
    const cashAfter = await CashMovement.find({ clientId: client._id })
      .sort({ occurredAt: 1 })
      .lean();
    expect(cashAfter).toHaveLength(2);
    expect(cashAfter[0].movementType).toBe('CASH_COLLECTION');
    expect(cashAfter[0].amountMinor).toBe(1_000_000);
    expect(cashAfter[1].movementType).toBe('CASH_REVERSAL');
    expect(cashAfter[1].amountMinor).toBe(1_000_000);
  });
});