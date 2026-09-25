import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import request from 'supertest';
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
import { buildPng } from './payment-fixtures';

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

async function seedLinkedClient(userId: mongoose.Types.ObjectId) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Client.create({
    firstName: 'Test',
    lastName: `Client${idx}`,
    documentType: 'DNI',
    documentNumber: idx.toString(),
    clientType: 'LOCAL',
    address: { street: 'Av. San Martín', number: '123', locality: 'Buchardo' },
    userId,
    active: true,
  });
}

async function uploadPayment(
  token: string,
  overrides: { amountMinor?: number; paymentMethod?: string } = {},
) {
  const res = await request(app)
    .post('/api/payments/me')
    .set('Authorization', `Bearer ${token}`)
    .field(
      'amountMinor',
      String(overrides.amountMinor ?? 100_000),
    )
    .field('paymentMethod', overrides.paymentMethod ?? 'BANK_TRANSFER')
    .attach('receipt', buildPng(), 'transfer.png');
  return res;
}

// ===========================================================================
// Privacy / IDOR
// ===========================================================================

describe('Privacy / IDOR', () => {
  it('Ciudadano A puede ver SUS pagos', async () => {
    const a = await seedUser('CIUDADANO', 'a@buchardo.gob.ar');
    await seedLinkedClient(a._id);
    const tokenA = await loginAs('a@buchardo.gob.ar');
    await uploadPayment(tokenA);

    const list = await request(app)
      .get('/api/payments/me')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
  });

  it('Ciudadano B NO ve los pagos de A en /me', async () => {
    const a = await seedUser('CIUDADANO', 'a@buchardo.gob.ar');
    const b = await seedUser('CIUDADANO', 'b@buchardo.gob.ar');
    await seedLinkedClient(a._id);
    await seedLinkedClient(b._id);
    const tokenA = await loginAs('a@buchardo.gob.ar');
    const tokenB = await loginAs('b@buchardo.gob.ar');
    await uploadPayment(tokenA);

    const listA = await request(app)
      .get('/api/payments/me')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(listA.body.data.items).toHaveLength(1);

    const listB = await request(app)
      .get('/api/payments/me')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(listB.body.data.items).toHaveLength(0);
  });

  it('Ciudadano B no puede ver el detalle de un Payment de A', async () => {
    const a = await seedUser('CIUDADANO', 'a@buchardo.gob.ar');
    const b = await seedUser('CIUDADANO', 'b@buchardo.gob.ar');
    await seedLinkedClient(a._id);
    await seedLinkedClient(b._id);
    const tokenA = await loginAs('a@buchardo.gob.ar');
    const tokenB = await loginAs('b@buchardo.gob.ar');

    const created = await uploadPayment(tokenA);
    expect(created.status).toBe(201);
    const paymentId = created.body.data.payment.id;

    // Anti-enumeration: NOT_FOUND (not 403) so existence isn't leaked.
    const get = await request(app)
      .get(`/api/payments/me/${paymentId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(get.status).toBe(404);
    expect(get.body.error.code).toBe('NOT_FOUND');
  });

  it('Ciudadano B no puede descargar el comprobante de A', async () => {
    const a = await seedUser('CIUDADANO', 'a@buchardo.gob.ar');
    const b = await seedUser('CIUDADANO', 'b@buchardo.gob.ar');
    await seedLinkedClient(a._id);
    await seedLinkedClient(b._id);
    const tokenA = await loginAs('a@buchardo.gob.ar');
    const tokenB = await loginAs('b@buchardo.gob.ar');

    const created = await uploadPayment(tokenA);
    const paymentId = created.body.data.payment.id;

    const res = await request(app)
      .get(`/api/payments/me/${paymentId}/receipt`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  it('Ciudadano B no puede adivinar paymentId de A', async () => {
    const b = await seedUser('CIUDADANO', 'b@buchardo.gob.ar');
    await seedLinkedClient(b._id);
    const tokenB = await loginAs('b@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/payments/me/507f1f77bcf86cd799439011')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  it('OPERADOR NO tiene payments.self', async () => {
    await seedUser('OPERADOR', 'op@buchardo.gob.ar');
    const token = await loginAs('op@buchardo.gob.ar');

    const list = await request(app)
      .get('/api/payments/me')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(403);

    const create = await uploadPayment(token);
    expect(create.status).toBe(403);
  });

  it('REPARTIDOR NO tiene payments.self', async () => {
    await seedUser('REPARTIDOR', 'rep@buchardo.gob.ar');
    const token = await loginAs('rep@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/payments/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('Sin autenticación → 401', async () => {
    const res = await request(app).get('/api/payments/me');
    expect(res.status).toBe(401);
  });

  it('RECEIPT endpoint propio funciona con headers correctos', async () => {
    const a = await seedUser('CIUDADANO', 'a@buchardo.gob.ar');
    await seedLinkedClient(a._id);
    const tokenA = await loginAs('a@buchardo.gob.ar');

    const created = await uploadPayment(tokenA);
    const paymentId = created.body.data.payment.id;

    const res = await request(app)
      .get(`/api/payments/me/${paymentId}/receipt`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toMatch(/private.*no-store/);
  });
});