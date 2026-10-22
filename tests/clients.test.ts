import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { setupTestDb, teardownTestDb, clearTestDb } from './setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import { ROLES, defaultPermissionsForRole } from '../src/modules/users/users.types';
import { signAccessToken } from '../src/modules/auth/auth.tokens';

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
  const user = await createUser({
    firstName: role,
    lastName: 'Test',
    email,
    password: 'Password123',
    role: ROLES[role],
  });
  return user;
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

describe('GET /api/clients', () => {
  it('lists clients as SUPER_ADMIN', async () => {
    await seedUser('SUPER_ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody({ documentNumber: '11111111' }));

    const res = await request(app)
      .get('/api/clients')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.pagination).toMatchObject({
      page: 1,
      limit: 20,
      total: 1,
      pages: 1,
    });
  });

  it('lists clients as REPARTIDOR', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/clients')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it('returns 403 for CIUDADANO', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/clients')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('POST /api/clients', () => {
  it('creates a valid client', async () => {
    await seedUser('OPERADOR', 'operador@buchardo.gob.ar');
    const token = await loginAs('operador@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody());

    expect(res.status).toBe(201);
    expect(res.body.data.client).toMatchObject({
      firstName: 'Juan',
      lastName: 'Pérez',
      clientType: 'LOCAL',
      active: true,
    });
    expect(res.body.data.client.fullName).toBe('Juan Pérez');
    expect(res.body.data.client.id).toBeDefined();
  });

  it('rejects creation without clients.create permission', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 400 for validation errors', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: '', clientType: 'INVALID' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 409 on duplicate document', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody({ documentNumber: '99999999' }));

    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody({ documentNumber: '99999999', email: 'otro@example.com' }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});

describe('GET /api/clients/:id', () => {
  it('returns a client by id', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody());
    const id = created.body.data.client.id;

    const res = await request(app)
      .get(`/api/clients/${id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.client.id).toBe(id);
  });

  it('returns 400 for invalid id format', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/clients/not-a-valid-id')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for non-existent client', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/clients/507f1f77bcf86cd799439011')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /api/clients/:id', () => {
  it('edits a client partially', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody());
    const id = created.body.data.client.id;

    const res = await request(app)
      .patch(`/api/clients/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '+54 358 9999999' });

    expect(res.status).toBe(200);
    expect(res.body.data.client.phone).toBe('+54 358 9999999');
  });

  it('changes clientType', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody());
    const id = created.body.data.client.id;

    const res = await request(app)
      .patch(`/api/clients/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientType: 'JUBILADO' });

    expect(res.status).toBe(200);
    expect(res.body.data.client.clientType).toBe('JUBILADO');
  });

  it('leaves omitted fields untouched', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody({ zona: 'ZONA 3', notes: 'Nota original' }));
    const id = created.body.data.client.id;

    const res = await request(app)
      .patch(`/api/clients/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientType: 'JUBILADO' });

    expect(res.status).toBe(200);
    expect(res.body.data.client).toMatchObject({
      clientType: 'JUBILADO',
      phone: '+54 358 4123456',
      email: 'juan@example.com',
      zona: 'ZONA 3',
      notes: 'Nota original',
    });
  });

  it('clears a field when null is sent explicitly', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody({ zona: 'ZONA 3' }));
    const id = created.body.data.client.id;

    const res = await request(app)
      .patch(`/api/clients/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ zona: null });

    expect(res.status).toBe(200);
    expect(res.body.data.client.zona).toBeNull();
  });

  it('deactivates a client', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody());
    const id = created.body.data.client.id;

    const res = await request(app)
      .patch(`/api/clients/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ active: false });

    expect(res.status).toBe(200);
    expect(res.body.data.client.active).toBe(false);
  });
});

