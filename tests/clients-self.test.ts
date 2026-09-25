import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { setupTestDb, teardownTestDb, clearTestDb } from './setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import { ROLES, defaultPermissionsForRole } from '../src/modules/users/users.types';
import { signAccessToken } from '../src/modules/auth/auth.tokens';
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

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

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

const baseAddress = {
  street: 'Av. San Martín',
  number: '123',
  locality: 'Buchardo',
};

async function seedClient(opts: {
  clientType?: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';
  userId?: mongoose.Types.ObjectId | null;
  active?: boolean;
  firstName?: string;
  lastName?: string;
  documentNumber?: string;
  notes?: string | null;
  email?: string | null;
} = {}) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Client.create({
    firstName: opts.firstName ?? 'Test',
    lastName: opts.lastName ?? `Client${idx}`,
    documentType: 'DNI',
    documentNumber: opts.documentNumber ?? idx.toString(),
    email: opts.email ?? null,
    clientType: opts.clientType ?? 'LOCAL',
    address: baseAddress,
    notes: opts.notes ?? null,
    userId: opts.userId ?? null,
    active: opts.active ?? true,
  });
}

// ===========================================================================
// GET /api/clients/me
// ===========================================================================

describe('GET /api/clients/me', () => {
  it('returns the linked client for an authenticated CIUDADANO', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient({ userId: citizen._id, firstName: 'Ana', lastName: 'Pérez' });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/clients/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.client.id).toBe(client._id.toString());
    expect(res.body.data.client.firstName).toBe('Ana');
    expect(res.body.data.client.fullName).toBe('Ana Pérez');
  });

  it('returns 404 CLIENT_NOT_LINKED for an unlinked CIUDADANO', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/clients/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CLIENT_NOT_LINKED');
    expect(res.body.error.message).toContain('vinculado a un cliente');
  });

  it('returns 403 when role lacks clients.self (REPARTIDOR)', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/clients/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 when role lacks clients.self (ADMIN)', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/clients/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('DTO excludes notes, userId, createdBy, updatedBy, passwordHash', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({
      userId: citizen._id,
      firstName: 'Ana',
      lastName: 'Pérez',
      notes: 'NOTAS_SECRETAS_ADMIN',
    });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/clients/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.client).not.toHaveProperty('notes');
    expect(res.body.data.client).not.toHaveProperty('userId');
    expect(res.body.data.client).not.toHaveProperty('createdBy');
    expect(res.body.data.client).not.toHaveProperty('updatedBy');
    expect(res.body.data.client).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(res.body.data.client)).not.toContain('NOTAS_SECRETAS_ADMIN');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/clients/me');
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// PATCH /api/clients/me
// ===========================================================================

describe('PATCH /api/clients/me', () => {
  it('updates phone and email', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .patch('/api/clients/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '+54 358 4111111', email: 'nuevo@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data.client.phone).toBe('+54 358 4111111');
    expect(res.body.data.client.email).toBe('nuevo@example.com');
  });

  it('updates address sub-fields', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .patch('/api/clients/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: {
          street: 'Belgrano',
          number: '999',
          floor: '2',
          apartment: 'B',
          neighborhood: 'Centro',
          postalCode: 'X5000',
          references: 'Casa azul',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.client.address.street).toBe('Belgrano');
    expect(res.body.data.client.address.number).toBe('999');
    expect(res.body.data.client.address.floor).toBe('2');
    expect(res.body.data.client.address.apartment).toBe('B');
    expect(res.body.data.client.address.neighborhood).toBe('Centro');
    expect(res.body.data.client.address.postalCode).toBe('X5000');
    expect(res.body.data.client.address.references).toBe('Casa azul');
  });

  it('rejects modification of clientType with 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .patch('/api/clients/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ clientType: 'AYUDA_SOCIAL' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects modification of active with 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .patch('/api/clients/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ active: false });

    expect(res.status).toBe(400);
  });

  it('rejects modification of documentNumber with 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .patch('/api/clients/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ documentNumber: '99999999' });

    expect(res.status).toBe(400);
  });

  it('rejects modification of locality with 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .patch('/api/clients/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: {
          street: 'X',
          number: '1',
          locality: 'OtraLocalidad',
        },
      });

    expect(res.status).toBe(400);
  });

  it('rejects modification of userId with 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .patch('/api/clients/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: new mongoose.Types.ObjectId().toString() });

    expect(res.status).toBe(400);
  });

  it('rejects modification of firstName/lastName with 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .patch('/api/clients/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'OtroNombre' });

    expect(res.status).toBe(400);
  });

  it('returns 404 CLIENT_NOT_LINKED for an unlinked CIUDADANO', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .patch('/api/clients/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '+54 358 4111111' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CLIENT_NOT_LINKED');
  });

  it('rejects extra unknown fields with 400 (mass-assignment guard)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedClient({ userId: citizen._id });

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .patch('/api/clients/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'injection attempt' });

    expect(res.status).toBe(400);
  });

  it('REPARTIDOR cannot PATCH /me (403)', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const res = await request(app)
      .patch('/api/clients/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '+54 358 4111111' });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// /me endpoint precedence over /:id
// ===========================================================================

describe('Route precedence — /me is not interpreted as ObjectId', () => {
  it('GET /api/clients/me does not 400 with invalid ObjectId', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/clients/me')
      .set('Authorization', `Bearer ${token}`);
    // Not linked → 404 CLIENT_NOT_LINKED. The important thing is it isn't a
    // 400 about "me" being an invalid ObjectId.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CLIENT_NOT_LINKED');
  });
});

// ===========================================================================
// IDOR
// ===========================================================================

describe('IDOR protection', () => {
  it('CIUDADANO cannot read another citizen\'s client by id', async () => {
    const a = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const b = await seedUser('CIUDADANO', 'other@buchardo.gob.ar');
    await seedClient({ userId: a._id });
    const clientB = await seedClient({ userId: b._id });

    const tokenA = await loginAs('vecino@buchardo.gob.ar');

    // Even if a citizen tries to read a client by ID (only staff endpoint),
    // they lack clients.read → 403.
    const res = await request(app)
      .get(`/api/clients/${clientB._id.toString()}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(403);
  });

  it('CIUDADANO cannot PATCH another citizen\'s client via /:id (403)', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const b = await seedUser('CIUDADANO', 'other@buchardo.gob.ar');
    const clientB = await seedClient({ userId: b._id });

    const tokenA = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .patch(`/api/clients/${clientB._id.toString()}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ phone: '+54 358 4111111' });
    expect(res.status).toBe(403);
  });
});