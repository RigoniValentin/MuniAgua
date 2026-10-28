/* eslint-disable no-console */
// Smoke test for FASE 9 — Ajustes de cuenta corriente hechos por el repartidor.
// Exercises the driver-facing account flow end-to-end against an in-memory MongoDB.
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
import request from 'supertest';

const baseAddress = { street: 'Av. San Martín', number: '123', locality: 'Buchardo' };

function ars(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

async function main(): Promise<void> {
  await setupTestDb();
  loadEnv();
  const app = createApp();

  console.log('== Smoke test: FASE 9 — Ajustes de repartidor en la cta cte ==\n');

  // 1) ADMIN
  const adminUser = await createUser({
    firstName: 'Maribel',
    lastName: 'Admin',
    email: 'admin@buchardo.gob.ar',
    password: 'AdminSecret123',
    role: ROLES.ADMIN,
  });
  const adminToken = signAccessToken({
    sub: adminUser._id.toString(),
    role: adminUser.role,
    permissions: defaultPermissionsForRole(adminUser.role),
  });
  console.log('1) ADMIN creado');

  // 2) REPARTIDOR
  const driver = await createUser({
    firstName: 'Ezequiel',
    lastName: 'Biasini',
    email: 'repartidor@buchardo.gob.ar',
    password: 'Reparto123',
    role: ROLES.REPARTIDOR,
  });
  const driverToken = signAccessToken({
    sub: driver._id.toString(),
    role: driver.role,
    permissions: defaultPermissionsForRole(driver.role),
  });
  console.log('2) REPARTIDOR creado');

  // 3) Cliente
  const cliente = await Client.create({
    firstName: 'Juan',
    lastName: 'Pérez',
    documentType: 'DNI',
    documentNumber: '12345678',
    clientType: 'LOCAL',
    address: baseAddress,
    userId: null,
    active: true,
  });
  console.log(`3) Cliente creado: ${cliente.firstName} ${cliente.lastName}`);

  // 4) El repartidor registra un DEBIT
  console.log('\n4) Repartidor registra DEBIT $2.500 (cobro en el domicilio):');
  let res = await request(app)
    .post(`/api/accounts/driver/${cliente._id.toString()}/adjustments`)
    .set('Authorization', `Bearer ${driverToken}`)
    .send({
      direction: 'DEBIT',
      amountMinor: 250_000,
      description: 'Cobro en el domicilio',
    });
  console.log(`   POST /accounts/driver/:id/adjustments → status=${res.status}`);
  if (res.status !== 201) throw new Error('El repartidor no pudo registrar el ajuste');

  const movement = res.body.data.movement;
  console.log(
    `   movementType=${movement.movementType} sourceType=${movement.sourceType}`,
  );
  console.log(
    `   createdByRole=${movement.createdByRole} createdByName=${movement.createdByName}`,
  );
  if (movement.movementType !== 'DRIVER_ADJUSTMENT') {
    throw new Error('movementType esperado DRIVER_ADJUSTMENT');
  }
  if (movement.sourceType !== 'DRIVER') {
    throw new Error('sourceType esperado DRIVER');
  }
  if (movement.createdByRole !== 'REPARTIDOR') {
    throw new Error('createdByRole esperado REPARTIDOR');
  }
  if (!movement.createdByName) {
    throw new Error('El autor del movimiento debe ser visible para el admin');
  }

  // 5) El saldo refleja el movimiento
  res = await request(app)
    .get(`/api/accounts/${cliente._id.toString()}/summary`)
    .set('Authorization', `Bearer ${adminToken}`);
  console.log(
    `   saldo=${ars(res.body.data.account.balanceMinor)} status=${res.body.data.account.status}`,
  );
  if (res.body.data.account.balanceMinor !== 250_000) {
    throw new Error('El saldo no refleja el ajuste del repartidor');
  }
  if (res.body.data.account.status !== 'DEBT') {
    throw new Error('Estado esperado DEBT');
  }

  // 6) El repartidor NO puede revertir
  console.log('\n6) El repartidor no puede revertir (debe ser 403):');
  res = await request(app)
    .post(`/api/accounts/movements/${movement.id}/reverse`)
    .set('Authorization', `Bearer ${driverToken}`)
    .send({ description: 'me equivoqué' });
  console.log(`   status=${res.status}`);
  if (res.status !== 403) throw new Error('El repartidor no debe poder revertir');

  // 7) El repartidor NO puede usar el flujo de ajuste administrativo
  console.log('\n7) El repartidor no puede usar el ajuste administrativo (debe ser 403):');
  res = await request(app)
    .post(`/api/accounts/${cliente._id.toString()}/adjustments`)
    .set('Authorization', `Bearer ${driverToken}`)
    .send({
      direction: 'DEBIT',
      amountMinor: 100_000,
      description: 'no debería',
    });
  console.log(`   status=${res.status}`);
  if (res.status !== 403) throw new Error('El repartidor no debe poder ajustar por la vía admin');

  // 8) El admin ve el autor y filtra por origen
  console.log('\n8) El admin ve el autor y filtra por origen repartidor:');
  res = await request(app)
    .get(
      `/api/accounts/${cliente._id.toString()}/movements?movementType=DRIVER_ADJUSTMENT`,
    )
    .set('Authorization', `Bearer ${adminToken}`);
  const first = res.body.data.items[0];
  console.log(
    `   total=${res.body.data.pagination.total} autor=${first?.createdByName} rol=${first?.createdByRole}`,
  );
  if (res.body.data.pagination.total !== 1) {
    throw new Error('El filtro por origen debería devolver 1 movimiento');
  }
  if (first?.createdByName !== 'Ezequiel Biasini') {
    throw new Error('El admin debe ver el nombre del repartidor');
  }

  // 9) Idempotencia
  console.log('\n9) Idempotencia del envío del repartidor:');
  const idemKey = `DRIVER:SMOKE:${Date.now()}`;
  const body = {
    direction: 'CREDIT',
    amountMinor: 100_000,
    description: 'Pago recibido en el domicilio',
    idempotencyKey: idemKey,
  };
  const firstRes = await request(app)
    .post(`/api/accounts/driver/${cliente._id.toString()}/adjustments`)
    .set('Authorization', `Bearer ${driverToken}`)
    .send(body);
  const secondRes = await request(app)
    .post(`/api/accounts/driver/${cliente._id.toString()}/adjustments`)
    .set('Authorization', `Bearer ${driverToken}`)
    .send(body);
  console.log(
    `   1ª _id=${firstRes.body.data.movement.id}  2ª _id=${secondRes.body.data.movement.id}`,
  );
  if (firstRes.body.data.movement.id !== secondRes.body.data.movement.id) {
    throw new Error('Idempotencia rota: dos movimientos distintos con la misma key');
  }
  const idemCount = await AccountMovement.countDocuments({ idempotencyKey: idemKey });
  if (idemCount !== 1) throw new Error('Idempotencia rota: más de un movimiento');
  console.log(`   movimientos con esa key=${idemCount} (ok)`);

  // 10) El repartidor lista sus propios ajustes
  console.log('\n10) El repartidor lista sus propios ajustes:');
  res = await request(app)
    .get('/api/accounts/driver/me/movements')
    .set('Authorization', `Bearer ${driverToken}`);
  console.log(`   total=${res.body.data.pagination.total}`);
  for (const m of res.body.data.items) {
    console.log(
      `   ${m.direction.padEnd(6)} | ${m.movementType.padEnd(18)} | ${ars(m.amountMinor).padStart(10)} | ${m.clientName} | ${m.description}`,
    );
  }
  if (res.body.data.pagination.total !== 2) {
    throw new Error('El repartidor debería tener 2 ajustes propios');
  }

  // 11) El admin revierte el ajuste del repartidor
  console.log('\n11) El admin revierte el DEBIT del repartidor:');
  res = await request(app)
    .post(`/api/accounts/movements/${movement.id}/reverse`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ description: 'Ajuste duplicado en el domicilio' });
  console.log(`   status=${res.status}`);
  if (res.status !== 201) throw new Error('La reversión administrativa falló');

  res = await request(app)
    .get(`/api/accounts/${cliente._id.toString()}/summary`)
    .set('Authorization', `Bearer ${adminToken}`);
  console.log(
    `   saldo=${ars(res.body.data.account.balanceMinor)} status=${res.body.data.account.status}`,
  );
  if (res.body.data.account.balanceMinor !== -100_000) {
    throw new Error('Saldo inesperado tras la reversión');
  }

  // 12) El original sigue existiendo (libro inmutable)
  const original = await AccountMovement.findById(movement.id);
  if (!original) throw new Error('El movimiento original no debe eliminarse');
  console.log(
    `   original sigue en el libro: type=${original.movementType} (inmutable)`,
  );

  // 13) Ledger final
  console.log('\n13) Ledger final del cliente:');
  const finalMovs = await request(app)
    .get(`/api/accounts/${cliente._id.toString()}/movements`)
    .set('Authorization', `Bearer ${adminToken}`);
  for (const m of finalMovs.body.data.items) {
    console.log(
      `   ${new Date(m.occurredAt).toISOString()} | ${m.direction.padEnd(6)} | ${m.movementType.padEnd(18)} | ${ars(m.amountMinor).padStart(10)} | ${m.createdByName ?? 'sistema'} | ${m.description}`,
    );
  }

  console.log('\n✅ Smoke FASE 9 (ajustes de repartidor) OK');

  await teardownTestDb();
}

main().catch(async (err) => {
  console.error('\n❌ Smoke test failed:', err);
  await teardownTestDb();
  process.exit(1);
});
