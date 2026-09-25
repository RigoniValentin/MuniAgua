/* eslint-disable no-console */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { User } from '../src/modules/users/users.model';
import { Client } from '../src/modules/clients/clients.model';
import { Product } from '../src/modules/products/products.model';
import { PricingRule } from '../src/modules/pricing/pricing.rules.model';
import { Order } from '../src/modules/orders/orders.model';
import { AccountMovement } from '../src/modules/accounts/account-movements.model';
import { Payment } from '../src/modules/payments/payments.model';

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

describe('seed:demo idempotency', () => {
  let replset: MongoMemoryReplSet | undefined;
  let env: SeedEnv;

  beforeAll(async () => {
    replset = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    env = {
      uri: replset.getUri(),
      storageDir: path.join(os.tmpdir(), `muni-seed-${Date.now()}`),
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

  it('runs twice without duplicating entities', async () => {
    await runSeedDemo(env);
    await runSeedDemo(env);

    await mongoose.connect(env.uri);

    const userCount = await User.countDocuments({});
    const adminCount = await User.countDocuments({ email: 'admin@demo.local' });
    const driverCount = await User.countDocuments({ email: 'repartidor@demo.local' });
    const citizenCount = await User.countDocuments({ email: 'ciudadano@demo.local' });

    const clientCount = await Client.countDocuments({});
    const productCount = await Product.countDocuments({});
    const ruleCount = await PricingRule.countDocuments({});
    const orderCount = await Order.countDocuments({});
    const movementCount = await AccountMovement.countDocuments({});
    const paymentCount = await Payment.countDocuments({});

    // Idempotency: each count must match the seed's intent.
    expect(userCount).toBe(3);
    expect(adminCount).toBe(1);
    expect(driverCount).toBe(1);
    expect(citizenCount).toBe(1);
    expect(clientCount).toBe(4);
    expect(productCount).toBe(3);
    expect(ruleCount).toBe(3);

    // Each demoOrder idempotency key appears exactly once in the ledger.
    const demoMovements = await AccountMovement.find({
      idempotencyKey: { $regex: '^demo:' },
    }).lean();
    const uniqueKeys = new Set(demoMovements.map((m) => m.idempotencyKey));
    expect(demoMovements.length).toBe(uniqueKeys.size);

    // Sanity: orders and payments have a reasonable count.
    expect(orderCount).toBeGreaterThanOrEqual(4);
    expect(paymentCount).toBeGreaterThanOrEqual(1);
    expect(movementCount).toBeGreaterThanOrEqual(orderCount);

    // The historical delivered pedido has its CREDIT paired with its DEBIT
    // so the net contribution of that pair is $0.
    const jubilado = await Client.findOne({ documentNumber: '12345678' });
    expect(jubilado).toBeTruthy();
    const historicalDebit = await AccountMovement.findOne({
      clientId: jubilado!._id,
      idempotencyKey: 'demo:order:jubilado-historical-delivered',
    });
    expect(historicalDebit).toBeTruthy();
    const historicalCredit = await AccountMovement.findOne({
      clientId: jubilado!._id,
      idempotencyKey: 'demo:order:jubilado-historical-delivered:payment',
    });
    expect(historicalCredit).toBeTruthy();
    expect(historicalDebit!.amountMinor).toBe(historicalCredit!.amountMinor);

    await mongoose.disconnect();
  }, 180_000);
});
