import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { setupTestDb, teardownTestDb, clearTestDb } from './setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { Client } from '../src/modules/clients/clients.model';

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

const baseAddress = {
  street: 'Av. San Martín',
  number: '123',
  locality: 'Buchardo',
};

async function seedClient(opts: {
  documentNumber?: string;
  userId?: null;
  firstName?: string;
  lastName?: string;
} = {}) {
  return Client.create({
    firstName: opts.firstName ?? 'Juan',
    lastName: opts.lastName ?? 'Pérez',
    documentType: 'DNI',
    documentNumber: opts.documentNumber ?? '12345678',
    clientType: 'LOCAL',
    address: baseAddress,
    userId: opts.userId ?? null,
    active: true,
  });
}

describe('POST /api/auth/register — public self-registration', () => {
  it('crea un User CIUDADANO y devuelve tokens', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'Juan',
        lastName: 'Pérez',
        email: 'juan@buchardo.gob.ar',
        password: 'Password123',
        phone: '+5493584000001',
        documentNumber: '12345678',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({
      firstName: 'Juan',
      lastName: 'Pérez',
      email: 'juan@buchardo.gob.ar',
      role: 'CIUDADANO',
      active: true,
    });
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(res.body.data.linked).toBe(false);

    // Refresh cookie set
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(cookies!.some((c: string) => c.includes('muni_rt'))).toBe(true);
  });

  it('rechaza email duplicado con 409', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'A',
        lastName: 'B',
        email: 'dup@buchardo.gob.ar',
        password: 'Password123',
        phone: '+5493584000002',
        documentNumber: '20000001',
      });

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'C',
        lastName: 'D',
        email: 'dup@buchardo.gob.ar',
        password: 'Password123',
        phone: '+5493584000003',
        documentNumber: '20000002',
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rechaza password corta con 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'X',
        lastName: 'Y',
        email: 'x@buchardo.gob.ar',
        password: 'short',
        phone: '+5493584000004',
        documentNumber: '20000003',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('auto-vincula con Client existente si DNI matchea', async () => {
    const client = await seedClient({ documentNumber: '12345678' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'María',
        lastName: 'Gómez',
        email: 'maria@buchardo.gob.ar',
        password: 'Password123',
        phone: '+5493584000006',
        documentNumber: '12.345.678',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.linked).toBe(true);

    const reloaded = await Client.findById(client._id);
    expect(reloaded?.userId?.toString()).toBe(res.body.data.user.id);
  });

  it('NO auto-vincula si el DNI no matchea ningún Client', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'A',
        lastName: 'B',
        email: 'a@buchardo.gob.ar',
        password: 'Password123',
        phone: '+5493584000007',
        documentNumber: '99999999',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.linked).toBe(false);
  });

  it('NO auto-vincula si el Client del DNI ya está vinculado', async () => {
    const { Types } = await import('mongoose');
    const otherUserId = new Types.ObjectId();
    await seedClient({
      documentNumber: '12345678',
      userId: null,
    });
    // Force the userId to be set so it's "already linked"
    await Client.updateOne(
      { documentNumber: '12345678' },
      { $set: { userId: otherUserId } },
    );

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'A',
        lastName: 'B',
        email: 'a@buchardo.gob.ar',
        password: 'Password123',
        phone: '+5493584000008',
        documentNumber: '12345678',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.linked).toBe(false);
  });

  it('rechaza documentNumber duplicado entre Users con 409', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'A',
        lastName: 'B',
        email: 'a@buchardo.gob.ar',
        password: 'Password123',
        documentNumber: '11111111',
        phone: '+5493584000011',
      });

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'C',
        lastName: 'D',
        email: 'c@buchardo.gob.ar',
        password: 'Password123',
        documentNumber: '11111111',
        phone: '+5493584000012',
      });

    expect(res.status).toBe(409);
  });

  it('el User creado puede loguearse inmediatamente', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'A',
        lastName: 'B',
        email: 'login@buchardo.gob.ar',
        password: 'Password123',
        phone: '+5493584000005',
        documentNumber: '20000004',
      });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@buchardo.gob.ar', password: 'Password123' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('login@buchardo.gob.ar');
  });

  // -------------------------------------------------------------------------
  // Auto-link by phone — Excel import scenario (no DNI in padrón).
  // -------------------------------------------------------------------------

  it('auto-vincula con Client existente si el teléfono matchea (sin DNI en padrón)', async () => {
    const client = await Client.create({
      firstName: 'Mario',
      lastName: 'Gómez',
      documentType: null,
      documentNumber: null,
      clientType: 'NO_LOCAL',
      phone: '+5493584001122',
      address: baseAddress,
      userId: null,
      active: true,
    });

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'Mario',
        lastName: 'Gómez',
        email: 'mario@buchardo.gob.ar',
        password: 'Password123',
        phone: '+5493584001122',
        documentNumber: '33445566',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.linked).toBe(true);

    const reloaded = await Client.findById(client._id);
    expect(reloaded?.userId?.toString()).toBe(res.body.data.user.id);
    // Email/DNI synced from User onto Client.
    expect(reloaded?.email).toBe('mario@buchardo.gob.ar');
  });

  it('DNI match tiene prioridad sobre phone match', async () => {
    // Client with both DNI and phone
    const clientByDni = await Client.create({
      firstName: 'Por',
      lastName: 'Dni',
      documentType: 'DNI',
      documentNumber: '11222333',
      clientType: 'NO_LOCAL',
      phone: '+5493584001111',
      address: baseAddress,
      userId: null,
      active: true,
    });
    // Another client with same phone but no DNI
    const clientByPhone = await Client.create({
      firstName: 'Por',
      lastName: 'Telefono',
      documentType: null,
      documentNumber: null,
      clientType: 'NO_LOCAL',
      phone: '+5493584002222',
      address: baseAddress,
      userId: null,
      active: true,
    });

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'Ana',
        lastName: 'Test',
        email: 'ana.priority@buchardo.gob.ar',
        password: 'Password123',
        documentNumber: '11.222.333',
        phone: '+5493584002222',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.linked).toBe(true);

    const reloadedByDni = await Client.findById(clientByDni._id);
    const reloadedByPhone = await Client.findById(clientByPhone._id);
    expect(reloadedByDni?.userId?.toString()).toBe(res.body.data.user.id);
    expect(reloadedByPhone?.userId ?? null).toBeNull();
  });

  it('NO auto-vincula por phone si el Client ya está vinculado', async () => {
    const { Types } = await import('mongoose');
    const otherUserId = new Types.ObjectId();
    const client = await Client.create({
      firstName: 'Pedro',
      lastName: 'Pérez',
      documentType: null,
      documentNumber: null,
      clientType: 'NO_LOCAL',
      phone: '+5493584003333',
      address: baseAddress,
      userId: null,
      active: true,
    });
    await Client.updateOne(
      { _id: client._id },
      { $set: { userId: otherUserId } },
    );

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'Otro',
        lastName: 'Pedro',
        email: 'otro.pedro@buchardo.gob.ar',
        password: 'Password123',
        phone: '+5493584003333',
        documentNumber: '44556677',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.linked).toBe(false);

    const reloaded = await Client.findById(client._id);
    expect(reloaded?.userId?.toString()).toBe(otherUserId.toString());
  });
});
