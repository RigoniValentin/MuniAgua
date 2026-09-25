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

async function seedCiudadanoWithDni(
  email: string,
  documentNumber: string,
  firstName = 'Vecino',
) {
  return createUser({
    firstName,
    lastName: 'Dni',
    email,
    password: 'Password123',
    role: ROLES.CIUDADANO,
    documentNumber,
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

const baseAddress = { street: 'Av. San Martín', number: '123', locality: 'Buchardo' };

async function seedClient(opts: {
  userId?: mongoose.Types.ObjectId | null;
  firstName?: string;
  lastName?: string;
  documentNumber?: string;
} = {}) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Client.create({
    firstName: opts.firstName ?? 'Test',
    lastName: opts.lastName ?? `Client${idx}`,
    documentType: 'DNI',
    documentNumber: opts.documentNumber ?? idx.toString(),
    clientType: 'LOCAL',
    address: baseAddress,
    userId: opts.userId ?? null,
    active: true,
  });
}

// ===========================================================================
// Linking by role
// ===========================================================================

describe('POST /api/clients/:clientId/citizen-access — RBAC', () => {
  it('ADMIN links a CIUDADANO to a Client → 200', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient();

    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ identifier: 'vecino@buchardo.gob.ar' });

    expect(res.status).toBe(200);
    expect(res.body.data.linked).toBe(true);
    expect(res.body.data.access.user.email).toBe('vecino@buchardo.gob.ar');

    const reloaded = await Client.findById(client._id);
    expect(reloaded?.userId?.toString()).toBeDefined();
  });

  it('SUPER_ADMIN links a CIUDADANO to a Client → 200', async () => {
    await seedUser('SUPER_ADMIN', 'super@buchardo.gob.ar');
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient();

    const token = await loginAs('super@buchardo.gob.ar');
    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'vecino@buchardo.gob.ar' });
    expect(res.status).toBe(200);
    expect(res.body.data.linked).toBe(true);
  });

  it('OPERADOR → 403', async () => {
    await seedUser('OPERADOR', 'operador@buchardo.gob.ar');
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient();

    const token = await loginAs('operador@buchardo.gob.ar');
    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'vecino@buchardo.gob.ar' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('REPARTIDOR → 403', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient();

    const token = await loginAs('repartidor@buchardo.gob.ar');
    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'vecino@buchardo.gob.ar' });
    expect(res.status).toBe(403);
  });

  it('CIUDADANO → 403', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient();

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'vecino@buchardo.gob.ar' });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Linking validation
// ===========================================================================

