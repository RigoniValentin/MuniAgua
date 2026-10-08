import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { setupTestDb, teardownTestDb, clearTestDb } from './setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import { ROLES, defaultPermissionsForRole } from '../src/modules/users/users.types';
import { signAccessToken } from '../src/modules/auth/auth.tokens';
import { BankInfo } from '../src/modules/bank-info/bank-info.model';
import { DEFAULT_BANK_INFO } from '../src/modules/bank-info/bank-info.types';

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await setupTestDb();
  loadEnv();
  app = createApp();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearTestDb();
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

describe('GET /api/bank-info', () => {
  it('seeds the BANCOR defaults on first read and returns them', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/bank-info')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.bankInfo).toMatchObject(DEFAULT_BANK_INFO);
    expect(typeof res.body.data.bankInfo.updatedAt).toBe('string');

    const doc = await BankInfo.findById('singleton');
    expect(doc?.bankName).toBe(DEFAULT_BANK_INFO.bankName);
    expect(doc?.cbu).toBe(DEFAULT_BANK_INFO.cbu);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/bank-info');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a role without bank_info.read (e.g. REPARTIDOR)', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/bank-info')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

describe('PUT /api/bank-info', () => {
  it('updates the singleton as ADMIN and records updatedBy', async () => {
    const admin = await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .put('/api/bank-info')
      .set('Authorization', `Bearer ${token}`)
      .send({
        bankName: 'NUEVO BANCO',
        razonSocial: 'Municipalidad de Buchardo',
        cuit: '30999098939',
        cbu: '0200367001000001020347',
        alias: 'aguamuni.nuevo',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.bankInfo).toMatchObject({
      bankName: 'NUEVO BANCO',
      alias: 'aguamuni.nuevo',
    });
    expect(res.body.data.bankInfo.updatedBy).toBe(admin._id.toString());

    const doc = await BankInfo.findById('singleton');
    expect(doc?.bankName).toBe('NUEVO BANCO');
  });

  it('rejects malformed CUIT', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .put('/api/bank-info')
      .set('Authorization', `Bearer ${token}`)
      .send({
        bankName: 'BANCOR',
        razonSocial: 'Municipalidad de Buchardo',
        cuit: '1234',
        cbu: '0200367001000001020347',
        alias: 'aguamuni.bancor',
      });

    expect(res.status).toBe(400);
  });

  it('rejects malformed CBU (not 22 digits)', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .put('/api/bank-info')
      .set('Authorization', `Bearer ${token}`)
      .send({
        bankName: 'BANCOR',
        razonSocial: 'Municipalidad de Buchardo',
        cuit: '30999098939',
        cbu: '12345',
        alias: 'aguamuni.bancor',
      });

    expect(res.status).toBe(400);
  });

  it('returns 403 when called by CIUDADANO', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .put('/api/bank-info')
      .set('Authorization', `Bearer ${token}`)
      .send({
        bankName: 'BANCOR',
        razonSocial: 'Municipalidad de Buchardo',
        cuit: '30999098939',
        cbu: '0200367001000001020347',
        alias: 'aguamuni.bancor',
      });

    expect(res.status).toBe(403);
  });

  it('accepts CBU and CUIT with spaces/dashes and normalizes them', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .put('/api/bank-info')
      .set('Authorization', `Bearer ${token}`)
      .send({
        bankName: 'BANCOR',
        razonSocial: 'Municipalidad de Buchardo',
        cuit: '30-99909893-9',
        cbu: '02003 67001000001020347',
        alias: 'aguamuni.bancor',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.bankInfo.cuit).toBe('30999098939');
    expect(res.body.data.bankInfo.cbu).toBe('0200367001000001020347');
  });
});