describe('GET /api/clients — filters, search and pagination', () => {
  async function seedThreeClients(token: string) {
    const bodies = [
      validClientBody({
        firstName: 'Ana',
        lastName: 'Garcia',
        documentNumber: '11111111',
        clientType: 'LOCAL',
      }),
      validClientBody({
        firstName: 'Luis',
        lastName: 'Gomez',
        documentNumber: '22222222',
        clientType: 'JUBILADO',
        active: false,
      }),
      validClientBody({
        firstName: 'Maria',
        lastName: 'Lopez',
        documentNumber: '33333333',
        clientType: 'NO_LOCAL',
        address: { ...baseAddress, street: 'Belgrano' },
      }),
    ];
    for (const body of bodies) {
      const r = await request(app)
        .post('/api/clients')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(r.status).toBe(201);
    }
  }

  it('filters by clientType', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    await seedThreeClients(token);

    const res = await request(app)
      .get('/api/clients?clientType=LOCAL')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].clientType).toBe('LOCAL');
  });

  it('filters by active=false', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    await seedThreeClients(token);

    const res = await request(app)
      .get('/api/clients?active=false')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].firstName).toBe('Luis');
  });

  it('searches by first name', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    await seedThreeClients(token);

    const res = await request(app)
      .get('/api/clients?search=Maria')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].firstName).toBe('Maria');
  });

  it('searches by last name', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    await seedThreeClients(token);

    const res = await request(app)
      .get('/api/clients?search=Gomez')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].lastName).toBe('Gomez');
  });

  it('searches by document number', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    await seedThreeClients(token);

    const res = await request(app)
      .get('/api/clients?search=22222222')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].documentNumber).toBe('22222222');
  });

  it('paginates results', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    await seedThreeClients(token);

    const page1 = await request(app)
      .get('/api/clients?page=1&limit=2')
      .set('Authorization', `Bearer ${token}`);
    expect(page1.body.data.items).toHaveLength(2);
    expect(page1.body.data.pagination).toMatchObject({
      page: 1,
      limit: 2,
      total: 3,
      pages: 2,
    });

    const page2 = await request(app)
      .get('/api/clients?page=2&limit=2')
      .set('Authorization', `Bearer ${token}`);
    expect(page2.body.data.items).toHaveLength(1);
  });

  it('enforces max limit', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/clients?limit=500')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/clients/bulk/ids', () => {
  it('returns every id matching the filters, ignoring pagination', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const created: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const res = await request(app)
        .post('/api/clients')
        .set('Authorization', `Bearer ${token}`)
        .send(
          validClientBody({
            documentNumber: `2000000${i}`,
            email: `many${i}@example.com`,
            lastName: `Apellido${String(i).padStart(2, '0')}`,
          }),
        );
      created.push(res.body.data.client.id);
    }

    const res = await request(app)
      .get('/api/clients/bulk/ids?limit=20')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(25);
    // `limit=20` only shrinks the list page; the id resolution ignores it.
    expect(res.body.data.ids).toHaveLength(25);
    expect(res.body.data.truncated).toBe(false);
    expect(new Set(res.body.data.ids)).toEqual(new Set(created));
  });

  it('honours the same filters as the list endpoint', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    for (const [i, clientType] of ['LOCAL', 'NO_LOCAL', 'NO_LOCAL'].entries()) {
      await request(app)
        .post('/api/clients')
        .set('Authorization', `Bearer ${token}`)
        .send(
          validClientBody({
            documentNumber: `3000000${i}`,
            email: `filtro${i}@example.com`,
            clientType,
          }),
        );
    }

    const res = await request(app)
      .get('/api/clients/bulk/ids?clientType=NO_LOCAL')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.ids).toHaveLength(2);
  });

  it('applies the search filter', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody({ documentNumber: '40000001', lastName: 'Buscable' }));
    await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody({ documentNumber: '40000002', lastName: 'Otro' }));

    const res = await request(app)
      .get('/api/clients/bulk/ids?search=Buscable')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.ids).toHaveLength(1);
  });

  it('returns an empty set when nothing matches', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/clients/bulk/ids?search=nada-deesto')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ids: [], total: 0, truncated: false });
  });

  it('requires clients.update permission', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/clients/bulk/ids')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/clients/bulk/ids');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/clients/bulk', () => {
  async function createClients(
    token: string,
    count: number,
    overrides: Record<string, unknown> = {},
  ) {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const res = await request(app)
        .post('/api/clients')
        .set('Authorization', `Bearer ${token}`)
        .send(
          validClientBody({
            documentNumber: `1000000${i}`,
            email: `bulk${i}@example.com`,
            ...overrides,
          }),
        );
      expect(res.status).toBe(201);
      ids.push(res.body.data.client.id);
    }
    return ids;
  }

  it('changes the client type for every selected client', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const ids = await createClients(token, 3);

    const res = await request(app)
      .patch('/api/clients/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids, changes: { clientType: 'NO_LOCAL' } });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ requested: 3, matched: 3, modified: 3, notFound: [] });

    const list = await request(app)
      .get('/api/clients?clientType=NO_LOCAL&limit=100')
      .set('Authorization', `Bearer ${token}`);
    expect(list.body.data.pagination.total).toBe(3);
  });

  it('applies clientType, active and zona together', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const [id] = await createClients(token, 1);

    const res = await request(app)
      .patch('/api/clients/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ids: [id],
        changes: { clientType: 'JUBILADO', active: false, zona: 'ZONA 9' },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.modified).toBe(1);

    const detail = await request(app)
      .get(`/api/clients/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.body.data.client).toMatchObject({
      clientType: 'JUBILADO',
      active: false,
      zona: 'ZONA 9',
    });
  });

  it('reports matched-but-unchanged clients without rewriting them', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const ids = await createClients(token, 2, { clientType: 'NO_LOCAL' });

    const res = await request(app)
      .patch('/api/clients/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids, changes: { clientType: 'NO_LOCAL' } });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ requested: 2, matched: 2, modified: 0 });
  });

  it('reports missing ids and de-duplicates the payload', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const [id] = await createClients(token, 1);

    const res = await request(app)
      .patch('/api/clients/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ids: [id, id, '507f1f77bcf86cd799439011'],
        changes: { clientType: 'AYUDA_SOCIAL' },
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      requested: 2,
      matched: 1,
      modified: 1,
      notFound: ['507f1f77bcf86cd799439011'],
    });
  });

  it('stamps updatedBy with the acting user', async () => {
    const admin = await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const [id] = await createClients(token, 1);

    await request(app)
      .patch('/api/clients/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [id], changes: { clientType: 'NO_LOCAL' } });

    const detail = await request(app)
      .get(`/api/clients/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.body.data.client.updatedBy).toBe(admin._id.toString());
  });

  it('returns 400 when no ids are sent', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .patch('/api/clients/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [], changes: { clientType: 'NO_LOCAL' } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when changes is empty', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const [id] = await createClients(token, 1);

    const res = await request(app)
      .patch('/api/clients/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [id], changes: {} });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid client type', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const [id] = await createClients(token, 1);

    const res = await request(app)
      .patch('/api/clients/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [id], changes: { clientType: 'EXTERNO' } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a malformed id before touching the database', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .patch('/api/clients/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: ['not-an-id'], changes: { clientType: 'NO_LOCAL' } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses to bulk-change the document (unique index)', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const [id] = await createClients(token, 1);

    const res = await request(app)
      .patch('/api/clients/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [id], changes: { documentType: 'DNI', documentNumber: '55555555' } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 403 without clients.update permission', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .patch('/api/clients/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: ['507f1f77bcf86cd799439011'], changes: { clientType: 'NO_LOCAL' } });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .patch('/api/clients/bulk')
      .send({ ids: ['507f1f77bcf86cd799439011'], changes: { clientType: 'NO_LOCAL' } });

    expect(res.status).toBe(401);
  });
});

describe('Security — sensitive data', () => {
  it('does not expose user data when a client is linked to a user', async () => {
    const admin = await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send(validClientBody());

    const id = created.body.data.client.id;

    const { Client } = await import('../src/modules/clients/clients.model');
    await Client.updateOne({ _id: id }, { $set: { userId: admin._id } });

    const res = await request(app)
      .get(`/api/clients/${id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.client).not.toHaveProperty('passwordHash');
    expect(res.body.data.client).not.toHaveProperty('password');
    expect(JSON.stringify(res.body.data.client)).not.toContain(admin.passwordHash);
    expect(res.body.data.client.hasUserAccount).toBe(true);
    expect(res.body.data.client.userId).toBe(admin._id.toString());
  });
});
