import { z } from 'zod';

/**
 * Argentina CUIT/CUIL: 11 digits (no formatting). We accept optional dashes
 * and spaces and normalize them out.
 */
const cuitSchema = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(
    z
      .string()
      .regex(/^\d{11}$/, 'El CUIT debe tener 11 dígitos'),
  );

/**
 * Argentina CBU: 22 digits, often formatted in 8-14 blocks. We accept
 * optional spaces and normalize them out.
 */
const cbuSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, ''))
  .pipe(
    z
      .string()
      .regex(/^\d{22}$/, 'El CBU debe tener 22 dígitos'),
  );

/**
 * Alias: 3-20 chars. Standard BANCOR aliases use lowercase letters, numbers
 * and dots (e.g. "aguamuni.bancor"). We allow letters, numbers, dots, dashes
 * and underscores.
 */
const aliasSchema = z
  .string()
  .trim()
  .min(3, 'El alias debe tener al menos 3 caracteres')
  .max(20, 'El alias debe tener como máximo 20 caracteres')
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    'El alias solo puede contener letras, números, puntos, guiones y guion bajo',
  );

const bankNameSchema = z
  .string()
  .trim()
  .min(1, 'El banco es obligatorio')
  .max(80, 'Máximo 80 caracteres');

const razonSocialSchema = z
  .string()
  .trim()
  .min(1, 'La razón social es obligatoria')
  .max(120, 'Máximo 120 caracteres');

export const updateBankInfoSchema = z
  .object({
    bankName: bankNameSchema,
    razonSocial: razonSocialSchema,
    cuit: cuitSchema,
    cbu: cbuSchema,
    alias: aliasSchema,
  })
  .strict();

export type UpdateBankInfoInput = z.infer<typeof updateBankInfoSchema>;
