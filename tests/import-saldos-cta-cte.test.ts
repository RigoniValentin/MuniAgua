/* eslint-disable no-console */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Client } from '../src/modules/clients/clients.model';
import { AccountMovement } from '../src/modules/accounts/account-movements.model';
import type { ClientType } from '../src/modules/clients/clients.types';

const exec = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_CSV = path.resolve(__dirname, 'fixtures', 'saldos-cta-cte.csv');

interface RunEnv {
  uri: string;
  outDir: string;
}

/**
 * Clients seeded in the test DB. NOTE the orientation: `firstName` holds the
 * SURNAME — exactly like the real padrón imported by `scripts/import-excel.ts`
 * (`splitName` takes the first token as firstName). The CSV lists names as
 * "Apellido,Nombre", so "Pereyra,Maria" maps to { firstName: 'Pereyra',
 * lastName: 'Maria' }.
 */
const SEED_CLIENTS: Array<{ firstName: string; lastName: string; clientType: ClientType }> = [
  { firstName: 'Pereyra', lastName: 'Maria', clientType: 'LOCAL' },
  { firstName: 'Becerra', lastName: 'Graciela', clientType: 'LOCAL' },
  { firstName: 'Lavega', lastName: 'Soledad', clientType: 'LOCAL' },
  { firstName: 'Carretero', lastName: 'Maria del Carmen', clientType: 'LOCAL' },
  { firstName: 'Azcurra', lastName: 'Natalio', clientType: 'LOCAL' },
  { firstName: 'Del', lastName: 'Arco Maria', clientType: 'LOCAL' },
  { firstName: 'Test Client Zona 9', lastName: 'Rigoni', clientType: 'LOCAL' },
];

async function seedClients(): Promise<void> {
  await Client.deleteMany({});
  for (const seed of SEED_CLIENTS) {
    await Client.create({
      firstName: seed.firstName,
      lastName: seed.lastName,
      documentType: null,
      documentNumber: null,
      clientType: seed.clientType,
      address: { street: 'Calle Falsa', number: '123', locality: 'Buchardo' },
      active: true,
    });
  }
}

async function runImport(
  env: RunEnv,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(
      'node',
      ['node_modules/tsx/dist/cli.mjs', 'scripts/import-saldos-cta-cte.ts', FIXTURE_CSV, ...args, '--out-dir', env.outDir],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          MONGODB_URI: env.uri,
          NODE_ENV: 'test',
          JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret',
          JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret',
          JWT_ACCESS_EXPIRES_IN: '15m',
          JWT_REFRESH_EXPIRES_IN: '7d',
          FRONTEND_URL: 'http://localhost:5173',
          PAYMENT_RECEIPTS_DIR: env.outDir,
          // The operator is optional — the script must work without it.
          IMPORT_OPERATOR_EMAIL: '',
        },
      },
    );
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `El script falló unexpectedly.\nstdout: ${e.stdout ?? ''}\nstderr: ${e.stderr ?? ''}\n${e.message}`,
    );
  }
}

/** Runs the script expecting a non-zero exit (usage/guard errors). */
async function runImportExpectingFailure(
  env: RunEnv,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    await exec(
      'node',
      ['node_modules/tsx/dist/cli.mjs', 'scripts/import-saldos-cta-cte.ts', FIXTURE_CSV, ...args, '--out-dir', env.outDir],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          MONGODB_URI: env.uri,
          NODE_ENV: 'test',
          JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret',
          JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret',
          JWT_ACCESS_EXPIRES_IN: '15m',
          JWT_REFRESH_EXPIRES_IN: '7d',
          FRONTEND_URL: 'http://localhost:5173',
          PAYMENT_RECEIPTS_DIR: env.outDir,
        },
      },
    );
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
  throw new Error('Se esperaba que el script fallara y no falló');
}

