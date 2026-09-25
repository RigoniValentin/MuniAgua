import type { Request, Response } from 'express';
import { asyncHandler } from '../../middlewares/error.js';
import { ok } from '../../shared/api-response.js';
import {
  requestResetSchema,
  resetPasswordSchema,
  validateTokenQuerySchema,
} from './password-recovery.validation.js';
import {
  requestPasswordReset,
  resetPasswordWithToken,
  validateResetToken,
} from './password-recovery.service.js';

export const requestResetController = asyncHandler(
  async (req: Request, res: Response) => {
    const { email } = requestResetSchema.parse(req.body);
    await requestPasswordReset(email);
    res.json(
      ok({
        ok: true,
        message:
          'Si el email está registrado, enviaremos un enlace de recuperación.',
      }),
    );
  },
);

export const validateResetTokenController = asyncHandler(
  async (req: Request, res: Response) => {
    const { token } = validateTokenQuerySchema.parse(req.query);
    const { valid } = await validateResetToken(token);
    res.json(ok({ valid }));
  },
);

export const resetPasswordController = asyncHandler(
  async (req: Request, res: Response) => {
    const { token, password } = resetPasswordSchema.parse(req.body);
    await resetPasswordWithToken(token, password);
    res.json(ok({ ok: true, message: 'Contraseña actualizada' }));
  },
);
