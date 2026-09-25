import { z } from 'zod';
import {
  ALL_ACCOUNT_STATUSES,
  ALL_DIRECTIONS,
  ALL_MOVEMENT_TYPES,
  ALL_SOURCE_TYPES,
  type AccountStatus,
  type Direction,
  type MovementType,
  type SourceType,
} from './accounts.types.js';

const trimmedShortText = (max: number, message?: string) =>
  z
    .string()
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(1, message ?? 'Requerido')
        .max(max, `Máximo ${max} caracteres`),
    );

const directionSchema = z.enum(ALL_DIRECTIONS as [Direction, ...Direction[]], {
  errorMap: () => ({ message: 'Dirección inválida' }),
});

const movementTypeSchema = z.enum(
  ALL_MOVEMENT_TYPES as [MovementType, ...MovementType[]],
  {
    errorMap: () => ({ message: 'Tipo de movimiento inválido' }),
  },
);

const sourceTypeSchema = z.enum(
  ALL_SOURCE_TYPES as [SourceType, ...SourceType[]],
  {
    errorMap: () => ({ message: 'Tipo de origen inválido' }),
  },
);

const accountStatusSchema = z.enum(
  ALL_ACCOUNT_STATUSES as [AccountStatus, ...AccountStatus[]],
  {
    errorMap: () => ({ message: 'Estado de cuenta inválido' }),
  },
);

/**
 * POST /api/accounts/:clientId/adjustments
 *
 * Body restricted to what the admin can legitimately influence: direction,
 * amountMinor and a free-text description. movementType, sourceType and
 * createdBy are derived server-side.
 */
export const createAdjustmentSchema = z
  .object({
    direction: directionSchema,
    amountMinor: z
      .number()
      .int('El importe debe ser un entero')
      .positive('El importe debe ser mayor a 0')
      .max(Number.MAX_SAFE_INTEGER, 'El importe excede el máximo permitido'),
    description: trimmedShortText(500, 'La descripción es obligatoria'),
  })
  .strict();

export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;

/**
 * POST /api/accounts/movements/:movementId/reverse
 */
export const reverseMovementSchema = z
  .object({
    description: trimmedShortText(500, 'La descripción es obligatoria'),
  })
  .strict();

export type ReverseMovementInput = z.infer<typeof reverseMovementSchema>;

/**
 * Internal schema for the postMovement service. Not exposed to the API.
 */
export const postMovementSchema = z.object({
  clientId: z.string().min(1),
  direction: directionSchema,
  amountMinor: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER),
  movementType: movementTypeSchema,
  description: trimmedShortText(500, 'La descripción es obligatoria'),
  sourceType: sourceTypeSchema.default('SYSTEM'),
  sourceId: z.string().nullish(),
  idempotencyKey: z.string().trim().min(1).max(200).nullish(),
  createdBy: z.string().nullish(),
  occurredAt: z.date().optional(),
  reversesMovementId: z.string().nullish(),
});

export type PostMovementInput = z.infer<typeof postMovementSchema>;

/**
 * GET /api/accounts/:clientId/movements
 */
export const MOVEMENTS_LIST_DEFAULT_LIMIT = 20;
export const MOVEMENTS_LIST_MAX_LIMIT = 100;

export const movementsListQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 1 : Number(v)))
    .pipe(
      z
        .number()
        .int('La página debe ser entera')
        .min(1, 'La página debe ser mayor o igual a 1'),
    ),
  limit: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? MOVEMENTS_LIST_DEFAULT_LIMIT : Number(v)))
    .pipe(
      z
        .number()
        .int('El límite debe ser entero')
        .min(1, 'El límite debe ser mayor o igual a 1')
        .max(
          MOVEMENTS_LIST_MAX_LIMIT,
          `El límite máximo es ${MOVEMENTS_LIST_MAX_LIMIT}`,
        ),
    ),
  direction: directionSchema.optional(),
  movementType: movementTypeSchema.optional(),
  dateFrom: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined))
    .refine((v) => v === undefined || !Number.isNaN(v.getTime()), {
      message: 'Fecha inválida',
    }),
  dateTo: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined))
    .refine((v) => v === undefined || !Number.isNaN(v.getTime()), {
      message: 'Fecha inválida',
    }),
});

export type MovementsListQuery = z.infer<typeof movementsListQuerySchema>;

/**
 * GET /api/accounts
 */
export const ACCOUNTS_LIST_DEFAULT_LIMIT = 20;
export const ACCOUNTS_LIST_MAX_LIMIT = 100;

export const accountsListQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 1 : Number(v)))
    .pipe(
      z
        .number()
        .int('La página debe ser entera')
        .min(1, 'La página debe ser mayor o igual a 1'),
    ),
  limit: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? ACCOUNTS_LIST_DEFAULT_LIMIT : Number(v)))
    .pipe(
      z
        .number()
        .int('El límite debe ser entero')
        .min(1, 'El límite debe ser mayor o igual a 1')
        .max(ACCOUNTS_LIST_MAX_LIMIT, `El límite máximo es ${ACCOUNTS_LIST_MAX_LIMIT}`),
    ),
  search: z
    .string()
    .max(80, 'Búsqueda demasiado larga')
    .optional()
    .transform((v) => (v ? v.trim() : undefined)),
  clientType: z
    .enum(['LOCAL', 'JUBILADO', 'NO_LOCAL', 'AYUDA_SOCIAL'] as const)
    .optional(),
  clientActive: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (typeof v === 'boolean') return v;
      return v === 'true';
    }),
  balanceStatus: accountStatusSchema.optional(),
});

export type AccountsListQuery = z.infer<typeof accountsListQuerySchema>;
