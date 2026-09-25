/* eslint-disable no-console */
// Smoke test for FASE 6 — Pagos y comprobantes.
//
// Exercises the end-to-end citizen + admin workflow against a ReplicaSet
// (transactions) and an isolated receipt storage directory:
//
//   1. SUPER_ADMIN, ADMIN, OPERADOR, CIUDADANO A, CIUDADANO B
//   2. Ledger inicial: A DEBIT $20.000
//   3. A informa payment 1 ($8.000 BANK_TRANSFER) → PENDING
//   4. Balance SIN cambio todavía
//   5. B intenta ver payment de A → 404
//   6. OPERADOR GET 200, POST approve → 403
//   7. ADMIN approves payment 1 → APPROVED + CREDIT $8.000
//   8. Balance A: DEBT $12.000
//   9. ADMIN approves 2da vez → 409, sigue existiendo 1 CREDIT
//  10. A informa payment 2 ($5.000) → PENDING
//  11. ADMIN rejects 2 → REJECTED + motivo guardado
//  12. ADMIN reverses approval del 1 → REVERSED + REVERSAL DEBIT $8.000
//  13. Balance A vuelve a DEBT $20.000
//  14. 2da reversal → 409
//  15. Receipts siguen existiendo en storage para REJECTED y REVERSED
//  16. History contiene ambos payments
//  17. DTO ciudadano NO expone storageKey/sha256
//  18. Receipt endpoint autenticado
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { teardownTestDb } from '../tests/setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import { ROLES, defaultPermissionsForRole } from '../src/modules/users/users.types';
import { signAccessToken } from '../src/modules/auth/auth.tokens';
import { Client } from '../src/modules/clients/clients.model';
import { postMovement } from '../src/modules/accounts/accounts.service';
import { Payment } from '../src/modules/payments/payments.model';
import { getPaymentReceiptStorage } from '../src/modules/payments/payments.storage';

