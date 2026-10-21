/**
 * Reports module tests — covers the `/api/reports` endpoints.
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
import { Product } from '../src/modules/products/products.model';
import { Order } from '../src/modules/orders/orders.model';
import { AccountMovement } from '../src/modules/accounts/account-movements.model';

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
  clientType?: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';
  documentNumber?: string;
  zona?: string | null;
} = {}) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Client.create({
    firstName: opts.clientType ?? 'Test',
    lastName: `Client${idx}`,
    documentType: 'DNI',
    documentNumber: opts.documentNumber ?? idx.toString(),
    clientType: opts.clientType ?? 'LOCAL',
    address: { street: 'Av. San Martín', number: '123', locality: 'Buchardo' },
    userId: null,
    active: true,
    zona: opts.zona ?? null,
  });
}

async function seedProduct(opts: {
  code?: string;
  name?: string;
  productType?: 'WATER_REFILL' | 'CONTAINER' | 'DISPENSER' | 'OTHER';
  basePriceMinor?: number;
} = {}) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Product.create({
    code: opts.code ?? `P${idx}`,
    name: opts.name ?? 'Recarga de agua',
    productType: opts.productType ?? 'WATER_REFILL',
    basePriceMinor: opts.basePriceMinor ?? 1_000_000,
    tracksStock: false,
    active: true,
  });
}

async function seedDeliveredOrder(opts: {
  clientId: Types.ObjectId;
  driverId: Types.ObjectId;
  items: Array<{
    productId: Types.ObjectId;
    productCode: string;
    productName: string;
    productType: 'WATER_REFILL' | 'CONTAINER' | 'DISPENSER' | 'OTHER';
    quantity: number;
    subtotalFinalMinor: number;
  }>;
  paymentMethod: 'CASH' | 'ACCOUNT';
  deliveredAt: Date;
  zonaSnapshot?: string | null;
}) {
  const created = await Order.create({
    clientId: opts.clientId,
    origin: 'STAFF',
    status: 'DELIVERED',
    paymentMethod: opts.paymentMethod,
    deliveredAt: opts.deliveredAt,
    assignedTo: opts.driverId,
    assignedAt: opts.deliveredAt,
    startedDeliveryAt: opts.deliveredAt,
    paidAt: opts.deliveredAt,
    createdBy: opts.driverId,
    items: opts.items.map((it) => ({
      productId: it.productId,
      productCode: it.productCode,
      productName: it.productName,
      productType: it.productType,
      quantity: it.quantity,
      unitBasePriceMinor: it.subtotalFinalMinor / it.quantity,
      adjustmentPercentage: 0,
      unitFinalPriceMinor: it.subtotalFinalMinor / it.quantity,
      subtotalBaseMinor: it.subtotalFinalMinor,
      subtotalFinalMinor: it.subtotalFinalMinor,
      appliedRuleId: null,
      appliedRuleName: null,
    })),
    totalBaseMinor: opts.items.reduce(
      (acc, it) => acc + it.subtotalFinalMinor,
      0,
    ),
    totalFinalMinor: opts.items.reduce(
      (acc, it) => acc + it.subtotalFinalMinor,
      0,
    ),
    deliveryAddressSnapshot: {
      street: 'Av. San Martín',
      number: '123',
      locality: 'Buchardo',
    },
    zonaSnapshot: opts.zonaSnapshot ?? null,
  });
  return created;
}

describe('Reports — /admin/informes', () => {
  it('aggregates delivered orders in the period and excludes cancelled', async () => {
    const admin = await seedUser('ADMIN', 'reports-admin@buchardo.gob.ar');
    const driver = await seedUser('REPARTIDOR', 'reports-driver@buchardo.gob.ar');
    const adminToken = await loginAs('reports-admin@buchardo.gob.ar');
    void admin;

    const client = await seedClient({ documentNumber: 'RPT-1' });
    const refill = await seedProduct({
      code: 'RPT-BIDON',
      name: 'Bidón 20L',
      basePriceMinor: 1_500_000,
    });

    const driverId = driver._id;
    expect(driverId).toBeTruthy();

    // Two delivered orders, one cancelled, on three days inside the period.
    const dayInside = new Date('2025-06-10T13:00:00.000Z');
    const dayInside2 = new Date('2025-06-12T13:00:00.000Z');
    const dayOutside = new Date('2025-06-20T13:00:00.000Z');

    await seedDeliveredOrder({
      clientId: client._id,
      driverId: driverId!,
      deliveredAt: dayInside,
      paymentMethod: 'CASH',
      items: [
        {
          productId: refill._id,
          productCode: refill.code,
          productName: refill.name,
          productType: 'WATER_REFILL',
          quantity: 2,
          subtotalFinalMinor: 3_000_000,
        },
      ],
    });

    await seedDeliveredOrder({
      clientId: client._id,
      driverId: driverId!,
      deliveredAt: dayInside2,
      paymentMethod: 'ACCOUNT',
      items: [
        {
          productId: refill._id,
          productCode: refill.code,
          productName: refill.name,
          productType: 'WATER_REFILL',
          quantity: 1,
          subtotalFinalMinor: 1_500_000,
        },
      ],
    });

    // Cancelled — has no deliveredAt; even so, filter requires status DELIVERED.
    await Order.create({
      clientId: client._id,
      origin: 'STAFF',
      status: 'CANCELLED',
      paymentMethod: 'ACCOUNT',
      deliveredAt: null,
      cancelledAt: new Date('2025-06-11T14:00:00.000Z'),
      assignedTo: driverId,
      items: [
        {
          productId: refill._id,
          productCode: refill.code,
          productName: refill.name,
          productType: 'WATER_REFILL',
          quantity: 5,
          unitBasePriceMinor: 1_500_000,
          adjustmentPercentage: 0,
          unitFinalPriceMinor: 1_500_000,
          subtotalBaseMinor: 7_500_000,
          subtotalFinalMinor: 7_500_000,
          appliedRuleId: null,
          appliedRuleName: null,
        },
      ],
      totalBaseMinor: 7_500_000,
      totalFinalMinor: 7_500_000,
      deliveryAddressSnapshot: {
        street: 'Av. San Martín',
        number: '123',
        locality: 'Buchardo',
      },
      createdBy: driverId,
    });

    // Out of range — would push totals if it slipped in.
    await seedDeliveredOrder({
      clientId: client._id,
      driverId: driverId!,
      deliveredAt: dayOutside,
      paymentMethod: 'CASH',
      items: [
        {
          productId: refill._id,
          productCode: refill.code,
          productName: refill.name,
          productType: 'WATER_REFILL',
          quantity: 99,
          subtotalFinalMinor: 9_900_000,
        },
      ],
    });

    const res = await request(app)
      .get('/api/reports/period')
      .query({
        period: 'CUSTOM',
        dateFrom: '2025-06-01',
        dateTo: '2025-06-15',
      })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const report = res.body.data;
    expect(report.totals.deliveredOrdersCount).toBe(2);
    expect(report.totals.grossSalesMinor).toBe(4_500_000);
    expect(report.totals.cashCollectedMinor).toBe(3_000_000);
    expect(report.totals.accountChargedMinor).toBe(1_500_000);
    expect(report.totals.unitsSold).toBe(3);
    expect(report.totals.distinctProducts).toBe(1);
    expect(report.productBreakdown).toHaveLength(1);
    expect(report.productBreakdown[0]).toMatchObject({
      productCode: refill.code,
      totalQuantity: 3,
      totalSubtotalFinalMinor: 4_500_000,
      orderCount: 2,
    });
    expect(report.deliveryBreakdown).toHaveLength(1);
    expect(report.deliveryBreakdown[0]).toMatchObject({
      deliveredOrdersCount: 2,
      unitsDelivered: 3,
      cashCollectedMinor: 3_000_000,
      totalDeliveredMinor: 4_500_000,
    });
    expect(report.orders).toHaveLength(2);
    expect(report.period.filters.driverId).toBeNull();
  });

  it('filtering by driverId only includes that driver\'s rows', async () => {
    const admin = await seedUser('ADMIN', 'reports-admin-b@buchardo.gob.ar');
    const adminToken = await loginAs('reports-admin-b@buchardo.gob.ar');
    const driverA = await seedUser('REPARTIDOR', 'driver-a@buchardo.gob.ar');
    const driverB = await seedUser('REPARTIDOR', 'driver-b@buchardo.gob.ar');
    void admin;
    const client = await seedClient({ documentNumber: 'RPT-DRV' });
    const refill = await seedProduct({ code: 'RPT-DRV-1' });

    const day = new Date('2025-07-10T13:00:00.000Z');

    await seedDeliveredOrder({
      clientId: client._id,
      driverId: driverA._id,
      deliveredAt: day,
      paymentMethod: 'CASH',
      items: [
        {
          productId: refill._id,
          productCode: refill.code,
          productName: refill.name,
          productType: 'WATER_REFILL',
          quantity: 1,
          subtotalFinalMinor: 1_000_000,
        },
      ],
    });

    await seedDeliveredOrder({
      clientId: client._id,
      driverId: driverB._id,
      deliveredAt: day,
      paymentMethod: 'ACCOUNT',
      items: [
        {
          productId: refill._id,
          productCode: refill.code,
          productName: refill.name,
          productType: 'WATER_REFILL',
          quantity: 1,
          subtotalFinalMinor: 2_500_000,
        },
      ],
    });

    const res = await request(app)
      .get('/api/reports/period')
      .query({
        period: 'CUSTOM',
        dateFrom: '2025-07-01',
        dateTo: '2025-07-15',
        driverId: driverA._id.toString(),
      })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const report = res.body.data;
    expect(report.totals.deliveredOrdersCount).toBe(1);
    expect(report.totals.grossSalesMinor).toBe(1_000_000);
    expect(report.deliveryBreakdown[0]).toMatchObject({
      driverName: `${driverA.firstName} ${driverA.lastName}`.trim(),
    });
  });

  it('rejects CUSTOM without dateFrom/dateTo and unauthenticated callers', async () => {
    await seedUser('ADMIN', 'reports-admin-c@buchardo.gob.ar');
    const adminToken = await loginAs('reports-admin-c@buchardo.gob.ar');
    const noRange = await request(app)
      .get('/api/reports/period')
      .query({ period: 'CUSTOM' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(noRange.status).toBe(400);

    const noAuth = await request(app).get('/api/reports/period');
    expect(noAuth.status).toBe(401);
  });

  it('downloads the period as xlsx with the four expected sheets', async () => {
    const admin = await seedUser('ADMIN', 'reports-admin-d@buchardo.gob.ar');
    const adminToken = await loginAs('reports-admin-d@buchardo.gob.ar');
    void admin;
    const { User } = await import('../src/modules/users/users.model');
    const driver = await User.findOne({ email: 'reports-admin-d@buchardo.gob.ar' });
    expect(driver).toBeTruthy();

    const client = await seedClient({ documentNumber: 'RPT-XLS' });
    const refill = await seedProduct({ code: 'RPT-XLS-1' });

    await seedDeliveredOrder({
      clientId: client._id,
      driverId: driver!._id,
      deliveredAt: new Date('2025-08-10T13:00:00.000Z'),
      paymentMethod: 'CASH',
      items: [
        {
          productId: refill._id,
          productCode: refill.code,
          productName: refill.name,
          productType: 'WATER_REFILL',
          quantity: 1,
          subtotalFinalMinor: 1_000_000,
        },
      ],
    });

    const res = await request(app)
      .get('/api/reports/period.xlsx')
      .query({
        period: 'CUSTOM',
        dateFrom: '2025-08-01',
        dateTo: '2025-08-31',
      })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
        response.on('error', (err: Error) => callback(err));
      })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toMatch(/informe-periodo-/);

    const wb = XLSX.read(res.body as Buffer, { type: 'buffer' });
    expect(wb.SheetNames).toEqual(
      expect.arrayContaining([
        'Resumen',
        'Productos',
        'Repartos',
        'Pedidos entregados',
      ]),
    );
    const pedidosSheet = wb.Sheets['Pedidos entregados'];
    const pedidosJson = XLSX.utils.sheet_to_json<{
      Pedido: string;
      'Total (ARS)': number;
    }>(pedidosSheet);
    expect(pedidosJson.length).toBeGreaterThanOrEqual(1);
    const firstRow = pedidosJson[0]!;
    expect(firstRow['Total (ARS)']).toBe(10000);
  });

  it('lists active repartidores for the filter dropdown', async () => {
    await seedUser('ADMIN', 'reports-admin-e@buchardo.gob.ar');
    await seedUser('REPARTIDOR', 'driver-on@buchardo.gob.ar');
    await seedUser('REPARTIDOR', 'driver-off@buchardo.gob.ar');
    // Disable one of them.
    const { User } = await import('../src/modules/users/users.model');
    await User.updateOne(
      { email: 'driver-off@buchardo.gob.ar' },
      { $set: { active: false } },
    );

    const adminToken = await loginAs('reports-admin-e@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/reports/available-drivers')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const drivers = res.body.data.drivers;
    const emails = drivers.map((d: { fullName: string }) => d.fullName);
    expect(emails).toContain('REPARTIDOR Test');
    // Only the active driver should show up.
    expect(drivers.length).toBe(1);
  });

  it('does not double-count cta cte movements (only ORDER.totalFinalMinor)', async () => {
    const admin = await seedUser('ADMIN', 'reports-admin-f@buchardo.gob.ar');
    const adminToken = await loginAs('reports-admin-f@buchardo.gob.ar');
    void admin;
    const { User } = await import('../src/modules/users/users.model');
    const driver = await User.findOne({ email: 'reports-admin-f@buchardo.gob.ar' });
    const client = await seedClient({ documentNumber: 'RPT-NOCASH' });
    const refill = await seedProduct({ code: 'RPT-NOCASH-1' });

    const day = new Date('2025-09-10T13:00:00.000Z');
    await seedDeliveredOrder({
      clientId: client._id,
      driverId: driver!._id,
      deliveredAt: day,
      paymentMethod: 'ACCOUNT',
      items: [
        {
          productId: refill._id,
          productCode: refill.code,
          productName: refill.name,
          productType: 'WATER_REFILL',
          quantity: 1,
          subtotalFinalMinor: 1_000_000,
        },
      ],
    });

    // Add unrelated movements to ensure the report is anchored to orders.
    await AccountMovement.create({
      clientId: client._id,
      direction: 'CREDIT',
      amountMinor: 500_000,
      movementType: 'PAYMENT',
      description: 'Pago',
      occurredAt: day,
      sourceType: 'PAYMENT',
      sourceId: new Types.ObjectId(),
      createdBy: driver!._id,
    });

    const res = await request(app)
      .get('/api/reports/period')
      .query({
        period: 'CUSTOM',
        dateFrom: '2025-09-01',
        dateTo: '2025-09-30',
      })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const report = res.body.data;
    expect(report.totals.grossSalesMinor).toBe(1_000_000);
    expect(report.totals.accountChargedMinor).toBe(1_000_000);
    expect(report.totals.cashCollectedMinor).toBe(0);
  });

  // Quick sanity check: empty period returns zeroed totals.
  it('returns empty totals for a period with no deliveries', async () => {
    const admin = await seedUser('ADMIN', 'reports-admin-g@buchardo.gob.ar');
    const adminToken = await loginAs('reports-admin-g@buchardo.gob.ar');
    void admin;
    const res = await request(app)
      .get('/api/reports/period')
      .query({
        period: 'CUSTOM',
        dateFrom: '2020-01-01',
        dateTo: '2020-01-31',
      })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totals.deliveredOrdersCount).toBe(0);
    expect(res.body.data.totals.grossSalesMinor).toBe(0);
    expect(res.body.data.productBreakdown).toEqual([]);
  });
});
