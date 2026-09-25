import { z } from 'zod';
import {
  ALL_ORDER_ORIGINS,
  ALL_ORDER_STATUSES,
  MAX_CANCELLATION_REASON_LENGTH,
  MAX_CUSTOMER_NOTE_LENGTH,
  MAX_QUANTITY_PER_LINE,
  MIN_QUANTITY_PER_LINE,
  ORDER_LIST_DEFAULT_LIMIT,
  ORDER_LIST_MAX_LIMIT,
} from './orders.types.js';

const objectIdSchema = z
  .string()
  .min(1, 'Identificador requerido')
  .refine((v) => /^[a-fA-F0-9]{24}$/.test(v), 'Identificador inválido');

const quantitySchema = z
  .number()
  .int('La cantidad debe ser un entero')
  .min(MIN_QUANTITY_PER_LINE, `La cantidad mínima es ${MIN_QUANTITY_PER_LINE}`)
  .max(MAX_QUANTITY_PER_LINE, `La cantidad máxima es ${MAX_QUANTITY_PER_LINE}`);

const orderItemInputSchema = z.object({
  productId: objectIdSchema,
  quantity: quantitySchema,
});

/**
 * Citizen self-creation payload. Strictly forbids prices, totals, clientId, etc.
 */
export const createMyOrderSchema = z
  .object({
    items: z
      .array(orderItemInputSchema)
      .min(1, 'El pedido debe contener al menos un producto'),
    customerNote: z
      .string()
      .trim()
      .max(MAX_CUSTOMER_NOTE_LENGTH, `Máximo ${MAX_CUSTOMER_NOTE_LENGTH} caracteres`)
      .optional(),
  })
  .strict();

export type CreateMyOrderPayload = z.infer<typeof createMyOrderSchema>;

/**
 * Staff direct-order payload (driver or admin creates an Order for a client).
 * Same shape as citizen but includes clientId.
 */
export const createStaffOrderSchema = createMyOrderSchema
  .extend({
    clientId: objectIdSchema,
  })
  .strict();

export type CreateStaffOrderPayload = z.infer<typeof createStaffOrderSchema>;

/**
 * Cancellation reason — optional for citizen, required for staff.
 */
export const cancelOrderSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .max(
        MAX_CANCELLATION_REASON_LENGTH,
        `Máximo ${MAX_CANCELLATION_REASON_LENGTH} caracteres`,
      )
      .optional(),
  })
  .strict();

export type CancelOrderPayload = z.infer<typeof cancelOrderSchema>;

/**
 * Staff cancellation — reason is required.
 */
export const staffCancelOrderSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1, 'El motivo de cancelación es obligatorio')
      .max(
        MAX_CANCELLATION_REASON_LENGTH,
        `Máximo ${MAX_CANCELLATION_REASON_LENGTH} caracteres`,
      ),
  })
  .strict();

export type StaffCancelOrderPayload = z.infer<typeof staffCancelOrderSchema>;

// ---------- Query schemas ----------

const ORDER_STATUS_TUPLE = ALL_ORDER_STATUSES as unknown as [
  string,
  ...string[],
];
const ORDER_ORIGIN_TUPLE = ALL_ORDER_ORIGINS as unknown as [string, ...string[]];

export const orderListStatusSchema = z
  .union([z.enum(ORDER_STATUS_TUPLE), z.literal('ALL')])
  .optional();

export const myOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ORDER_LIST_MAX_LIMIT)
    .default(ORDER_LIST_DEFAULT_LIMIT),
  status: orderListStatusSchema,
});

export type MyOrdersQuery = z.infer<typeof myOrdersQuerySchema>;

export const adminOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ORDER_LIST_MAX_LIMIT)
    .default(ORDER_LIST_DEFAULT_LIMIT),
  search: z.string().trim().min(1).max(120).optional(),
  status: orderListStatusSchema,
  origin: z.enum(ORDER_ORIGIN_TUPLE).optional(),
  clientType: z
    .enum(['LOCAL', 'JUBILADO', 'NO_LOCAL', 'AYUDA_SOCIAL'] as [
      string,
      ...string[],
    ])
    .optional(),
  assignedTo: objectIdSchema.optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

export type AdminOrdersQuery = z.infer<typeof adminOrdersQuerySchema>;

export const driverOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ORDER_LIST_MAX_LIMIT)
    .default(ORDER_LIST_DEFAULT_LIMIT),
});

export type DriverOrdersQuery = z.infer<typeof driverOrdersQuerySchema>;
