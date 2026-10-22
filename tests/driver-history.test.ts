/**
 * Driver history tests — covers `/api/delivery/me/history`.
 *
 * The timezone under test is America/Argentina/Buenos_Aires (set in the test
 * bootstrap), so a CUSTOM period of `2025-06-10 → 2025-06-10` spans
 * `2025-06-10T03:00Z → 2025-06-11T03:00Z`.
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
import * as XLSX from 'xlsx';
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
import { Order } from '../src/modules/orders/orders.model';
import { CashMovement } from '../src/modules/cash/cash-movements.model';
import { AccountMovement } from '../src/modules/accounts/account-movements.model';

let app: ReturnType<typeof createApp>;

const PERIOD = {
  period: 'CUSTOM',
  dateFrom: '2025-06-10',
  dateTo: '2025-06-15',
};

// 2025-06-10 10:00 ART == 13:00Z, comfortably inside the period above.
const IN_PERIOD = new Date('2025-06-10T13:00:00.000Z');
const IN_PERIOD_LATER = new Date('2025-06-11T15:30:00.000Z');
const BEFORE_PERIOD = new Date('2025-06-09T13:00:00.000Z');
const AFTER_PERIOD = new Date('2025-06-16T13:00:00.000Z');

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

async function seedDriver(email: string) {
  const user = await createUser({
    firstName: 'Repartidor',
    lastName: email.split('@')[0]!.slice(0, 6),
    email,
    password: 'Password123',
    role: ROLES.REPARTIDOR,
  });
  return {
    id: user._id,
    token: signAccessToken({
      sub: user._id.toString(),
      role: user.role,
      permissions: defaultPermissionsForRole(user.role),
    }),
  };
}

async function seedClient(documentNumber: string) {
  return Client.create({
    firstName: 'Ana',
    lastName: 'Cliente',
    documentType: 'DNI',
    documentNumber,
    clientType: 'LOCAL',
    address: { street: 'Av. San Martín', number: '123', locality: 'Buchardo' },
    userId: null,
    active: true,
    zona: 'ZONA 1',
  });
}

const PRODUCT_ID = new Types.ObjectId();

function orderItems(quantity = 2, subtotalFinalMinor = 3_000_000) {
  return [
    {
      productId: PRODUCT_ID,
      productCode: 'BID20',
      productName: 'Bidón 20L',
      productType: 'WATER_REFILL',
      quantity,
      unitBasePriceMinor: subtotalFinalMinor / quantity,
      adjustmentPercentage: 0,
      unitFinalPriceMinor: subtotalFinalMinor / quantity,
      subtotalBaseMinor: subtotalFinalMinor,
      subtotalFinalMinor,
      appliedRuleId: null,
      appliedRuleName: null,
    },
  ];
}

interface OrderOverrides {
  clientId: Types.ObjectId;
  driverId: Types.ObjectId;
  origin?: 'CITIZEN' | 'STAFF';
  status?: string;
  paymentMethod?: 'ACCOUNT' | 'CASH';
  totalFinalMinor?: number;
  assignedAt?: Date | null;
  startedDeliveryAt?: Date | null;
  deliveredAt?: Date | null;
  cancelledAt?: Date | null;
  cancellationMovementId?: Types.ObjectId | null;
  cancellationReason?: string | null;
}

async function seedOrder(overrides: OrderOverrides) {
  const totalFinalMinor = overrides.totalFinalMinor ?? 3_000_000;
  return Order.create({
    clientId: overrides.clientId,
    origin: overrides.origin ?? 'CITIZEN',
    status: overrides.status ?? 'DELIVERED',
    paymentMethod: overrides.paymentMethod ?? 'ACCOUNT',
    totalBaseMinor: totalFinalMinor,
    totalFinalMinor,
    items: orderItems(2, totalFinalMinor),
    deliveryAddressSnapshot: {
      street: 'Av. San Martín',
      number: '123',
      locality: 'Buchardo',
    },
    zonaSnapshot: 'ZONA 1',
    assignedTo: overrides.driverId,
    assignedAt:
      overrides.assignedAt === undefined ? IN_PERIOD : overrides.assignedAt,
    startedDeliveryAt:
      overrides.startedDeliveryAt === undefined
        ? IN_PERIOD
        : overrides.startedDeliveryAt,
    deliveredAt:
      overrides.deliveredAt === undefined ? IN_PERIOD : overrides.deliveredAt,
    paidAt: overrides.deliveredAt === undefined ? IN_PERIOD : null,
    cancelledAt:
      overrides.cancelledAt === undefined ? null : overrides.cancelledAt,
    cancellationMovementId:
      overrides.cancellationMovementId === undefined
        ? null
        : overrides.cancellationMovementId,
    cancellationReason: overrides.cancellationReason ?? null,
    createdBy: overrides.driverId,
  });
}

async function getHistory(token: string, query: Record<string, string> = PERIOD) {
  return request(app)
    .get('/api/delivery/me/history')
    .query(query)
    .set('Authorization', `Bearer ${token}`);
}

describe('Driver history — /api/delivery/me/history', () => {
  it('expands a full-circuit order into claim, start and deliver entries', async () => {
    const driver = await seedDriver('hist-full@buchardo.gob.ar');
    const client = await seedClient('HIST-1');

    await seedOrder({
      clientId: client._id,
      driverId: driver.id,
      origin: 'CITIZEN',
      paymentMethod: 'ACCOUNT',
      assignedAt: IN_PERIOD,
      startedDeliveryAt: IN_PERIOD_LATER,
      deliveredAt: IN_PERIOD_LATER,
    });

    const res = await getHistory(driver.token);
    expect(res.status).toBe(200);

    const ops = res.body.data.operations;
    expect(ops.map((o: { kind: string }) => o.kind)).toEqual([
      'ORDER_DELIVERED',
      'DELIVERY_STARTED',
      'ORDER_CLAIMED',
    ]);
    expect(ops[0]).toMatchObject({
      orderReference: expect.any(String),
      clientName: 'Ana Cliente',
      documentNumber: 'HIST-1',
      zona: 'ZONA 1',
      origin: 'CITIZEN',
      paymentMethod: 'ACCOUNT',
      totalFinalMinor: 3_000_000,
      units: 2,
      accountChargedMinor: 3_000_000,
      cashCollectedMinor: 0,
      items: [
        {
          productCode: 'BID20',
          productName: 'Bidón 20L',
          quantity: 2,
          subtotalFinalMinor: 3_000_000,
        },
      ],
    });

    const summary = res.body.data.summary;
    expect(summary.ordersClaimed).toBe(1);
    expect(summary.deliveriesStarted).toBe(1);
    expect(summary.ordersDelivered).toBe(1);
    expect(summary.operationCount).toBe(3);
    expect(summary.unitsDelivered).toBe(2);
    expect(summary.totalDeliveredMinor).toBe(3_000_000);
    expect(summary.accountChargedMinor).toBe(3_000_000);
    expect(summary.cashCollectedMinor).toBe(0);
    expect(summary.distinctClients).toBe(1);
    expect(res.body.data.driver).toMatchObject({
      firstName: 'Repartidor',
    });
  });

  it('collapses a direct order into a single NEW_DELIVERY-style entry', async () => {
    const driver = await seedDriver('hist-direct@buchardo.gob.ar');
    const client = await seedClient('HIST-2');

    await seedOrder({
      clientId: client._id,
      driverId: driver.id,
      origin: 'STAFF',
      paymentMethod: 'CASH',
      assignedAt: IN_PERIOD,
      startedDeliveryAt: IN_PERIOD,
      deliveredAt: IN_PERIOD,
    });

    const res = await getHistory(driver.token);
    expect(res.status).toBe(200);

    const ops = res.body.data.operations;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'DIRECT_ORDER',
      label: 'Nueva entrega',
      origin: 'STAFF',
      paymentMethod: 'CASH',
      cashCollectedMinor: 3_000_000,
      accountChargedMinor: 0,
      totalFinalMinor: 3_000_000,
    });

    const summary = res.body.data.summary;
    expect(summary.directOrders).toBe(1);
    expect(summary.ordersDelivered).toBe(1);
    expect(summary.ordersClaimed).toBe(0);
    expect(summary.deliveriesStarted).toBe(0);
    expect(summary.cashCollectedMinor).toBe(3_000_000);
  });

  it('folds order cash into the delivery entry and never double counts it', async () => {
    const driver = await seedDriver('hist-cash@buchardo.gob.ar');
    const client = await seedClient('HIST-3');

    const order = await seedOrder({
      clientId: client._id,
      driverId: driver.id,
      origin: 'STAFF',
      paymentMethod: 'CASH',
      assignedAt: IN_PERIOD,
      startedDeliveryAt: IN_PERIOD,
      deliveredAt: IN_PERIOD,
    });

    // The cash ledger entry attached to the order must NOT surface as its
    // own timeline row — it is already reported on the delivery.
    await CashMovement.create({
      clientId: client._id,
      driverId: driver.id,
      amountMinor: 3_000_000,
      movementType: 'CASH_COLLECTION',
      description: 'Cobro en contado',
      sourceType: 'ORDER',
      orderId: order._id,
      idempotencyKey: `ORDER:${order._id}:CASH_COLLECTION`,
    });

    const res = await getHistory(driver.token);
    expect(res.status).toBe(200);
    expect(res.body.data.operations).toHaveLength(1);
    expect(res.body.data.summary.manualCashCollections).toBe(0);
    expect(res.body.data.summary.cashCollectedMinor).toBe(3_000_000);
  });

  it('reports the cta cte reversal when an account order is paid in cash', async () => {
    const driver = await seedDriver('hist-flip@buchardo.gob.ar');
    const client = await seedClient('HIST-4');

    const reversal = await AccountMovement.create({
      clientId: client._id,
      direction: 'CREDIT',
      amountMinor: 3_000_000,
      movementType: 'REVERSAL',
      description: 'Reversión de cargo (cobro en efectivo)',
      occurredAt: IN_PERIOD,
      sourceType: 'REVERSAL',
      reversesMovementId: new Types.ObjectId(),
    });

    await seedOrder({
      clientId: client._id,
      driverId: driver.id,
      origin: 'CITIZEN',
      paymentMethod: 'CASH',
      assignedAt: IN_PERIOD,
      startedDeliveryAt: IN_PERIOD,
      deliveredAt: IN_PERIOD,
      cancellationMovementId: reversal._id,
    });

    const res = await getHistory(driver.token);
    expect(res.status).toBe(200);

    const delivered = res.body.data.operations.find(
      (o: { kind: string }) => o.kind === 'ORDER_DELIVERED',
    );
    expect(delivered).toMatchObject({
      cashCollectedMinor: 3_000_000,
      accountChargedMinor: 0,
      accountReversedMinor: 3_000_000,
    });
    expect(res.body.data.summary.accountReversedMinor).toBe(3_000_000);
  });

  it('surfaces standalone cash movements and reversals as their own entries', async () => {
    const driver = await seedDriver('hist-manual@buchardo.gob.ar');
    const client = await seedClient('HIST-5');

    await CashMovement.create({
      clientId: client._id,
      driverId: driver.id,
      amountMinor: 500_000,
      movementType: 'CASH_COLLECTION',
      description: 'Cobro manual',
      sourceType: 'MANUAL',
      sourceId: null,
      orderId: null,
      occurredAt: IN_PERIOD,
    });
    await CashMovement.create({
      clientId: client._id,
      driverId: driver.id,
      amountMinor: 500_000,
      movementType: 'CASH_REVERSAL',
      description: 'Anulación de cobro manual',
      sourceType: 'MANUAL',
      sourceId: null,
      orderId: null,
      occurredAt: IN_PERIOD_LATER,
    });

    const res = await getHistory(driver.token);
    expect(res.status).toBe(200);
    expect(res.body.data.operations.map((o: { kind: string }) => o.kind)).toEqual(
      ['CASH_REVERSED', 'CASH_COLLECTED'],
    );
    expect(res.body.data.summary.manualCashCollections).toBe(1);
    expect(res.body.data.summary.manualCashReversals).toBe(1);
    expect(res.body.data.summary.cashCollectedMinor).toBe(500_000);
    expect(res.body.data.summary.distinctClients).toBe(1);
  });

  it('records a cancellation with its reason and reversal amount', async () => {
    const driver = await seedDriver('hist-cancel@buchardo.gob.ar');
    const client = await seedClient('HIST-6');

    const reversal = await AccountMovement.create({
      clientId: client._id,
      direction: 'CREDIT',
      amountMinor: 3_000_000,
      movementType: 'REVERSAL',
      description: 'Reversión por cancelación',
      occurredAt: IN_PERIOD_LATER,
      sourceType: 'REVERSAL',
      reversesMovementId: new Types.ObjectId(),
    });

    await seedOrder({
      clientId: client._id,
      driverId: driver.id,
      origin: 'CITIZEN',
      status: 'CANCELLED',
      paymentMethod: 'ACCOUNT',
      assignedAt: IN_PERIOD,
      startedDeliveryAt: null,
      deliveredAt: null,
      cancelledAt: IN_PERIOD_LATER,
      cancellationMovementId: reversal._id,
      cancellationReason: 'El cliente no estaba',
    });

    const res = await getHistory(driver.token);
    expect(res.status).toBe(200);
    const ops = res.body.data.operations;
    expect(ops.map((o: { kind: string }) => o.kind)).toEqual([
      'ORDER_CANCELLED',
      'ORDER_CLAIMED',
    ]);
    expect(ops[0]).toMatchObject({
      detail: 'El cliente no estaba',
      accountReversedMinor: 3_000_000,
    });
    expect(res.body.data.summary.ordersCancelled).toBe(1);
    expect(res.body.data.summary.ordersDelivered).toBe(0);
  });

  it('never leaks another repartidor\'s movements', async () => {
    const driverA = await seedDriver('hist-iso-a@buchardo.gob.ar');
    const driverB = await seedDriver('hist-iso-b@buchardo.gob.ar');
    const client = await seedClient('HIST-7');

    await seedOrder({
      clientId: client._id,
      driverId: driverB.id,
      origin: 'STAFF',
      paymentMethod: 'CASH',
      assignedAt: IN_PERIOD,
      startedDeliveryAt: IN_PERIOD,
      deliveredAt: IN_PERIOD,
    });
    await CashMovement.create({
      clientId: client._id,
      driverId: driverB.id,
      amountMinor: 900_000,
      movementType: 'CASH_COLLECTION',
      description: 'Cobro de otro repartidor',
      sourceType: 'MANUAL',
      orderId: null,
      occurredAt: IN_PERIOD,
    });

    const res = await getHistory(driverA.token);
    expect(res.status).toBe(200);
    expect(res.body.data.operations).toEqual([]);
    expect(res.body.data.summary.operationCount).toBe(0);
    expect(res.body.data.summary.cashCollectedMinor).toBe(0);
  });

  it('anchors every entry to the instant of the operation', async () => {
    const driver = await seedDriver('hist-anchor@buchardo.gob.ar');
    const client = await seedClient('HIST-8');

    // Claimed inside the period, delivered a month later — the delivery must
    // not appear in this period's timeline.
    await seedOrder({
      clientId: client._id,
      driverId: driver.id,
      origin: 'CITIZEN',
      paymentMethod: 'ACCOUNT',
      assignedAt: IN_PERIOD,
      startedDeliveryAt: IN_PERIOD,
      deliveredAt: new Date('2025-07-20T13:00:00.000Z'),
    });

    const res = await getHistory(driver.token);
    expect(res.status).toBe(200);
    expect(
      res.body.data.operations.map((o: { kind: string }) => o.kind),
    ).toEqual(['DELIVERY_STARTED', 'ORDER_CLAIMED']);
    expect(res.body.data.summary.ordersDelivered).toBe(0);

    // Same order, a period that contains the delivery.
    const wider = await getHistory(driver.token, {
      period: 'CUSTOM',
      dateFrom: '2025-07-01',
      dateTo: '2025-07-31',
    });
    expect(
      wider.body.data.operations.map((o: { kind: string }) => o.kind),
    ).toEqual(['ORDER_DELIVERED']);
  });

  it('ignores operations that fall outside the CUSTOM range', async () => {
    const driver = await seedDriver('hist-range@buchardo.gob.ar');
    const client = await seedClient('HIST-9');

    await seedOrder({
      clientId: client._id,
      driverId: driver.id,
      origin: 'STAFF',
      paymentMethod: 'CASH',
      assignedAt: BEFORE_PERIOD,
      startedDeliveryAt: BEFORE_PERIOD,
      deliveredAt: BEFORE_PERIOD,
    });
    await seedOrder({
      clientId: client._id,
      driverId: driver.id,
      origin: 'STAFF',
      paymentMethod: 'CASH',
      assignedAt: AFTER_PERIOD,
      startedDeliveryAt: AFTER_PERIOD,
      deliveredAt: AFTER_PERIOD,
    });

    const res = await getHistory(driver.token);
    expect(res.status).toBe(200);
    expect(res.body.data.operations).toEqual([]);
    expect(res.body.data.summary.operationCount).toBe(0);
  });

  it('rejects CUSTOM without a range and unauthenticated callers', async () => {
    const driver = await seedDriver('hist-auth@buchardo.gob.ar');

    const noRange = await request(app)
      .get('/api/delivery/me/history')
      .query({ period: 'CUSTOM' })
      .set('Authorization', `Bearer ${driver.token}`);
    expect(noRange.status).toBe(400);

    const noAuth = await request(app).get('/api/delivery/me/history');
    expect(noAuth.status).toBe(401);
  });

  it('downloads the history as xlsx with Resumen and Movimientos sheets', async () => {
    const driver = await seedDriver('hist-xlsx@buchardo.gob.ar');
    const client = await seedClient('HIST-10');

    await seedOrder({
      clientId: client._id,
      driverId: driver.id,
      origin: 'STAFF',
      paymentMethod: 'CASH',
      assignedAt: IN_PERIOD,
      startedDeliveryAt: IN_PERIOD,
      deliveredAt: IN_PERIOD,
    });

    const res = await request(app)
      .get('/api/delivery/me/history.xlsx')
      .query(PERIOD)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
        response.on('error', (err: Error) => callback(err));
      })
      .set('Authorization', `Bearer ${driver.token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toMatch(
      /mis-movimientos-2025-06-10_a_2025-06-15/,
    );

    const wb = XLSX.read(res.body as Buffer, { type: 'buffer' });
    expect(wb.SheetNames).toEqual(['Resumen', 'Movimientos']);

    const rows = XLSX.utils.sheet_to_json<{
      Operación: string;
      Cliente: string;
      'Efectivo (ARS)': number;
    }>(wb.Sheets['Movimientos']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      Operación: 'Nueva entrega',
      Cliente: 'Ana Cliente',
      'Efectivo (ARS)': 30000,
    });
  });
});