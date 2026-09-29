import { z } from 'zod';
import {
  CASH_LIST_DEFAULT_LIMIT,
  CASH_LIST_MAX_LIMIT,
} from './cash.types.js';

const objectIdSchema = z
  .string()
  .min(1, 'Identificador requerido')
  .refine((v) => /^[a-fA-F0-9]{24}$/.test(v), 'Identificador inválido');

export const listCashMovementsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CASH_LIST_MAX_LIMIT)
    .default(CASH_LIST_DEFAULT_LIMIT),
  clientId: objectIdSchema.optional(),
  driverId: objectIdSchema.optional(),
  orderId: objectIdSchema.optional(),
  movementType: z.enum(['CASH_COLLECTION']).optional(),
  sourceType: z.enum(['ORDER', 'MANUAL']).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

export type ListCashMovementsQuery = z.infer<typeof listCashMovementsQuerySchema>;

export const listClientCashMovementsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CASH_LIST_MAX_LIMIT)
    .default(CASH_LIST_DEFAULT_LIMIT),
});

export type ListClientCashMovementsQuery = z.infer<
  typeof listClientCashMovementsQuerySchema
>;

export const listDriverCashMovementsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CASH_LIST_MAX_LIMIT)
    .default(CASH_LIST_DEFAULT_LIMIT),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

export type ListDriverCashMovementsQuery = z.infer<
  typeof listDriverCashMovementsQuerySchema
>;

export const aggregateByClientQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CASH_LIST_MAX_LIMIT)
    .default(CASH_LIST_DEFAULT_LIMIT),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  clientType: z
    .enum(['LOCAL', 'JUBILADO', 'NO_LOCAL', 'AYUDA_SOCIAL'] as [
      string,
      ...string[],
    ])
    .optional(),
});

export type AggregateByClientQuery = z.infer<typeof aggregateByClientQuerySchema>;

export const aggregateByDriverQuerySchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

export type AggregateByDriverQuery = z.infer<typeof aggregateByDriverQuerySchema>;