describe('POST /api/clients/:clientId/citizen-access — validation', () => {
  it('returns 404 for unknown email', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const client = await seedClient();
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'fantasma@example.com' });

    expect(res.status).toBe(404);
  });

  it('returns 4xx for User with role ADMIN (not CIUDADANO)', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    await seedUser('ADMIN', 'admin2@buchardo.gob.ar');
    const client = await seedClient();
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'admin2@buchardo.gob.ar' });

    expect([400, 422]).toContain(res.status);
  });

  it('returns 4xx for inactive User', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    citizen.active = false;
    await citizen.save();
    const client = await seedClient();
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'vecino@buchardo.gob.ar' });

    expect([400, 422]).toContain(res.status);
  });

  it('returns 404 for unknown client', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/clients/507f1f77bcf86cd799439011/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'vecino@buchardo.gob.ar' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when User already linked to ANOTHER Client', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const clientA = await seedClient({ userId: citizen._id });
    const clientB = await seedClient();

    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post(`/api/clients/${clientB._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'vecino@buchardo.gob.ar' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    void clientA;
  });

  it('returns 409 when Client already linked to a DIFFERENT User', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    await seedUser('CIUDADANO', 'vecino1@buchardo.gob.ar');
    await seedUser('CIUDADANO', 'vecino2@buchardo.gob.ar');

    const client = await seedClient();
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ identifier: 'vecino1@buchardo.gob.ar' });

    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ identifier: 'vecino2@buchardo.gob.ar' });
    expect(res.status).toBe(409);
  });

  it('linking the same User to the same Client is idempotent (200)', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient();
    const token = await loginAs('admin@buchardo.gob.ar');

    const first = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'vecino@buchardo.gob.ar' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'vecino@buchardo.gob.ar' });
    expect(second.status).toBe(200);
    expect(second.body.data.linked).toBe(true);
  });

  it('normalizes email case and whitespace', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient();
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: '  Vecino@Buchardo.gob.ar  ' });
    expect(res.status).toBe(200);
    expect(res.body.data.access.user.email).toBe('vecino@buchardo.gob.ar');
  });

  it('returns 400 for missing email field', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const client = await seedClient();
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Linking by documentNumber (DNI)
// ===========================================================================

describe('POST /api/clients/:clientId/citizen-access — by DNI', () => {
  it('links when identifier is a DNI', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    await seedCiudadanoWithDni('vecino@buchardo.gob.ar', '12345678', 'Juan');
    const client = await seedClient();
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: '12345678' });

    expect(res.status).toBe(200);
    expect(res.body.data.linked).toBe(true);
    expect(res.body.data.access.user.email).toBe('vecino@buchardo.gob.ar');
    expect(res.body.data.access.user.documentNumber).toBe('12345678');
  });

  it('normalizes DNI with dots/dashes/spaces', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    await seedCiudadanoWithDni('vecino@buchardo.gob.ar', '12345678');
    const client = await seedClient();
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: '12.345.678' });

    expect(res.status).toBe(200);
    expect(res.body.data.access.user.email).toBe('vecino@buchardo.gob.ar');
  });

  it('returns 404 for unknown DNI', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const client = await seedClient();
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: '99999999' });

    expect(res.status).toBe(404);
  });

  it('email-or-DNI path returns USER_NOT_FOUND-style message for email', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const client = await seedClient();
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'fantasma@example.com' });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/email/i);
  });
});

// ===========================================================================
// GET /api/clients/:clientId/citizen-access
// ===========================================================================

describe('GET /api/clients/:clientId/citizen-access', () => {
  it('returns linked=true with user info', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient({ userId: citizen._id });

    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .get(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.access.linked).toBe(true);
    expect(res.body.data.access.user.email).toBe('vecino@buchardo.gob.ar');
    expect(res.body.data.access.user).not.toHaveProperty('passwordHash');
  });

  it('returns linked=false when no user is linked', async () => {
    const client = await seedClient();
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .get(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.access.linked).toBe(false);
    expect(res.body.data.access.user).toBeNull();
  });

  it('OPERADOR → 403', async () => {
    const client = await seedClient();
    await seedUser('OPERADOR', 'operador@buchardo.gob.ar');
    const token = await loginAs('operador@buchardo.gob.ar');
    const res = await request(app)
      .get(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// DELETE /api/clients/:clientId/citizen-access
// ===========================================================================

describe('DELETE /api/clients/:clientId/citizen-access', () => {
  it('unlinks the User (sets userId=null)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient({ userId: citizen._id });
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .delete(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.access.linked).toBe(false);

    const reloaded = await Client.findById(client._id);
    expect(reloaded?.userId).toBeNull();
  });

  it('unlinking a non-linked Client is idempotent', async () => {
    const client = await seedClient();
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .delete(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.access.linked).toBe(false);
  });

  it('unlinking does NOT delete the User or Client', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient({ userId: citizen._id });
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    await request(app)
      .delete(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`);

    const { User } = await import('../src/modules/users/users.model');
    const stillThere = await User.findById(citizen._id);
    const clientStillThere = await Client.findById(client._id);
    expect(stillThere).not.toBeNull();
    expect(clientStillThere).not.toBeNull();
  });

it('OPERADOR → 403', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedClient({ userId: citizen._id });
    await seedUser('OPERADOR', 'operador@buchardo.gob.ar');
    const token = await loginAs('operador@buchardo.gob.ar');

    const res = await request(app)
      .delete(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Linking by phone number
// ===========================================================================

describe('POST /api/clients/:clientId/citizen-access — by phone', () => {
  it('links when identifier is an exact phone match', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    await createUser({
      firstName: 'Ana',
      lastName: 'Pérez',
      email: 'ana@buchardo.gob.ar',
      password: 'Password123',
      role: ROLES.CIUDADANO,
      phone: '+5493584001122',
    });
    const client = await seedClient();
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: '+5493584001122' });

    expect(res.status).toBe(200);
    expect(res.body.data.linked).toBe(true);
    expect(res.body.data.access.user.email).toBe('ana@buchardo.gob.ar');
  });

  it('links via tail-10 fallback when only the trailing digits match', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    await createUser({
      firstName: 'Luis',
      lastName: 'Gómez',
      email: 'luis@buchardo.gob.ar',
      password: 'Password123',
      role: ROLES.CIUDADANO,
      phone: '+5493584003344',
    });
    const client = await seedClient();
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: '3584003344' });

    expect(res.status).toBe(200);
    expect(res.body.data.access.user.email).toBe('luis@buchardo.gob.ar');
  });

  it('returns 404 for unknown phone', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const client = await seedClient();
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: '+5493584009999' });

    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/teléfono/i);
  });
});