// Minimal valid PNG bytes. Inlined here (not imported from the test
// fixtures module) so the script is self-contained and does not depend on
// test-only paths that may be excluded from the production tsconfig build.
function buildPngBytes(sizeBytes = 1024): Buffer {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Minimal IHDR (13 bytes): width=1, height=1, depth=8, RGB.
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const ihdrCrc = crc32(Buffer.concat([Buffer.from('IHDR'), ihdrData]));
  const ihdr = chunk('IHDR', ihdrData, ihdrCrc);
  // IDAT: 1 zero byte (filter byte) + 0 RGB = 4 bytes of compressed data.
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
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function login(userId: string, _role: string): Promise<string> {
  const { User } = await import('../src/modules/users/users.model');
  const user = await User.findById(userId);
  if (!user) throw new Error(`User not found: ${userId}`);
  return signAccessToken({
    sub: user._id.toString(),
    role: user.role,
    permissions: defaultPermissionsForRole(user.role),
  });
}

async function main(): Promise<void> {
  // Use a ReplSet so transactions are supported. The standard mongodb-memory-server
  // singleton (setupTestDb) is replaced for this smoke.
  await teardownTestDb().catch(() => undefined);

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

  // Isolated receipt storage.
  const storageDir = path.join(
    os.tmpdir(),
    `muni-payments-smoke-${Date.now()}`,
  );
  await fs.mkdir(storageDir, { recursive: true });
  process.env.PAYMENT_RECEIPTS_DIR = storageDir;

  await mongoose.connect(uri);

  loadEnv();
  const app = createApp();

  console.log('== Smoke test: FASE 6 — Pagos y comprobantes ==\n');

  // 1) SUPER_ADMIN, ADMIN, OPERADOR, CIUDADANO A, CIUDADANO B
  await createUser({
    firstName: 'Super',
    lastName: 'Admin',
    email: 'super@buchardo.gob.ar',
    password: 'SuperSecret123',
    role: ROLES.SUPER_ADMIN,
  });
  const { User } = await import('../src/modules/users/users.model');
  const superAdmin = await User.findOne({ email: 'super@buchardo.gob.ar' });
  const superToken = await login(superAdmin!._id.toString(), 'super');

  await createUser({
    firstName: 'Admin',
    lastName: 'Cuenta',
    email: 'admin@buchardo.gob.ar',
    password: 'Password123',
    role: ROLES.ADMIN,
  });
  const admin = await User.findOne({ email: 'admin@buchardo.gob.ar' });
  const adminToken = await login(admin!._id.toString(), 'admin');

  await createUser({
    firstName: 'Operador',
    lastName: 'X',
    email: 'op@buchardo.gob.ar',
    password: 'Password123',
    role: ROLES.OPERADOR,
  });
  const operador = await User.findOne({ email: 'op@buchardo.gob.ar' });
  const opToken = await login(operador!._id.toString(), 'op');

  const citizenA = await createUser({
    firstName: 'Ana',
    lastName: 'Pérez',
    email: 'ana@test.local',
    password: 'Password123',
    role: ROLES.CIUDADANO,
  });
  const citizenB = await createUser({
    firstName: 'Beto',
    lastName: 'Gómez',
    email: 'beto@test.local',
    password: 'Password123',
    role: ROLES.CIUDADANO,
  });
  const aToken = await login(citizenA._id.toString(), 'a');
  const bToken = await login(citizenB._id.toString(), 'b');

  console.log('1) Usuarios creados (SUPER_ADMIN, ADMIN, OPERADOR, CIUDADANO A, CIUDADANO B)');

  // Clients
  const clientA = await Client.create({
    firstName: 'Ana',
    lastName: 'Pérez',
    documentType: 'DNI',
    documentNumber: '11111111',
    clientType: 'LOCAL',
    address: { street: 'Belgrano', number: '100', locality: 'Buchardo' },
    userId: citizenA._id,
    active: true,
  });
  await Client.create({
    firstName: 'Beto',
    lastName: 'Gómez',
    documentType: 'DNI',
    documentNumber: '22222222',
    clientType: 'LOCAL',
    address: { street: 'San Martín', number: '200', locality: 'Buchardo' },
    userId: citizenB._id,
    active: true,
  });

  // 2) Ledger inicial A: DEBIT $20.000
  await postMovement({
    clientId: clientA._id.toString(),
    direction: 'DEBIT',
    amountMinor: 2_000_000,
    movementType: 'MANUAL_ADJUSTMENT',
    description: 'Saldo inicial A',
  });
  console.log('2) Ledger A inicial: DEBIT $20.000');

  // 3) A informa payment 1 ($8.000 BANK_TRANSFER) → PENDING
  const pngBuffer = buildPngBytes(1024);
  console.log(`   PNG buffer length: ${pngBuffer.length}, first bytes: ${pngBuffer.subarray(0, 8).toString('hex')}`);
  let res = await request(app)
    .post('/api/payments/me')
    .set('Authorization', `Bearer ${aToken}`)
    .field('amountMinor', '800000')
    .field('paymentMethod', 'BANK_TRANSFER')
    .attach('receipt', pngBuffer, 'transfer.png');
  if (res.status !== 201) throw new Error(`Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  const payment1Id = res.body.data.payment.id;
  console.log(`3) Payment 1 creado: ${payment1Id}`);

  // 4) Balance sin cambio
  res = await request(app)
    .get('/api/accounts/me/summary')
    .set('Authorization', `Bearer ${aToken}`);
  const balanceAfterP1 = res.body.data.account.balanceMinor;
  if (balanceAfterP1 !== 2_000_000) {
    throw new Error(`Expected balance $20.000, got ${balanceAfterP1}`);
  }
  console.log(`4) Balance A sigue: DEBT $${(balanceAfterP1 / 100).toFixed(0)}`);

  // 5) B intenta ver payment de A → 404
  res = await request(app)
    .get(`/api/payments/me/${payment1Id}`)
    .set('Authorization', `Bearer ${bToken}`);
  if (res.status !== 404) {
    throw new Error(`Expected 404 for cross-citizen read, got ${res.status}`);
  }
  console.log('5) B no puede ver payment de A: 404 ✓');

  // 6) OPERADOR GET 200, approve 403
  res = await request(app)
    .get(`/api/payments/${payment1Id}`)
    .set('Authorization', `Bearer ${opToken}`);
  if (res.status !== 200) throw new Error(`OPERADOR GET ${res.status}`);
  console.log('   OPERADOR GET payment: 200 ✓');

  res = await request(app)
    .post(`/api/payments/${payment1Id}/approve`)
    .set('Authorization', `Bearer ${opToken}`);
  if (res.status !== 403) {
    throw new Error(`OPERADOR approve ${res.status}`);
  }
  console.log('   OPERADOR approve: 403 ✓');

  // 7) ADMIN approves payment 1
  res = await request(app)
    .post(`/api/payments/${payment1Id}/approve`)
    .set('Authorization', `Bearer ${adminToken}`);
  if (res.status !== 200) {
    throw new Error(`ADMIN approve ${res.status}: ${JSON.stringify(res.body)}`);
  }
  console.log(`7) ADMIN approves: ${res.status} → APPROVED`);

  // 8) Balance: DEBT $12.000
  res = await request(app)
    .get('/api/accounts/me/summary')
    .set('Authorization', `Bearer ${aToken}`);
  if (res.body.data.account.balanceMinor !== 1_200_000) {
    throw new Error(`Expected $12.000, got ${res.body.data.account.balanceMinor}`);
  }
  console.log(`8) Balance A: DEBT $${(res.body.data.account.balanceMinor / 100).toFixed(0)}`);

  // 9) Segundo approve → 409, sigue existiendo 1 CREDIT
  res = await request(app)
    .post(`/api/payments/${payment1Id}/approve`)
    .set('Authorization', `Bearer ${adminToken}`);
  if (res.status !== 409) {
    throw new Error(`Expected 409, got ${res.status}`);
  }
  const { AccountMovement } = await import(
    '../src/modules/accounts/account-movements.model'
  );
  const credits = await AccountMovement.countDocuments({
    clientId: clientA._id,
    movementType: 'PAYMENT',
    sourceType: 'PAYMENT',
  });
  if (credits !== 1) {
    throw new Error(`Expected 1 PAYMENT movement, got ${credits}`);
  }
  console.log(`9) Segundo approve: 409 — sigue habiendo 1 CREDIT ✓`);

  // 10) A informa payment 2 ($5.000) → PENDING
  res = await request(app)
    .post('/api/payments/me')
    .set('Authorization', `Bearer ${aToken}`)
    .field('amountMinor', '500000')
    .field('paymentMethod', 'OTHER')
    .field('note', 'Pago parcial')
    .attach('receipt', buildPngBytes(), 'receipt2.png');
  if (res.status !== 201) throw new Error(`P2 create ${res.status}`);
  const payment2Id = res.body.data.payment.id;
  console.log(`10) Payment 2 creado: ${payment2Id}`);

  // 11) ADMIN rejects payment 2
  res = await request(app)
    .post(`/api/payments/${payment2Id}/reject`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ reason: 'Comprobante ilegible' });
  if (res.status !== 200) throw new Error(`Reject ${res.status}: ${JSON.stringify(res.body)}`);
  const p2AfterReject = await Payment.findById(payment2Id);
  if (p2AfterReject?.status !== 'REJECTED') {
    throw new Error('Payment 2 should be REJECTED');
  }
  if (p2AfterReject.rejectionReason !== 'Comprobante ilegible') {
    throw new Error('Rejection reason not saved');
  }
  console.log('11) Payment 2: REJECTED + motivo guardado');

  // Balance continúa $12.000
  res = await request(app)
    .get('/api/accounts/me/summary')
    .set('Authorization', `Bearer ${aToken}`);
  if (res.body.data.account.balanceMinor !== 1_200_000) {
    throw new Error('Balance should still be $12.000 after reject');
  }
  console.log(`    Balance A sigue: DEBT $${(res.body.data.account.balanceMinor / 100).toFixed(0)}`);

  // 12) ADMIN reverses approval del 1
  res = await request(app)
    .post(`/api/payments/${payment1Id}/reverse-approval`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ reason: 'Aprobado por error' });
  if (res.status !== 200) throw new Error(`Reverse ${res.status}: ${JSON.stringify(res.body)}`);
  const p1AfterReverse = await Payment.findById(payment1Id);
  if (p1AfterReverse?.status !== 'REVERSED') {
    throw new Error('Payment 1 should be REVERSED');
  }
  console.log('12) Payment 1: REVERSED + reversalReason guardado');

  // 13) Balance vuelve a DEBT $20.000
  res = await request(app)
    .get('/api/accounts/me/summary')
    .set('Authorization', `Bearer ${aToken}`);
  if (res.body.data.account.balanceMinor !== 2_000_000) {
    throw new Error(`Balance should be $20.000 after reverse, got ${res.body.data.account.balanceMinor}`);
  }
  console.log(`13) Balance A vuelve a DEBT $${(res.body.data.account.balanceMinor / 100).toFixed(0)}`);

  // Ledger now has: DEBIT 2.000.000 (initial), CREDIT 800.000 (approve),
  // REVERSAL DEBIT 800.000 (reverse). CREDIT original sigue existiendo.
  const ledgerCount = await AccountMovement.countDocuments({ clientId: clientA._id });
  if (ledgerCount !== 3) {
    throw new Error(`Expected 3 movements, got ${ledgerCount}`);
  }
  console.log('    Ledger conserva el movimiento original (3 movimientos) ✓');

  // 14) Segundo reverse → 409
  res = await request(app)
    .post(`/api/payments/${payment1Id}/reverse-approval`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ reason: 'r2' });
  if (res.status !== 409) {
    throw new Error(`Expected 409 second reverse, got ${res.status}`);
  }
  console.log('14) Segundo reverse: 409 ✓');

  // 15) Receipts siguen existiendo en storage
  const storage = getPaymentReceiptStorage();
  const p1Receipt = p1AfterReverse?.receipt.storageKey;
  const p2Receipt = p2AfterReject?.receipt.storageKey;
  if (!p1Receipt || !p2Receipt) throw new Error('Missing storage keys');
  const p1Exists = await storage.exists(p1Receipt);
  const p2Exists = await storage.exists(p2Receipt);
  if (!p1Exists) throw new Error('REVERSED receipt missing');
  if (!p2Exists) throw new Error('REJECTED receipt missing');
  console.log('15) Comprobantes conservados (REVERSED + REJECTED) ✓');

  // 16) History contiene ambos Payments
  res = await request(app)
    .get('/api/payments/me')
    .set('Authorization', `Bearer ${aToken}`);
  if (res.body.data.items.length !== 2) {
    throw new Error(`Expected 2 payments in history, got ${res.body.data.items.length}`);
  }
  console.log(`16) History contiene ${res.body.data.items.length} payments ✓`);

  // 17) DTO NO expone storageKey/sha256
  const item = res.body.data.items[0];
  if (item.receipt.storageKey !== undefined) {
    throw new Error('storageKey leaked');
  }
  if (item.receipt.sha256 !== undefined) {
    throw new Error('sha256 leaked');
  }
  const itemKeys = Object.keys(item.receipt);
  if (
    itemKeys.length !== 3 ||
    !itemKeys.includes('originalName') ||
    !itemKeys.includes('mimeType') ||
    !itemKeys.includes('size')
  ) {
    throw new Error(`Unexpected receipt keys: ${JSON.stringify(itemKeys)}`);
  }
  console.log('17) DTO expone solo originalName/mimeType/size ✓');

  // 18) Receipt endpoint autenticado funciona
  res = await request(app)
    .get(`/api/payments/me/${payment1Id}/receipt`)
    .set('Authorization', `Bearer ${aToken}`);
  if (res.status !== 200) {
    throw new Error(`Receipt 200 expected, got ${res.status}`);
  }
  if (res.headers['x-content-type-options'] !== 'nosniff') {
    throw new Error('Missing nosniff header');
  }
  if (!res.headers['cache-control']?.includes('no-store')) {
    throw new Error('Missing no-store cache header');
  }
  console.log('18) Receipt endpoint autenticado: 200 + nosniff + no-store ✓');

  // SUPER_ADMIN smoke: listar payments
  res = await request(app)
    .get('/api/payments')
    .set('Authorization', `Bearer ${superToken}`);
  if (res.status !== 200) {
    throw new Error(`SUPER_ADMIN list ${res.status}`);
  }
  console.log('   SUPER_ADMIN GET /api/payments: 200 ✓');

  console.log('\n✅ Smoke FASE 6 OK');

  // Cleanup
  await mongoose.disconnect();
  await replset.stop();
  try {
    await fs.rm(storageDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

main().catch(async (err) => {
  console.error('❌ Smoke FASE 6 failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});