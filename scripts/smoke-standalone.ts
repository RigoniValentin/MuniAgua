/* eslint-disable no-console */
/**
 * Smoke STANDALONE — verifies the end-to-end circuit against a
 * MongoMemoryServer configured WITHOUT a ReplicaSet. This is the
 * closest simulation of the production deployment for the demo: a
 * vanilla MongoDB standalone server with no `?replicaSet=` flag.
 *
 * Validates:
 *   - Citizen creates Order → DEBIT (fallback path)
 *   - Admin assigns the order
 *   - Driver delivers it
 *   - Citizen submits a Payment (PENDING)
 *   - Admin approves → CREDIT
 *   - Balance becomes SETTLED $0
 *   - Driver direct-order (STAFF origin) → DEBIT + OUT_FOR_DELIVERY
 *
 * Expected output: ✅ STANDALONE MVP OK
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { loadEnv } from '../src/config/env';
import { detectTransactionSupport, supportsTransactions } from '../src/shared/transactions';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import {
  defaultPermissionsForRole,
  ROLES,
} from '../src/modules/users/users.types';
import { signAccessToken } from '../src/modules/auth/auth.tokens';
import { User } from '../src/modules/users/users.model';
import { Client } from '../src/modules/clients/clients.model';
import { Product } from '../src/modules/products/products.model';
import { PricingRule } from '../src/modules/pricing/pricing.rules.model';
import { Order } from '../src/modules/orders/orders.model';
import { AccountMovement } from '../src/modules/accounts/account-movements.model';

// ----------------------------------------------------------------------------
// PNG helper (minimal valid 1x1 PNG)
// ----------------------------------------------------------------------------
function buildPngBytes(sizeBytes = 1024): Buffer {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const ihdrCrc = crc32(Buffer.concat([Buffer.from('IHDR'), ihdrData]));
  const ihdr = chunk('IHDR', ihdrData, ihdrCrc);
  const idatRaw = Buffer.from([0x00, 0x00, 0x00, 0x00]);
  const idatCrc = crc32(Buffer.concat([Buffer.from('IDAT'), idatRaw]));
  const idat = chunk('IDAT', idatRaw, idatCrc);
  const iendCrc = crc32(Buffer.from('IEND'));
  const iend = chunk('IEND', Buffer.alloc(0), iendCrc);
  const core = Buffer.concat([PNG_MAGIC, ihdr, idat, iend]);
  if (core.length >= sizeBytes) return core;
  return Buffer.concat([core, Buffer.alloc(sizeBytes - core.length, 0)]);
}
function chunk(type: string, data: Buffer, crc: number): Buffer {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> (8));
  return (c ^ 0xffffffff) >>> 0;
}

async function tokenFor(email: string): Promise<string> {
  const user = await User.findOne({ email });
  if (!user) throw new Error(`User not found: ${email}`);
  return signAccessToken({
    sub: user._id.toString(),
    role: user.role,
    permissions: defaultPermissionsForRole(user.role),
  });
}

const ars = (minor: number): string =>
  `$${(minor / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function header(title: string): void {
  const bar = '====================================';
  console.log(`\n${bar}\n${title}\n${bar}`);
}

async function main(): Promise<void> {
  header('SMOKE STANDALONE — MongoDB sin ReplicaSet');

  // -------------------------------------------------------------------------
  // Boot a vanilla MongoMemoryServer (NOT a ReplicaSet)
  // -------------------------------------------------------------------------
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  process.env.MONGODB_URI = uri;
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.MONGO_TRANSACTION_MODE = 'auto';
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret';
  process.env.JWT_ACCESS_EXPIRES_IN = '15m';
  process.env.JWT_REFRESH_EXPIRES_IN = '7d';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  process.env.PAYMENT_SUBMIT_RATE_LIMIT = 'disabled';

  const storageDir = path.join(os.tmpdir(), `muni-standalone-smoke-${Date.now()}`);
  await fs.mkdir(storageDir, { recursive: true });
  process.env.PAYMENT_RECEIPTS_DIR = storageDir;

  await mongoose.connect(uri);
  await detectTransactionSupport();

  if (supportsTransactions()) {
    throw new Error(
      'Standalone smoke expected NO transaction support but detection reported true',
    );
  }
  console.log(`MongoDB URI: ${uri}`);
  console.log('Mode: STANDALONE (compensated fallback)');

  loadEnv();
  const app = createApp();

  try {
    // -------------------------------------------------------------------------
    // Users
    // -------------------------------------------------------------------------
    await createUser({
      firstName: 'Admin',
      lastName: 'Demo',
      email: 'admin@demo.local',
      password: 'AdminSecret123',
      role: ROLES.ADMIN,
    });
    const driverUser = await createUser({
      firstName: 'Repartidor',
      lastName: 'Demo',
      email: 'repartidor@demo.local',
      password: 'DriverSecret123',
      role: ROLES.REPARTIDOR,
    });
    const citizenUser = await createUser({
      firstName: 'Vecino',
      lastName: 'Demo',
      email: 'ciudadano@demo.local',
      password: 'CitizenSecret123',
      role: ROLES.CIUDADANO,
    });

    const adminToken = await tokenFor('admin@demo.local');
    const driverToken = await tokenFor('repartidor@demo.local');
    const citizenToken = await tokenFor('ciudadano@demo.local');

    // -------------------------------------------------------------------------
    // Clients + Products + Pricing rules
    // -------------------------------------------------------------------------
    const jubiladoClient = await Client.create({
      firstName: 'Vecino',
      lastName: 'Jubilado',
      documentType: 'DNI',
      documentNumber: '12345678',
      clientType: 'JUBILADO',
      address: { street: 'Belgrano', number: '250', locality: 'Buchardo' },
      userId: citizenUser._id,
      active: true,
    });
    const localClient = await Client.create({
      firstName: 'Cliente',
      lastName: 'Local',
      documentType: 'DNI',
      documentNumber: '22334455',
      clientType: 'LOCAL',
      address: { street: 'San Martín', number: '450', locality: 'Buchardo' },
      active: true,
    });
    const refill = await Product.create({
      code: 'RECARGA',
      name: 'Recarga de agua',
      productType: 'WATER_REFILL',
      basePriceMinor: 1_000_000,
      tracksStock: false,
      active: true,
    });
    const container = await Product.create({
      code: 'BIDON',
      name: 'Bidón 20L',
      productType: 'CONTAINER',
      basePriceMinor: 1_500_000,
      tracksStock: false,
      active: true,
    });
    await PricingRule.create({
      name: 'Jubilados 50% off',
      clientType: 'JUBILADO',
      scope: 'ALL_PRODUCTS',
      productType: null,
      productId: null,
      adjustmentType: 'PERCENTAGE',
      adjustmentValue: -50,
      priority: 0,
      active: true,
    });

    // -------------------------------------------------------------------------
    // FLUJO 1 — CIUDADANO → ADMIN → REPARTIDOR → PAGO
    // -------------------------------------------------------------------------
    header('FLUJO 1 — CIUDADANO crea pedido, paga y queda al día');

    let res = await request(app)
      .post('/api/orders/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({
        items: [
          { productId: refill._id.toString(), quantity: 1 },
          { productId: container._id.toString(), quantity: 1 },
        ],
        customerNote: 'Pasar después de las 17:00',
      });
    if (res.status !== 201) {
      throw new Error(`Order create failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const order1Id = res.body.data.order.id;
    const order1Total = res.body.data.order.totalFinalMinor;
    if (order1Total !== 1_250_000) {
      throw new Error(`Expected total $12.500, got ${order1Total}`);
    }
    console.log(`Pedido creado ${order1Id.slice(-6)}: CONFIRMED ${ars(order1Total)}`);

    const debits = await AccountMovement.find({
      clientId: jubiladoClient._id,
      movementType: 'ORDER_CHARGE',
    }).lean();
    if (debits.length !== 1 || debits[0].amountMinor !== 1_250_000) {
      throw new Error(`Expected 1 DEBIT $12.500, got ${debits.length}`);
    }
    console.log(`Ledger generó DEBIT ${ars(debits[0].amountMinor)} (fallback path)`);

    res = await request(app)
      .post(`/api/orders/${order1Id}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: driverUser._id.toString() });
    if (res.body.data.order.status !== 'ASSIGNED') {
      throw new Error(`Assign failed: ${JSON.stringify(res.body)}`);
    }
    console.log('Admin asignó repartidor → ASSIGNED');

    res = await request(app)
      .post(`/api/delivery/me/orders/${order1Id}/start`)
      .set('Authorization', `Bearer ${driverToken}`);
    if (res.body.data.order.status !== 'OUT_FOR_DELIVERY') {
      throw new Error(`Start failed: ${JSON.stringify(res.body)}`);
    }
    console.log('Repartidor inició → OUT_FOR_DELIVERY');

    res = await request(app)
      .post(`/api/delivery/me/orders/${order1Id}/deliver`)
      .set('Authorization', `Bearer ${driverToken}`);
    if (res.body.data.order.status !== 'DELIVERED') {
      throw new Error(`Deliver failed: ${JSON.stringify(res.body)}`);
    }
    console.log('Repartidor entregó → DELIVERED');

    res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${citizenToken}`)
      .field('amountMinor', '1250000')
      .field('paymentMethod', 'BANK_TRANSFER')
      .field('note', 'Pago pedido demo')
      .attach('receipt', buildPngBytes(), 'transfer.png');
    if (res.status !== 201) {
      throw new Error(`Payment submit failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const paymentId = res.body.data.payment.id;
    res = await request(app)
      .get(`/api/payments/me/${paymentId}`)
      .set('Authorization', `Bearer ${citizenToken}`);
    if (res.body.data.payment.status !== 'PENDING') {
      throw new Error(`Expected PENDING, got ${res.body.data.payment.status}`);
    }
    console.log('Vecino informó pago → PENDING');

    res = await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    if (res.status !== 200) {
      throw new Error(`Approve failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    console.log('Admin aprobó → APPROVED + CREDIT');

    res = await request(app)
      .get('/api/accounts/me/summary')
      .set('Authorization', `Bearer ${citizenToken}`);
    if (res.body.data.account.status !== 'SETTLED') {
      throw new Error(`Expected SETTLED, got ${res.body.data.account.status}`);
    }
    if (res.body.data.account.balanceMinor !== 0) {
      throw new Error(`Expected balance 0, got ${res.body.data.account.balanceMinor}`);
    }
    console.log(`Saldo ${ars(res.body.data.account.balanceMinor)} → SETTLED`);

    // -------------------------------------------------------------------------
    // FLUJO 2 — REPARTIDOR entrega directa (STAFF origin)
    // -------------------------------------------------------------------------
    header('FLUJO 2 — Repartidor entrega directa (direct-order)');

    res = await request(app)
      .post('/api/delivery/me/direct-order')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        clientId: localClient._id.toString(),
        items: [
          { productId: refill._id.toString(), quantity: 2 },
        ],
      });
    if (res.status !== 201) {
      throw new Error(`Direct order failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    if (res.body.data.order.status !== 'OUT_FOR_DELIVERY') {
      throw new Error(`Direct order expected OUT_FOR_DELIVERY, got ${res.body.data.order.status}`);
    }
    if (res.body.data.order.totalFinalMinor !== 2_000_000) {
      throw new Error(`Direct order expected $20.000, got ${res.body.data.order.totalFinalMinor}`);
    }
    console.log(
      `Direct-order creado ${res.body.data.order.id.slice(-6)}: OUT_FOR_DELIVERY ${ars(res.body.data.order.totalFinalMinor)}`,
    );

    const directDebits = await AccountMovement.find({
      clientId: localClient._id,
      movementType: 'ORDER_CHARGE',
    }).lean();
    if (directDebits.length !== 1 || directDebits[0].amountMinor !== 2_000_000) {
      throw new Error(`Direct-order: expected 1 DEBIT $20.000`);
    }
    console.log(`Ledger generó DEBIT ${ars(directDebits[0].amountMinor)}`);

    res = await request(app)
      .post(`/api/delivery/me/orders/${res.body.data.order.id}/deliver`)
      .set('Authorization', `Bearer ${driverToken}`);
    if (res.body.data.order.status !== 'DELIVERED') {
      throw new Error(`Deliver failed: ${JSON.stringify(res.body)}`);
    }
    console.log('Direct-order entregado → DELIVERED');

    // Final sanity: count orders and movements
    const orderCount = await Order.countDocuments({});
    const movementCount = await AccountMovement.countDocuments({});
    console.log(`Totales: ${orderCount} pedidos, ${movementCount} movimientos contables`);

    console.log('\n✅ STANDALONE MVP OK');
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
    try {
      await fs.rm(storageDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    process.exit(0);
  }
}

main().catch(async (err) => {
  console.error('❌ STANDALONE MVP failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
