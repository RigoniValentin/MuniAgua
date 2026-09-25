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
import {
  AccountMovement,
} from '../src/modules/accounts/account-movements.model';
import { postMovement } from '../src/modules/accounts/accounts.service';

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

const baseAddress = { street: 'Av. San Martín', number: '123', locality: 'Buchardo' };

async function seedClient(opts: {
  clientType?: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';
  userId?: mongoose.Types.ObjectId | null;
  active?: boolean;
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
    clientType: opts.clientType ?? 'LOCAL',
    address: baseAddress,
    userId: opts.userId ?? null,
    active: opts.active ?? true,
  });
}

function validAdjustmentBody(overrides: Record<string, unknown> = {}) {
  return {
    direction: 'DEBIT',
    amountMinor: 1_000_000,
    description: 'Saldo inicial pendiente',
    ...overrides,
  };
}

// ===========================================================================
// Balance computation (the heart of FASE 4)
// ===========================================================================

describe('Account ledger — balance computation', () => {
  it('starts SETTLED at zero for a new client', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();
    const res = await request(app)
      .get(`/api/accounts/${client._id.toString()}/summary`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.account).toMatchObject({
      totalDebitsMinor: 0,
      totalCreditsMinor: 0,
      balanceMinor: 0,
      status: 'SETTLED',
      lastMovementAt: null,
    });
  });

  it('DEBIT $10.000 → balance +$10.000 (DEBT)', async () => {
    const admin = await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();

    await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 1_000_000 }));

    const res = await request(app)
      .get(`/api/accounts/${client._id.toString()}/summary`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.account).toMatchObject({
      totalDebitsMinor: 1_000_000,
      totalCreditsMinor: 0,
      balanceMinor: 1_000_000,
      status: 'DEBT',
    });
    void admin;
  });

  it('DEBIT $10.000 + CREDIT $3.000 → balance +$7.000 (DEBT)', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();

    await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 1_000_000 }));
    await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ direction: 'CREDIT', amountMinor: 300_000 }));

    const res = await request(app)
      .get(`/api/accounts/${client._id.toString()}/summary`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.data.account.balanceMinor).toBe(700_000);
    expect(res.body.data.account.status).toBe('DEBT');
  });

  it('DEBIT $10.000 + CREDIT $3.000 + CREDIT $10.000 → balance -$3.000 (CREDIT)', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();

    await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 1_000_000 }));
    await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ direction: 'CREDIT', amountMinor: 300_000 }));
    await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ direction: 'CREDIT', amountMinor: 1_000_000 }));

    const res = await request(app)
      .get(`/api/accounts/${client._id.toString()}/summary`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.data.account.balanceMinor).toBe(-300_000);
    expect(res.body.data.account.status).toBe('CREDIT');
  });
});

// ===========================================================================
// Reversal
// ===========================================================================