describe('import:saldos-cta-cte — migración de saldos y tipo de cliente', () => {
  let replset: MongoMemoryReplSet | undefined;
  let env: RunEnv;

  beforeAll(async () => {
    replset = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    env = {
      uri: replset.getUri(),
      outDir: path.join(os.tmpdir(), `muni-saldos-${Date.now()}`),
    };
    await fs.mkdir(env.outDir, { recursive: true });
  }, 180_000);

  afterAll(async () => {
    await mongoose.disconnect();
    if (replset) await replset.stop();
    try {
      await fs.rm(env.outDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    await mongoose.connect(env.uri);
    await seedClients();
    await AccountMovement.deleteMany({});
    await mongoose.disconnect();
    // Cada caso arranca con el out-dir limpio: los snapshots referencian los
    // `_id` de los clientes del momento de la corrida, y `beforeEach` los
    // re-siembra con `_id` nuevos.
    const files = await fs.readdir(env.outDir);
    for (const file of files) {
      await fs.rm(path.join(env.outDir, file), { force: true });
    }
  });

  it('exige --confirm para escribir en la base', async () => {
    const { stdout, stderr } = await runImportExpectingFailure(env, []);
    expect(stdout + stderr).toMatch(/--confirm/i);
    // Nada se escribió.
    await mongoose.connect(env.uri);
    expect(await AccountMovement.countDocuments({})).toBe(0);
    const pereyra = await Client.findOne({ firstName: 'Pereyra' });
    expect(pereyra?.clientType).toBe('LOCAL');
    await mongoose.disconnect();
  }, 120_000);

  it('aplica el tipo de cliente con el mapeo del padrón', async () => {
    await runImport(env, ['--confirm']);

    await mongoose.connect(env.uri);
    const byName = async (first: string, last: string) =>
      Client.findOne({ firstName: first, lastName: last });

    // Mapeo explícito: AYUDA SOCIAL → AYUDA_SOCIAL, JIBILADO → JUBILADO,
    // NOLOCAL → NO_LOCAL.
    expect((await byName('Lavega', 'Soledad'))?.clientType).toBe('AYUDA_SOCIAL');
    expect((await byName('Carretero', 'Maria del Carmen'))?.clientType).toBe('JUBILADO');
    expect((await byName('Azcurra', 'Natalio'))?.clientType).toBe('NO_LOCAL');
    expect((await byName('Becerra', 'Graciela'))?.clientType).toBe('JUBILADO');
    expect((await byName('Pereyra', 'Maria'))?.clientType).toBe('LOCAL');

    await mongoose.disconnect();
  }, 120_000);

  it('registra el saldo como movimiento OPENING_BALANCE en minor units', async () => {
    await runImport(env, ['--confirm']);

    await mongoose.connect(env.uri);
    const movements = await AccountMovement.find({}).lean();
    expect(movements).toHaveLength(3);

    const pereyra = await Client.findOne({ firstName: 'Pereyra', lastName: 'Maria' });
    const pereyraMovement = movements.find(
      (m) => m.clientId.toString() === pereyra!._id.toString(),
    );
    expect(pereyraMovement).toBeTruthy();
    expect(pereyraMovement!.movementType).toBe('OPENING_BALANCE');
    expect(pereyraMovement!.direction).toBe('DEBIT');
    // 5200 pesos → 520000 minor units.
    expect(pereyraMovement!.amountMinor).toBe(520_000);
    expect(pereyraMovement!.sourceType).toBe('SYSTEM');
    expect(pereyraMovement!.idempotencyKey).toBe('import:saldos-cta-cte:pereyra-maria');

    // Saldo 0 → no genera movimiento.
    const laVega = await Client.findOne({ firstName: 'Lavega', lastName: 'Soledad' });
    expect(
      movements.filter((m) => m.clientId.toString() === laVega!._id.toString()),
    ).toHaveLength(0);

    await mongoose.disconnect();
  }, 120_000);

  it('es idempotente: correr dos veces no duplica movimientos', async () => {
    await runImport(env, ['--confirm']);
    const { stdout } = await runImport(env, ['--confirm']);

    await mongoose.connect(env.uri);
    const movements = await AccountMovement.find({}).lean();
    expect(movements).toHaveLength(3);

    const keys = movements.map((m) => m.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);

    // La 2ª corrida reporta las filas como YA_APLICADO.
    expect(stdout).toContain('YA_APLICADO');

    const pereyra = await Client.findOne({ firstName: 'Pereyra', lastName: 'Maria' });
    const movement = await AccountMovement.findOne({ clientId: pereyra!._id });
    expect(movement!.amountMinor).toBe(520_000);

    await mongoose.disconnect();
  }, 180_000);

  it('rechaza tipos desconocidos y nombres inexistentes sin tocar la base', async () => {
    await runImport(env, ['--confirm']);

    await mongoose.connect(env.uri);
    // La fila con tipo inválido no creó cliente ni movimiento.
    expect(await Client.countDocuments({ firstName: 'Tipo' })).toBe(0);
    expect(await AccountMovement.countDocuments({})).toBe(3);

    // El reporte de reconciliación lista el motivo del rechazo.
    const files = await fs.readdir(env.outDir);
    const report = files.find((f) => f.startsWith('reconciliacion-'));
    expect(report).toBeTruthy();
    const content = await fs.readFile(path.join(env.outDir, report!), 'utf8');
    expect(content).toContain('TIPO_INVALIDO');
    expect(content).toContain('NO_ENCONTRADO');

    await mongoose.disconnect();
  }, 120_000);

  it('--dry-run no escribe nada pero genera el reporte', async () => {
    await runImport(env, ['--dry-run']);

    await mongoose.connect(env.uri);
    expect(await AccountMovement.countDocuments({})).toBe(0);
    const becerra = await Client.findOne({ firstName: 'Becerra' });
    expect(becerra?.clientType).toBe('LOCAL');

    const files = await fs.readdir(env.outDir);
    expect(files.some((f) => f.startsWith('reconciliacion-'))).toBe(true);
    // En dry-run no se escribe el snapshot (no hay rollback posible).
    expect(files.some((f) => f.startsWith('snapshot-'))).toBe(false);

    await mongoose.disconnect();
  }, 120_000);

  it('--skip-test-clients omite las filas de clientes de prueba', async () => {
    await runImport(env, ['--confirm', '--skip-test-clients']);

    await mongoose.connect(env.uri);
    const testClient = await Client.findOne({ firstName: 'Test Client Zona 9' });
    expect(testClient?.clientType).toBe('LOCAL');
    expect(await AccountMovement.countDocuments({ clientId: testClient!._id })).toBe(0);

    await mongoose.disconnect();
  }, 120_000);

  it('el snapshot permite revertir tipos y saldos', async () => {
    await runImport(env, ['--confirm']);

    await mongoose.connect(env.uri);
    const files = await fs.readdir(env.outDir);
    const snapshotFile = files.find((f) => f.startsWith('snapshot-'));
    expect(snapshotFile).toBeTruthy();
    await mongoose.disconnect();

    // Rollback
    await exec(
      'node',
      [
        'node_modules/tsx/dist/cli.mjs',
        'scripts/import-saldos-cta-cte.ts',
        '--rollback',
        path.join(env.outDir, snapshotFile!),
        '--confirm',
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          MONGODB_URI: env.uri,
          NODE_ENV: 'test',
          JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret',
          JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret',
          JWT_ACCESS_EXPIRES_IN: '15m',
          JWT_REFRESH_EXPIRES_IN: '7d',
          FRONTEND_URL: 'http://localhost:5173',
          PAYMENT_RECEIPTS_DIR: env.outDir,
        },
      },
    );

    await mongoose.connect(env.uri);
    // Los tipos vuelven a LOCAL.
    const becerra = await Client.findOne({ firstName: 'Becerra' });
    expect(becerra?.clientType).toBe('LOCAL');

    // Los saldos quedaron revertidos (REVERSAL) → balance en cero.
    const movements = await AccountMovement.find({}).lean();
    const reversals = movements.filter((m) => m.movementType === 'REVERSAL');
    expect(reversals.length).toBe(3);

    const pereyra = await Client.findOne({ firstName: 'Pereyra', lastName: 'Maria' });
    const balance = movements
      .filter((m) => m.clientId.toString() === pereyra!._id.toString())
      .reduce(
        (acc, m) => acc + (m.direction === 'DEBIT' ? m.amountMinor : -m.amountMinor),
        0,
      );
    expect(balance).toBe(0);

    await mongoose.disconnect();
  }, 180_000);
});
