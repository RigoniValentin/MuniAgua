import { Types } from 'mongoose';
import { z } from 'zod';
import {
  ALL_CLIENT_TYPES,
  ALL_DOCUMENT_TYPES,
  SORTABLE_FIELDS,
  type ClientSortableField,
  type ClientType,
  type DocumentType,
} from './clients.types.js';

const trimmedString = (max: number, message?: string) =>
  z
    .string()
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(1, message ?? 'Requerido')
        .max(max, `Máximo ${max} caracteres`),
    );

/**
 * Normalises an optional string while preserving the difference between "the
 * caller did not send this field" and "the caller wants to clear it":
 *
 *   absent / undefined → undefined  (leave the stored value alone)
 *   null / ''          → null       (explicit clear)
 *
 * Collapsing `undefined` into `null` here would turn every partial update into a
 * field wipe, because the service applies `value !== undefined` checks.
 */
const blankToNull = (value: string | null | undefined) => {
  if (value === undefined) return undefined;
  if (value === null || value.length === 0) return null;
  return value;
};

const optionalTrimmedString = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .max(max),
    )
    .nullish()
    .transform(blankToNull);

const phoneSchema = z
  .string()
  .max(40, 'Máximo 40 caracteres')
  .transform((v) => v.replace(/[^\d+()\-\s]/g, '').trim())
  .pipe(
    z
      .string()
      .max(40, 'Máximo 40 caracteres')
      .regex(/^[+\d()\-\s]*$/, 'Teléfono inválido')
      .refine((v) => v.length === 0 || v.replace(/\D/g, '').length >= 4, {
        message: 'Teléfono demasiado corto',
      }),
  )
  .nullish()
  .transform(blankToNull);

const emailSchema = z
  .string()
  .max(160, 'Máximo 160 caracteres')
  .transform((v) => v.trim().toLowerCase())
  .pipe(
    z
      .string()
      .max(160)
      .refine(
        (v) => v.length === 0 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
        'Email inválido',
      ),
  )
  .nullish()
  .transform(blankToNull);

const documentNumberSchema = z
  .string()
  .min(1, 'Requerido')
  .max(32, 'Máximo 32 caracteres')
  .transform((v) =>
    v
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '')
      .replace(/-/g, '')
      .replace(/\./g, ''),
  )
  .pipe(
    z
      .string()
      .min(1, 'Requerido')
      .max(32, 'Máximo 32 caracteres')
      .regex(/^[A-Z0-9]+$/, 'Solo letras y números'),
  );

const addressSchema = z.object({
  street: trimmedString(120, 'La calle es obligatoria'),
  number: optionalTrimmedString(20),
  floor: optionalTrimmedString(10),
  apartment: optionalTrimmedString(10),
  neighborhood: optionalTrimmedString(80),
  locality: trimmedString(80, 'La localidad es obligatoria'),
  postalCode: optionalTrimmedString(20),
  references: optionalTrimmedString(240),
});

export const createClientSchema = z.object({
  firstName: trimmedString(80, 'El nombre es obligatorio'),
  lastName: trimmedString(80, 'El apellido es obligatorio'),
  documentType: z
    .enum(ALL_DOCUMENT_TYPES as [DocumentType, ...DocumentType[]], {
      errorMap: () => ({ message: 'Tipo de documento inválido' }),
    })
    .optional(),
  documentNumber: documentNumberSchema.optional(),
  phone: phoneSchema,
  email: emailSchema,
  clientType: z.enum(ALL_CLIENT_TYPES as [ClientType, ...ClientType[]], {
    errorMap: () => ({ message: 'Tipo de cliente inválido' }),
  }),
  address: addressSchema,
  zona: optionalTrimmedString(32),
  notes: optionalTrimmedString(1000),
  active: z.boolean().optional().default(true),
});

export type CreateClientInput = z.infer<typeof createClientSchema>;

const documentTypeSchema = z.enum(ALL_DOCUMENT_TYPES as [DocumentType, ...DocumentType[]], {
  errorMap: () => ({ message: 'Tipo de documento inválido' }),
});

const clientTypeSchema = z.enum(ALL_CLIENT_TYPES as [ClientType, ...ClientType[]], {
  errorMap: () => ({ message: 'Tipo de cliente inválido' }),
});

/**
 * Every field a staff member may edit on an existing client. Shared by the
 * single-record `PATCH /:id` and the bulk `PATCH /bulk` so both accept exactly
 * the same payload — `.strict()` on each caller is the mass-assignment guard.
 */
const updatableClientFields = {
  firstName: trimmedString(80, 'El nombre es obligatorio').optional(),
  lastName: trimmedString(80, 'El apellido es obligatorio').optional(),
  documentType: documentTypeSchema.optional(),
  documentNumber: documentNumberSchema.optional(),
  phone: phoneSchema,
  email: emailSchema,
  clientType: clientTypeSchema.optional(),
  address: addressSchema.optional(),
  zona: optionalTrimmedString(32),
  notes: optionalTrimmedString(1000),
  active: z.boolean().optional(),
};

export const updateClientSchema = z.object(updatableClientFields).strict();

export type UpdateClientInput = z.infer<typeof updateClientSchema>;

// ============================================================================
// Bulk update — applies the same field set to many clients at once.
// ============================================================================

/**
 * Hard cap on a single bulk request. It bounds both `PATCH /bulk` and
 * `GET /bulk/ids`, so any selection the UI can build is always submittable.
 * One `bulkWrite` of 1000 single-key updates is a few hundred KB and stays
 * well inside Mongo's 16 MB command limit.
 */
