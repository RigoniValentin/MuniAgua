/* eslint-disable no-console */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { User } from '../src/modules/users/users.model';
import { Client } from '../src/modules/clients/clients.model';
import { Product } from '../src/modules/products/products.model';
import { Order } from '../src/modules/orders/orders.model';
import { AccountMovement } from '../src/modules/accounts/account-movements.model';
import { signAccessToken } from '../src/modules/auth/auth.tokens';
import {
  defaultPermissionsForRole,
  ROLES,
} from '../src/modules/users/users.types';
import { createApp } from '../src/app';

const exec = promisify(execFile);

interface SeedEnv {
  uri: string;
  storageDir: string;
}

async function runSeedDemo(env: SeedEnv): Promise<void> {
  await exec(
    'node',
    ['node_modules/tsx/dist/cli.mjs', 'scripts/seed-demo.ts'],
    {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        MONGODB_URI: env.uri,
        NODE_ENV: 'test',
        JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret',
        JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret',
        JWT_ACCESS_EXPIRES_IN: '15m',
        JWT_REFRESH_EXPIRES_IN: '7d',
        FRONTEND_URL: 'http://localhost:5173',
        PAYMENT_RECEIPTS_DIR: env.storageDir,
        APP_TIMEZONE: 'America/Argentina/Buenos_Aires',
        DEMO_ADMIN_EMAIL: 'admin@demo.local',
        DEMO_ADMIN_PASSWORD: 'DemoAdmin123!',
        DEMO_DRIVER_EMAIL: 'repartidor@demo.local',
        DEMO_DRIVER_PASSWORD: 'DemoDriver123!',
        DEMO_CITIZEN_EMAIL: 'ciudadano@demo.local',
        DEMO_CITIZEN_PASSWORD: 'DemoCitizen123!',
      },
    },
  );
}

async function runSeedReports(env: SeedEnv): Promise<void> {
  await exec(
    'node',
    ['node_modules/tsx/dist/cli.mjs', 'scripts/seed-reports.ts'],
    {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        MONGODB_URI: env.uri,
        NODE_ENV: 'test',
        JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret',
        JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret',
        JWT_ACCESS_EXPIRES_IN: '15m',
        JWT_REFRESH_EXPIRES_IN: '7d',
        FRONTEND_URL: 'http://localhost:5173',
        PAYMENT_RECEIPTS_DIR: env.storageDir,
        APP_TIMEZONE: 'America/Argentina/Buenos_Aires',
        DEMO_ADMIN_EMAIL: 'admin@demo.local',
        DEMO_ADMIN_PASSWORD: 'DemoAdmin123!',
        DEMO_DRIVER_EMAIL: 'repartidor@demo.local',
        DEMO_DRIVER_PASSWORD: 'DemoDriver123!',
        DEMO_CITIZEN_EMAIL: 'ciudadano@demo.local',
        DEMO_CITIZEN_PASSWORD: 'DemoCitizen123!',
        REPORTS_DRIVER_EMAIL: 'repartidor@demo.local',
        REPORTS_CLIENT_DOC_PREFIX: '9911',
      },
    },
  );
}

