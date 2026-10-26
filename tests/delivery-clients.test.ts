import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
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
  if (!user) {
    throw new Error(`User not found: ${email}`);
  }
  return signAccessToken({
    sub: user._id.toString(),
    role: user.role,
    permissions: defaultPermissionsForRole(user.role),
  });
}

/** Signs a token with an explicit permission list, to exercise the gates. */
async function loginAsWithPermissions(
  email: string,
  permissions: string[],
): Promise<{ token: string; userId: string }> {
  const { User } = await import('../src/modules/users/users.model');
  const user = await User.findOne({ email });
  if (!user) {
    throw new Error(`User not found: ${email}`);
  }
  const token = signAccessToken({
    sub: user._id.toString(),
    role: user.role,
    permissions: permissions as never,
  });
  return { token, userId: user._id.toString() };
}

const baseAddress = {
  street: 'Av. San Martín',
  number: '123',
  locality: 'Buchardo',
};

function validClientBody(overrides: Record<string, unknown> = {}) {
  return {
    firstName: 'Juan',
    lastName: 'Pérez',
    documentType: 'DNI',
    documentNumber: '12345678',
    phone: '+54 358 4123456',
    email: 'juan@example.com',
    clientType: 'LOCAL',
    address: baseAddress,
    ...overrides,
  };
}

describe('POST /api/delivery/me/clients', () => {
  it('creates a client as REPARTIDOR and stamps createdBy with the driver id', async () => {
    const driver = await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/delivery/me/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody());

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.client.fullName).toBe('Juan Pérez');
    expect(res.body.data.client.createdBy).toBe(driver._id.toString());
    expect(res.body.data.client.updatedBy).toBe(driver._id.toString());

    const stored = await Client.findById(res.body.data.client.id);
    expect(stored).not.toBeNull();
    expect(stored?.createdBy?.toString()).toBe(driver._id.toString());
  });

  it('accepts the full field set (paridad total con admin)', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/delivery/me/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(
        validClientBody({
          clientType: 'AYUDA_SOCIAL',
          zona: 'ZONA 2',
          notes: 'Registrado en el mostrador del reparto',
          active: false,
        }),
      );

    expect(res.status).toBe(201);
    expect(res.body.data.client.clientType).toBe('AYUDA_SOCIAL');
    expect(res.body.data.client.zona).toBe('ZONA 2');
    expect(res.body.data.client.active).toBe(false);
  });

  it('returns 409 when the document already exists', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(validClientBody());

    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const driverToken = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/delivery/me/clients')
      .set('Authorization', `Bearer ${driverToken}`)
      .send(validClientBody());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns 403 for CIUDADANO', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/delivery/me/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 when the driver token lacks delivery.clients.create', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const { token } = await loginAsWithPermissions('repartidor@buchardo.gob.ar', [
      'clients.read',
      'delivery.read',
    ]);

    const res = await request(app)
      .post('/api/delivery/me/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 400 for an invalid payload', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/delivery/me/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody({ firstName: '' }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/delivery/me/clients/:id', () => {
  async function seedClient(token: string) {
    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody());
    expect(res.status).toBe(201);
    return res.body.data.client.id as string;
  }

  it('updates a client as REPARTIDOR and stamps updatedBy with the driver id', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const clientId = await seedClient(adminToken);

    const driver = await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const driverToken = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .patch(`/api/delivery/me/clients/${clientId}`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        phone: '+54 358 4000000',
        address: { ...baseAddress, number: '999', references: 'Timbre 2' },
        notes: 'Casa de familia, llamar antes',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.client.phone).toBe('+54 358 4000000');
    expect(res.body.data.client.address.number).toBe('999');
    expect(res.body.data.client.address.references).toBe('Timbre 2');
    expect(res.body.data.client.updatedBy).toBe(driver._id.toString());
  });

  it('allows the full field set (paridad total con admin)', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const clientId = await seedClient(adminToken);

    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const driverToken = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .patch(`/api/delivery/me/clients/${clientId}`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        documentType: 'DNI',
        documentNumber: '87654321',
        clientType: 'JUBILADO',
        zona: 'ZONA 1',
        active: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.client.documentNumber).toBe('87654321');
    expect(res.body.data.client.clientType).toBe('JUBILADO');
    expect(res.body.data.client.zona).toBe('ZONA 1');
    expect(res.body.data.client.active).toBe(false);
  });

  it('returns 404 for an unknown client', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .patch('/api/delivery/me/clients/507f1f77bcf86cd799439d11')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '+54 358 4000000' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 403 for CIUDADANO', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const clientId = await seedClient(adminToken);

    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .patch(`/api/delivery/me/clients/${clientId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '+54 358 4000000' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 when the driver token lacks delivery.clients.update', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const clientId = await seedClient(adminToken);

    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const { token } = await loginAsWithPermissions('repartidor@buchardo.gob.ar', [
      'clients.read',
      'delivery.read',
      'delivery.clients.create',
    ]);

    const res = await request(app)
      .patch(`/api/delivery/me/clients/${clientId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '+54 358 4000000' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects unknown fields (mass-assignment guard)', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const clientId = await seedClient(adminToken);

    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const driverToken = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .patch(`/api/delivery/me/clients/${clientId}`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ userId: '507f1f77bcf86cd799439d11' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('El repartidor NO hereda los permisos del módulo clients', () => {
  it('returns 403 on POST /api/clients', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 on PATCH /api/clients/:id', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const createRes = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(validClientBody());
    const clientId = createRes.body.data.client.id as string;

    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .patch(`/api/clients/${clientId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '+54 358 4000000' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 on PATCH /api/clients/bulk', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const createRes = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(validClientBody());
    const clientId = createRes.body.data.client.id as string;

    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .patch('/api/clients/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [clientId], changes: { clientType: 'NO_LOCAL' } });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 on the citizen-access endpoints', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const createRes = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(validClientBody());
    const clientId = createRes.body.data.client.id as string;

    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const getRes = await request(app)
      .get(`/api/clients/${clientId}/citizen-access`)
      .set('Authorization', `Bearer ${token}`);
    const postRes = await request(app)
      .post(`/api/clients/${clientId}/citizen-access`)
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: 'vecino@buchardo.gob.ar' });

    expect(getRes.status).toBe(403);
    expect(postRes.status).toBe(403);
  });

  it('still allows the driver to READ the padrón', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/clients')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Regresión — el personal de administración sigue usando /api/clients', () => {
  it('ADMIN creates and updates through the staff endpoints', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const createRes = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody());
    expect(createRes.status).toBe(201);

    const clientId = createRes.body.data.client.id as string;
    const updateRes = await request(app)
      .patch(`/api/clients/${clientId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '+54 358 4111111' });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.client.phone).toBe('+54 358 4111111');
  });
});
