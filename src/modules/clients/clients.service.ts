import { Types } from 'mongoose';
import { Client, type ClientAddress, type ClientDocument } from './clients.model.js';
import {
  type ClientListQuery,
  LIST_DEFAULT_LIMIT,
  classifyIdentifier,
  normalizeDni,
  normalizePhone,
} from './clients.validation.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import type { ClientType, DocumentType } from './clients.types.js';
import type {
  CitizenAccessDto,
  CitizenAccessUserDto,
  CitizenClientDto,
} from './clients.citizen.types.js';
import { User, type UserDocument } from '../users/users.model.js';
import { ROLES } from '../users/users.types.js';

export interface ClientListPagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface ClientListResult {
  items: ClientDto[];
  pagination: ClientListPagination;
}

export interface ClientDto {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  documentType: DocumentType | null;
  documentNumber: string | null;
  phone: string | null;
  email: string | null;
  clientType: ClientType;
  address: ClientAddress;
  zona: string | null;
  userId: string | null;
  hasUserAccount: boolean;
  notes: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface CreateClientArgs {
  firstName: string;
  lastName: string;
  documentType?: DocumentType | null;
  documentNumber?: string | null;
  phone?: string | null;
  email?: string | null;
  clientType: ClientType;
  address: ClientAddress;
  zona?: string | null;
  notes?: string | null;
  active?: boolean;
  createdBy?: string | null;
}

export interface UpdateClientArgs {
  firstName?: string;
  lastName?: string;
  documentType?: DocumentType | null;
  documentNumber?: string | null;
  phone?: string | null;
  email?: string | null;
  clientType?: ClientType;
  address?: ClientAddress;
  zona?: string | null;
  notes?: string | null;
  active?: boolean;
  updatedBy?: string | null;
}

export function toClientDto(doc: ClientDocument): ClientDto {
  const userId = doc.userId ? doc.userId.toString() : null;
  return {
    id: doc._id.toString(),
    firstName: doc.firstName,
    lastName: doc.lastName,
    fullName: `${doc.firstName} ${doc.lastName}`.trim(),
    documentType: doc.documentType,
    documentNumber: doc.documentNumber,
    phone: doc.phone ?? null,
    email: doc.email ?? null,
    clientType: doc.clientType,
    address: doc.address,
    zona: doc.zona ?? null,
    userId,
    hasUserAccount: Boolean(userId),
    notes: doc.notes ?? null,
    active: doc.active,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: doc.createdBy ? doc.createdBy.toString() : null,
    updatedBy: doc.updatedBy ? doc.updatedBy.toString() : null,
  };
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchFilter(search: string | undefined) {
  if (!search) return undefined;
  const safe = escapeRegex(search);
  const re = new RegExp(safe, 'i');
  return {
    $or: [
      { firstName: re },
      { lastName: re },
      { documentNumber: re },
      { phone: re },
      { 'address.street': re },
    ],
  };
}

const SEARCH_COLLATION = { locale: 'es', strength: 2 } as const;

export async function listClients(query: ClientListQuery): Promise<ClientListResult> {
  const page = query.page ?? 1;
  const limit = query.limit ?? LIST_DEFAULT_LIMIT;

  const filter: Record<string, unknown> = {};
  if (query.clientType) {
    filter.clientType = query.clientType;
  }
  if (query.active !== undefined) {
    filter.active = query.active;
  }
  const searchFilter = buildSearchFilter(query.search);
  if (searchFilter) {
    Object.assign(filter, searchFilter);
  }

  const sort: Record<string, 1 | -1> = {
    [query.sortBy]: query.sortOrder === 'desc' ? -1 : 1,
  };
  if (query.sortBy !== 'lastName') {
    sort.lastName = 1;
  }
  if (query.sortBy !== 'firstName') {
    sort.firstName = 1;
  }

  const [docs, total] = await Promise.all([
    Client.find(filter)
      .sort(sort)
      .collation(SEARCH_COLLATION)
      .skip((page - 1) * limit)
      .limit(limit),
    Client.countDocuments(filter),
  ]);

  const pages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;
  return {
    items: docs.map(toClientDto),
    pagination: { page, limit, total, pages },
  };
}

export async function findClientById(id: string): Promise<ClientDocument | null> {
  if (!Types.ObjectId.isValid(id)) {
    return null;
  }
  return Client.findById(id);
}

export async function getClientOrThrow(id: string): Promise<ClientDocument> {
  const client = await findClientById(id);
  if (!client) {
    throw new NotFoundError('Cliente no encontrado');
  }
  return client;
}

export async function findClientByDocument(
  documentType: DocumentType,
  documentNumber: string,
): Promise<ClientDocument | null> {
  return Client.findByDocument(documentType, documentNumber);
}

export async function createClient(args: CreateClientArgs): Promise<ClientDocument> {
  if (args.documentType && args.documentNumber) {
    const existing = await Client.findByDocument(args.documentType, args.documentNumber);
    if (existing) {
      throw new ConflictError('Ya existe un cliente registrado con ese documento');
    }
  }

  const createdById = args.createdBy && Types.ObjectId.isValid(args.createdBy)
    ? new Types.ObjectId(args.createdBy)
    : null;

  return Client.create({
    firstName: args.firstName,
    lastName: args.lastName,
    documentType: args.documentType ?? null,
    documentNumber: args.documentNumber ?? null,
    phone: args.phone ?? null,
    email: args.email ?? null,
    clientType: args.clientType,
    address: args.address,
    zona: args.zona ?? null,
    notes: args.notes ?? null,
    active: args.active ?? true,
    createdBy: createdById,
    updatedBy: createdById,
  });
}

export async function updateClient(
  id: string,
  args: UpdateClientArgs,
): Promise<ClientDocument> {
  const client = await getClientOrThrow(id);

  if (
    args.documentType &&
    args.documentNumber &&
    (args.documentType !== client.documentType || args.documentNumber !== client.documentNumber)
  ) {
    const conflict = await Client.findOne({
      _id: { $ne: client._id },
      documentType: args.documentType,
      documentNumber: args.documentNumber,
    });
    if (conflict) {
      throw new ConflictError('Ya existe un cliente registrado con ese documento');
    }
  }
  // Allow clearing document by passing an empty/null value explicitly.
  const clearingDocument =
    args.documentNumber !== undefined &&
    args.documentNumber !== null &&
    args.documentNumber.trim() === '';

  if (args.firstName !== undefined) client.firstName = args.firstName;
  if (args.lastName !== undefined) client.lastName = args.lastName;
  if (clearingDocument) {
    client.documentType = null;
    client.documentNumber = null;
  } else {
    if (args.documentType !== undefined) client.documentType = args.documentType;
    if (args.documentNumber !== undefined) client.documentNumber = args.documentNumber;
  }
  if (args.phone !== undefined) client.phone = args.phone;
  if (args.email !== undefined) client.email = args.email;
  if (args.clientType !== undefined) client.clientType = args.clientType;
  if (args.zona !== undefined) client.zona = args.zona;
  if (args.notes !== undefined) client.notes = args.notes;
  if (args.active !== undefined) client.active = args.active;
  if (args.address !== undefined) client.address = args.address;

  if (args.updatedBy && Types.ObjectId.isValid(args.updatedBy)) {
    client.updatedBy = new Types.ObjectId(args.updatedBy);
  }

  await client.save();
  return client;
}

// ============================================================================
// Citizen self — secure DTO + restricted update
// ============================================================================

/**
 * Domain error thrown when the authenticated user has no Client linked.
 * Surfaces as a 404 with a stable code `CLIENT_NOT_LINKED`.
 */
export class ClientNotLinkedError extends AppError {
  constructor() {
    super(404, 'CLIENT_NOT_LINKED', 'Tu usuario todavía no está vinculado a un cliente');
  }
}

/**
 * Build the safe CitizenClientDto. NEVER include notes/userId/createdBy/updatedBy.
 * `createdAt` is exposed so the dashboard can render "Cliente desde …" but the
 * shape is otherwise restricted.
 */
export function toCitizenClientDto(doc: ClientDocument): CitizenClientDto {
  return {
    id: doc._id.toString(),
    firstName: doc.firstName,
    lastName: doc.lastName,
    fullName: `${doc.firstName} ${doc.lastName}`.trim(),
documentType: doc.documentType,
      documentNumber: doc.documentNumber,
      phone: doc.phone ?? null,
      email: doc.email ?? null,
    clientType: doc.clientType,
    address: {
      street: doc.address.street,
      number: doc.address.number ?? null,
      floor: doc.address.floor ?? null,
      apartment: doc.address.apartment ?? null,
      neighborhood: doc.address.neighborhood ?? null,
      locality: doc.address.locality,
      postalCode: doc.address.postalCode ?? null,
      references: doc.address.references ?? null,
    },
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
  };
}

function buildCitizenAccessUserDto(user: UserDocument): CitizenAccessUserDto {
  return {
    id: user._id.toString(),
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    documentNumber: user.documentNumber ?? null,
    active: user.active,
  };
}

function buildCitizenAccessDto(
  user: UserDocument | null,
): CitizenAccessDto {
  return {
    linked: user !== null,
    user: user ? buildCitizenAccessUserDto(user) : null,
  };
}

export async function findClientByUserId(
  userId: string,
): Promise<ClientDocument | null> {
  if (!Types.ObjectId.isValid(userId)) return null;
  return Client.findOne({ userId: new Types.ObjectId(userId) });
}

export async function getSelfClientOrThrow(
  userId: string,
): Promise<ClientDocument> {
  const client = await findClientByUserId(userId);
  if (!client) {
    throw new ClientNotLinkedError();
  }
  return client;
}

/**
 * Restricted self-update: ONLY phone/email/address.sub-fields.
 * - locality MUST NOT change from this endpoint.
 * - Everything else (name/document/clientType/active/userId/notes) is rejected
 *   at the validation layer via `.strict()` Zod schema.
 * - `updatedBy` is set to the authenticated user (the citizen themself) for
 *   accountability, but it is NOT returned to the citizen.
 */
export async function updateSelfClient(
  userId: string,
  args: {
    phone?: string | null;
    email?: string | null;
    address?: {
      street?: string;
      number?: string | null;
      floor?: string | null;
      apartment?: string | null;
      neighborhood?: string | null;
      postalCode?: string | null;
      references?: string | null;
    };
  },
): Promise<ClientDocument> {
  const client = await getSelfClientOrThrow(userId);

  if (args.phone !== undefined) client.phone = args.phone;
  if (args.email !== undefined) client.email = args.email;
  if (args.address) {
    if (args.address.street !== undefined) {
      client.address.street = args.address.street;
    }
    if (args.address.number !== undefined) {
      client.address.number = args.address.number;
    }
    if (args.address.floor !== undefined) {
      client.address.floor = args.address.floor;
    }
    if (args.address.apartment !== undefined) {
      client.address.apartment = args.address.apartment;
    }
    if (args.address.neighborhood !== undefined) {
      client.address.neighborhood = args.address.neighborhood;
    }
    if (args.address.postalCode !== undefined) {
      client.address.postalCode = args.address.postalCode;
    }
    if (args.address.references !== undefined) {
      client.address.references = args.address.references;
    }
  }

  if (Types.ObjectId.isValid(userId)) {
    client.updatedBy = new Types.ObjectId(userId);
  }

  await client.save();
  return client;
}

// ============================================================================
// Administrative citizen-access linking
// ============================================================================

async function loadLinkedUserForClient(
  client: ClientDocument,
): Promise<UserDocument | null> {
  if (!client.userId) return null;
  return User.findById(client.userId);
}

export async function getCitizenAccess(
  clientId: string,
): Promise<CitizenAccessDto> {
  const client = await getClientOrThrow(clientId);
  const user = await loadLinkedUserForClient(client);
  return buildCitizenAccessDto(user);
}

export interface LinkCitizenAccessResult {
  client: ClientDocument;
  user: UserDocument;
  linked: boolean;
}

/**
 * Sync core identity & contact fields from the User onto the Client after a
 * successful link. The User is the source of truth: when the User has a value,
 * it overwrites the Client. When the User lacks a value, the Client keeps its
 * existing value (non-destructive fallback so we don't blank out phone/email
 * that came from the Excel import just because the User forgot to fill them
 * during self-registration).
 *
 * Exported so `auth.service.register` can reuse the same policy.
 */
export function syncClientFromUser(client: ClientDocument, user: UserDocument): void {
  // Document: if the User has one, copy it (and assume DNI if not already set).
  if (user.documentNumber) {
    client.documentNumber = user.documentNumber;
    if (!client.documentType) {
      client.documentType = 'DNI';
    }
  }
  // Email: User wins if present.
  if (user.email) {
    client.email = user.email;
  }
  // Phone: User wins if present, otherwise keep whatever the Client had.
  if (user.phone) {
    client.phone = user.phone;
  }
  // First/Last name: only overwrite if the Client doesn't have one yet
  // (handles the Excel-import case where the padrón row may be a "placeholder").
  if (!client.firstName?.trim() && user.firstName) client.firstName = user.firstName;
  if (!client.lastName?.trim() && user.lastName) client.lastName = user.lastName;
}

/**
 * Link a CIUDADANO User to a Client. Idempotent if the same User is already
 * linked to the same Client.
 *
 * The `identifier` may be an email, a phone number or a document number (DNI).
 * The function auto-detects format. Errors:
 *  - 404 if the identifier does not match any User, the User is not CIUDADANO,
 *    the User is inactive, or the Client is missing
 *  - 409 if User is already linked to a DIFFERENT Client
 *  - 409 if Client is already linked to a DIFFERENT User
 *
 * On success, the Client is updated with the User's email, phone and document
 * number so the padrón stays consistent even if the imported Excel row was
 * missing those fields. The User is the source of truth — non-destructive
 * fallback applies when the User lacks a field.
 */
export async function linkCitizenAccess(
  clientId: string,
  identifier: string,
  actorId: string | null,
): Promise<LinkCitizenAccessResult> {
  const client = await getClientOrThrow(clientId);

  const trimmed = identifier.trim();
  const kind = classifyIdentifier(trimmed);
  let user: UserDocument | null;

  if (kind === 'email') {
    const normalized = trimmed.toLowerCase();
    user = await User.findOne({ email: normalized });
    if (!user) {
      throw new NotFoundError('No existe un usuario con ese email');
    }
  } else if (kind === 'phone') {
    const normalized = normalizePhone(trimmed);
    // Match by exact normalized phone. We also match the trailing N digits
    // to be friendly to slight formatting differences in the padrón vs the
    // self-registration form (e.g. +549 vs 549 prefix).
    user = await User.findOne({ phone: normalized });
    if (!user) {
      // Try trailing 10 digits fallback (covers the +54 country code prefix).
      const tail = normalized.slice(-10);
      if (tail.length === 10) {
        user = await User.findOne({ phone: { $regex: `${tail}$` } });
      }
    }
    if (!user) {
      throw new NotFoundError(
        'No existe un usuario con ese teléfono. Verificá que el vecino haya completado el registro con el mismo número.',
      );
    }
  } else {
    const normalized = normalizeDni(trimmed);
    user = await User.findOne({ documentNumber: normalized });
    if (!user) {
      throw new NotFoundError(
        'No existe un usuario con ese documento. Verificá que el vecino haya completado el registro.',
      );
    }
  }

  if (user.role !== ROLES.CIUDADANO) {
    throw new ValidationError(
      'El usuario debe tener rol CIUDADANO para ser vinculado como cliente',
    );
  }
  if (!user.active) {
    throw new ValidationError('El usuario está inactivo y no puede vincularse');
  }

  // Idempotent path: same User, same Client. Still re-sync fields so a later
  // registration update propagates back to the Client.
  if (client.userId && client.userId.toString() === user._id.toString()) {
    syncClientFromUser(client, user);
    if (actorId && Types.ObjectId.isValid(actorId)) {
      client.updatedBy = new Types.ObjectId(actorId);
    }
    await client.save();
    return { client, user, linked: true };
  }

  // Client already linked to a DIFFERENT User.
  if (client.userId && client.userId.toString() !== user._id.toString()) {
    throw new ConflictError(
      'Este cliente ya está vinculado a otra cuenta de usuario',
    );
  }

  // User already linked to a DIFFERENT Client.
  const otherClient = await Client.findOne({
    userId: user._id,
    _id: { $ne: client._id },
  });
  if (otherClient) {
    throw new ConflictError(
      'Este usuario ya está vinculado a otro cliente',
    );
  }

  client.userId = user._id;
  syncClientFromUser(client, user);
  if (actorId && Types.ObjectId.isValid(actorId)) {
    client.updatedBy = new Types.ObjectId(actorId);
  }
  await client.save();

  return { client, user, linked: true };
}

/**
 * Unlink the citizen access from a Client. Does NOT delete the User, the
 * Client, or any ledger entry.
 */
export async function unlinkCitizenAccess(
  clientId: string,
  actorId: string | null,
): Promise<ClientDocument> {
  const client = await getClientOrThrow(clientId);
  if (!client.userId) {
    // Idempotent: nothing to do.
    return client;
  }
  client.userId = null;
  if (actorId && Types.ObjectId.isValid(actorId)) {
    client.updatedBy = new Types.ObjectId(actorId);
  }
  await client.save();
  return client;
}
