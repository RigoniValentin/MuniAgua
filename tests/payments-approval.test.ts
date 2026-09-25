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
import { postMovement } from '../src/modules/accounts/accounts.service';
import { AccountMovement } from '../src/modules/accounts/account-movements.model';
import { buildPng } from './payment-fixtures';

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
  permissions?: string[],
) {
  const user = await createUser({
    firstName: role,
    lastName: 'Test',
    email,
    password: 'Password123',
    role: ROLES[role],
  });
  if (permissions) {
    user.permissions = permissions as typeof user.permissions;
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

async function seedLinkedClient(userId: mongoose.Types.ObjectId) {
  const idx = Math.floor(Math.random() * 1_000_000_000);
  return Client.create({
    firstName: 'Test',
    lastName: `Client${idx}`,
    documentType: 'DNI',
    documentNumber: idx.toString(),
    clientType: 'LOCAL',
    address: { street: 'Av. San Martín', number: '123', locality: 'Buchardo' },
    userId,
    active: true,
  });
}

async function uploadPayment(token: string, amountMinor = 400_000) {
  const res = await request(app)
    .post('/api/payments/me')
    .set('Authorization', `Bearer ${token}`)
    .field('amountMinor', String(amountMinor))
    .field('paymentMethod', 'BANK_TRANSFER')
    .attach('receipt', buildPng(), 'transfer.png');
  return res;
}

// ===========================================================================
// Approval
// ===========================================================================

describe('Approval workflow', () => {
  it('Cliente DEBT $10.000, Payment $4.000 → APPROVED, balance DEBT $6.000', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedLinkedClient(citizen._id);
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    // Seed initial ledger
    await postMovement({
      clientId: client._id.toString(),
      direction: 'DEBIT',
      amountMinor: 1_000_000,
      movementType: 'MANUAL_ADJUSTMENT',
      description: 'Saldo inicial',
    });

    const created = await uploadPayment(citizenToken, 400_000);
    expect(created.status).toBe(201);
    const paymentId = created.body.data.payment.id;

    // Approve
    const approve = await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(approve.status).toBe(200);
    expect(approve.body.data.payment.status).toBe('APPROVED');

    // Ledger check
    const movements = await AccountMovement.find({ clientId: client._id }).sort({ _id: 1 });
    expect(movements).toHaveLength(2);
    const credit = movements.find((m) => m.direction === 'CREDIT');
    expect(credit).toBeDefined();
    expect(credit!.movementType).toBe('PAYMENT');
    expect(credit!.sourceType).toBe('PAYMENT');
    expect(credit!.sourceId?.toString()).toBe(paymentId);

    const debits = movements.filter((m) => m.direction === 'DEBIT');
    const credits = movements.filter((m) => m.direction === 'CREDIT');
    const balance = debits.reduce((s, m) => s + m.amountMinor, 0) - credits.reduce((s, m) => s + m.amountMinor, 0);
    expect(balance).toBe(600_000); // 1.000.000 - 400.000 = 600.000 DEBT
  });

  it('Payment APPROVED expone ledgerMovementId y reviewedAt', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    const detail = await request(app)
      .get(`/api/payments/${paymentId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.payment.status).toBe('APPROVED');
    expect(detail.body.data.payment.ledgerMovementId).toBeDefined();
    expect(detail.body.data.payment.reviewedAt).toBeDefined();
    expect(detail.body.data.payment.reviewedBy).toBeDefined();
  });

  it('Aprobar dos veces → 409', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    const first = await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(second.status).toBe(409);

    // Verify only ONE CREDIT exists
    const { Payment } = await import('../src/modules/payments/payments.model');
    const payment = await Payment.findById(paymentId);
    const ledgerCount = await AccountMovement.countDocuments({
      clientId: payment!.clientId,
      movementType: 'PAYMENT',
      sourceId: paymentId,
    });
    expect(ledgerCount).toBe(1);
  });

  it('Aprobar payment inexistente → 404', async () => {
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const fakeId = new mongoose.Types.ObjectId().toString();

    const res = await request(app)
      .post(`/api/payments/${fakeId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('SUPER_ADMIN también puede aprobar', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    const superAdmin = await seedUser('SUPER_ADMIN', 'super@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const superToken = await loginAs('super@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    const res = await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(200);
    void superAdmin;
  });

  it('OPERADOR NO puede aprobar (403)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    await seedUser('OPERADOR', 'op@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const opToken = await loginAs('op@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    const res = await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${opToken}`);
    expect(res.status).toBe(403);
  });

  it('CIUDADANO NO puede aprobar (403)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    const res = await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${citizenToken}`);
    expect(res.status).toBe(403);
  });

  it('REPARTIDOR NO puede aprobar (403)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    await seedUser('REPARTIDOR', 'rep@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const repToken = await loginAs('rep@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    const res = await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${repToken}`);
    expect(res.status).toBe(403);
  });

  it('Approve de payment REJECTED → 409', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    const reject = await request(app)
      .post(`/api/payments/${paymentId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Comprobante ilegible' });
    expect(reject.status).toBe(200);

    const approve = await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(approve.status).toBe(409);
  });
});

// ===========================================================================
// Rejection
// ===========================================================================

describe('Rejection workflow', () => {
  it('REJECTED no genera movimiento en ledger', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedLinkedClient(citizen._id);
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    const reject = await request(app)
      .post(`/api/payments/${paymentId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Comprobante ilegible' });
    expect(reject.status).toBe(200);

    const movements = await AccountMovement.find({ clientId: client._id });
    expect(movements).toHaveLength(0);
  });

  it('REJECTED guarda motivo', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    await request(app)
      .post(`/api/payments/${paymentId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Comprobante ilegible' });

    const detail = await request(app)
      .get(`/api/payments/${paymentId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detail.body.data.payment.status).toBe('REJECTED');
    expect(detail.body.data.payment.rejectionReason).toBe('Comprobante ilegible');
  });

  it('REJECT sin reason → 400', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    const res = await request(app)
      .post(`/api/payments/${paymentId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('Segundo reject → 409', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    const first = await request(app)
      .post(`/api/payments/${paymentId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'r1' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/payments/${paymentId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'r2' });
    expect(second.status).toBe(409);
  });

  it('Approve después de reject → 409', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    await request(app)
      .post(`/api/payments/${paymentId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'r' });

    const approve = await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(approve.status).toBe(409);
  });
});

// ===========================================================================
// Reversal
// ===========================================================================

describe('Reversal workflow', () => {
  it('Approve + reverse: balance vuelve al original', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const client = await seedLinkedClient(citizen._id);
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    await postMovement({
      clientId: client._id.toString(),
      direction: 'DEBIT',
      amountMinor: 1_000_000,
      movementType: 'MANUAL_ADJUSTMENT',
      description: 'Saldo inicial',
    });

    const created = await uploadPayment(citizenToken, 400_000);
    const paymentId = created.body.data.payment.id;

    await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    // After approve: balance = 600_000 (DEBT)
    const afterApprove = await AccountMovement.find({ clientId: client._id });
    const balanceAfterApprove =
      afterApprove.filter((m) => m.direction === 'DEBIT').reduce((s, m) => s + m.amountMinor, 0) -
      afterApprove.filter((m) => m.direction === 'CREDIT').reduce((s, m) => s + m.amountMinor, 0);
    expect(balanceAfterApprove).toBe(600_000);

    // Reverse
    const reverse = await request(app)
      .post(`/api/payments/${paymentId}/reverse-approval`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Aprobado por error' });
    expect(reverse.status).toBe(200);
    expect(reverse.body.data.payment.status).toBe('REVERSED');

    // After reverse: balance = 1_000_000 (DEBT)
    const afterReverse = await AccountMovement.find({ clientId: client._id });
    const balanceAfterReverse =
      afterReverse.filter((m) => m.direction === 'DEBIT').reduce((s, m) => s + m.amountMinor, 0) -
      afterReverse.filter((m) => m.direction === 'CREDIT').reduce((s, m) => s + m.amountMinor, 0);
    expect(balanceAfterReverse).toBe(1_000_000);

    // Ledger now has: DEBIT 1.000.000 (initial), CREDIT 400.000 (approve),
    // REVERSAL DEBIT 400.000 (reverse) → net balance 1.000.000.
    expect(afterReverse).toHaveLength(3);
    const reversal = afterReverse.find((m) => m.movementType === 'REVERSAL');
    expect(reversal).toBeDefined();
    expect(reversal!.direction).toBe('DEBIT');
    expect(reversal!.amountMinor).toBe(400_000);
    expect(reversal!.reversesMovementId).toBeDefined();

    // Payment REVERSED con reversalMovementId
    const detail = await request(app)
      .get(`/api/payments/${paymentId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detail.body.data.payment.status).toBe('REVERSED');
    expect(detail.body.data.payment.reversalMovementId).toBeDefined();
    expect(detail.body.data.payment.reversedAt).toBeDefined();
  });

  it('Segundo reverse → 409', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    const first = await request(app)
      .post(`/api/payments/${paymentId}/reverse-approval`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'r' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/payments/${paymentId}/reverse-approval`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'r2' });
    expect(second.status).toBe(409);
  });

  it('OPERADOR NO puede revertir (403)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    await seedUser('OPERADOR', 'op@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');
    const opToken = await loginAs('op@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    await request(app)
      .post(`/api/payments/${paymentId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    const res = await request(app)
      .post(`/api/payments/${paymentId}/reverse-approval`)
      .set('Authorization', `Bearer ${opToken}`)
      .send({ reason: 'r' });
    expect(res.status).toBe(403);
  });

  it('Reverse de payment PENDING → 409', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    const res = await request(app)
      .post(`/api/payments/${paymentId}/reverse-approval`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'r' });
    expect(res.status).toBe(409);
  });
});

// ===========================================================================
// Receipt endpoints (admin)
// ===========================================================================

describe('Admin receipt endpoint', () => {
  it('ADMIN con payments.read puede descargar comprobante', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    void await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    const res = await request(app)
      .get(`/api/payments/${paymentId}/receipt`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toMatch(/private.*no-store/);
  });

  it('REPARTIDOR no puede descargar comprobante (403)', async () => {
    const citizen = await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    await seedLinkedClient(citizen._id);
    await seedUser('REPARTIDOR', 'rep@buchardo.gob.ar');
    const citizenToken = await loginAs('vecino@buchardo.gob.ar');
    const repToken = await loginAs('rep@buchardo.gob.ar');

    const created = await uploadPayment(citizenToken);
    const paymentId = created.body.data.payment.id;

    const res = await request(app)
      .get(`/api/payments/${paymentId}/receipt`)
      .set('Authorization', `Bearer ${repToken}`);
    expect(res.status).toBe(403);
  });
});