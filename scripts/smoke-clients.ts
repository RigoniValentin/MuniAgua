/* eslint-disable no-console */
import { setupTestDb, teardownTestDb } from '../tests/setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import { ROLES, defaultPermissionsForRole } from '../src/modules/users/users.types';
import { signAccessToken } from '../src/modules/auth/auth.tokens';
import request from 'supertest';

async function main() {
  await setupTestDb();
  loadEnv();
  const app = createApp();

  console.log('== Smoke test: FASE 2 — Clientes ==\n');

  // SUPER_ADMIN
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

  // CIUDADANO
  const ciudadano = await createUser({
    firstName: 'Ana',
    lastName: 'Vecina',
    email: 'vecina@buchardo.gob.ar',
    password: 'Vecina123',
    role: ROLES.CIUDADANO,
  });
  const ciudadanoToken = signAccessToken({
    sub: ciudadano._id.toString(),
    role: ciudadano.role,
    permissions: defaultPermissionsForRole(ciudadano.role),
  });

  // 1) Login (skip — using signed token directly)
  console.log('1) SUPER_ADMIN: crear cliente');
  let res = await request(app)
    .post('/api/clients')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      firstName: 'Juan',
      lastName: 'Pérez',
      documentType: 'DNI',
      documentNumber: '12345678',
      phone: '+54 358 4123456',
      email: 'juan@example.com',
      clientType: 'LOCAL',
      address: {
        street: 'Av. San Martín',
        number: '123',
        locality: 'Buchardo',
      },
    });
  console.log('   status:', res.status, '|', res.body.data?.client?.fullName);
  if (res.status !== 201) throw new Error('create failed');
  const clientId = res.body.data.client.id;

  // 2) Listar
  console.log('2) SUPER_ADMIN: listar cliente');
  res = await request(app).get('/api/clients').set('Authorization', `Bearer ${adminToken}`);
  console.log('   status:', res.status, '| total:', res.body.data.pagination.total);
  if (res.body.data.pagination.total !== 1) throw new Error('list count wrong');

  // 3) Buscar por documento
  console.log('3) SUPER_ADMIN: buscar por documento');
  res = await request(app)
    .get('/api/clients?search=12345678')
    .set('Authorization', `Bearer ${adminToken}`);
  console.log('   status:', res.status, '| found:', res.body.data.items.length);
  if (res.body.data.items.length !== 1) throw new Error('search by doc failed');

  // 4) Editar teléfono
  console.log('4) SUPER_ADMIN: editar teléfono/dirección');
  res = await request(app)
    .patch(`/api/clients/${clientId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ phone: '+54 358 9999999', address: { street: 'Belgrano', number: '999', locality: 'Buchardo' } });
  console.log('   status:', res.status, '| phone:', res.body.data.client.phone);
  if (res.body.data.client.phone !== '+54 358 9999999') throw new Error('phone update failed');

  // 5) Cambiar clientType
  console.log('5) SUPER_ADMIN: cambiar clientType a JUBILADO');
  res = await request(app)
    .patch(`/api/clients/${clientId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ clientType: 'JUBILADO' });
  console.log('   status:', res.status, '| type:', res.body.data.client.clientType);
  if (res.body.data.client.clientType !== 'JUBILADO') throw new Error('type update failed');

  // 6) Desactivar
  console.log('6) SUPER_ADMIN: desactivar cliente');
  res = await request(app)
    .patch(`/api/clients/${clientId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ active: false });
  console.log('   status:', res.status, '| active:', res.body.data.client.active);
  if (res.body.data.client.active !== false) throw new Error('deactivate failed');

  // 7) Filtrar active=false
  console.log('7) SUPER_ADMIN: listar active=false');
  res = await request(app)
    .get('/api/clients?active=false')
    .set('Authorization', `Bearer ${adminToken}`);
  console.log('   status:', res.status, '| total:', res.body.data.pagination.total);
  if (res.body.data.pagination.total !== 1) throw new Error('active=false filter failed');

  // 8) REP can GET
  console.log('8) REPARTIDOR: GET /api/clients permitido');
  res = await request(app).get('/api/clients').set('Authorization', `Bearer ${repartidorToken}`);
  console.log('   status:', res.status);
  if (res.status !== 200) throw new Error('REPARTIDOR GET should be allowed');

  // 9) CIUDADANO cannot GET
  console.log('9) CIUDADANO: GET /api/clientes debe devolver 403');
  res = await request(app).get('/api/clients').set('Authorization', `Bearer ${ciudadanoToken}`);
  console.log('   status:', res.status, '| code:', res.body.error?.code);
  if (res.status !== 403) throw new Error('CIUDADANO GET should be 403');

  console.log('\n✅ Smoke test OK');

  await teardownTestDb();
}

main().catch(async (err) => {
  console.error('\n❌ Smoke test failed:', err.message);
  await teardownTestDb();
  process.exit(1);
});
