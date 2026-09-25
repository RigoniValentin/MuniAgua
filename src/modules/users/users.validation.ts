import { z } from 'zod';
import { ROLES, type Role } from './users.types.js';

export const passwordSchema = z
  .string()
  .min(8, 'La contraseña debe tener al menos 8 caracteres')
  .max(128, 'La contraseña es demasiado larga');

export const loginSchema = z.object({
  email: z.string().email('Email inválido').max(160),
  password: passwordSchema,
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Public self-registration schema. Always CIUDADANO role, regardless of input.
 * Auto-link by documentNumber is attempted server-side.
 */
export const registerSchema = z
  .object({
    firstName: z.string().min(1, 'El nombre es obligatorio').max(80),
    lastName: z.string().min(1, 'El apellido es obligatorio').max(80),
    email: z.string().email('Email inválido').max(160),
    password: passwordSchema,
    phone: z
      .string()
      .trim()
      .min(1, 'El teléfono es obligatorio')
      .max(40, 'El teléfono es demasiado largo'),
    documentNumber: z
      .string()
      .trim()
      .min(1, 'El DNI es obligatorio')
      .max(32, 'El DNI es demasiado largo'),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;

export const createUserSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email().max(160),
  password: passwordSchema,
  phone: z.string().trim().max(40).optional(),
  role: z
    .string()
    .refine((v): v is Role => (Object.values(ROLES) as string[]).includes(v), {
      message: 'Rol inválido',
    }),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  active: z.boolean().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  role: z
    .string()
    .refine((v): v is Role => (Object.values(ROLES) as string[]).includes(v), {
      message: 'Rol inválido',
    })
    .optional(),
  permissions: z.array(z.string()).optional(),
});

export type UpdateUserInput = z.infer<typeof updateUserSchema>;