describe('Account ledger — reversal', () => {
  it('reverses a DEBIT $10.000 with a CREDIT $10.000 (REVERSAL)', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();

    const created = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 1_000_000 }));
    const movementId = created.body.data.movement.id;
    expect(created.body.data.movement.direction).toBe('DEBIT');

    const reversalRes = await request(app)
      .post(`/api/accounts/movements/${movementId}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'Reversión de ajuste incorrecto.' });

    expect(reversalRes.status).toBe(201);
    expect(reversalRes.body.data.reversal).toMatchObject({
      direction: 'CREDIT',
      amountMinor: 1_000_000,
      movementType: 'REVERSAL',
      sourceType: 'REVERSAL',
      reversesMovementId: movementId,
    });

    const summaryRes = await request(app)
      .get(`/api/accounts/${client._id.toString()}/summary`)
      .set('Authorization', `Bearer ${token}`);
    expect(summaryRes.body.data.account.balanceMinor).toBe(0);
    expect(summaryRes.body.data.account.status).toBe('SETTLED');
  });

  it('keeps the original movement intact and reachable via history', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();

    const created = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 1_000_000 }));
    const movementId = created.body.data.movement.id;

    await request(app)
      .post(`/api/accounts/movements/${movementId}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'Reversión' });

    const original = await AccountMovement.findById(movementId);
    expect(original).not.toBeNull();
    expect(original!.direction).toBe('DEBIT');
    expect(original!.movementType).toBe('MANUAL_ADJUSTMENT');
  });

  it('returns 409 when attempting to reverse the same movement twice', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();

    const created = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 1_000_000 }));
    const movementId = created.body.data.movement.id;

    const first = await request(app)
      .post(`/api/accounts/movements/${movementId}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'Reversión' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/accounts/movements/${movementId}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'Intento duplicado' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
  });

  it('rejects reversal of a REVERSAL movement', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();

    const created = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 1_000_000 }));
    const movementId = created.body.data.movement.id;
    const reversalRes = await request(app)
      .post(`/api/accounts/movements/${movementId}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'Reversión' });
    const reversalId = reversalRes.body.data.reversal.id;

    const res = await request(app)
      .post(`/api/accounts/movements/${reversalId}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'No se puede revertir una reversión' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ===========================================================================
// Immutability / API surface
// ===========================================================================

describe('Account ledger — immutability of the API', () => {
  it('does not expose PATCH /:movementId', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();

    const created = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 1_000_000 }));
    const movementId = created.body.data.movement.id;

    const patch = await request(app)
      .patch(`/api/accounts/movements/${movementId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'should not work' });
    expect(patch.status).toBe(404);

    const del = await request(app)
      .delete(`/api/accounts/movements/${movementId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(404);
  });

  it('the original movement is not modified during a reversal', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();

    const created = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 1_000_000 }));
    const movementId = created.body.data.movement.id;

    const before = await AccountMovement.findById(movementId);
    const beforeSnapshot = {
      direction: before!.direction,
      amountMinor: before!.amountMinor,
      movementType: before!.movementType,
      reversesMovementId: before!.reversesMovementId
        ? before!.reversesMovementId.toString()
        : null,
    };

    await request(app)
      .post(`/api/accounts/movements/${movementId}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'Reversión' });

    const after = await AccountMovement.findById(movementId);
    expect({
      direction: after!.direction,
      amountMinor: after!.amountMinor,
      movementType: after!.movementType,
      reversesMovementId: after!.reversesMovementId
        ? after!.reversesMovementId.toString()
        : null,
    }).toEqual(beforeSnapshot);
  });
});

// ===========================================================================
// Idempotency (postMovement service)
// ===========================================================================

describe('Account ledger — idempotency', () => {
  it('returns the same movement when called twice with the same idempotencyKey', async () => {
    const client = await seedClient();
    const key = `TEST:EVENT:${Date.now()}`;
    const a = await postMovement({
      clientId: client._id.toString(),
      direction: 'DEBIT',
      amountMinor: 500_000,
      movementType: 'MANUAL_ADJUSTMENT',
      description: 'carga',
      sourceType: 'MANUAL',
      idempotencyKey: key,
    });
    const b = await postMovement({
      clientId: client._id.toString(),
      direction: 'DEBIT',
      amountMinor: 500_000,
      movementType: 'MANUAL_ADJUSTMENT',
      description: 'carga',
      sourceType: 'MANUAL',
      idempotencyKey: key,
    });
    expect(a._id.toString()).toBe(b._id.toString());
    const count = await AccountMovement.countDocuments();
    expect(count).toBe(1);
  });

  it('throws IdempotencyConflictError when same key is used with a different payload', async () => {
    const client = await seedClient();
    const key = `TEST:CONFLICT:${Date.now()}`;
    await postMovement({
      clientId: client._id.toString(),
      direction: 'DEBIT',
      amountMinor: 500_000,
      movementType: 'MANUAL_ADJUSTMENT',
      description: 'carga',
      sourceType: 'MANUAL',
      idempotencyKey: key,
    });
    await expect(
      postMovement({
        clientId: client._id.toString(),
        direction: 'CREDIT',
        amountMinor: 500_000,
        movementType: 'MANUAL_ADJUSTMENT',
        description: 'carga',
        sourceType: 'MANUAL',
        idempotencyKey: key,
      }),
    ).rejects.toThrow(/Conflicto|Conflict|409|conflict/i);
  });

  it('allows multiple movements with no idempotencyKey', async () => {
    const client = await seedClient();
    await postMovement({
      clientId: client._id.toString(),
      direction: 'DEBIT',
      amountMinor: 100,
      movementType: 'MANUAL_ADJUSTMENT',
      description: 'a',
      sourceType: 'MANUAL',
    });
    await postMovement({
      clientId: client._id.toString(),
      direction: 'DEBIT',
      amountMinor: 100,
      movementType: 'MANUAL_ADJUSTMENT',
      description: 'b',
      sourceType: 'MANUAL',
    });
    const count = await AccountMovement.countDocuments();
    expect(count).toBe(2);
  });
});

