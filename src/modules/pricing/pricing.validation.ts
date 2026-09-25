import { z } from 'zod';
import { ALL_CLIENT_TYPES, type ClientType } from '../clients/clients.types.js';
import { ALL_PRODUCT_TYPES, type ProductType } from '../products/products.types.js';
import {
  ALL_PRICING_ADJUSTMENT_TYPES,
  ALL_PRICING_SCOPES,
  MAX_ADJUSTMENT_PERCENTAGE,
  MAX_QUOTE_QUANTITY,
  MAX_RULE_NAME_LENGTH,
  MIN_ADJUSTMENT_PERCENTAGE,
  MIN_QUOTE_QUANTITY,
  SORTABLE_PRICING_RULE_FIELDS,
  type PricingAdjustmentType,
  type PricingRuleSortableField,
  type PricingScope,
} from './pricing.types.js';

const objectIdString = z
  .string()
  .min(1, 'Identificador requerido')
  .regex(/^[a-f0-9]{24}$/i, 'Identificador inválido');

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

const clientTypeEnum = z.enum(
  ALL_CLIENT_TYPES as [ClientType, ...ClientType[]],
  { errorMap: () => ({ message: 'Tipo de cliente inválido' }) },
);

const productTypeEnum = z.enum(
  ALL_PRODUCT_TYPES as [ProductType, ...ProductType[]],
  { errorMap: () => ({ message: 'Tipo de producto inválido' }) },
);

const adjustmentTypeEnum = z.enum(
  ALL_PRICING_ADJUSTMENT_TYPES as [PricingAdjustmentType, ...PricingAdjustmentType[]],
  { errorMap: () => ({ message: 'Tipo de ajuste inválido' }) },
);

const adjustmentValueSchema = z
  .number({
    invalid_type_error: 'El ajuste debe ser un número entero',
    required_error: 'El ajuste es obligatorio',
  })
  .int('El ajuste debe ser un entero')
  .min(MIN_ADJUSTMENT_PERCENTAGE, `El ajuste mínimo es ${MIN_ADJUSTMENT_PERCENTAGE}%`)
  .max(MAX_ADJUSTMENT_PERCENTAGE, `El ajuste máximo es ${MAX_ADJUSTMENT_PERCENTAGE}%`);

export const createPricingRuleSchema = z
  .object({
    name: trimmedRequired(MAX_RULE_NAME_LENGTH, 'El nombre es obligatorio'),
    clientType: clientTypeEnum,
    scope: z.enum(ALL_PRICING_SCOPES as [PricingScope, ...PricingScope[]], {
      errorMap: () => ({ message: 'Alcance inválido' }),
    }),
    productType: productTypeEnum.optional(),
    productId: objectIdString.optional(),
    adjustmentType: adjustmentTypeEnum.optional().default('PERCENTAGE'),
    adjustmentValue: adjustmentValueSchema,
    priority: z
      .number({
        invalid_type_error: 'La prioridad debe ser un número entero',
      })
      .int('La prioridad debe ser un entero')
      .min(-10000, 'Prioridad fuera de rango')
      .max(10000, 'Prioridad fuera de rango')
      .optional()
      .default(0),
    active: z.boolean().optional().default(true),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.scope === 'ALL_PRODUCTS') {
      if (data.productType !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['productType'],
          message:
            'productType debe estar vacío cuando scope es ALL_PRODUCTS',
        });
      }
      if (data.productId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['productId'],
          message: 'productId debe estar vacío cuando scope es ALL_PRODUCTS',
        });
      }
    }
    if (data.scope === 'PRODUCT_TYPE') {
      if (data.productType === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['productType'],
          message: 'productType es requerido cuando scope es PRODUCT_TYPE',
        });
      }
      if (data.productId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['productId'],
          message: 'productId debe estar vacío cuando scope es PRODUCT_TYPE',
        });
      }
    }
    if (data.scope === 'PRODUCT') {
      if (data.productId === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['productId'],
          message: 'productId es requerido cuando scope es PRODUCT',
        });
      }
      if (data.productType !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['productType'],
          message: 'productType debe estar vacío cuando scope es PRODUCT',
        });
      }
    }
  });

export type CreatePricingRuleInput = z.infer<typeof createPricingRuleSchema>;

