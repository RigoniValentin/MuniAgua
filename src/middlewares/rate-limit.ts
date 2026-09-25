import rateLimit from 'express-rate-limit';

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT',
      message: 'Demasiados intentos de login. Intente nuevamente más tarde.',
    },
  },
});

const registerLimitEnabled = process.env.NODE_ENV !== 'test';

export const registerLimiter = registerLimitEnabled
  ? rateLimit({
      windowMs: 60 * 60 * 1000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: {
          code: 'RATE_LIMIT',
          message:
            'Demasiados registros desde tu IP. Intente nuevamente más tarde.',
        },
      },
    })
  : (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next();

export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Soft limiter for citizen payment submissions.
 *   - 10 submissions / 15 minutes / key (user > ip fallback).
 *   - Generous enough to allow legitimate retries, restrictive enough to
 *     prevent abuse.
 *
 * Tests can disable it by setting `PAYMENT_SUBMIT_RATE_LIMIT=disabled`.
 */
const submitLimitEnabled =
  process.env.NODE_ENV !== 'test' &&
  process.env.PAYMENT_SUBMIT_RATE_LIMIT !== 'disabled';

export const paymentSubmitLimiter = submitLimitEnabled
  ? rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => {
        const userId = req.user?.id;
        if (userId) return `u:${userId}`;
        return `ip:${req.ip ?? 'unknown'}`;
      },
      message: {
        success: false,
        error: {
          code: 'RATE_LIMIT',
          message:
            'Has alcanzado el límite de envíos de pagos. Intente nuevamente más tarde.',
        },
      },
    })
  : (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next();

/**
 * Rate limit for self-service password recovery endpoints
 * (`forgot-password`, `reset-password/validate`, `reset-password`).
 *
 * Disabled in tests so suites can hammer the endpoints without
 * hitting an artificial cap. In production: 5 requests / 15 min / IP.
 * Generous enough for legitimate retries across devices; restrictive
 * enough to throttle brute-force token guessing.
 */
const passwordRecoveryEnabled =
  process.env.NODE_ENV !== 'test' &&
  process.env.PASSWORD_RECOVERY_RATE_LIMIT !== 'disabled';

export const passwordRecoveryLimiter = passwordRecoveryEnabled
  ? rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: {
          code: 'RATE_LIMIT',
          message:
            'Demasiadas solicitudes de recuperación. Intente nuevamente más tarde.',
        },
      },
    })
  : (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next();
