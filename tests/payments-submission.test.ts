import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import request from 'supertest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
import {
  buildJpeg,
  buildPdf,
  buildPng,
  buildWebp,
  buildSvg,
  buildOversizedPdf,
} from './payment-fixtures';

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

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function seedUser(
  role: keyof typeof ROLES,
  email: string,
  extras: { active?: boolean } = {},
) {
  const user = await createUser({
    firstName: role,
    lastName: 'Test',
    email,
    password: 'Password123',
    role: ROLES[role],
  });
  if (extras.active === false) {
    user.active = false;
    await user.save();
  }
  return user;
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

async function seedLinkedClient(opts: { userId: mongoose.Types.ObjectId | null; active?: boolean } = { userId: null }) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Client.create({
    firstName: 'Test',
    lastName: `Client${idx}`,
    documentType: 'DNI',
    documentNumber: idx.toString(),
    clientType: 'JUBILADO',
    address: { street: 'Av. San Martín', number: '123', locality: 'Buchardo' },
    userId: opts.userId ?? null,
    active: opts.active ?? true,
  });
}

// ===========================================================================
// Submission
// ===========================================================================

describe('POST /api/payments/me — submission', () => {
  it('CIUDADANO vinculado crea Payment válido con status PENDING', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', 100_000)
      .field('paymentMethod', 'BANK_TRANSFER')
      .field('note', 'Pago de prueba')
      .attach('receipt', buildPng(), 'transfer.png');

    expect(res.status).toBe(201);
    expect(res.body.data.payment.id).toBeDefined();

    const list = await request(app)
      .get('/api/payments/me')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].status).toBe('PENDING');
    expect(list.body.data.items[0].amountMinor).toBe(100_000);
    expect(list.body.data.items[0].paymentMethod).toBe('BANK_TRANSFER');
    expect(list.body.data.items[0].note).toBe('Pago de prueba');
    expect(list.body.data.items[0].receipt.mimeType).toBe('image/png');
    expect(list.body.data.items[0].receipt.originalName).toBe('transfer.png');
    expect(list.body.data.items[0].receipt.size).toBeGreaterThan(0);
    // The DTO must NOT expose storageKey, sha256, submittedBy, etc.
    expect(list.body.data.items[0]).not.toHaveProperty('storageKey');
    expect(list.body.data.items[0]).not.toHaveProperty('sha256');
    expect(list.body.data.items[0]).not.toHaveProperty('submittedBy');
  });

  it('PENDING no crea AccountMovement', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedLinkedClient({ userId: citizen._id });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', 100_000)
      .field('paymentMethod', 'BANK_TRANSFER')
      .attach('receipt', buildPng(), 'transfer.png');
    expect(res.status).toBe(201);

    const { AccountMovement } = await import(
      '../src/modules/accounts/account-movements.model'
    );
    const movements = await AccountMovement.find({ clientId: client._id });
    expect(movements).toHaveLength(0);
  });

  it('Cliente inactive puede informar pago', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id, active: false });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', 50_000)
      .field('paymentMethod', 'OTHER')
      .attach('receipt', buildPdf(), 'receipt.pdf');
    expect(res.status).toBe(201);
  });

  it('Ciudadano sin Client → 404 CLIENT_NOT_LINKED', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', 100_000)
      .field('paymentMethod', 'BANK_TRANSFER')
      .attach('receipt', buildPng(), 'transfer.png');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CLIENT_NOT_LINKED');
  });

  it('clientId enviado manualmente → 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', 100_000)
      .field('paymentMethod', 'BANK_TRANSFER')
      .field('clientId', '507f1f77bcf86cd799439011')
      .attach('receipt', buildPng(), 'transfer.png');
    expect(res.status).toBe(400);
  });

  it('status enviado manualmente → 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', 100_000)
      .field('paymentMethod', 'BANK_TRANSFER')
      .field('status', 'APPROVED')
      .attach('receipt', buildPng(), 'transfer.png');
    expect(res.status).toBe(400);
  });

  it('amount 0 → 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', 0)
      .field('paymentMethod', 'BANK_TRANSFER')
      .attach('receipt', buildPng(), 'transfer.png');
    expect(res.status).toBe(400);
  });

  it('amount negativo → 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', -100_000)
      .field('paymentMethod', 'BANK_TRANSFER')
      .attach('receipt', buildPng(), 'transfer.png');
    expect(res.status).toBe(400);
  });

  it('amount decimal → 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', '100.5')
      .field('paymentMethod', 'BANK_TRANSFER')
      .attach('receipt', buildPng(), 'transfer.png');
    expect(res.status).toBe(400);
  });

  it('método inválido → 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', 100_000)
      .field('paymentMethod', 'CASH')
      .attach('receipt', buildPng(), 'transfer.png');
    expect(res.status).toBe(400);
  });

  it('sin comprobante → 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', 100_000)
      .field('paymentMethod', 'BANK_TRANSFER');
    expect(res.status).toBe(400);
  });

  it('archivo > 8MB → 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', 100_000)
      .field('paymentMethod', 'BANK_TRANSFER')
      .attach('receipt', buildOversizedPdf(), 'big.pdf');
    expect(res.status).toBe(400);
  });

  it('MIME permitido: PDF, JPEG, WEBP', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id });
    const token = await loginAs('vecino@buchardo.gob.ar');

    for (const [name, build, ext] of [
      ['a.pdf', buildPdf, 'pdf'],
      ['a.jpg', buildJpeg, 'jpg'],
      ['a.webp', buildWebp, 'webp'],
    ] as const) {
      const res = await request(app)
        .post('/api/payments/me')
        .set('Authorization', `Bearer ${token}`)
        .field('amountMinor', 100_000)
        .field('paymentMethod', 'BANK_TRANSFER')
        .attach('receipt', build(256), name);
      expect(res.status).toBe(201);
      expect(res.body.data.payment.id).toBeDefined();
      void ext;
    }
  });

  it('SVG rechazado → 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', 100_000)
      .field('paymentMethod', 'BANK_TRANSFER')
      .attach('receipt', buildSvg(), 'x.svg');
    expect(res.status).toBe(400);
  });

  it('El comprobante queda fuera de public/', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', 100_000)
      .field('paymentMethod', 'BANK_TRANSFER')
      .attach('receipt', buildPng(), 'transfer.png');
    expect(res.status).toBe(201);

    const publicDir = path.resolve(process.cwd(), 'public');
    const list = await fs.readdir(publicDir).catch(() => [] as string[]);
    expect(list).not.toContain('transfer.png');
  });

  it('storageKey NO aparece en DTO ciudadano', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id });
    const token = await loginAs('vecino@buchardo.gob.ar');

    const created = await request(app)
      .post('/api/payments/me')
      .set('Authorization', `Bearer ${token}`)
      .field('amountMinor', 100_000)
      .field('paymentMethod', 'BANK_TRANSFER')
      .attach('receipt', buildPng(), 'transfer.png');
    expect(created.status).toBe(201);

    const list = await request(app)
      .get('/api/payments/me')
      .set('Authorization', `Bearer ${token}`);
    const item = list.body.data.items[0];
    expect(item.receipt).not.toHaveProperty('storageKey');
    expect(item.receipt).not.toHaveProperty('sha256');
    // The full receipt object must only contain the safe fields
    expect(Object.keys(item.receipt).sort()).toEqual(
      ['mimeType', 'originalName', 'size'].sort(),
    );
  });
});

