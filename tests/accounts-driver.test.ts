/**
 * Ajustes de cuenta corriente hechos por el repartidor (cobro en el domicilio).
 *
 * Cubre:
 *   - La escritura en el ledger (movementType DRIVER_ADJUSTMENT, sourceType DRIVER).
 *   - La auditoría: actor, rol congelado y nombre visible para el admin.
 *   - La separación de permisos: el repartidor NO entra al flujo admin.
 *   - La reversión por parte del admin y la inmutabilidad del libro.
 *   - Idempotencia y validaciones de entrada.
 */
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
import { User } from '../src/modules/users/users.model';
import { AccountMovement } from '../src/modules/accounts/account-movements.model';

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

async function seedUser(
  role: keyof typeof ROLES,
  email: string,
  firstName?: string,
) {
  return createUser({
    firstName: firstName ?? role,
    lastName: 'Test',
    email,
    password: 'Password123',
    role: ROLES[role],
  });
}

async function loginAs(email: string) {
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

let clientSeq = 0;

async function seedClient(opts: {
  clientType?: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';
  active?: boolean;
  firstName?: string;
  lastName?: string;
} = {}) {
  clientSeq += 1;
  return Client.create({
    firstName: opts.firstName ?? 'Vecina',
    lastName: opts.lastName ?? `Cliente${clientSeq}`,
    documentType: 'DNI',
    documentNumber: (10000000 + clientSeq).toString(),
    clientType: opts.clientType ?? 'LOCAL',
    address: baseAddress,
    userId: null,
    active: opts.active ?? true,
  });
}

function driverBody(overrides: Record<string, unknown> = {}) {
  return {
    direction: 'DEBIT',
    amountMinor: 500_000,
    description: 'Cobro en el domicilio',
    ...overrides,
  };
}

// ===========================================================================
// Escritura en el ledger
// ===========================================================================

describe('Ajustes de repartidor — escritura en el ledger', () => {
  it('registra un DEBIT y refleja el saldo del cliente', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    const res = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(driverBody());

    expect(res.status).toBe(201);
    expect(res.body.data.movement).toMatchObject({
      clientId: client._id.toString(),
      direction: 'DEBIT',
      amountMinor: 500_000,
      signedAmountMinor: 500_000,
      movementType: 'DRIVER_ADJUSTMENT',
      sourceType: 'DRIVER',
      description: 'Cobro en el domicilio',
    });

    const summary = await request(app)
      .get(`/api/accounts/${client._id.toString()}/summary`)
      .set('Authorization', `Bearer ${token}`);
    expect(summary.status).toBe(200);
    expect(summary.body.data.account).toMatchObject({
      totalDebitsMinor: 500_000,
      totalCreditsMinor: 0,
      balanceMinor: 500_000,
      status: 'DEBT',
    });
  });

  it('registra un CREDIT y deja saldo a favor', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    const res = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(driverBody({ direction: 'CREDIT', amountMinor: 250_000 }));

    expect(res.status).toBe(201);
    expect(res.body.data.movement.signedAmountMinor).toBe(-250_000);

    const summary = await request(app)
      .get(`/api/accounts/${client._id.toString()}/summary`)
      .set('Authorization', `Bearer ${token}`);
    expect(summary.body.data.account).toMatchObject({
      balanceMinor: -250_000,
      status: 'CREDIT',
    });
  });

  it('estampa la auditoría: autor, rol congelado y nombre visible', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    const res = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(driverBody());

    const movement = res.body.data.movement;
    expect(movement.createdByRole).toBe('REPARTIDOR');
    expect(movement.createdByName).toBe('REPARTIDOR Test');
    expect(movement.createdBy).toBeTruthy();

    const stored = await AccountMovement.findById(movement.id);
    expect(stored?.createdByRole).toBe('REPARTIDOR');
    expect(stored?.createdBy?.toString()).toBe(movement.createdBy);
  });

  it('el rol congelado sobrevive a un cambio de rol posterior del usuario', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    const res = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(driverBody());
    expect(res.status).toBe(201);

    // El usuario cambia de rol después del hecho: el rastro histórico no se
    // debe reescribir.
    await User.updateOne(
      { email: 'repartidor@buchardo.gob.ar' },
      { $set: { role: ROLES.ADMIN } },
    );

    const stored = await AccountMovement.findById(res.body.data.movement.id);
    expect(stored?.createdByRole).toBe('REPARTIDOR');
  });

  it('permite registrar movimientos sobre clientes inactivos', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient({ active: false });

    const res = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(driverBody());

    expect(res.status).toBe(201);
  });
});