// ===========================================================================
// Sync User → Client identity fields after a successful link
// ===========================================================================

describe('POST /api/clients/:clientId/citizen-access — sync from User', () => {
  it('copies email, document and phone from the User onto the Client', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    await createUser({
      firstName: 'Juan',
      lastName: 'Pérez',
      email: 'juan.sync@buchardo.gob.ar',
      password: 'Password123',
      role: ROLES.CIUDADANO,
      phone: '+5493584112233',
      documentNumber: '33445566',
    });
    // Client from the Excel import: NO document, NO phone, NO email.
    const client = await Client.create({
      firstName: 'Juan',
      lastName: 'Pérez',
      documentType: null,
      documentNumber: null,
      clientType: 'NO_LOCAL',
      phone: null,
      email: null,
      address: baseAddress,
      userId: null,
      active: true,
    });

    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'juan.sync@buchardo.gob.ar' });

    expect(res.status).toBe(200);

    const reloaded = await Client.findById(client._id);
    expect(reloaded?.email).toBe('juan.sync@buchardo.gob.ar');
    expect(reloaded?.documentNumber).toBe('33445566');
    expect(reloaded?.documentType).toBe('DNI');
    expect(reloaded?.phone).toBe('+5493584112233');
  });

  it('does NOT blank out fields when the User lacks them (non-destructive)', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    // User has no phone, no document. Only email.
    await createUser({
      firstName: 'Ana',
      lastName: 'Ruiz',
      email: 'ana.ruiz@buchardo.gob.ar',
      password: 'Password123',
      role: ROLES.CIUDADANO,
    });
    // Client from Excel already has phone.
    const client = await Client.create({
      firstName: 'Ana',
      lastName: 'Ruiz',
      documentType: null,
      documentNumber: null,
      clientType: 'NO_LOCAL',
      phone: '+5493584000001',
      email: null,
      address: baseAddress,
      userId: null,
      active: true,
    });

    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'ana.ruiz@buchardo.gob.ar' });

    expect(res.status).toBe(200);

    const reloaded = await Client.findById(client._id);
    expect(reloaded?.email).toBe('ana.ruiz@buchardo.gob.ar');
    // Phone is preserved from the Excel row.
    expect(reloaded?.phone).toBe('+5493584000001');
  });

  it('idempotent re-link re-syncs the Client', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizen = await createUser({
      firstName: 'Pedro',
      lastName: 'Suárez',
      email: 'pedro@buchardo.gob.ar',
      password: 'Password123',
      role: ROLES.CIUDADANO,
      phone: '+5493584556677',
      documentNumber: '44556677',
    });
    const client = await seedClient();
    const token = await loginAs('admin@buchardo.gob.ar');

    // First link
    await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'pedro@buchardo.gob.ar' });

    // Re-link (should be 200 + still linked)
    const second = await request(app)
      .post(`/api/clients/${client._id.toString()}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'pedro@buchardo.gob.ar' });
    expect(second.status).toBe(200);

    const reloaded = await Client.findById(client._id);
    expect(reloaded?.userId?.toString()).toBe(citizen._id.toString());
    expect(reloaded?.email).toBe('pedro@buchardo.gob.ar');
    expect(reloaded?.phone).toBe('+5493584556677');
  });
});

// ===========================================================================
// Client creation without document (Excel-import shape)
// ===========================================================================

describe('POST /api/clients — documentNumber is optional', () => {
  it('creates a Client with documentNumber=null (Excel import)', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send({
        firstName: 'Sin',
        lastName: 'Dni',
        clientType: 'NO_LOCAL',
        phone: '+5493584123456',
        address: baseAddress,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.client.documentNumber).toBeNull();
    expect(res.body.data.client.documentType).toBeNull();
    expect(res.body.data.client.phone).toBe('+5493584123456');
  });

  it('creates a Client with zona and uppercases it', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send({
        firstName: 'Roberto',
        lastName: 'Gómez',
        clientType: 'LOCAL',
        documentNumber: '12345678',
        address: baseAddress,
        zona: 'zona 1',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.client.zona).toBe('ZONA 1');
  });
});