export const BULK_MAX_IDS = 1000;

const objectIdSchema = z
  .string()
  .refine((v) => Types.ObjectId.isValid(v), { message: 'Identificador de cliente inválido' });

/**
 * Bulk changes are deliberately narrower than `updateClientSchema`: the
 * document pair is backed by a unique compound index, so writing one document
 * number onto N clients can only ever collide. Rejecting it here turns an
 * opaque Mongo duplicate-key 500 into an actionable 400.
 */
const bulkClientFields = {
  ...updatableClientFields,
  documentType: z.never().optional(),
  documentNumber: z.never().optional(),
};

const bulkChangesSchema = z
  .object(bulkClientFields)
  .strict()
  .refine(
    (changes) => Object.values(changes).some((v) => v !== undefined),
    'Seleccioná al menos un campo a modificar',
  );

export const bulkUpdateClientsSchema = z
  .object({
    ids: z
      .array(objectIdSchema)
      .min(1, 'Seleccioná al menos un cliente')
      .max(BULK_MAX_IDS, `No se pueden modificar más de ${BULK_MAX_IDS} clientes por vez`),
    changes: bulkChangesSchema,
  })
  .strict();

export type BulkUpdateClientsInput = z.infer<typeof bulkUpdateClientsSchema>;

// ============================================================================
// Citizen self profile — STRICT allow-list.
// Only contact / address fields that the citizen may edit. Mass-assignment
// guard via `.strict()` — any other field is a 400.
// ============================================================================

export const updateSelfClientSchema = z
  .object({
    phone: phoneSchema,
    email: emailSchema,
    address: z
      .object({
        street: trimmedString(120, 'La calle es obligatoria'),
        number: optionalTrimmedString(20),
        floor: optionalTrimmedString(10),
        apartment: optionalTrimmedString(10),
        neighborhood: optionalTrimmedString(80),
        postalCode: optionalTrimmedString(20),
        references: optionalTrimmedString(240),
      })
      .strict()
      .optional(),
  })
  .strict();

export type UpdateSelfClientInput = z.infer<typeof updateSelfClientSchema>;

/**
 * Discriminated identifier: email OR documentNumber. The operator types whichever
 * they have on hand. Server-side picks the lookup by format.
 */
export const linkCitizenAccessSchema = z
  .object({
    identifier: z
      .string()
      .min(1, 'Ingresá el email o el documento del usuario')
      .max(160)
      .transform((v) => v.trim())
      .pipe(
        z
          .string()
          .min(1, 'Ingresá el email o el documento del usuario')
          .max(160),
      ),
  })
  .strict();

export type LinkCitizenAccessInput = z.infer<typeof linkCitizenAccessSchema>;

/** Detects if a string looks like a DNI (numeric, optional dots/hyphens, 6-9 digits). */
export function looksLikeDni(input: string): boolean {
  const cleaned = input.replace(/[\s.-]/g, '');
  return /^\d{6,9}$/.test(cleaned);
}

/** Detects if a string looks like a phone number (10+ digits after cleanup). */
export function looksLikePhone(input: string): boolean {
  const cleaned = input.replace(/\D/g, '');
  return /^\d{10,}$/.test(cleaned);
}

/** Normalize a phone number: strip everything except digits. */
export function normalizePhone(input: string): string {
  return input.replace(/\D/g, '');
}

/** Normalize a document number like the Client/User model does. */
export function normalizeDni(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/-/g, '')
    .replace(/\./g, '');
}

/** Discriminated identifier kinds accepted by `linkCitizenAccess`. */
export type IdentifierKind = 'email' | 'dni' | 'phone';

/**
 * Classify a free-form identifier string. Order matters:
 *  - `@` → email
 *  - >= 10 digits → phone (covers AR mobiles +549 11 5555 5555 = 13 digits)
 *  - else → DNI
 */
export function classifyIdentifier(input: string): IdentifierKind {
  const trimmed = input.trim();
  if (trimmed.includes('@')) return 'email';
  if (looksLikePhone(trimmed)) return 'phone';
  return 'dni';
}

export const LIST_MAX_LIMIT = 100;
export const LIST_DEFAULT_LIMIT = 20;

export const clientListQuerySchema = z.object({
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
    .transform((v) => (v === undefined ? LIST_DEFAULT_LIMIT : Number(v)))
    .pipe(
      z
        .number()
        .int('El límite debe ser entero')
        .min(1, 'El límite debe ser mayor o igual a 1')
        .max(LIST_MAX_LIMIT, `El límite máximo es ${LIST_MAX_LIMIT}`),
    ),
  search: z
    .string()
    .max(80, 'Búsqueda demasiado larga')
    .optional()
    .transform((v) => (v ? v.trim() : undefined)),
  clientType: z
    .enum(ALL_CLIENT_TYPES as [ClientType, ...ClientType[]], {
      errorMap: () => ({ message: 'Tipo de cliente inválido' }),
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
    .transform((v): ClientSortableField => {
      if (!v) return 'lastName';
      return (SORTABLE_FIELDS as readonly string[]).includes(v)
        ? (v as ClientSortableField)
        : 'lastName';
    }),
  sortOrder: z
    .union([z.literal('asc'), z.literal('desc')])
    .optional()
    .transform((v) => v ?? 'asc'),
});

export type ClientListQuery = z.infer<typeof clientListQuerySchema>;
