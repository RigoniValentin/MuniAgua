/* eslint-disable no-console */
// Smoke test for FASE 5 — Portal Ciudadano.
//
// Exercises the citizen self-service experience end-to-end against an
// in-memory MongoDB:
//   - SUPER_ADMIN
//   - User CIUDADANO (no client link yet)
//   - Client JUBILADO without userId
//   - AGUA_RECARGA product @ $10.000
//   - JUBILADO -50% rule
//   - Ledger: DEBIT $12.000 + CREDIT $4.000 (DEBT $8.000)
//   - Linking
//   - /me self endpoints
//   - Pricing /me/quote (rule changes dynamically)
//   - Unlinking
//   - Idempotency and access safety after unlinking
import { setupTestDb, teardownTestDb } from '../tests/setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import { ROLES, defaultPermissionsForRole } from '../src/modules/users/users.types';
import { signAccessToken } from '../src/modules/auth/auth.tokens';
import { Client } from '../src/modules/clients/clients.model';
import { Product } from '../src/modules/products/products.model';
import { PricingRule } from '../src/modules/pricing/pricing.rules.model';
import { postMovement } from '../src/modules/accounts/accounts.service';
import request from 'supertest';

const baseAddress = { street: 'Av. San Martín', number: '123', locality: 'Buchardo' };

