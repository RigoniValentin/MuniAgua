/* eslint-disable no-console */
// Smoke test for FASE 4 — Cuenta corriente y ledger de movimientos.
// Exercises the account ledger end-to-end against an in-memory MongoDB.
import { setupTestDb, teardownTestDb } from '../tests/setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import { ROLES, defaultPermissionsForRole } from '../src/modules/users/users.types';
import { signAccessToken } from '../src/modules/auth/auth.tokens';
import { Client } from '../src/modules/clients/clients.model';
import {
  AccountMovement,
} from '../src/modules/accounts/account-movements.model';
import { postMovement } from '../src/modules/accounts/accounts.service';
import request from 'supertest';

const baseAddress = { street: 'Av. San Martín', number: '123', locality: 'Buchardo' };

function ars(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

async function main(): Promise<void> {
  await setupTestDb();
  loadEnv();
  const app = createApp();

  console.log('== Smoke test: FASE 4 — Cuenta corriente + ledger ==\n');

  // 1) SUPER_ADMIN
  await createUser({
    firstName: 'Super',
    lastName: 'Admin',
    email: 'admin@buchardo.gob.ar',
    password: 'SuperSecret123',
    role: ROLES.SUPER_ADMIN,
  });
  const { User } = await import('../src/modules/users/users.model');
  const admin = await User.findOne({ email: 'admin@buchardo.gob.ar' });
  const adminToken = signAccessToken({
    sub: admin!._id.toString(),
    role: admin!.role,
    permissions: defaultPermissionsForRole(admin!.role),
  });
  console.log('1) SUPER_ADMIN creado');

  // REPARTIDOR
  const repartidor = await createUser({
    firstName: 'Juan',
    lastName: 'Reparto',
    email: 'repartidor@buchardo.gob.ar',
    password: 'Reparto123',
    role: ROLES.REPARTIDOR,
  });
  const repartidorToken = signAccessToken({
    sub: repartidor._id.toString(),
    role: repartidor.role,
    permissions: defaultPermissionsForRole(repartidor.role),
  });

  // OPERADOR
  const operador = await createUser({
    firstName: 'Operador',
    lastName: 'Cuenta',
    email: 'operador@buchardo.gob.ar',
    password: 'Operador123',
    role: ROLES.OPERADOR,
  });
  const operadorToken = signAccessToken({
    sub: operador._id.toString(),
    role: operador.role,
    permissions: defaultPermissionsForRole(operador.role),
  });

  // CIUDADANO A linked to ClientA
  const ciudadanoA = await createUser({
    firstName: 'Ana',
    lastName: 'Vecina',
    email: 'vecina@buchardo.gob.ar',
    password: 'Vecina123',
    role: ROLES.CIUDADANO,
  });
  const ciudadanoAToken = signAccessToken({
    sub: ciudadanoA._id.toString(),
    role: ciudadanoA.role,
    permissions: defaultPermissionsForRole(ciudadanoA.role),
  });

  // CIUDADANO B linked to ClientB (for cross-citizen privacy check)
  const ciudadanoB = await createUser({
    firstName: 'Bruno',
    lastName: 'Vecino',
    email: 'vecino@buchardo.gob.ar',
    password: 'Vecino123',
    role: ROLES.CIUDADANO,
  });
  const ciudadanoBToken = signAccessToken({
    sub: ciudadanoB._id.toString(),
    role: ciudadanoB.role,
    permissions: defaultPermissionsForRole(ciudadanoB.role),
  });

  // 2) Crear cliente LOCAL
  const clienteA = await Client.create({
    firstName: 'Juan',
    lastName: 'Pérez',
    documentType: 'DNI',
    documentNumber: '12345678',
    clientType: 'LOCAL',
    address: baseAddress,
    userId: ciudadanoA._id,
    active: true,
  });
  await Client.create({
    firstName: 'Pedro',
    lastName: 'Gómez',
    documentType: 'DNI',
    documentNumber: '87654321',
    clientType: 'LOCAL',
    address: baseAddress,
    userId: ciudadanoB._id,
    active: true,
  });
  console.log(`2) Cliente LOCAL creado: ${clienteA.fullName} (ciudadano A vinculado)`);

  // 3) Verificar cuenta vacía
  console.log('\n3) Verificar cuenta vacía del cliente A:');
  let res = await request(app)
    .get(`/api/accounts/${clienteA._id.toString()}/summary`)
    .set('Authorization', `Bearer ${adminToken}`);
  console.log(
    `   GET /api/accounts/.../summary → status=${res.status} balance=${ars(res.body.data.account.balanceMinor)} status=${res.body.data.account.status}`,
  );
  if (res.body.data.account.status !== 'SETTLED') {
    throw new Error('Cuenta debería iniciar SETTLED');
  }
  if (res.body.data.account.balanceMinor !== 0) {
    throw new Error('Cuenta debería iniciar en $0');
  }

  // 4) DEBIT $10.000
  console.log('\n4) Ajuste manual DEBIT $10.000:');
  res = await request(app)
    .post(`/api/accounts/${clienteA._id.toString()}/adjustments`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      direction: 'DEBIT',
      amountMinor: 1_000_000,
      description: 'Carga inicial por consumo',
    });
  console.log(`   POST .../adjustments → status=${res.status}`);
  if (res.status !== 201) throw new Error('Ajuste DEBIT falló');
  void res;

  res = await request(app)
    .get(`/api/accounts/${clienteA._id.toString()}/summary`)
    .set('Authorization', `Bearer ${adminToken}`);
  console.log(
    `   saldo=${ars(res.body.data.account.balanceMinor)} status=${res.body.data.account.status}`,
  );
  if (res.body.data.account.balanceMinor !== 1_000_000) {
    throw new Error(`Saldo esperado $10.000, fue ${ars(res.body.data.account.balanceMinor)}`);
  }
  if (res.body.data.account.status !== 'DEBT') {
    throw new Error('Estado esperado DEBT');
  }

  // 5) CREDIT $4.000
  console.log('\n5) Ajuste manual CREDIT $4.000:');
  res = await request(app)
    .post(`/api/accounts/${clienteA._id.toString()}/adjustments`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      direction: 'CREDIT',
      amountMinor: 400_000,
      description: 'Pago parcial recibido',
    });
  if (res.status !== 201) throw new Error('Ajuste CREDIT $4.000 falló');

  res = await request(app)
    .get(`/api/accounts/${clienteA._id.toString()}/summary`)
    .set('Authorization', `Bearer ${adminToken}`);
  console.log(
    `   saldo=${ars(res.body.data.account.balanceMinor)} status=${res.body.data.account.status}`,
  );
  if (res.body.data.account.balanceMinor !== 600_000) {
    throw new Error(`Saldo esperado $6.000, fue ${ars(res.body.data.account.balanceMinor)}`);
  }

  // 6) CREDIT $8.000 (pasa a saldo a favor)
  console.log('\n6) Ajuste manual CREDIT $8.000 (ahora saldo a favor):');
  res = await request(app)
    .post(`/api/accounts/${clienteA._id.toString()}/adjustments`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      direction: 'CREDIT',
      amountMinor: 800_000,
      description: 'Pago recibido por adelantado',
    });
  if (res.status !== 201) throw new Error('Ajuste CREDIT $8.000 falló');

  res = await request(app)
    .get(`/api/accounts/${clienteA._id.toString()}/summary`)
    .set('Authorization', `Bearer ${adminToken}`);
  console.log(
    `   saldo=${ars(res.body.data.account.balanceMinor)} status=${res.body.data.account.status}`,
  );
  if (res.body.data.account.balanceMinor !== -200_000) {
    throw new Error(
      `Saldo esperado -$2.000 (a favor), fue ${ars(res.body.data.account.balanceMinor)}`,
    );
  }
  if (res.body.data.account.status !== 'CREDIT') {
    throw new Error('Estado esperado CREDIT (saldo a favor)');
  }

  // 7) Reversión del CREDIT $8.000
  console.log('\n7) Reversión del movimiento CREDIT $8.000:');
  // Buscar el movimiento CREDIT $8.000 en historial
  const movementsRes = await request(app)
    .get(`/api/accounts/${clienteA._id.toString()}/movements`)
    .set('Authorization', `Bearer ${adminToken}`);
  const credit8000 = movementsRes.body.data.items.find(
    (m: { direction: string; amountMinor: number }) =>
      m.direction === 'CREDIT' && m.amountMinor === 800_000,
  );
  if (!credit8000) throw new Error('No encontré el movimiento CREDIT $8.000');

  res = await request(app)
    .post(`/api/accounts/movements/${credit8000.id}/reverse`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ description: 'Reversión de pago erróneo' });
  console.log(`   POST .../reverse → status=${res.status}`);
  if (res.status !== 201) throw new Error('Reversión falló');
  if (res.body.data.reversal.direction !== 'DEBIT') {
    throw new Error('Reversión debería ser DEBIT');
  }
  if (res.body.data.reversal.movementType !== 'REVERSAL') {
    throw new Error('movementType debería ser REVERSAL');
  }

  res = await request(app)
    .get(`/api/accounts/${clienteA._id.toString()}/summary`)
    .set('Authorization', `Bearer ${adminToken}`);
  console.log(
    `   saldo=${ars(res.body.data.account.balanceMinor)} status=${res.body.data.account.status}`,
  );
  if (res.body.data.account.balanceMinor !== 600_000) {
    throw new Error(
      `Saldo esperado $6.000 tras reversión, fue ${ars(res.body.data.account.balanceMinor)}`,
    );
  }

  // 8) Verificar que ambos movimientos existen
  console.log('\n8) Verificar que el original y la reversión existen:');
  const original = await AccountMovement.findById(credit8000.id);
  const reversal = await AccountMovement.findOne({ reversesMovementId: credit8000.id });
  if (!original) throw new Error('Original no existe');
  if (!reversal) throw new Error('Reversal no existe');
  console.log(
    `   original: direction=${original.direction} amount=${ars(original.amountMinor)} type=${original.movementType}`,
  );
  console.log(
    `   reversal: direction=${reversal.direction} amount=${ars(reversal.amountMinor)} type=${reversal.movementType}`,
  );

  // 9) Intentar revertir de nuevo
  console.log('\n9) Segunda reversión debe ser 409 CONFLICT:');
  res = await request(app)
    .post(`/api/accounts/movements/${credit8000.id}/reverse`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ description: 'Intento duplicado' });
  console.log(`   status=${res.status} code=${res.body.error?.code}`);
  if (res.status !== 409) throw new Error('Esperaba 409 CONFLICT');

  // 10) Idempotencia con postMovement
  console.log('\n10) Idempotencia con postMovement:');
  const idemKey = `TEST:SMOKE:${Date.now()}`;
  const m1 = await postMovement({
    clientId: clienteA._id.toString(),
    direction: 'DEBIT',
    amountMinor: 50_000,
    movementType: 'MANUAL_ADJUSTMENT',
    description: 'cargo idempotente',
    sourceType: 'MANUAL',
    idempotencyKey: idemKey,
  });
  const m2 = await postMovement({
    clientId: clienteA._id.toString(),
    direction: 'DEBIT',
    amountMinor: 50_000,
    movementType: 'MANUAL_ADJUSTMENT',
    description: 'cargo idempotente',
    sourceType: 'MANUAL',
    idempotencyKey: idemKey,
  });
  console.log(`   primera llamada _id=${m1._id}`);
  console.log(`   segunda  llamada _id=${m2._id}`);
  if (m1._id.toString() !== m2._id.toString()) {
    throw new Error('Idempotencia rota: dos IDs distintos con misma key');
  }
  const idemCount = await AccountMovement.countDocuments({ idempotencyKey: idemKey });
  console.log(`   movimientos con esa key=${idemCount}`);
  if (idemCount !== 1) throw new Error('Idempotencia rota: más de un movimiento');

  // 11) REPARTIDOR
  console.log('\n11) Permisos REPARTIDOR:');
  res = await request(app)
    .get(`/api/accounts/${clienteA._id.toString()}/summary`)
    .set('Authorization', `Bearer ${repartidorToken}`);
  console.log(`   GET /summary → status=${res.status} (debería 200)`);
  if (res.status !== 200) throw new Error('REPARTIDOR debe poder leer');

  res = await request(app)
    .post(`/api/accounts/${clienteA._id.toString()}/adjustments`)
    .set('Authorization', `Bearer ${repartidorToken}`)
    .send({
      direction: 'DEBIT',
      amountMinor: 100_000,
      description: 'no debería',
    });
  console.log(`   POST /adjustments → status=${res.status} (debería 403)`);
  if (res.status !== 403) throw new Error('REPARTIDOR no debe poder ajustar');

  // 12) OPERADOR
  console.log('\n12) Permisos OPERADOR:');
  res = await request(app)
    .post(`/api/accounts/${clienteA._id.toString()}/adjustments`)
    .set('Authorization', `Bearer ${operadorToken}`)
    .send({
      direction: 'DEBIT',
      amountMinor: 100_000,
      description: 'carga operador',
    });
  console.log(`   POST /adjustments → status=${res.status} (debería 201)`);
  if (res.status !== 201) throw new Error('OPERADOR debe poder ajustar');

  // encontrar un movimiento para intentar revertir
  const movsForRev = await AccountMovement.find({
    clientId: clienteA._id,
    movementType: 'MANUAL_ADJUSTMENT',
  }).limit(1);
  if (movsForRev.length === 0) throw new Error('Sin movimientos para reversión');
  const operatorReversalId = movsForRev[0]!._id.toString();

  res = await request(app)
    .post(`/api/accounts/movements/${operatorReversalId}/reverse`)
    .set('Authorization', `Bearer ${operadorToken}`)
    .send({ description: 'intento operador' });
  console.log(`   POST /reverse → status=${res.status} (debería 403)`);
  if (res.status !== 403) throw new Error('OPERADOR no debe poder revertir');

  // 13) CIUDADANO privacy
  console.log('\n13) Privacidad del ciudadano:');
  // Crear ClientB para ciudadano B (ya existe)
  const allClients = await Client.find({}).sort({ createdAt: 1 });
  const clientB = allClients.find((c) => c._id.toString() !== clienteA._id.toString());
  if (!clientB) throw new Error('No hay client B');

  res = await request(app)
    .get('/api/accounts/me/summary')
    .set('Authorization', `Bearer ${ciudadanoAToken}`);
  console.log(`   A GET /me/summary → status=${res.status} (debería 200)`);
  if (res.status !== 200) throw new Error('Ciudadano A debe poder ver /me/summary');

  res = await request(app)
    .get(`/api/accounts/${clientB._id.toString()}/summary`)
    .set('Authorization', `Bearer ${ciudadanoAToken}`);
  console.log(
    `   A GET /accounts/<B>/summary → status=${res.status} (debería 403)`,
  );
  if (res.status !== 403) throw new Error('A no debe poder ver cuenta de B');

  // ciudadano B
  res = await request(app)
    .get('/api/accounts/me/summary')
    .set('Authorization', `Bearer ${ciudadanoBToken}`);
  console.log(`   B GET /me/summary → status=${res.status} (debería 200)`);
  if (res.status !== 200) throw new Error('B debe poder ver su /me/summary');

  // historial final
  console.log('\n14) Historial final del cliente A:');
  const finalMovs = await request(app)
    .get(`/api/accounts/${clienteA._id.toString()}/movements`)
    .set('Authorization', `Bearer ${adminToken}`);
  for (const m of finalMovs.body.data.items) {
    console.log(
      `   ${new Date(m.occurredAt).toISOString()} | ${m.direction.padEnd(6)} | ${m.movementType.padEnd(18)} | ${ars(m.amountMinor).padStart(10)} | ${m.description}`,
    );
  }

  console.log('\n✅ Smoke FASE 4 OK');

  await teardownTestDb();
}

main().catch(async (err) => {
  console.error('\n❌ Smoke test failed:', err);
  await teardownTestDb();
  process.exit(1);
});
