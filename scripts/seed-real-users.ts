/* eslint-disable no-console */
/**
 * Seed real users — creates the 4 production operators of the Municipalidad
 * de Buchardo (treasury, accounting, two drivers). Idempotent: skips users
 * that already exist by email. Does NOT create clients, products, rules,
 * orders or payments — only users.
 *
 * Personas and credentials live in the `REAL_USER_SEEDS` array below; they
 * can be overridden via env vars (`TREASURY_ADMIN_EMAIL`, `TREASURY_ADMIN_PASSWORD`,
 * `TREASURY_ADMIN_PHONE`, etc.).
 *
 * Run with:
 *   npm run seed:real-users
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { loadEnv } from '../src/config/env.js';
import { User } from '../src/modules/users/users.model.js';
import { hashPassword } from '../src/modules/users/users.service.js';
import {
  defaultPermissionsForRole,
  ROLES,
  type Role,
} from '../src/modules/users/users.types.js';
import { logger } from '../src/shared/logger.js';

interface UserSeed {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone: string;
  role: Role;
}

function buildSeed(
  emailEnv: string,
  passwordEnv: string,
  phoneEnv: string,
  firstName: string,
  lastName: string,
  role: Role,
  fallbackEmail: string,
  fallbackPassword: string,
  fallbackPhone: string,
): UserSeed {
  const env = process.env;
  const email = (env[emailEnv] ?? fallbackEmail).toLowerCase().trim();
  const password = env[passwordEnv] ?? fallbackPassword;
  const phone = env[phoneEnv] ?? fallbackPhone;
  return { email, password, firstName, lastName, phone, role };
}

async function main(): Promise<void> {
  const env = loadEnv();

  const adminRole = ROLES.ADMIN;
  const driverRole = ROLES.REPARTIDOR;
  if (!adminRole || !driverRole) {
    throw new Error('ROLES.ADMIN / ROLES.REPARTIDOR missing from users.types');
  }

  const seeds: UserSeed[] = [
    buildSeed(
      'TREASURY_ADMIN_EMAIL',
      'TREASURY_ADMIN_PASSWORD',
      'TREASURY_ADMIN_PHONE',
      'Maribel',
      'Arduzzo',
      adminRole,
      'tesoreriamunibuchardo@gmail.com',
      'Admin123!',
      '3385437074',
    ),
    buildSeed(
      'ACCOUNTING_ADMIN_EMAIL',
      'ACCOUNTING_ADMIN_PASSWORD',
      'ACCOUNTING_ADMIN_PHONE',
      'Macarena',
      'Gonzalez',
      adminRole,
      'secretariacontablebuchardo@gmail.com',
      'Admin123!',
      '2302391342',
    ),
    buildSeed(
      'DRIVER_EZEQUIEL_EMAIL',
      'DRIVER_EZEQUIEL_PASSWORD',
      'DRIVER_EZEQUIEL_PHONE',
      'Ezequiel',
      'Biasini',
      driverRole,
      'repartos_ezequiel@gmail.com',
      'Reparto123!',
      '3385461601',
    ),
    buildSeed(
      'DRIVER_ROBERTINO_EMAIL',
      'DRIVER_ROBERTINO_PASSWORD',
      'DRIVER_ROBERTINO_PHONE',
      'Robertino',
      'Goggi',
      driverRole,
      'repartos_robertino@gmail.com',
      'Reparto123!',
      '2302391342',
    ),
  ];

  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  let created = 0;
  let skipped = 0;

for (const seed of seeds) {
    const existing = await User.findOne({ email: seed.email.toLowerCase() });
    if (existing) {
      // Existing user: merge any missing role-default permissions. This
      // keeps idempotency safe even when new permissions are added to a
      // role after the user was first seeded (e.g. delivery.claim for
      // REPARTIDOR). Custom permissions stay intact.
      const defaults = defaultPermissionsForRole(seed.role);
      const missing = defaults.filter((p) => !existing.permissions.includes(p));
      if (missing.length > 0) {
        existing.permissions = Array.from(new Set([...existing.permissions, ...defaults]));
        await existing.save();
        logger.info(
          `[FIX]  Refreshed permissions for ${seed.email}: added ${missing.join(', ')}`,
        );
      } else {
        logger.info(`[SKIP] User already exists: ${seed.email}`);
      }
      skipped += 1;
      continue;
    }
    const passwordHash = await hashPassword(seed.password);
    const doc = await User.create({
      firstName: seed.firstName,
      lastName: seed.lastName,
      email: seed.email,
      phone: seed.phone,
      passwordHash,
      role: seed.role,
      active: true,
    });
    logger.info(
      `[OK]   Created ${seed.role} ${doc._id.toString()} → ${seed.email} (${doc.firstName} ${doc.lastName}, ${doc.phone})`,
    );
    created += 1;
  }

  logger.info('---');
  logger.info(`Created: ${created} | Skipped: ${skipped} | Total: ${seeds.length}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  logger.error('Seed real users failed', err);
  process.exit(1);
});