// ===========================================================================
// Permisos
// ===========================================================================

describe('Ajustes de repartidor — permisos', () => {
  it('el repartidor NO puede usar el flujo de ajuste administrativo', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    const res = await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(driverBody());

    expect(res.status).toBe(403);
  });

  it('el repartidor NO puede revertir movimientos', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    const created = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(driverBody());

    const res = await request(app)
      .post(
        `/api/accounts/movements/${created.body.data.movement.id}/reverse`,
      )
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'Me equivoqué' });

    expect(res.status).toBe(403);
  });

  it('el ADMIN y el OPERADOR no pueden usar la ruta del repartidor', async () => {
    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    await seedUser('OPERADOR', 'operador@buchardo.gob.ar');
    const client = await seedClient();

    for (const email of ['admin@buchardo.gob.ar', 'operador@buchardo.gob.ar']) {
      const token = await loginAs(email);
      const res = await request(app)
        .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
        .set('Authorization', `Bearer ${token}`)
        .send(driverBody());
      expect(res.status).toBe(403);
    }
  });

  it('el CIUDADANO no puede registrar ajustes', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');
    const client = await seedClient();

    const res = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(driverBody());

    expect(res.status).toBe(403);
  });

  it('un repartidor puede leer el saldo del cliente (accounts.read)', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    const res = await request(app)
      .get(`/api/accounts/${client._id.toString()}/summary`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// Reversión por parte del admin
// ===========================================================================

describe('Ajustes de repartidor — reversión administrativa', () => {
  it('el admin revierte el ajuste y el saldo vuelve al estado anterior', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const repToken = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    const created = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${repToken}`)
      .send(driverBody({ amountMinor: 750_000 }));
    expect(created.status).toBe(201);
    const movementId = created.body.data.movement.id;

    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const reversal = await request(app)
      .post(`/api/accounts/movements/${movementId}/reverse`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ description: 'Ajuste duplicado del repartidor' });

    expect(reversal.status).toBe(201);
    expect(reversal.body.data.reversal).toMatchObject({
      movementType: 'REVERSAL',
      direction: 'CREDIT',
      amountMinor: 750_000,
      reversesMovementId: movementId,
      createdByRole: 'ADMIN',
    });

    // El original sigue existiendo: el libro es append-only.
    const original = await AccountMovement.findById(movementId);
    expect(original).not.toBeNull();
    expect(original?.movementType).toBe('DRIVER_ADJUSTMENT');

    const summary = await request(app)
      .get(`/api/accounts/${client._id.toString()}/summary`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(summary.body.data.account).toMatchObject({
      totalDebitsMinor: 750_000,
      totalCreditsMinor: 750_000,
      balanceMinor: 0,
      status: 'SETTLED',
    });
  });

  it('devuelve 409 al intentar revertir dos veces el mismo ajuste', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const repToken = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    const created = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${repToken}`)
      .send(driverBody());
    const movementId = created.body.data.movement.id;

    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const first = await request(app)
      .post(`/api/accounts/movements/${movementId}/reverse`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ description: 'Corrección' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/accounts/movements/${movementId}/reverse`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ description: 'Corrección repetida' });
    expect(second.status).toBe(409);
  });

  it('el admin ve el autor del movimiento en el historial del cliente', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar', 'Ezequiel');
    const repToken = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${repToken}`)
      .send(driverBody());

    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    const res = await request(app)
      .get(`/api/accounts/${client._id.toString()}/movements`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const item = res.body.data.items[0];
    expect(item.movementType).toBe('DRIVER_ADJUSTMENT');
    expect(item.createdByName).toBe('Ezequiel Test');
    expect(item.createdByRole).toBe('REPARTIDOR');
  });

  it('el admin puede filtrar el historial por origen repartidor', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const repToken = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${repToken}`)
      .send(driverBody());

    await seedUser('ADMIN', 'admin@buchardo.gob.ar');
    const adminToken = await loginAs('admin@buchardo.gob.ar');

    await request(app)
      .post(`/api/accounts/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        direction: 'DEBIT',
        amountMinor: 100_000,
        description: 'Ajuste de administración',
      });

    const filtered = await request(app)
      .get(
        `/api/accounts/${client._id.toString()}/movements?movementType=DRIVER_ADJUSTMENT`,
      )
      .set('Authorization', `Bearer ${adminToken}`);

    expect(filtered.status).toBe(200);
    expect(filtered.body.data.pagination.total).toBe(1);
    expect(filtered.body.data.items[0].movementType).toBe('DRIVER_ADJUSTMENT');
  });
});

