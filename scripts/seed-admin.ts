// Seed script: creates a SUPER_ADMIN user if one does not already exist.
// Idempotent — will NOT overwrite an existing admin with the same email.
import 'dotenv/config';
import mongoose from 'mongoose';
import { loadEnv } from '../src/config/env.js';
import { User } from '../src/modules/users/users.model.js';
import { hashPassword } from '../src/modules/users/users.service.js';
import { ROLES } from '../src/modules/users/users.types.js';
import { logger } from '../src/shared/logger.js';

async function main(): Promise<void> {
  const env = loadEnv();

  const email = env.SEED_ADMIN_EMAIL ?? 'admin@buchardo.gob.ar';
  const password = env.SEED_ADMIN_PASSWORD ?? 'ChangeMe123!';
  const firstName = env.SEED_ADMIN_FIRSTNAME ?? 'Super';
  const lastName = env.SEED_ADMIN_LASTNAME ?? 'Admin';

  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    logger.info(`Admin already exists: ${email}. Skipping.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const passwordHash = await hashPassword(password);

  await User.create({
    firstName,
    lastName,
    email: email.toLowerCase(),
    passwordHash,
    role: ROLES.SUPER_ADMIN,
    active: true,
  });

  logger.info(`SUPER_ADMIN created: ${email}`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  logger.error('Seed failed', err);
  process.exit(1);
});