// ===========================================================================
// Validation
// ===========================================================================

describe('Account ledger — validation', () => {
  beforeEach(async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
  });

  it('rejects amountMinor = 0', async () => {
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();
    const res = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 0 }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects negative amountMinor', async () => {
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();
    const res = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: -100 }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects decimal amountMinor', async () => {
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();
    const res = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 100.5 }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid direction', async () => {
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();
    const res = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ direction: 'INVALID' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects empty description', async () => {
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();
    const res = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ description: '   ' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid clientId in path', async () => {
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/accounts/not-a-valid-id/summary')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid movementId in reversal path', async () => {
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post('/api/accounts/movements/not-a-valid-id/reverse')
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for non-existent client', async () => {
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .get(`/api/accounts/${new mongoose.Types.ObjectId().toString()}/summary`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for non-existent movement', async () => {
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .post(`/api/accounts/movements/${new mongoose.Types.ObjectId().toString()}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('forbids clients from setting movementType / sourceType / createdBy', async () => {
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();
    const res = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        direction: 'DEBIT',
        amountMinor: 1000,
        description: 'forzar payment',
        movementType: 'PAYMENT',
        sourceType: 'PAYMENT',
        createdBy: new mongoose.Types.ObjectId().toString(),
      });
    // Strict zod schemas reject unknown keys.
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Permissions matrix
// ===========================================================================

describe('Account ledger — permissions', () => {
  it('SUPER_ADMIN: read + adjust + reverse', async () => {
    await seedUser('SUPER_ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();

    const adjust = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody());
    expect(adjust.status).toBe(201);
    const movementId = adjust.body.data.movement.id;

    const reverse = await request(app)
      .post(`/api/accounts/movements/${movementId}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'r' });
    expect(reverse.status).toBe(201);
  });

  it('ADMIN: read + adjust + reverse', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();
    const adjust = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody());
    expect(adjust.status).toBe(201);
    const reverse = await request(app)
      .post(`/api/accounts/movements/${adjust.body.data.movement.id}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'r' });
    expect(reverse.status).toBe(201);
  });

  it('OPERADOR: read + adjust, NO reverse', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();

    const seed = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(validAdjustmentBody());
    const movementId = seed.body.data.movement.id;

    await seedUser('OPERADOR', 'operador@buchardo.gob.ar');
    const opToken = await loginAs('operador@buchardo.gob.ar');

    const list = await request(app)
      .get(`/api/accounts/${client._id.toString()}/summary`)
      .set('Authorization', `Bearer ${opToken}`);
    expect(list.status).toBe(200);

    const adjust = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${opToken}`)
      .send(validAdjustmentBody({ amountMinor: 200_000 }));
    expect(adjust.status).toBe(201);

    const reverse = await request(app)
      .post(`/api/accounts/movements/${movementId}/reverse`)
      .set('Authorization', `Bearer ${opToken}`)
      .send({ description: 'no' });
    expect(reverse.status).toBe(403);
  });

  it('REPARTIDOR: read only', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();
    await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(validAdjustmentBody());

    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const repToken = await loginAs('repartidor@buchardo.gob.ar');

    const list = await request(app)
      .get(`/api/accounts/${client._id.toString()}/summary`)
      .set('Authorization', `Bearer ${repToken}`);
    expect(list.status).toBe(200);

    const adjust = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${repToken}`)
      .send(validAdjustmentBody());
    expect(adjust.status).toBe(403);
  });

  it('CIUDADANO: cannot read /api/accounts', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');

    const list = await request(app)
      .get('/api/accounts')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(403);

    const detail = await request(app)
      .get(`/api/accounts/${new mongoose.Types.ObjectId().toString()}/summary`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(403);
  });
});

// ===========================================================================
// Inactive clients
// ===========================================================================

describe('Account ledger — inactive clients', () => {
  it('allows reading the account of an inactive client', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient({ active: false });

    const summary = await request(app)
      .get(`/api/accounts/${client._id.toString()}/summary`)
      .set('Authorization', `Bearer ${token}`);
    expect(summary.status).toBe(200);
    expect(summary.body.data.client.active).toBe(false);

    const movements = await request(app)
      .get(`/api/accounts/${client._id.toString()}/movements`)
      .set('Authorization', `Bearer ${token}`);
    expect(movements.status).toBe(200);
  });

  it('allows ADMIN to post adjustments on inactive clients', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient({ active: false });

    const res = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody());
    expect(res.status).toBe(201);
  });
});

// ===========================================================================
// Citizen /me privacy
// ===========================================================================

describe('Account ledger — citizen /me', () => {
  async function seedLinkedClientFor(role: keyof typeof ROLES, email: string) {
    const user = await seedUser(role, email);
    const client = await seedClient({ userId: user._id });
    return { user, client };
  }

  it('returns the linked client summary for the authenticated ciudadano', async () => {
    const { client } = await seedLinkedClientFor('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(validAdjustmentBody({ amountMinor: 750_000 }));

    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/accounts/me/summary')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.client.id).toBe(client._id.toString());
    expect(res.body.data.account.balanceMinor).toBe(750_000);
    expect(res.body.data.account.status).toBe('DEBT');
  });

  it('CIUDADANO cannot access another citizen\'s summary', async () => {
    const { client: clientA } = await seedLinkedClientFor('CIUDADANO', 'vecino@buchardo.gob.ar');
    const { client: clientB } = await seedLinkedClientFor('CIUDADANO', 'other@buchardo.gob.ar');

    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .get(`/api/accounts/${clientB._id.toString()}/summary`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);

    const okRes = await request(app)
      .get(`/api/accounts/${clientA._id.toString()}/summary`)
      .set('Authorization', `Bearer ${token}`);
    // /me routes don't expose arbitrary clientIds — but the route exists for
    // staff. Verify the citizen cannot bypass by hitting /me/summary of B.
    void okRes;
  });

  it('CIUDADANO cannot list staff endpoints', async () => {
    await seedLinkedClientFor('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');

    const list = await request(app)
      .get('/api/accounts')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(403);

    const me = await request(app)
      .get('/api/accounts/me/movements')
      .set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
  });

  it('CIUDADANO without linked client gets a 404 CLIENT_NOT_LINKED', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/accounts/me/summary')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CLIENT_NOT_LINKED');
  });

  it('CIUDADANO without linked client also gets 404 CLIENT_NOT_LINKED on /me/movements', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/accounts/me/movements')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CLIENT_NOT_LINKED');
  });
});

// ===========================================================================
// Account list with balanceStatus filter
// ===========================================================================

describe('Account ledger — listing', () => {
  it('lists clients with their balance and status, paginates correctly', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const a = await seedClient({ firstName: 'Ana', lastName: 'Deuda' });
    const b = await seedClient({ firstName: 'Bruno', lastName: 'Credito' });
    const c = await seedClient({ firstName: 'Carla', lastName: 'Dia' });

    // A: DEBT
    await request(app)
      .post(`/api/accounts/${a._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 1_000_000 }));

    // B: CREDIT
    await request(app)
      .post(`/api/accounts/${b._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ direction: 'CREDIT', amountMinor: 200_000 }));
    // C: SETTLED (no movements)

    const allRes = await request(app)
      .get('/api/accounts?limit=100')
      .set('Authorization', `Bearer ${token}`);
    expect(allRes.status).toBe(200);
    expect(allRes.body.data.items).toHaveLength(3);
    const findItem = (clientId: string) =>
      allRes.body.data.items.find((it: { clientId: string }) => it.clientId === clientId);
    expect(findItem(a._id.toString()).status).toBe('DEBT');
    expect(findItem(a._id.toString()).balanceMinor).toBe(1_000_000);
    expect(findItem(b._id.toString()).status).toBe('CREDIT');
    expect(findItem(b._id.toString()).balanceMinor).toBe(-200_000);
    expect(findItem(c._id.toString()).status).toBe('SETTLED');
    expect(findItem(c._id.toString()).balanceMinor).toBe(0);
  });

  it('filters by balanceStatus and reflects totals in pagination metadata', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');

    const a = await seedClient({ firstName: 'Ana', lastName: 'Deuda' });
    const b = await seedClient({ firstName: 'Bruno', lastName: 'Credito' });
    const c = await seedClient({ firstName: 'Carla', lastName: 'Dia' });

    await request(app)
      .post(`/api/accounts/${a._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 1_000_000 }));
    await request(app)
      .post(`/api/accounts/${b._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ direction: 'CREDIT', amountMinor: 100_000 }));

    const debt = await request(app)
      .get('/api/accounts?balanceStatus=DEBT&limit=100')
      .set('Authorization', `Bearer ${token}`);
    expect(debt.body.data.items).toHaveLength(1);
    expect(debt.body.data.items[0].clientId).toBe(a._id.toString());
    expect(debt.body.data.pagination.total).toBe(1);

    const credit = await request(app)
      .get('/api/accounts?balanceStatus=CREDIT&limit=100')
      .set('Authorization', `Bearer ${token}`);
    expect(credit.body.data.items).toHaveLength(1);
    expect(credit.body.data.items[0].clientId).toBe(b._id.toString());
    expect(credit.body.data.pagination.total).toBe(1);

    const settled = await request(app)
      .get('/api/accounts?balanceStatus=SETTLED&limit=100')
      .set('Authorization', `Bearer ${token}`);
    expect(settled.body.data.items).toHaveLength(1);
    expect(settled.body.data.items[0].clientId).toBe(c._id.toString());
    expect(settled.body.data.pagination.total).toBe(1);
  });

  it('paginates the list respecting limit/page', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    for (let i = 0; i < 5; i++) {
      await seedClient({ firstName: `C${i}`, lastName: `Test${i}` });
    }
    const page1 = await request(app)
      .get('/api/accounts?page=1&limit=2')
      .set('Authorization', `Bearer ${token}`);
    expect(page1.body.data.items).toHaveLength(2);
    expect(page1.body.data.pagination.total).toBe(5);

    const page2 = await request(app)
      .get('/api/accounts?page=2&limit=2')
      .set('Authorization', `Bearer ${token}`);
    expect(page2.body.data.items).toHaveLength(2);

    const page3 = await request(app)
      .get('/api/accounts?page=3&limit=2')
      .set('Authorization', `Bearer ${token}`);
    expect(page3.body.data.items).toHaveLength(1);
  });

  it('rejects limit above maximum', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const res = await request(app)
      .get('/api/accounts?limit=500')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Movements listing
// ===========================================================================

describe('Account ledger — movements listing', () => {
  it('returns movements ordered desc by occurredAt', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();

    await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 100_000, description: 'a' }));
    await new Promise((r) => setTimeout(r, 5));
    await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 200_000, description: 'b' }));

    const res = await request(app)
      .get(`/api/accounts/${client._id.toString()}/movements`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.data.items[0].description).toBe('b');
    expect(res.body.data.items[1].description).toBe('a');
  });

  it('filters by direction and movementType', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();

    await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ amountMinor: 100_000 }));
    await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(validAdjustmentBody({ direction: 'CREDIT', amountMinor: 50_000 }));

    const debits = await request(app)
      .get(`/api/accounts/${client._id.toString()}/movements?direction=DEBIT`)
      .set('Authorization', `Bearer ${token}`);
    expect(debits.body.data.items).toHaveLength(1);

    const adjustments = await request(app)
      .get(`/api/accounts/${client._id.toString()}/movements?movementType=MANUAL_ADJUSTMENT`)
      .set('Authorization', `Bearer ${token}`);
    expect(adjustments.body.data.items).toHaveLength(2);
  });

  it('enforces the max limit', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const token = await loginAs('admin@buchardo.gob.ar');
    const client = await seedClient();
    const res = await request(app)
      .get(`/api/accounts/${client._id.toString()}/movements?limit=500`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
