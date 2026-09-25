/* eslint-disable no-console */
/**
 * Cleanup testing — one-shot helper that removes every artifact left
 * behind by `npm run seed:demo` and the legacy `npm run seed:admin`.
 *
 * Intended for the local MongoDB after demos or smoke runs, before
 * the database is handed over to real operators.
 *
 * What is deleted:
 *   - Users with email in {@link TESTING_EMAILS}.
 *   - Clients whose `documentNumber` is one of {@link DEMO_DOCUMENT_NUMBERS}.
 *   - Orders whose `deliveryAddressSnapshot.references` starts with `demo:`.
 *   - Payments tied to the deleted clients OR whose `note` contains `demo:`.
 *   - Account movements whose `idempotencyKey` starts with `demo:`.
 *   - Receipt files on disk for the deleted payments.
 *
 * What is KEPT:
 *   - Products (catalog).
 *   - PricingRules (catalog).
 *   - Any client/user/order/payment NOT matching the filters above.
 *
 * Idempotent — re-running on a clean DB is a no-op.
 *
 * Run with:
 *   npm run cleanup:testing
 *   npm run cleanup:testing -- --dry-run   # log counts only, no deletes
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { loadEnv } from '../src/config/env.js';
import { User } from '../src/modules/users/users.model.js';
import { Client } from '../src/modules/clients/clients.model.js';
import { Order } from '../src/modules/orders/orders.model.js';
import { Payment } from '../src/modules/payments/payments.model.js';
import { AccountMovement } from '../src/modules/accounts/account-movements.model.js';
import { getPaymentReceiptStorage } from '../src/modules/payments/payments.storage.js';
import { logger } from '../src/shared/logger.js';

const TESTING_EMAILS = [
  'admin@demo.local',
  'repartidor@demo.local',
  'ciudadano@demo.local',
  'admin@buchardo.gob.ar',
];

const DEMO_DOCUMENT_NUMBERS = ['12345678', '22334455', '33445566', '44556677'];

const DEMO_REF_PREFIX = 'demo:';

interface Counters {
  users: number;
  clients: number;
  orders: number;
  payments: number;
  movements: number;
  receiptFiles: number;
}

function emptyCounters(): Counters {
  return { users: 0, clients: 0, orders: 0, payments: 0, movements: 0, receiptFiles: 0 };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const env = loadEnv();

  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  const counters = emptyCounters();

  // 1) Users
  const userQuery = { email: { $in: TESTING_EMAILS.map((e) => e.toLowerCase()) } };
  counters.users = await User.countDocuments(userQuery);
  if (!dryRun) {
    const { deletedCount } = await User.deleteMany(userQuery);
    counters.users = deletedCount;
  }
  logger.info(
    `[users] ${counters.users} matching (${dryRun ? 'dry-run' : 'deleted'})`,
  );

  // 2) Clients (demo documents)
  const clientQuery = { documentNumber: { $in: DEMO_DOCUMENT_NUMBERS } };
  const clientsToDelete = await Client.find(clientQuery).select('_id').lean();
  counters.clients = clientsToDelete.length;
  if (!dryRun) {
    const { deletedCount } = await Client.deleteMany(clientQuery);
    counters.clients = deletedCount;
  }
  logger.info(
    `[clients] ${counters.clients} matching (${dryRun ? 'dry-run' : 'deleted'})`,
  );

  // 3) Orders (references starts with demo:)
  const orderQuery = {
    'deliveryAddressSnapshot.references': { $regex: `^${DEMO_REF_PREFIX}` },
  };
  const ordersToDelete = await Order.find(orderQuery).select('_id').lean();
  counters.orders = ordersToDelete.length;
  if (!dryRun) {
    const orderIds = ordersToDelete.map((o) => o._id);
    const { deletedCount } = await Order.deleteMany({ _id: { $in: orderIds } });
    counters.orders = deletedCount;
  }
  logger.info(
    `[orders] ${counters.orders} matching (${dryRun ? 'dry-run' : 'deleted'})`,
  );

  // 4) Payments: tied to deleted clients OR note contains demo:
  const deletedClientIds = clientsToDelete.map((c) => c._id);
  const paymentQuery = {
    $or: [
      { clientId: { $in: deletedClientIds } },
      { note: { $regex: DEMO_REF_PREFIX } },
    ],
  };
  const paymentsToDelete = await Payment.find(paymentQuery)
    .select('_id receipt')
    .lean();
  counters.payments = paymentsToDelete.length;
  if (!dryRun) {
    const paymentIds = paymentsToDelete.map((p) => p._id);
    const { deletedCount } = await Payment.deleteMany({ _id: { $in: paymentIds } });
    counters.payments = deletedCount;
  }
  logger.info(
    `[payments] ${counters.payments} matching (${dryRun ? 'dry-run' : 'deleted'})`,
  );

  // 5) Account movements (idempotencyKey starts with demo:)
  const movementQuery = { idempotencyKey: { $regex: `^${DEMO_REF_PREFIX}` } };
  counters.movements = await AccountMovement.countDocuments(movementQuery);
  if (!dryRun) {
    const { deletedCount } = await AccountMovement.deleteMany(movementQuery);
    counters.movements = deletedCount;
  }
  logger.info(
    `[account-movements] ${counters.movements} matching (${dryRun ? 'dry-run' : 'deleted'})`,
  );

  // 6) Receipt files on disk for the deleted payments.
  if (!dryRun) {
    const storage = getPaymentReceiptStorage();
    for (const p of paymentsToDelete) {
      const key = p.receipt?.storageKey;
      if (!key) continue;
      try {
        const absolute = storage.resolveAbsolutePath(key);
        await fs.unlink(absolute);
        counters.receiptFiles += 1;
      } catch {
        // Missing file is fine — the DB reference is already gone.
      }
    }
  }
  logger.info(
    `[receipt-files] ${counters.receiptFiles} deleted from ${path.resolve(env.PAYMENT_RECEIPTS_DIR)}`,
  );

  // Summary
  logger.info('---');
  logger.info('Summary:');
  for (const [k, v] of Object.entries(counters)) {
    logger.info(`  ${k}: ${v}`);
  }
  logger.info(dryRun ? 'DRY-RUN — no changes written.' : 'Done.');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  logger.error('Cleanup failed', err);
  process.exit(1);
});