// ===========================================================================
// Listado propio del repartidor
// ===========================================================================

describe('Ajustes de repartidor — listado propio', () => {
  it('devuelve solo los movimientos del repartidor autenticado', async () => {
    await seedUser('REPARTIDOR', 'repartidor1@buchardo.gob.ar');
    await seedUser('REPARTIDOR', 'repartidor2@buchardo.gob.ar');
    const token1 = await loginAs('repartidor1@buchardo.gob.ar');
    const token2 = await loginAs('repartidor2@buchardo.gob.ar');
    const client = await seedClient();

    await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token1}`)
      .send(driverBody({ amountMinor: 100_000 }));

    await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token2}`)
      .send(driverBody({ amountMinor: 200_000 }));

    const res = await request(app)
      .get('/api/accounts/driver/me/movements')
      .set('Authorization', `Bearer ${token1}`);

    expect(res.status).toBe(200);
    expect(res.body.data.pagination.total).toBe(1);
    expect(res.body.data.items[0].amountMinor).toBe(100_000);
    expect(res.body.data.items[0].clientName).toBeTruthy();
  });

  it('filtra por dirección', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(driverBody({ direction: 'DEBIT', amountMinor: 100_000 }));
    await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(driverBody({ direction: 'CREDIT', amountMinor: 200_000 }));

    const res = await request(app)
      .get('/api/accounts/driver/me/movements?direction=CREDIT')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.pagination.total).toBe(1);
    expect(res.body.data.items[0].direction).toBe('CREDIT');
  });

  it('el ciudadano no puede listar ajustes de repartidor', async () => {
    await seedUser('CIUDADANO', 'vecino@buchardo.gob.ar');
    const token = await loginAs('vecino@buchardo.gob.ar');

    const res = await request(app)
      .get('/api/accounts/driver/me/movements')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Validaciones e idempotencia
// ===========================================================================

describe('Ajustes de repartidor — validaciones', () => {
  it('rechaza importes no positivos o no enteros', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    for (const amountMinor of [0, -100, 10.5]) {
      const res = await request(app)
        .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
        .set('Authorization', `Bearer ${token}`)
        .send(driverBody({ amountMinor }));
      expect(res.status).toBe(400);
    }
  });

  it('exige un motivo', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    const res = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(driverBody({ description: '   ' }));

    expect(res.status).toBe(400);
  });

  it('impide que el repartidor se atribuya el movimiento a otro usuario', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    const res = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(
        driverBody({
          createdBy: new mongoose.Types.ObjectId().toString(),
          movementType: 'MANUAL_ADJUSTMENT',
          sourceType: 'MANUAL',
        }),
      );

    expect(res.status).toBe(400);
    expect(await AccountMovement.countDocuments({})).toBe(0);
  });

  it('devuelve 404 cuando el cliente no existe', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');

    const res = await request(app)
      .post(
        `/api/accounts/driver/${new mongoose.Types.ObjectId().toString()}/adjustments`,
      )
      .set('Authorization', `Bearer ${token}`)
      .send(driverBody());

    expect(res.status).toBe(404);
  });

  it('es idempotente: la misma clave y el mismo cuerpo no duplican el movimiento', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    const body = driverBody({ idempotencyKey: 'driver-abc-123' });

    const first = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    const second = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.movement.id).toBe(first.body.data.movement.id);
    expect(await AccountMovement.countDocuments({})).toBe(1);
  });

  it('devuelve 409 si la misma clave se reutiliza con otro cuerpo', async () => {
    await seedUser('REPARTIDOR', 'repartidor@buchardo.gob.ar');
    const token = await loginAs('repartidor@buchardo.gob.ar');
    const client = await seedClient();

    const body = driverBody({ idempotencyKey: 'driver-abc-123' });

    await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

    const conflict = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .send(driverBody({ idempotencyKey: 'driver-abc-123', amountMinor: 999 }));

    expect(conflict.status).toBe(409);
    expect(await AccountMovement.countDocuments({})).toBe(1);
  });

  it('requiere autenticación', async () => {
    const client = await seedClient();
    const res = await request(app)
      .post(`/api/accounts/driver/${client._id.toString()}/adjustments`)
      .send(driverBody());
    expect(res.status).toBe(401);
  });
});
