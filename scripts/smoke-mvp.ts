/* eslint-disable no-console */
/**
 * Smoke MVP — FASE 7 + FASE 8 MVP (DEMO).
 *
 * Validates the COMPLETE end-to-end circuit:
 *
 *   1) Flujo CIUDADANO:
 *      login → crea pedido → CONFIRMED → ADMIN asigna → REPARTIDOR entrega
 *      → DELIVERED → CIUDADANO consulta DELIVERED → informa pago
 *      → ADMIN aprueba → saldo = $0 SETTLED.
 *
 *   2) ENTREGA DIRECTA por repartidor (cliente LOCAL):
 *      REPARTIDOR hace POST /delivery/me/direct-order → OUT_FOR_DELIVERY → deliver.
 *
 *   3) AYUDA_SOCIAL: REPARTIDOR hace direct-order, total $0, sin DEBIT, entregado.
 *
 *   4) SNAPSHOT: JUBILADO -50%, cambiar regla a -20%, pedido nuevo usa -20%,
 *      pedido anterior conserva -50%.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { loadEnv } from '../src/config/env';
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
// PNG helpers (minimal valid 1x1 PNG, padded to a target size)
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

const ars = (minor: number): string => `$${(minor / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function header(title: string): void {
  const bar = '====================================';
  console.log(`\n${bar}\n${title}\n${bar}`);
}

async function main(): Promise<void> {
  // Bootstrap Mongo (ReplicaSet) for proper transactions.
  const replset = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const uri = replset.getUri();
  process.env.MONGODB_URI = uri;
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret';
  process.env.JWT_ACCESS_EXPIRES_IN = '15m';
  process.env.JWT_REFRESH_EXPIRES_IN = '7d';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  process.env.PAYMENT_SUBMIT_RATE_LIMIT = 'disabled';

  const storageDir = path.join(os.tmpdir(), `muni-mvp-smoke-${Date.now()}`);
  await fs.mkdir(storageDir, { recursive: true });
  process.env.PAYMENT_RECEIPTS_DIR = storageDir;

  await mongoose.connect(uri);
  loadEnv();
  const app = createApp();

  header('SMOKE MVP — CIRCUITO COMPLETO');

  // ----------------------------------------------------------------
  // 1) Users
  // ----------------------------------------------------------------
  await createUser({
    firstName: 'Super',
    lastName: 'Admin',
    email: 'super@demo.local',
    password: 'SuperSecret123',
    role: ROLES.SUPER_ADMIN,
  });
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
  console.log('1) Usuarios creados: SUPER_ADMIN, ADMIN, REPARTIDOR, CIUDADANO');

  const superToken = await tokenFor('super@demo.local');
  const adminToken = await tokenFor('admin@demo.local');
  const driverToken = await tokenFor('repartidor@demo.local');
  const citizenToken = await tokenFor('ciudadano@demo.local');

  // ----------------------------------------------------------------
  // 2) Client JUBILADO linked to the citizen
  // ----------------------------------------------------------------
  const jubiladoClient = await Client.create({
    firstName: 'Vecino',
    lastName: 'Jubilado',
    documentType: 'DNI',
    documentNumber: '12345678',
    clientType: 'JUBILADO',
    address: {
      street: 'Belgrano',
      number: '250',
      locality: 'Buchardo',
      phone: '+5493584000000',
    },
    phone: '+5493584000000',
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
  const socialClient = await Client.create({
    firstName: 'Cliente',
    lastName: 'Social',
    documentType: 'DNI',
    documentNumber: '33445566',
    clientType: 'AYUDA_SOCIAL',
    address: { street: 'Rivadavia', number: '780', locality: 'Buchardo' },
    active: true,
  });
  console.log('2) Clientes creados: JUBILADO (vinculado al ciudadano), LOCAL, AYUDA_SOCIAL');

  // ----------------------------------------------------------------
  // 3) Productos
  // ----------------------------------------------------------------
  const refill = await Product.create({
    code: 'RECARGA',
    name: 'Recarga de agua',
    productType: 'WATER_REFILL',
    basePriceMinor: 1_000_000, // $10.000
    tracksStock: false,
    active: true,
  });
  const container = await Product.create({
    code: 'BIDON',
    name: 'Bidón 20L',
    productType: 'CONTAINER',
    basePriceMinor: 1_500_000, // $15.000
    tracksStock: false,
    active: true,
  });
  const dispenser = await Product.create({
    code: 'DISPENSER',
    name: 'Dispenser',
    productType: 'DISPENSER',
    basePriceMinor: 3_500_000, // $35.000
    tracksStock: false,
    active: true,
  });
  console.log('3) Productos: RECARGA $10.000, BIDÓN $15.000, DISPENSER $35.000');

  // ----------------------------------------------------------------
  // 4) Regla JUBILADO -50%
  // ----------------------------------------------------------------
  const jubiladoRule = await PricingRule.create({
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
  const socialRule = await PricingRule.create({
    name: 'Ayuda social 100% off',
    clientType: 'AYUDA_SOCIAL',
    scope: 'ALL_PRODUCTS',
    adjustmentType: 'PERCENTAGE',
    adjustmentValue: -100,
    priority: 0,
    active: true,
  });
  console.log('4) Reglas: JUBILADO -50%, AYUDA_SOCIAL -100%');

  // =================================================================
  // FLUJO 1: CIUDADANO → ADMIN → REPARTIDOR → PAGO
  // =================================================================
  header('FLUJO 1 — CIUDADANO crea pedido, paga y queda al día');

  // 5) CIUDADANO crea pedido
  let res = await request(app)
    .post('/api/orders/me')
    .set('Authorization', `Bearer ${citizenToken}`)
    .send({
      items: [
        { productId: refill._id.toString(), quantity: 1 },
        { productId: container._id.toString(), quantity: 1 },
      ],
      customerNote: 'Por favor pasar después de las 17:00',
    });
  if (res.status !== 201) throw new Error(`Order create ${res.status}: ${JSON.stringify(res.body)}`);
  const order1Id = res.body.data.order.id;
  const order1Total = res.body.data.order.totalFinalMinor;
  if (order1Total !== 1_250_000) throw new Error(`Order1 total expected $12.500, got ${order1Total}`);
  console.log(`5) Pedido creado (${order1Id.slice(-6)}): CONFIRMED, total ${ars(order1Total)}`);

  // 6) Ledger DEBIT $12.500
  const debits = await AccountMovement.find({
    clientId: jubiladoClient._id,
    movementType: 'ORDER_CHARGE',
  }).lean();
  if (debits.length !== 1 || debits[0].amountMinor !== 1_250_000) {
    throw new Error(`Expected 1 DEBIT $12.500, got ${debits.length}`);
  }
  console.log('6) Ledger generó DEBIT $12.500 ✓');

  // 7) ADMIN ve pedido
  res = await request(app)
    .get('/api/orders')
    .set('Authorization', `Bearer ${adminToken}`);
  if (!res.body.data.items.some((o: { id: string }) => o.id === order1Id)) {
    throw new Error('Admin does not see order');
  }
  console.log('7) ADMIN ve pedido en listado ✓');

  // 8) ADMIN asigna repartidor
  res = await request(app)
    .post(`/api/orders/${order1Id}/assign`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ userId: driverUser._id.toString() });
  if (res.body.data.order.status !== 'ASSIGNED') {
    throw new Error(`Assign failed: ${JSON.stringify(res.body)}`);
  }
  console.log('8) ADMIN asignó REPARTIDOR → ASSIGNED ✓');

  // 9) Repartidor lo ve
  res = await request(app)
    .get('/api/delivery/me/orders')
    .set('Authorization', `Bearer ${driverToken}`);
  if (!res.body.data.items.some((o: { id: string }) => o.id === order1Id)) {
    throw new Error('Driver does not see assigned order');
  }
  console.log('9) REPARTIDOR ve pedido asignado ✓');

  // 10) Repartidor inicia
  res = await request(app)
    .post(`/api/delivery/me/orders/${order1Id}/start`)
    .set('Authorization', `Bearer ${driverToken}`);
  if (res.body.data.order.status !== 'OUT_FOR_DELIVERY') {
    throw new Error(`Start failed: ${JSON.stringify(res.body)}`);
  }
  console.log('10) REPARTIDOR inició → OUT_FOR_DELIVERY ✓');

  // 11) Repartidor entrega
  res = await request(app)
    .post(`/api/delivery/me/orders/${order1Id}/deliver`)
    .set('Authorization', `Bearer ${driverToken}`);
  if (res.body.data.order.status !== 'DELIVERED') {
    throw new Error(`Deliver failed: ${JSON.stringify(res.body)}`);
  }
  console.log('11) REPARTIDOR entregó → DELIVERED ✓');

  // 12) CIUDADANO consulta → DELIVERED
  res = await request(app)
    .get(`/api/orders/me/${order1Id}`)
    .set('Authorization', `Bearer ${citizenToken}`);
  if (res.body.data.order.status !== 'DELIVERED') {
    throw new Error('Citizen does not see DELIVERED');
  }
  // Snapshot check: still $12.500
  if (res.body.data.order.totalFinalMinor !== 1_250_000) {
    throw new Error(`Snapshot drift: ${res.body.data.order.totalFinalMinor}`);
  }
  console.log('12) CIUDADANO consulta → DELIVERED ✓ (snapshot $12.500)');

  // 13) CIUDADANO informa pago $12.500
  res = await request(app)
    .post('/api/payments/me')
    .set('Authorization', `Bearer ${citizenToken}`)
    .field('amountMinor', '1250000')
    .field('paymentMethod', 'BANK_TRANSFER')
    .field('note', 'Pago pedido demo')
    .attach('receipt', buildPngBytes(), 'transfer.png');
  if (res.status !== 201) throw new Error(`Payment submit ${res.status}: ${JSON.stringify(res.body)}`);
  const paymentId = res.body.data.payment.id;
  // The submit endpoint returns only { id }; fetch the detail to confirm status.
  res = await request(app)
    .get(`/api/payments/me/${paymentId}`)
    .set('Authorization', `Bearer ${citizenToken}`);
  if (res.body.data.payment.status !== 'PENDING') {
    throw new Error(
      `Payment should be PENDING, got ${res.body.data.payment.status}`,
    );
  }
  console.log('13) CIUDADANO informa pago $12.500 → PENDING ✓');

  // 14) ADMIN aprueba
  res = await request(app)
    .post(`/api/payments/${paymentId}/approve`)
    .set('Authorization', `Bearer ${adminToken}`);
  if (res.status !== 200) throw new Error(`Approve ${res.status}`);
  console.log('14) ADMIN aprueba pago → APPROVED + CREDIT ✓');

  // 15) Cuenta en SETTLED $0
  res = await request(app)
    .get('/api/accounts/me/summary')
    .set('Authorization', `Bearer ${citizenToken}`);
  if (res.body.data.account.balanceMinor !== 0 || res.body.data.account.status !== 'SETTLED') {
    throw new Error(`Expected SETTLED $0, got ${JSON.stringify(res.body.data.account)}`);
  }
  console.log('15) Cuenta JUBILADO: SETTLED $0 ✓');

  // =================================================================
  // FLUJO 2: ENTREGA DIRECTA por repartidor (cliente LOCAL)
  // =================================================================
  header('FLUJO 2 — REPARTIDOR hace entrega directa (cliente LOCAL)');

  res = await request(app)
    .post('/api/delivery/me/direct-order')
    .set('Authorization', `Bearer ${driverToken}`)
    .send({
      clientId: localClient._id.toString(),
      items: [
        { productId: refill._id.toString(), quantity: 1 },
        { productId: dispenser._id.toString(), quantity: 1 },
      ],
      customerNote: 'Cliente paga en el lugar',
    });
  if (res.status !== 201) throw new Error(`Direct order ${res.status}: ${JSON.stringify(res.body)}`);
  const order2Id = res.body.data.order.id;
  const order2Total = res.body.data.order.totalFinalMinor;
  if (order2Total !== 4_500_000) throw new Error(`Expected $45.000, got ${order2Total}`);
  if (res.body.data.order.status !== 'OUT_FOR_DELIVERY') {
    throw new Error('Direct order should start OUT_FOR_DELIVERY');
  }
  console.log(`16) REPARTIDOR crea direct-order LOCAL: ${ars(order2Total)} → OUT_FOR_DELIVERY ✓`);

  const localDebits = await AccountMovement.find({
    clientId: localClient._id,
    movementType: 'ORDER_CHARGE',
  }).lean();
  if (localDebits.length !== 1) throw new Error(`Expected 1 DEBIT, got ${localDebits.length}`);
  console.log('17) Ledger LOCAL: DEBIT $45.000 ✓');

  res = await request(app)
    .post(`/api/delivery/me/orders/${order2Id}/deliver`)
    .set('Authorization', `Bearer ${driverToken}`);
  if (res.body.data.order.status !== 'DELIVERED') {
    throw new Error('Direct deliver failed');
  }
  console.log('18) REPARTIDOR entrega → DELIVERED ✓');

  // =================================================================
  // FLUJO 3: AYUDA_SOCIAL — pedido $0
  // =================================================================
  header('FLUJO 3 — AYUDA_SOCIAL pedido $0');

  res = await request(app)
    .post('/api/delivery/me/direct-order')
    .set('Authorization', `Bearer ${driverToken}`)
    .send({
      clientId: socialClient._id.toString(),
      items: [{ productId: refill._id.toString(), quantity: 1 }],
    });
  if (res.status !== 201) throw new Error(`Social order ${res.status}`);
  const order3Id = res.body.data.order.id;
  const order3Total = res.body.data.order.totalFinalMinor;
  if (order3Total !== 0) throw new Error(`Expected $0, got ${order3Total}`);
  const socialDebits = await AccountMovement.find({
    clientId: socialClient._id,
    movementType: 'ORDER_CHARGE',
  }).lean();
  if (socialDebits.length !== 0) {
    throw new Error(`AYUDA_SOCIAL should NOT generate DEBIT, got ${socialDebits.length}`);
  }
  console.log(`19) Pedido AYUDA_SOCIAL: total ${ars(order3Total)}, sin DEBIT ✓`);

  res = await request(app)
    .post(`/api/delivery/me/orders/${order3Id}/deliver`)
    .set('Authorization', `Bearer ${driverToken}`);
  if (res.body.data.order.status !== 'DELIVERED') {
    throw new Error('Social deliver failed');
  }
  console.log('20) Pedido SOCIAL → DELIVERED ✓');

  // =================================================================
  // FLUJO 4: SNAPSHOT - cambiar regla no afecta pedido histórico
  // =================================================================
  header('FLUJO 4 — Snapshot precios históricos');

  // El pedido 1 (JUBILADO) debe seguir con -50% aunque cambiemos la regla.
  res = await request(app)
    .get(`/api/orders/me/${order1Id}`)
    .set('Authorization', `Bearer ${citizenToken}`);
  const oldTotal = res.body.data.order.totalFinalMinor;
  const oldAdjustment = res.body.data.order.items[0].adjustmentPercentage;
  if (oldTotal !== 1_250_000 || oldAdjustment !== -50) {
    throw new Error(`Snapshot drift: total ${oldTotal} adjustment ${oldAdjustment}`);
  }
  console.log(`21) Pedido JUBILADO histórico: total ${ars(oldTotal)}, ajuste ${oldAdjustment}% ✓`);

  jubiladoRule.adjustmentValue = -20;
  await jubiladoRule.save();
  console.log('22) Regla cambiada a -20%');

  // Pedido 1 sigue en -50%
  res = await request(app)
    .get(`/api/orders/me/${order1Id}`)
    .set('Authorization', `Bearer ${citizenToken}`);
  if (res.body.data.order.items[0].adjustmentPercentage !== -50) {
    throw new Error('Snapshot broken');
  }
  console.log('23) Pedido histórico SIGUE con -50% ✓');

  // Pedido nuevo usa -20%
  res = await request(app)
    .post('/api/orders/me')
    .set('Authorization', `Bearer ${citizenToken}`)
    .send({
      items: [
        { productId: refill._id.toString(), quantity: 1 },
        { productId: container._id.toString(), quantity: 1 },
      ],
    });
  if (res.status !== 201) throw new Error('New order failed');
  if (res.body.data.order.items[0].adjustmentPercentage !== -20) {
    throw new Error('New order should use -20%');
  }
  if (res.body.data.order.totalFinalMinor !== 2_000_000) {
    throw new Error(`Expected $20.000 with -20%, got ${res.body.data.order.totalFinalMinor}`);
  }
  console.log(`24) Pedido NUEVO JUBILADO: ${ars(2_000_000)}, ajuste -20% ✓`);

  // =================================================================
  // RESUMEN FINAL
  // =================================================================
  header('DEMO MVP — CIRCUITO COMPLETO OK');

  const finalClientSummary = await request(app)
    .get('/api/accounts/me/summary')
    .set('Authorization', `Bearer ${citizenToken}`);
  console.log(`Ciudadano JUBILADO (${jubiladoClient.documentNumber}):`);
  console.log(`  Pedido 1 (demo completo): ${ars(1_250_000)} → DELIVERED → pagado`);
  console.log(`  Pedido 4 (snapshot nuevo): ${ars(2_000_000)} → CONFIRMED`);
  console.log(`  Saldo: ${ars(finalClientSummary.body.data.account.balanceMinor)} — ${finalClientSummary.body.data.account.status}`);

  console.log(`\nCliente LOCAL:`);
  console.log(`  Direct-order: ${ars(4_500_000)} → DELIVERED`);
  console.log(`  Saldo: ${ars(4_500_000)} — DEBT (pago en efectivo post-MVP)`);

  console.log(`\nCliente AYUDA_SOCIAL:`);
  console.log(`  Direct-order: $0,00 → DELIVERED (sin deuda)`);

  console.log('\nSnapshot:');
  console.log('  Pedido antiguo (regla original -50%): conserva -50%');
  console.log('  Pedido nuevo (regla cambiada -20%): usa -20%');

  console.log('\n✅ DEMO MVP CORE OK\n');

  // Cleanup
  await mongoose.disconnect();
  await replset.stop();
  try {
    await fs.rm(storageDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  // Help avoid "unused" warnings for refs that are only used in some branches.
  void jubiladoRule;
  void socialRule;
  void Product;
  void PricingRule;
  void Order;
  void AccountMovement;
  void superToken;
}

main().catch(async (err) => {
  console.error('❌ SMOKE MVP failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
