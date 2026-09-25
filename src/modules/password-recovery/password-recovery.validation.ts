import { z } from 'zod';
import { passwordSchema } from '../users/users.validation.js';

export const requestResetSchema = z
  .object({
    email: z.string().email('Email inválido').max(160),
  })
  .strict();

export type RequestResetInput = z.infer<typeof requestResetSchema>;

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1, 'Token requerido').max(512),
    password: passwordSchema,
  })
  .strict();

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const validateTokenQuerySchema = z.object({
  token: z.string().min(1).max(512),
});

export type ValidateTokenQuery = z.infer<typeof validateTokenQuerySchema>;
