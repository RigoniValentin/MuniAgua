import nodemailer, { type Transporter } from 'nodemailer';
import { getEnv } from '../config/env.js';
import { logger } from './logger.js';

export interface SendPasswordResetEmailArgs {
  to: string;
  resetUrl: string;
  expiresInMinutes: number;
}

interface Mailer {
  sendPasswordResetEmail(args: SendPasswordResetEmailArgs): Promise<void>;
  /** True if the underlying transport is a real SMTP send (not a dev mock). */
  readonly realTransport: boolean;
}

let cached: Mailer | undefined;

export function getMailer(): Mailer {
  if (cached) {
    return cached;
  }
  const env = getEnv();
  const enabled = env.SMTP_ENABLED === 'true';

  if (!enabled || !env.SMTP_HOST) {
    cached = buildMockMailer();
    return cached;
  }

  const transporter: Transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    secure: env.SMTP_SECURE === 'true',
    auth:
      env.SMTP_USER || env.SMTP_PASSWORD
        ? { user: env.SMTP_USER ?? '', pass: env.SMTP_PASSWORD ?? '' }
        : undefined,
  });

  cached = {
    realTransport: true,
    sendPasswordResetEmail: async (args) => {
      const html = renderResetEmailHtml({
        resetUrl: args.resetUrl,
        expiresInMinutes: args.expiresInMinutes,
      });
      try {
        await transporter.sendMail({
          from: env.SMTP_FROM,
          to: args.to,
          subject: 'Restablecé tu contraseña — Municipalidad de Buchardo',
          text: renderResetEmailText({
            resetUrl: args.resetUrl,
            expiresInMinutes: args.expiresInMinutes,
          }),
          html,
        });
      } catch (err) {
        logger.error('[mailer] SMTP send failed:', err);
        throw err;
      }
    },
  };
  return cached;
}

/**
 * Test/dev fallback: logs the message to stdout instead of sending. Lets
 * the recovery flow work end-to-end without a real SMTP server.
 */
function buildMockMailer(): Mailer {
  return {
    realTransport: false,
    sendPasswordResetEmail: async ({ to, resetUrl, expiresInMinutes }) => {
      logger.warn(
        '[mailer] SMTP disabled — DEV reset link (delete after use):',
        { to, resetUrl, expiresInMinutes },
      );
    },
  };
}

function renderResetEmailText(args: {
  resetUrl: string;
  expiresInMinutes: number;
}): string {
  return [
    'Recibimos una solicitud para restablecer la contraseña de tu cuenta.',
    '',
    `Para continuar, ingresá al siguiente enlace dentro de los próximos ${args.expiresInMinutes} minutos:`,
    args.resetUrl,
    '',
    'Si no solicitaste este cambio, podés ignorar este mensaje.',
    '',
    'Municipalidad de Buchardo',
  ].join('\n');
}

function renderResetEmailHtml(args: {
  resetUrl: string;
  expiresInMinutes: number;
}): string {
  const safeUrl = escapeHtml(args.resetUrl);
  return `<!doctype html>
<html lang="es">
  <body style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
    <h2 style="margin: 0 0 16px;">Restablecé tu contraseña</h2>
    <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta en la plataforma de la Municipalidad de Buchardo.</p>
    <p>Para continuar, hacé click en el siguiente botón dentro de los próximos <strong>${args.expiresInMinutes} minutos</strong>:</p>
    <p style="margin: 24px 0;">
      <a href="${safeUrl}" style="background:#0f766e;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block;">
        Restablecer contraseña
      </a>
    </p>
    <p>Si el botón no funciona, copiá y pegá este enlace en tu navegador:</p>
    <p style="word-break: break-all; color: #1d4ed8;">${safeUrl}</p>
    <p style="margin-top: 24px;">Si no solicitaste este cambio, podés ignorar este mensaje. Tu contraseña actual seguirá siendo válida.</p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
    <p style="color:#6b7280;font-size:12px;">Municipalidad de Buchardo · Plataforma digital</p>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Test-only helper: clears the cached mailer so tests can switch
 * SMTP_ENABLED between runs.
 */
export function _resetMailerForTests(): void {
  cached = undefined;
}
