import { z } from 'zod';
import {
  ALL_PRODUCT_TYPES,
  MAX_BASE_PRICE_MINOR,
  SORTABLE_PRODUCT_FIELDS,
  type ProductSortableField,
  type ProductType,
} from './products.types.js';

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
    .max(max, `Máximo ${max} caracteres`)
    .transform((v) => v.trim())
    .pipe(z.string().max(max))
    .nullish()
    .transform((v) => {
      if (v === undefined || v === null) return null;
      return v.length === 0 ? null : v;
    });

const codeSchema = z
  .string()
  .transform((v) =>
    v
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '_')
      .replace(/-/g, '_')
      .replace(/\./g, ''),
  )
  .pipe(
    z
      .string()
      .min(1, 'El código es obligatorio')
      .max(40, 'Máximo 40 caracteres')
      .regex(/^[A-Z0-9_]+$/, 'Solo letras, números y guion bajo'),
  );

const basePriceMinorSchema = z
  .number({
    invalid_type_error: 'El precio base debe ser un número entero',
    required_error: 'El precio base es obligatorio',
  })
  .int('El precio base debe ser un entero')
  .min(0, 'El precio base no puede ser negativo')
  .max(MAX_BASE_PRICE_MINOR, `El precio base máximo es ${MAX_BASE_PRICE_MINOR}`);

export const createProductSchema = z.object({
  code: codeSchema,
  name: trimmedRequired(120, 'El nombre es obligatorio'),
  description: trimmedOptional(500),
  productType: z.enum(ALL_PRODUCT_TYPES as [ProductType, ...ProductType[]], {
    errorMap: () => ({ message: 'Tipo de producto inválido' }),
  }),
  basePriceMinor: basePriceMinorSchema,
  tracksStock: z.boolean().optional().default(false),
  active: z.boolean().optional().default(true),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    code: codeSchema.optional(),
    name: trimmedRequired(120, 'El nombre es obligatorio').optional(),
    description: trimmedOptional(500),
    productType: z
      .enum(ALL_PRODUCT_TYPES as [ProductType, ...ProductType[]], {
        errorMap: () => ({ message: 'Tipo de producto inválido' }),
      })
      .optional(),
    basePriceMinor: basePriceMinorSchema.optional(),
    tracksStock: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const PRODUCTS_LIST_MAX_LIMIT = 100;
export const PRODUCTS_LIST_DEFAULT_LIMIT = 20;

export const productListQuerySchema = z.object({
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
    .transform((v) => (v === undefined ? PRODUCTS_LIST_DEFAULT_LIMIT : Number(v)))
    .pipe(
      z
        .number()
        .int('El límite debe ser entero')
        .min(1, 'El límite debe ser mayor o igual a 1')
        .max(PRODUCTS_LIST_MAX_LIMIT, `El límite máximo es ${PRODUCTS_LIST_MAX_LIMIT}`),
    ),
  search: z
    .string()
    .max(80, 'Búsqueda demasiado larga')
    .optional()
    .transform((v) => (v ? v.trim() : undefined)),
  productType: z
    .enum(ALL_PRODUCT_TYPES as [ProductType, ...ProductType[]], {
      errorMap: () => ({ message: 'Tipo de producto inválido' }),
    })
    .optional(),
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
    .transform((v): ProductSortableField => {
      if (!v) return 'name';
      return (SORTABLE_PRODUCT_FIELDS as readonly string[]).includes(v)
        ? (v as ProductSortableField)
        : 'name';
    }),
  sortOrder: z
    .union([z.literal('asc'), z.literal('desc')])
    .optional()
    .transform((v) => v ?? 'asc'),
});

export type ProductListQuery = z.infer<typeof productListQuerySchema>;
