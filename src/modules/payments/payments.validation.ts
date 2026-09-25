import { z } from 'zod';
import {
  ALL_PAYMENT_METHODS,
  ALL_PAYMENT_STATUSES,
  MAX_RECEIPT_SIZE_BYTES,
  type PaymentMethod,
  type PaymentStatus,
} from './payments.types.js';
import {
  SORTABLE_PAYMENT_FIELDS,
  PAYMENTS_LIST_MAX_LIMIT,
  PAYMENTS_LIST_DEFAULT_LIMIT,
  type PaymentSortableField,
} from './payments.types.js';

const trimmedRequired = (max: number, message: string) =>
  z
    .string()
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(1, message)
        .max(max, `Máximo ${max} caracteres`),
    );

const trimmedOptional = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim())
    .nullish()
    .transform((v) => {
      if (v === undefined || v === null) return null;
      return v.length === 0 ? null : v;
    });

const paymentMethodEnum = z.enum(
  ALL_PAYMENT_METHODS as [PaymentMethod, ...PaymentMethod[]],
  { errorMap: () => ({ message: 'Método de pago inválido' }) },
);

const paymentStatusEnum = z.enum(
  ALL_PAYMENT_STATUSES as [PaymentStatus, ...PaymentStatus[]],
  { errorMap: () => ({ message: 'Estado de pago inválido' }) },
);

// Multipart bodies arrive as strings. Coerce amountMinor explicitly.
const amountMinorField = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const num = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(num)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'El monto debe ser un número',
      });
      return z.NEVER;
    }
    return num;
  })
  .pipe(
    z
      .number()
      .int('El monto debe ser un entero')
      .positive('El monto debe ser mayor a cero')
      .max(Number.MAX_SAFE_INTEGER, 'El monto excede el máximo permitido'),
  );

/**
 * Multipart fields that accompany the receipt upload. The file itself is
 * handled by multer + the storage service, NOT by Zod (Zod does not parse
 * binary streams).
 */
export const submitPaymentMetadataSchema = z
  .object({
    amountMinor: amountMinorField,
    paymentMethod: paymentMethodEnum,
    note: trimmedOptional(500),
  })
  .strict();

export type SubmitPaymentMetadataInput = z.infer<typeof submitPaymentMetadataSchema>;

export const rejectPaymentSchema = z
  .object({
    reason: trimmedRequired(500, 'El motivo es obligatorio'),
  })
  .strict();

export type RejectPaymentInput = z.infer<typeof rejectPaymentSchema>;

export const reversePaymentSchema = z
  .object({
    reason: trimmedRequired(500, 'El motivo es obligatorio'),
  })
  .strict();

export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>;

export const paymentListQuerySchema = z.object({
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
    .transform((v) => (v === undefined ? PAYMENTS_LIST_DEFAULT_LIMIT : Number(v)))
    .pipe(
      z
        .number()
        .int('El límite debe ser entero')
        .min(1, 'El límite debe ser mayor o igual a 1')
        .max(PAYMENTS_LIST_MAX_LIMIT, `El límite máximo es ${PAYMENTS_LIST_MAX_LIMIT}`),
    ),
  search: z
    .string()
    .max(120, 'Búsqueda demasiado larga')
    .optional()
    .transform((v) => (v ? v.trim() : undefined)),
  status: paymentStatusEnum.optional(),
  paymentMethod: paymentMethodEnum.optional(),
  dateFrom: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined))
    .refine((d) => d === undefined || !Number.isNaN(d.getTime()), {
      message: 'dateFrom inválido',
    }),
  dateTo: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined))
    .refine((d) => d === undefined || !Number.isNaN(d.getTime()), {
      message: 'dateTo inválido',
    }),
  sortBy: z
    .string()
    .optional()
    .transform((v): PaymentSortableField => {
      if (!v) return 'submittedAt';
      return (SORTABLE_PAYMENT_FIELDS as readonly string[]).includes(v)
        ? (v as PaymentSortableField)
        : 'submittedAt';
    }),
  sortOrder: z
    .union([z.literal('asc'), z.literal('desc')])
    .optional()
    .transform((v) => v ?? 'desc'),
});

export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;

export const myPaymentsListQuerySchema = paymentListQuerySchema.pick({
  page: true,
  limit: true,
  status: true,
});

export type MyPaymentsListQuery = z.infer<typeof myPaymentsListQuerySchema>;

export { MAX_RECEIPT_SIZE_BYTES };