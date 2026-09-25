import { createHash, randomBytes } from 'node:crypto';
import { getEnv } from '../../config/env.js';
import { logger } from '../../shared/logger.js';
import { getMailer } from '../../shared/mailer.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { findUserByEmail, updateUserPassword } from '../users/users.service.js';
import { revokeAllForUser } from '../auth/auth.service.js';
import { PasswordResetToken } from './password-recovery.model.js';

function hashToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

function newToken(): string {
  // 32 bytes -> 64 hex chars. Plenty of entropy, plenty of URL safety.
  return randomBytes(32).toString('hex');
}

export interface RequestResetResult {
  /** Always true in the public response — exists to keep callers honest. */
  accepted: boolean;
}

export interface TokenValidationResult {
  valid: boolean;
}

/**
 * Request a password reset for the given email.
 *
 * Public response is ALWAYS 200 with the same body, regardless of whether
 * the email is registered, active, or unknown. This is intentional: it
 * prevents account enumeration by an attacker.
 *
 * When the email matches an active user, any pending tokens for that
 * user are invalidated (so only one link is valid at a time) and a fresh
 * token is issued. The plain token is rendered into a URL and handed
 * off to the mailer.
 */
export async function requestPasswordReset(
  rawEmail: string,
): Promise<RequestResetResult> {
  const email = rawEmail.toLowerCase().trim();
  const user = email ? await findUserByEmail(email) : null;

  if (user && user.active) {
    const token = newToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + getEnv().PASSWORD_RESET_TTL_MS);

    await PasswordResetToken.invalidatePendingForUser(user._id);
    await PasswordResetToken.create({
      userId: user._id,
      tokenHash,
      expiresAt,
      usedAt: null,
    });

    const resetUrl =
      `${getEnv().PASSWORD_RESET_URL_BASE.replace(/\/$/, '')}` +
      `/recuperar/${encodeURIComponent(token)}`;

    const expiresInMinutes = Math.round(
      getEnv().PASSWORD_RESET_TTL_MS / 60000,
    );

    try {
      await getMailer().sendPasswordResetEmail({
        to: user.email,
        resetUrl,
        expiresInMinutes,
      });
    } catch (err) {
      // We intentionally swallow SMTP failures for non-enumeration:
      // the user is told "check your inbox" while we log internally.
      logger.error(
        '[password-recovery] failed to deliver reset email:',
        err,
      );
    }
  } else if (user && !user.active) {
    // Same path as unknown: no email is dispatched, but no difference is
    // leaked to the API response.
    logger.warn(
      `[password-recovery] reset requested for inactive user: ${email}`,
    );
  }

  return { accepted: true };
}

/**
 * Validate a reset token without consuming it.
 *
 * Used by the front-end to decide whether to render the
 * "set new password" form or an error state, before prompting the user
 * to type anything.
 */
export async function validateResetToken(
  rawToken: string,
): Promise<TokenValidationResult> {
  const tokenHash = hashToken(rawToken);
  const record = await PasswordResetToken.findActiveByHash(tokenHash);
  return { valid: Boolean(record) };
}

export interface ResetPasswordResult {
  ok: true;
}

/**
 * Consume a reset token and set a new password.
 *
 * Rules:
 *   - The token must be present, not used, and not expired.
 *   - On success, the user's password hash is replaced and all
 *     outstanding refresh tokens for that user are revoked (defensive
 *     against an attacker who already controls an active session with
 *     the old password).
 */
export async function resetPasswordWithToken(
  rawToken: string,
  newPassword: string,
): Promise<ResetPasswordResult> {
  const tokenHash = hashToken(rawToken);
  const record = await PasswordResetToken.findActiveByHash(tokenHash);
  if (!record) {
    throw new ValidationError('El enlace de recuperación es inválido o expiró');
  }

  const updated = await updateUserPassword(
    record.userId.toString(),
    newPassword,
  );
  if (!updated) {
    throw new NotFoundError('El usuario asociado ya no existe');
  }

  record.usedAt = new Date();
  await record.save();

  await PasswordResetToken.invalidatePendingForUser(record.userId);
  revokeAllForUser(record.userId.toString());

  return { ok: true };
}
