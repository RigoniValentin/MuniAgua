/* eslint-disable no-console */
/**
 * Backfill `Order.zonaSnapshot` for orders created before the delivery-zone
 * feature shipped. Safe to re-run: only orders whose snapshot is missing
 * (or empty/whitespace) get touched, and they're stamped from `Client.zona`
 * at the moment the script runs.
 *
 * Strategy:
 *   1. Find orders with `zonaSnapshot` null/empty.
 *   2. Resolve client for each (in batches) — orders pointing at deleted
 *      clients are reported as "orphaned".
 *   3. Apply the snapshot in-place with `Order.updateOne` (no save hooks).
 *
 * CLI:
 *   tsx scripts/backfill-order-zona.ts [--dry-run]
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { loadEnv } from '../src/config/env.js';
import { connectMongo, disconnectMongo } from '../src/config/mongo.js';
import { Order } from '../src/modules/orders/orders.model.js';
import { Client } from '../src/modules/clients/clients.model.js';
import { logger } from '../src/shared/logger.js';

interface BackfillSummary {
  totalCandidates: number;
  backfilled: number;
  orphaned: number;
  noClientZone: number;
  dryRun: boolean;
}

function normalizeZona(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim().toUpperCase();
  return trimmed.length === 0 ? null : trimmed;
}

async function runBatch(dryRun: boolean): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    totalCandidates: 0,
    backfilled: 0,
    orphaned: 0,
    noClientZone: 0,
    dryRun,
  };

  const BATCH_SIZE = 200;
  let processed = 0;
  const cursor = Order.find({
    $or: [
      { zonaSnapshot: { $exists: false } },
      { zonaSnapshot: null },
      { zonaSnapshot: '' },
    ],
  })
    .select('_id clientId')
    .cursor();

  let batch: Array<{ _id: mongoose.Types.ObjectId; clientId: mongoose.Types.ObjectId }> = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const clientIds = [...new Set(batch.map((o) => o.clientId.toString()))];
    const clients = await Client.find({ _id: { $in: clientIds } }).select(
      '_id zona',
    );
    const clientById = new Map(
      clients.map((c) => [c._id.toString(), c.zona ?? null]),
    );

    for (const order of batch) {
      const clientZona = clientById.get(order.clientId.toString());
      if (clientZona === undefined) {
        summary.orphaned += 1;
        continue;
      }
      const snapshot = normalizeZona(clientZona);
      if (!snapshot) {
        summary.noClientZone += 1;
        continue;
      }
      if (!dryRun) {
        await Order.updateOne(
          { _id: order._id },
          { $set: { zonaSnapshot: snapshot } },
        );
      }
      summary.backfilled += 1;
    }
    batch = [];
  };

  for await (const order of cursor) {
    summary.totalCandidates += 1;
    batch.push({
      _id: order._id as mongoose.Types.ObjectId,
      clientId: order.clientId as mongoose.Types.ObjectId,
    });
    if (batch.length >= BATCH_SIZE) {
      await flush();
    }
    processed += 1;
  }
  await flush();

  logger.info(
    `Backfill processed=${processed} backfilled=${summary.backfilled} orphaned=${summary.orphaned} noClientZone=${summary.noClientZone} dryRun=${dryRun}`,
  );
  return summary;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  loadEnv();
  await connectMongo();
  try {
    const summary = await runBatch(dryRun);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await disconnectMongo();
  }
}

main().catch((err) => {
  logger.error('Backfill failed', err);
  process.exitCode = 1;
});
