/* eslint-disable no-console */
// Seed script: idempotent creation of the initial commercial rules.
// Creates the four ALL_PRODUCTS / PERCENTAGE / priority=0 rules for the
// municipality. Does NOT run automatically and never overwrites a rule that
// an administrator may have edited.
import 'dotenv/config';
import mongoose from 'mongoose';
import { loadEnv } from '../src/config/env.js';
import { PricingRule } from '../src/modules/pricing/pricing.rules.model.js';
import { logger } from '../src/shared/logger.js';

interface SeedRule {
  name: string;
  clientType: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';
  adjustmentValue: number;
}

const SEED_RULES: SeedRule[] = [
  { name: 'Precio base local', clientType: 'LOCAL', adjustmentValue: 0 },
  { name: 'Descuento jubilados', clientType: 'JUBILADO', adjustmentValue: -50 },
  { name: 'Recargo no local', clientType: 'NO_LOCAL', adjustmentValue: 40 },
  {
    name: 'Beneficio ayuda social',
    clientType: 'AYUDA_SOCIAL',
    adjustmentValue: -100,
  },
];

async function main(): Promise<void> {
  const env = loadEnv();
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  let created = 0;
  let skipped = 0;

  for (const seed of SEED_RULES) {
    const existing = await PricingRule.findOne({
      clientType: seed.clientType,
      scope: 'ALL_PRODUCTS',
      productType: null,
      productId: null,
      priority: 0,
      active: true,
    });

    if (existing) {
      skipped += 1;
      logger.info(
        `Skipped (already exists): ${seed.name} (${existing._id.toString()})`,
      );
      continue;
    }

    const doc = await PricingRule.create({
      name: seed.name,
      clientType: seed.clientType,
      scope: 'ALL_PRODUCTS',
      productType: null,
      productId: null,
      adjustmentType: 'PERCENTAGE',
      adjustmentValue: seed.adjustmentValue,
      priority: 0,
      active: true,
    });
    created += 1;
    logger.info(
      `Created: ${seed.name} (${doc._id.toString()})`,
    );
  }

  logger.info(`Seed pricing finished. created=${created} skipped=${skipped}`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  logger.error('Seed pricing failed', err);
  process.exit(1);
});