export const updatePricingRuleSchema = z
  .object({
    name: trimmedRequired(MAX_RULE_NAME_LENGTH, 'El nombre es obligatorio').optional(),
    clientType: clientTypeEnum.optional(),
    adjustmentValue: adjustmentValueSchema.optional(),
    adjustmentType: adjustmentTypeEnum.optional(),
    priority: z.number().int().min(-10000).max(10000).optional(),
    active: z.boolean().optional(),
    scope: z
      .enum(ALL_PRICING_SCOPES as [PricingScope, ...PricingScope[]], {
        errorMap: () => ({ message: 'Alcance inválido' }),
      })
      .optional(),
    productType: productTypeEnum.nullish(),
    productId: objectIdString.nullish(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.scope === 'ALL_PRODUCTS') {
      if (data.productType !== undefined && data.productType !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['productType'],
          message:
            'productType debe estar vacío cuando scope es ALL_PRODUCTS',
        });
      }
      if (data.productId !== undefined && data.productId !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['productId'],
          message: 'productId debe estar vacío cuando scope es ALL_PRODUCTS',
        });
      }
    }
    if (data.scope === 'PRODUCT_TYPE') {
      if (data.productType === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['productType'],
          message: 'productType es requerido cuando scope es PRODUCT_TYPE',
        });
      }
      if (data.productId !== undefined && data.productId !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['productId'],
          message: 'productId debe estar vacío cuando scope es PRODUCT_TYPE',
        });
      }
    }
    if (data.scope === 'PRODUCT') {
      if (data.productId === null || data.productId === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['productId'],
          message: 'productId es requerido cuando scope es PRODUCT',
        });
      }
      if (data.productType !== undefined && data.productType !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['productType'],
          message: 'productType debe estar vacío cuando scope es PRODUCT',
        });
      }
    }
  });

export type UpdatePricingRuleInput = z.infer<typeof updatePricingRuleSchema>;

export const pricingRuleListQuerySchema = z.object({
  clientType: clientTypeEnum.optional(),
  scope: z
    .enum(ALL_PRICING_SCOPES as [PricingScope, ...PricingScope[]], {
      errorMap: () => ({ message: 'Alcance inválido' }),
    })
    .optional(),
  productType: productTypeEnum.optional(),
  productId: objectIdString.optional(),
  active: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (typeof v === 'boolean') return v;
      return v === 'true';
    }),
  sortBy: z
    .string()
    .optional()
    .transform((v): PricingRuleSortableField => {
      if (!v) return 'priority';
      return (SORTABLE_PRICING_RULE_FIELDS as readonly string[]).includes(v)
        ? (v as PricingRuleSortableField)
        : 'priority';
    }),
  sortOrder: z
    .union([z.literal('asc'), z.literal('desc')])
    .optional()
    .transform((v) => v ?? 'desc'),
});

export type PricingRuleListQuery = z.infer<typeof pricingRuleListQuerySchema>;

export const quoteItemSchema = z.object({
  productId: objectIdString,
  quantity: z
    .number({
      invalid_type_error: 'La cantidad debe ser un número',
      required_error: 'La cantidad es obligatoria',
    })
    .int('La cantidad debe ser entera')
    .min(MIN_QUOTE_QUANTITY, `La cantidad mínima es ${MIN_QUOTE_QUANTITY}`)
    .max(MAX_QUOTE_QUANTITY, `La cantidad máxima es ${MAX_QUOTE_QUANTITY}`),
});

export const quoteRequestSchema = z.object({
  clientId: objectIdString,
  items: z
    .array(quoteItemSchema)
    .min(1, 'Debe incluir al menos un ítem')
    .max(50, 'Máximo 50 ítems por cotización'),
});

export type QuoteRequestInput = z.infer<typeof quoteRequestSchema>;

/**
 * Self-quote: NO clientId. The backend resolves the Client from
 * `req.user.id` and validates ownership via the existing Pricing Engine.
 */
export const selfQuoteRequestSchema = z
  .object({
    items: z
      .array(quoteItemSchema)
      .min(1, 'Debe incluir al menos un ítem')
      .max(50, 'Máximo 50 ítems por cotización'),
  })
  .strict();

export type SelfQuoteRequestInput = z.infer<typeof selfQuoteRequestSchema>;
