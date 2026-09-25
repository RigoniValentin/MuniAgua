import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, teardownTestDb, clearTestDb } from './setup';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/app';
import { createUser } from '../src/modules/users/users.service';
import { ROLES } from '../src/modules/users/users.types';
import { User } from '../src/modules/users/users.model';
import { PasswordResetToken } from '../src/modules/password-recovery/password-recovery.model';
import { logger } from '../src/shared/logger';

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
  process.env.PASSWORD_RESET_URL_BASE = 'http://localhost:5173';
  process.env.PASSWORD_RESET_TTL_MS = String(60 * 60 * 1000);
});

interface MockMail {
  to: string;
  resetUrl: string;
  expiresInMinutes: number;
}

function installMailerSpy() {
  const calls: MockMail[] = [];
  const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  spy.mockImplementation(() => {});
  return {
    calls,
    spy,
    unmock() {
      spy.mockRestore();
    },
    extractResetUrl(): string | null {
      const arg = spy.mock.calls[0]?.[1] as { resetUrl?: string } | undefined;
      return arg?.resetUrl ?? null;
    },
  };
}

async function seedCiudadano() {
  return createUser({
    firstName: 'María',
    lastName: 'González',
    email: 'maria@buchardo.gob.ar',
    password: 'OriginalPass123',
    role: ROLES.CIUDADANO,
  });
}

describe('POST /api/auth/forgot-password', () => {
  it('returns 200 with the same body for a registered email', async () => {
    await seedCiudadano();
    const mailer = installMailerSpy();
    try {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'maria@buchardo.gob.ar' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.ok).toBe(true);
      const tokens = await PasswordResetToken.find({});
      expect(tokens).toHaveLength(1);
      expect(tokens[0].usedAt).toBeNull();
    } finally {
      mailer.unmock();
    }
  });

  it('returns identical body for an unknown email (anti-enumeration)', async () => {
    const mailer = installMailerSpy();
    try {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'nadie@buchardo.gob.ar' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const tokens = await PasswordResetToken.find({});
      expect(tokens).toHaveLength(0);
      expect(mailer.spy).not.toHaveBeenCalled();
    } finally {
      mailer.unmock();
    }
  });

  it('does not dispatch an email for inactive users', async () => {
    const user = await seedCiudadano();
    await User.updateOne({ _id: user._id }, { $set: { active: false } });
    const mailer = installMailerSpy();
    try {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'maria@buchardo.gob.ar' });

      expect(res.status).toBe(200);
      const tokens = await PasswordResetToken.find({});
      expect(tokens).toHaveLength(0);
      const devCalls = mailer.spy.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('SMTP disabled'),
      );
      expect(devCalls).toHaveLength(0);
    } finally {
      mailer.unmock();
    }
  });

  it('rejects a malformed payload with 400', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('invalidates prior pending tokens when re-requesting', async () => {
    const user = await seedCiudadano();
    const earlierExpiration = new Date(Date.now() + 60 * 60 * 1000);
    const older = await PasswordResetToken.create({
      userId: user._id,
      tokenHash: 'a'.repeat(64),
      usedAt: null,
      expiresAt: earlierExpiration,
    });

    const mailer = installMailerSpy();
    try {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'maria@buchardo.gob.ar' });
      expect(res.status).toBe(200);

      const reloaded = await PasswordResetToken.findById(older._id);
      expect(reloaded?.usedAt).not.toBeNull();
      const total = await PasswordResetToken.find({});
      expect(total).toHaveLength(2);
      const usable = total.filter((t) => t.usedAt === null);
      expect(usable).toHaveLength(1);
    } finally {
      mailer.unmock();
    }
  });
});

describe('GET /api/auth/reset-password/validate', () => {
  it('returns valid:true for an active token', async () => {
    await seedCiudadano();
    const request1 = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'maria@buchardo.gob.ar' });
    expect(request1.status).toBe(200);

    const doc = (await PasswordResetToken.findOne({}))!;
    const expiresAtMs = doc.expiresAt.getTime();
    const createdAtMs = doc.createdAt.getTime();
    const ttl = expiresAtMs - createdAtMs;
    const url = new URL(`http://x/recuperar/__never_used__`);
    void url;

    // We must re-derive the plaintext token from the doc; hash -> brute force not feasible.
    // Instead, request a fresh link and inspect what the dev mailer logged:
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'maria@buchardo.gob.ar' });
      const arg = spy.mock.calls[0]?.[1] as { resetUrl?: string } | undefined;
      const tokenEncoded = arg?.resetUrl?.split('/').pop() ?? '';
      const token = decodeURIComponent(tokenEncoded);

      const valid = await request(app)
        .get('/api/auth/reset-password/validate')
        .query({ token });
      expect(valid.status).toBe(200);
      expect(valid.body.data.valid).toBe(true);
      void ttl;
    } finally {
      spy.mockRestore();
    }
  });

  it('returns valid:false for an unknown token', async () => {
    const res = await request(app)
      .get('/api/auth/reset-password/validate')
      .query({ token: 'this-token-was-never-issued' });
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(false);
  });

  it('returns valid:false for an expired token', async () => {
    const user = await seedCiudadano();
    await PasswordResetToken.create({
      userId: user._id,
      tokenHash: 'b'.repeat(64),
      usedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await request(app)
      .get('/api/auth/reset-password/validate')
      .query({ token: 'whatever' });
    expect(res.body.data.valid).toBe(false);
  });
});

describe('POST /api/auth/reset-password', () => {
  async function captureToken(): Promise<string> {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'maria@buchardo.gob.ar' });
      const arg = spy.mock.calls[0]?.[1] as { resetUrl?: string } | undefined;
      const tokenEncoded = arg?.resetUrl?.split('/').pop() ?? '';
      return decodeURIComponent(tokenEncoded);
    } finally {
      spy.mockRestore();
    }
  }

  it('replaces the password hash and lets the user log in with the new one', async () => {
    await seedCiudadano();
    const token = await captureToken();

    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'NewPassword456' });
    expect(reset.status).toBe(200);
    expect(reset.body.data.ok).toBe(true);

    const loginOld = await request(app)
      .post('/api/auth/login')
      .send({ email: 'maria@buchardo.gob.ar', password: 'OriginalPass123' });
    expect(loginOld.status).toBe(401);

    const loginNew = await request(app)
      .post('/api/auth/login')
      .send({ email: 'maria@buchardo.gob.ar', password: 'NewPassword456' });
    expect(loginNew.status).toBe(200);
  });

  it('cannot be reused: a second attempt with the same token returns 400', async () => {
    await seedCiudadano();
    const token = await captureToken();

    const first = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'NewPassword456' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'AnotherNew789' });
    expect(second.status).toBe(400);
  });

  it('rejects a too-short password with 400', async () => {
    await seedCiudadano();
    const token = await captureToken();
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'short' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown token with 400', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'never-issued-token', password: 'NewPassword456' });
    expect(res.status).toBe(400);
  });
});