// ===========================================================================
// Storage cleanup
// ===========================================================================

describe('Storage cleanup on failure', () => {
  it('Si Payment.create falla, el archivo se elimina', async () => {
    const { submitPayment, validateAndHashReceipt } = await import(
      '../src/modules/payments/payments.service'
    );

    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient({ userId: citizen._id });
    const tempDir = path.join(os.tmpdir(), `payments-cleanup-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Snapshot files BEFORE the failing submission.
    const baseDir = path.resolve(
      process.env.PAYMENT_RECEIPTS_DIR ?? './storage/payment-receipts',
    );
    const before = await fs.readdir(baseDir).catch(() => [] as string[]);

    const validated = await validateAndHashReceipt(
      buildPng(),
      'x.png',
      'image/png',
    );

    await expect(
      submitPayment({
        userId: citizen._id.toString(),
        amountMinor: 0, // forced failure — service guards amountMinor > 0
        paymentMethod: 'BANK_TRANSFER',
        receipt: validated,
        tempDir,
      }),
    ).rejects.toThrow();

    // The temp file the service wrote must be gone, and the storage
    // directory must not have gained a new committed file.
    const after = await fs.readdir(baseDir).catch(() => [] as string[]);
    expect(after.length).toBe(before.length);
    // The tempDir itself must also be cleaned up (the temp file was the
    // only thing inside it).
    const tempFiles = await fs.readdir(tempDir).catch(() => [] as string[]);
    expect(tempFiles.length).toBe(0);
  });
});