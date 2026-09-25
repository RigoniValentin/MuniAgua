import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setupTestDb, teardownTestDb } from './setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await setupTestDb();
  loadEnv();
  app = createApp();
});

afterAll(async () => {
  await teardownTestDb();
});

describe('GET /api/health', () => {
  it('returns ok status with database connected', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        status: 'ok',
        database: 'connected',
      },
    });
    expect(res.body.data).toHaveProperty('timestamp');
    expect(res.body.data).toHaveProperty('uptime');
  });
});

describe('Unknown API route', () => {
  it('returns JSON 404 for /api/inexistente', async () => {
    const res = await request(app).get('/api/inexistente');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'NOT_FOUND',
      },
    });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns JSON 404 for unknown API method', async () => {
    const res = await request(app).post('/api/health');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api (root)', () => {
  it('returns API metadata', async () => {
    const res = await request(app).get('/api');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'MuniBack API',
      version: '0.1.0',
    });
  });
});
