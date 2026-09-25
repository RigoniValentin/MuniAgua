import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z
    .string()
    .default('3000')
    .transform((v) => Number(v))
    .pipe(z.number().int().nonnegative()),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('390m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  REFRESH_COOKIE_NAME: z.string().default('muni_rt'),
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
  SEED_ADMIN_FIRSTNAME: z.string().optional(),
  SEED_ADMIN_LASTNAME: z.string().optional(),
  PAYMENT_RECEIPTS_DIR: z.string().default('./storage/payment-receipts'),
  /**
   * Transaction strategy:
   *   auto      — detect at startup, use transactions when supported, otherwise fallback (default)
   *   enabled   — require transactions; fail to start when running against a standalone server
   *   disabled  — never use transactions, even when available
   */
  MONGO_TRANSACTION_MODE: z.enum(['auto', 'enabled', 'disabled']).default('auto'),
  DEMO_ADMIN_EMAIL: z.string().email().optional(),
  DEMO_ADMIN_PASSWORD: z.string().min(8).optional(),
  DEMO_DRIVER_EMAIL: z.string().email().optional(),
  DEMO_DRIVER_PASSWORD: z.string().min(8).optional(),
  DEMO_CITIZEN_EMAIL: z.string().email().optional(),
  DEMO_CITIZEN_PASSWORD: z.string().min(8).optional(),
  /**
   * IANA timezone used to evaluate "today" for delivery-zone routing.
   * Keeps L/X/V and M/J/S anchored to municipal time even when the
   * server runs in UTC (containers, CI, etc.).
   */
  APP_TIMEZONE: z.string().min(1).default('America/Argentina/Buenos_Aires'),

  // ==================================================
  // PASSWORD RECOVERY / MAIL
  // ==================================================
  /**
   * `'true'` switches the mailer to a real SMTP transport.
   * Anything else (incl. unset) keeps a dev mock that logs reset
   * URLs to stdout. Never enable SMTP without a real host.
   */
  SMTP_ENABLED: z
    .enum(['true', 'false'])
    .default('false'),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z
    .string()
    .min(1)
    .default('Municipalidad de Buchardo <no-reply@buchardo.gob.ar>'),
  /** Override the password-reset link origin (e.g. https://app.buchardo.gob.ar). */
  PASSWORD_RESET_URL_BASE: z.string().url().default('http://localhost:5173'),
  PASSWORD_RESET_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Environment validation failed. Please check your .env file against .env.example.\n${issues}`,
    );
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}

export function getEnv(): Env {
  if (!cachedEnv) {
    return loadEnv();
  }
  return cachedEnv;
}
