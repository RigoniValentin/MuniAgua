/* eslint-disable no-console */
/**
 * Report on the current Client.zona distribution. Read-only — does not
 * write anything. Use this before going live to gauge how many clients
 * need to be backfilled with a zone label by an admin.
 *
 * Usage:
 *   npx tsx scripts/audit-client-zonas.ts
 */
import 'dotenv/config';
import { loadEnv } from '../src/config/env.js';
import { connectMongo, disconnectMongo } from '../src/config/mongo.js';
import { Client } from '../src/modules/clients/clients.model.js';
import { logger } from '../src/shared/logger.js';

async function main(): Promise<void> {
  loadEnv();
  await connectMongo();
  try {
    const totals = await Client.aggregate<{
      _id: string | null;
      count: number;
    }>([
      { $group: { _id: { $ifNull: ['$zona', null] }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    const overall = await Client.countDocuments();
    logger.info(`Total clients: ${overall}`);
    for (const row of totals) {
      const label = row._id === null ? '(sin zona)' : row._id;
      logger.info(`  ${label}: ${row.count}`);
    }
  } finally {
    await disconnectMongo();
  }
}

main().catch((err) => {
  logger.error('Audit failed', err);
  process.exitCode = 1;
});
