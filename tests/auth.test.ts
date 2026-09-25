import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { setupTestDb, teardownTestDb, clearTestDb } from './setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import { ROLES } from '../src/modules/users/users.types';

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

async function seedAdmin() {
  return createUser({
    firstName: 'Super',
    lastName: 'Admin',
    email: 'admin@buchardo.gob.ar',
    password: 'SuperSecret123',
    role: ROLES.SUPER_ADMIN,
  });
}

async function seedRepartidor() {
  return createUser({
    firstName: 'Juan',
    lastName: 'Reparto',
    email: 'juan@buchardo.gob.ar',
    password: 'Reparto123',
    role: ROLES.REPARTIDOR,
  });
}

describe('POST /api/auth/login', () => {
  it('logs in with valid credentials', async () => {
    await seedAdmin();

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@buchardo.gob.ar', password: 'SuperSecret123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({
      email: 'admin@buchardo.gob.ar',
      role: ROLES.SUPER_ADMIN,
      active: true,
    });
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(res.body.data.accessToken.length).toBeGreaterThan(0);
    expect(res.body.data.user).not.toHaveProperty('passwordHash');

    // refresh cookie set
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(cookies!.some((c: string) => c.includes('muni_rt'))).toBe(true);
  });

  it('rejects invalid credentials with 401', async () => {
    await seedAdmin();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@buchardo.gob.ar', password: 'WrongPassword!' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'UNAUTHORIZED' },
    });
  });

  it('rejects malformed payload with 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: '123' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 for unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@buchardo.gob.ar', password: 'whatever123' });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the user when authenticated', async () => {
    const user = await seedAdmin();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@buchardo.gob.ar', password: 'SuperSecret123' });
    const token = login.body.data.accessToken;

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user._id.toString());
    expect(res.body.data.user.email).toBe('admin@buchardo.gob.ar');
  });

  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for invalid token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not.a.real.token');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/refresh', () => {
  it('rotates refresh token', async () => {
    await seedAdmin();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@buchardo.gob.ar', password: 'SuperSecret123' });
    const cookieHeader = login.headers['set-cookie']!.find((c: string) => c.startsWith('muni_rt='))!;
    const cookie = cookieHeader.split(';')[0].split('=')[1];

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `muni_rt=${cookie}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.data.accessToken).toBe('string');
  });

  it('returns 401 without cookie', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('returns 401 for invalid cookie', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', 'muni_rt=invalid');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the refresh cookie and rejects subsequent refresh', async () => {
    await seedAdmin();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@buchardo.gob.ar', password: 'SuperSecret123' });
    const cookieHeader = login.headers['set-cookie']!.find((c: string) => c.startsWith('muni_rt='))!;
    const cookie = cookieHeader.split(';')[0].split('=')[1];

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `muni_rt=${cookie}`);
    expect(logoutRes.status).toBe(200);

    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `muni_rt=${cookie}`);
    expect(refreshRes.status).toBe(401);
  });
});

describe('Protected routes — RBAC', () => {
  it('returns 403 when permission missing', async () => {
    await seedRepartidor(); // REPARTIDOR lacks users.manage
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'juan@buchardo.gob.ar', password: 'Reparto123' });
    const token = login.body.data.accessToken;

    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows SUPER_ADMIN to list users', async () => {
    await seedAdmin();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@buchardo.gob.ar', password: 'SuperSecret123' });
    const token = login.body.data.accessToken;

    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.users)).toBe(true);
  });
});