function ars(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

async function login(email: string): Promise<string> {
  const { User } = await import('../src/modules/users/users.model');
  const user = await User.findOne({ email });
  if (!user) throw new Error(`User not found: ${email}`);
  return signAccessToken({
    sub: user._id.toString(),
    role: user.role,
    permissions: defaultPermissionsForRole(user.role),
  });
}

async function main(): Promise<void> {
  await setupTestDb();
  loadEnv();
  const app = createApp();

  console.log('== Smoke test: FASE 5 — Portal Ciudadano ==\n');

  // 1) SUPER_ADMIN
  await createUser({
    firstName: 'Super',
    lastName: 'Admin',
    email: 'admin@buchardo.gob.ar',
    password: 'SuperSecret123',
    role: ROLES.SUPER_ADMIN,
  });
  const adminToken = await login('admin@buchardo.gob.ar');
  console.log('1) SUPER_ADMIN creado');

  // 2) User CIUDADANO
  const citizen = await createUser({
    firstName: 'Juan',
    lastName: 'Pérez',
    email: 'ciudadano@test.local',
    password: 'Password123',
    role: ROLES.CIUDADANO,
  });
  const citizenToken = await login('ciudadano@test.local');
  console.log('2) User CIUDADANO creado (sin cliente vinculado)');

  // 3) Client JUBILADO sin userId
  const client = await Client.create({
    firstName: 'Juan',
    lastName: 'Pérez',
    documentType: 'DNI',
    documentNumber: '12345678',
    phone: '+54 358 4111111',
    email: 'juan@example.com',
    clientType: 'JUBILADO',
    address: { ...baseAddress, street: 'Belgrano', number: '999' },
    notes: 'NOTAS_SECRETAS',
    userId: null,
    active: true,
  });
  console.log(`3) Cliente JUBILADO creado: ${client._id.toString()}`);

  // 4) Producto
  const product = await Product.create({
    code: 'AGUA_RECARGA',
    name: 'Recarga de agua',
    description: null,
    productType: 'WATER_REFILL',
    basePriceMinor: 1_000_000,
    tracksStock: false,
    active: true,
  });
  console.log(`4) Producto AGUA_RECARGA creado: ${product._id.toString()} @ ${ars(product.basePriceMinor)}`);

  // 5) Regla configurable
  const rule = await PricingRule.create({
    name: 'Jubilados -50%',
    clientType: 'JUBILADO',
    scope: 'ALL_PRODUCTS',
    productType: null,
    productId: null,
    adjustmentType: 'PERCENTAGE',
    adjustmentValue: -50,
    priority: 0,
    active: true,
  });
  console.log(`5) Regla JUBILADO -50% creada: ${rule._id.toString()}`);

  // 6) Ledger
  await postMovement({
    clientId: client._id.toString(),
    direction: 'DEBIT',
    amountMinor: 1_200_000,
    movementType: 'MANUAL_ADJUSTMENT',
    description: 'Saldo inicial pendiente',
    createdBy: null,
  });
  await postMovement({
    clientId: client._id.toString(),
    direction: 'CREDIT',
    amountMinor: 400_000,
    movementType: 'MANUAL_ADJUSTMENT',
    description: 'Pago parcial',
    createdBy: null,
  });
  console.log('6) Ledger: DEBIT $12.000 + CREDIT $4.000 → DEBT $8.000');

  // 7) Antes del link: GET /api/clients/me → 404 CLIENT_NOT_LINKED
  let res = await request(app)
    .get('/api/clients/me')
    .set('Authorization', `Bearer ${citizenToken}`);
  console.log(
    `7) /api/clients/me (sin vínculo): ${res.status} ${res.body.error?.code ?? ''}`,
  );
  if (res.status !== 404 || res.body.error?.code !== 'CLIENT_NOT_LINKED') {
    throw new Error('Expected 404 CLIENT_NOT_LINKED before linking');
  }

  // 8) SUPER_ADMIN vincula
  res = await request(app)
    .post(`/api/clients/${client._id.toString()}/citizen-access`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email: 'ciudadano@test.local' });
  console.log(
    `8) Link: ${res.status} linked=${res.body.data?.linked} user=${res.body.data?.access?.user?.email}`,
  );
  if (res.status !== 200 || res.body.data?.linked !== true) {
    throw new Error('Expected 200 with linked=true after link');
  }

  // 9) GET /api/clients/me
  res = await request(app)
    .get('/api/clients/me')
    .set('Authorization', `Bearer ${citizenToken}`);
  console.log(
    `9) /api/clients/me (vinculado): ${res.status} id=${res.body.data?.client?.id}`,
  );
  if (res.status !== 200) {
    throw new Error('Expected 200 after linking');
  }
  if (res.body.data?.client?.notes !== undefined) {
    throw new Error('DTO must NOT include notes');
  }
  if (res.body.data?.client?.userId !== undefined) {
    throw new Error('DTO must NOT include userId');
  }
  if (res.body.data?.client?.createdBy !== undefined) {
    throw new Error('DTO must NOT include createdBy');
  }
  if (res.body.data?.client?.updatedBy !== undefined) {
    throw new Error('DTO must NOT include updatedBy');
  }
  console.log('   DTO excludes notes / userId / createdBy / updatedBy ✓');

  // 10) Resumen de cuenta
  res = await request(app)
    .get('/api/accounts/me/summary')
    .set('Authorization', `Bearer ${citizenToken}`);
  console.log(
    `10) /api/accounts/me/summary: ${res.status} balance=${ars(res.body.data?.account?.balanceMinor ?? 0)} status=${res.body.data?.account?.status}`,
  );
  if (res.status !== 200 || res.body.data?.account?.balanceMinor !== 800_000) {
    throw new Error('Expected DEBT $8.000');
  }

  // 11) Movimientos
  res = await request(app)
    .get('/api/accounts/me/movements?limit=10')
    .set('Authorization', `Bearer ${citizenToken}`);
  console.log(
    `11) /api/accounts/me/movements: ${res.status} count=${res.body.data?.items?.length}`,
  );
  if (res.status !== 200 || res.body.data?.items?.length !== 2) {
    throw new Error('Expected 2 movements');
  }

  // 12) Cotización self-quote (qty=1, regla -50 → $5.000)
  res = await request(app)
    .post('/api/pricing/me/quote')
    .set('Authorization', `Bearer ${citizenToken}`)
    .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });
  console.log(
    `12) /api/pricing/me/quote (-50%): ${res.status} final=${ars(res.body.data?.totals?.finalMinor ?? 0)}`,
  );
  if (res.status !== 200 || res.body.data?.totals?.finalMinor !== 500_000) {
    throw new Error('Expected $5.000 with -50% rule');
  }
  if (res.body.data?.client?.id !== client._id.toString()) {
    throw new Error('Quote client must be the linked client');
  }

  // 13) Cambiar regla a -25
  rule.adjustmentValue = -25;
  await rule.save();
  res = await request(app)
    .post('/api/pricing/me/quote')
    .set('Authorization', `Bearer ${citizenToken}`)
    .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });
  console.log(
    `13) /api/pricing/me/quote (-25%): ${res.status} final=${ars(res.body.data?.totals?.finalMinor ?? 0)}`,
  );
  if (res.status !== 200 || res.body.data?.totals?.finalMinor !== 750_000) {
    throw new Error('Expected $7.500 with -25% rule');
  }

  // 14) PATCH /api/clients/me (campos permitidos)
  res = await request(app)
    .patch('/api/clients/me')
    .set('Authorization', `Bearer ${citizenToken}`)
    .send({
      phone: '+54 358 4222222',
      address: {
        street: 'Belgrano',
        number: '1234',
        floor: '3',
        apartment: 'A',
      },
    });
  console.log(
    `14) PATCH /api/clients/me (permitido): ${res.status} phone=${res.body.data?.client?.phone}`,
  );
  if (res.status !== 200 || res.body.data?.client?.phone !== '+54 358 4222222') {
    throw new Error('PATCH should accept allowed fields');
  }

  // 15) PATCH clientType → 400
  res = await request(app)
    .patch('/api/clients/me')
    .set('Authorization', `Bearer ${citizenToken}`)
    .send({ clientType: 'AYUDA_SOCIAL' });
  console.log(`15) PATCH clientType (prohibido): ${res.status} ${res.body.error?.code}`);
  if (res.status !== 400) {
    throw new Error('clientType must be rejected');
  }

  // 16) PATCH active → 400
  res = await request(app)
    .patch('/api/clients/me')
    .set('Authorization', `Bearer ${citizenToken}`)
    .send({ active: true });
  console.log(`16) PATCH active (prohibido): ${res.status}`);
  if (res.status !== 400) {
    throw new Error('active must be rejected');
  }

  // 17) SUPER_ADMIN desvincula
  res = await request(app)
    .delete(`/api/clients/${client._id.toString()}/citizen-access`)
    .set('Authorization', `Bearer ${adminToken}`);
  console.log(`17) Unlink: ${res.status} linked=${res.body.data?.access?.linked}`);
  if (res.status !== 200 || res.body.data?.access?.linked !== false) {
    throw new Error('Expected unlink to succeed');
  }

  // 18) Después del unlink, /me/summary → 404 CLIENT_NOT_LINKED
  res = await request(app)
    .get('/api/clients/me')
    .set('Authorization', `Bearer ${citizenToken}`);
  console.log(`18) /api/clients/me (post-unlink): ${res.status} ${res.body.error?.code}`);
  if (res.status !== 404 || res.body.error?.code !== 'CLIENT_NOT_LINKED') {
    throw new Error('Expected 404 CLIENT_NOT_LINKED after unlink');
  }

  res = await request(app)
    .get('/api/accounts/me/summary')
    .set('Authorization', `Bearer ${citizenToken}`);
  console.log(`    /api/accounts/me/summary (post-unlink): ${res.status} ${res.body.error?.code}`);
  if (res.status !== 404 || res.body.error?.code !== 'CLIENT_NOT_LINKED') {
    throw new Error('Expected 404 CLIENT_NOT_LINKED on accounts/me/summary after unlink');
  }

  res = await request(app)
    .post('/api/pricing/me/quote')
    .set('Authorization', `Bearer ${citizenToken}`)
    .send({ items: [{ productId: product._id.toString(), quantity: 1 }] });
  console.log(`    /api/pricing/me/quote (post-unlink): ${res.status} ${res.body.error?.code}`);

  // 19) Verificar que Client, User y ledger siguen existiendo
  const stillClient = await Client.findById(client._id);
  const { User } = await import('../src/modules/users/users.model');
  const stillUser = await User.findById(citizen._id);
  const ledgerCount = await (
    await import('../src/modules/accounts/account-movements.model')
  ).AccountMovement.countDocuments({ clientId: client._id });
  console.log(
    `19) Persistencia: clientExists=${Boolean(stillClient)} userExists=${Boolean(stillUser)} ledgerMovements=${ledgerCount}`,
  );
  if (!stillClient || !stillUser || ledgerCount !== 2) {
    throw new Error('Unlink must NOT delete Client / User / ledger');
  }

  console.log('\n✅ Smoke FASE 5 OK');
  await teardownTestDb();
}

main().catch(async (err) => {
  console.error('❌ Smoke FASE 5 failed:', err);
  await teardownTestDb().catch(() => undefined);
  process.exit(1);
});