describe('seed:reports', () => {
  let replset: MongoMemoryReplSet | undefined;
  let env: SeedEnv;

  beforeAll(async () => {
    replset = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    env = {
      uri: replset.getUri(),
      storageDir: path.join(os.tmpdir(), `muni-seed-reports-${Date.now()}`),
    };
    await fs.mkdir(env.storageDir, { recursive: true });
    process.env.MONGODB_URI = env.uri;
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    if (replset) await replset.stop();
    try {
      await fs.rm(env.storageDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('seed:demo + seed:reports idempotencia y smoke del endpoint', async () => {
    // 1) Sembrar base (admin, repartidor, clientes, productos, reglas).
    await runSeedDemo(env);
    // 2) Sembrar órdenes entregadas + canceladas para informes.
    await runSeedReports(env);
    // 3) Re-ejecución: no debe duplicar nada.
    await runSeedReports(env);

    await mongoose.connect(env.uri);

    // Conteo estable: demo trae 1 repartidor; reports reutiliza ese mismo repartidor.
    const driverCount = await User.countDocuments({
      email: 'repartidor@demo.local',
    });
    expect(driverCount).toBe(1);

    // Reportes crea 4 clientes sintéticos con prefijo 9911 — sin colisionar.
    const reportsClients = await Client.countDocuments({
      documentNumber: { $regex: '^9911' },
    });
    expect(reportsClients).toBe(4);

    // Productos ya creados por demo; seed-reports no debe duplicarlos.
    const productCount = await Product.countDocuments({});
    expect(productCount).toBe(3);

    // 22 delivered + 3 cancelled + 1 pending (del seed-demo).
    const orderCount = await Order.countDocuments({});
    expect(orderCount).toBeGreaterThanOrEqual(26);

    const cancelledCount = await Order.countDocuments({ status: 'CANCELLED' });
    expect(cancelledCount).toBeGreaterThanOrEqual(3);

    const deliveredCount = await Order.countDocuments({ status: 'DELIVERED' });
    expect(deliveredCount).toBeGreaterThanOrEqual(22);

    // Cada idempotencyKey de demo:reports:* aparece una sola vez en las órdenes.
    const reportsOrders = await Order.find({
      'deliveryAddressSnapshot.references': { $regex: '^demo:reports:' },
    }).lean();
    const uniqueRefs = new Set(
      reportsOrders.map((o) => o.deliveryAddressSnapshot?.references),
    );
    expect(reportsOrders.length).toBe(uniqueRefs.size);

    // Cada DEMBIT pareado (ACCOUNT) tiene un AccountMovement asociado.
    const reportsDebits = await AccountMovement.find({
      idempotencyKey: { $regex: '^demo:reports:.*:debit$' },
    }).lean();
    expect(reportsDebits.length).toBeGreaterThan(0);
    const debitKeys = new Set(reportsDebits.map((m) => m.idempotencyKey));
    expect(reportsDebits.length).toBe(debitKeys.size);

    // 4) Smoke test del endpoint /api/reports/period.
    const app = createApp();
    const admin = await User.findOne({ email: 'admin@demo.local' });
    expect(admin).toBeTruthy();
    const token = signAccessToken({
      sub: admin!._id.toString(),
      role: ROLES.ADMIN,
      permissions: defaultPermissionsForRole(ROLES.ADMIN),
    });

    const monthRes = await request(app)
      .get('/api/reports/period')
      .query({ period: 'THIS_MONTH' })
      .set('Authorization', `Bearer ${token}`);
    expect(monthRes.status).toBe(200);
    const monthReport = monthRes.body.data;
    expect(monthReport.totals.deliveredOrdersCount).toBeGreaterThan(0);
    expect(monthReport.totals.grossSalesMinor).toBeGreaterThan(0);

    // Debe haber mix CASH/ACCOUNT → ambos contadores > 0.
    expect(monthReport.totals.cashCollectedMinor).toBeGreaterThan(0);
    expect(monthReport.totals.accountChargedMinor).toBeGreaterThan(0);

    // Filtro por clientType AYUDA_SOCIAL subset.
    const socialRes = await request(app)
      .get('/api/reports/period')
      .query({ period: 'THIS_MONTH', clientType: 'AYUDA_SOCIAL' })
      .set('Authorization', `Bearer ${token}`);
    expect(socialRes.status).toBe(200);
    expect(
      socialRes.body.data.totals.deliveredOrdersCount,
    ).toBeGreaterThan(0);

    // YESTERDAY también tiene al menos 1 entrega.
    const yesterdayRes = await request(app)
      .get('/api/reports/period')
      .query({ period: 'YESTERDAY' })
      .set('Authorization', `Bearer ${token}`);
    expect(yesterdayRes.status).toBe(200);
    expect(
      yesterdayRes.body.data.totals.deliveredOrdersCount,
    ).toBeGreaterThan(0);

    // TODAY ≥ 1
    const todayRes = await request(app)
      .get('/api/reports/period')
      .query({ period: 'TODAY' })
      .set('Authorization', `Bearer ${token}`);
    expect(todayRes.status).toBe(200);
    expect(todayRes.body.data.totals.deliveredOrdersCount).toBeGreaterThan(0);

    await mongoose.disconnect();
  }, 180_000);
});
