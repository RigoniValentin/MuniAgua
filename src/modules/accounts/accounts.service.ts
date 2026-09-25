/**
 * Accounts module — FASE 4.
 *
 * The AccountMovement ledger is the single source of truth for the balance.
 * Controllers NEVER call `AccountMovement.create()` directly — they use
 * `postMovement()` (or `reverseMovement()` for reversals). Future phases
 * (Orders, Payments) will reuse the same service.
 *
 * The optional `session` argument is accepted on all write paths so that
 * future transactions (e.g. creating an Order + AccountMovement atomically)
 * can be wired without changing call sites.
 */
import {
  Types,
  type ClientSession,
  type PipelineStage,
} from 'mongoose';
import {
  AccountMovement,
  type AccountMovementDocument,
} from './account-movements.model.js';
import {
  inverseDirection,
  signedContribution,
  statusFromBalance,
  type AccountStatus,
  type Direction,
  type MovementType,
  type SourceType,
} from './accounts.types.js';
import { Client, type ClientDocument } from '../clients/clients.model.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import {
  ACCOUNTS_LIST_DEFAULT_LIMIT,
  type AccountsListQuery,
} from './accounts.validation.js';
import type { ClientType } from '../clients/clients.types.js';

// ============================================================================
// Public DTOs
// ============================================================================

export interface AccountMovementDto {
  id: string;
  clientId: string;
  direction: Direction;
  amountMinor: number;
  signedAmountMinor: number;
  movementType: MovementType;
  description: string;
  occurredAt: Date;
  sourceType: SourceType;
  sourceId: string | null;
  idempotencyKey: string | null;
  reversesMovementId: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface AccountSummary {
  clientId: string;
  totalDebitsMinor: number;
  totalCreditsMinor: number;
  balanceMinor: number;
  status: AccountStatus;
  lastMovementAt: Date | null;
}

export interface AccountSummaryResponse {
  client: {
    id: string;
    firstName: string;
    lastName: string;
    fullName: string;
    documentType: string | null;
    documentNumber: string | null;
    clientType: ClientType;
    active: boolean;
    hasUserAccount: boolean;
  };
  account: AccountSummary;
}

export interface AccountListItem {
  clientId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  documentType: string | null;
  documentNumber: string | null;
  clientType: ClientType;
  active: boolean;
  hasUserAccount: boolean;
  totalDebitsMinor: number;
  totalCreditsMinor: number;
  balanceMinor: number;
  status: AccountStatus;
  lastMovementAt: Date | null;
}

export interface AccountListPagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface AccountListResult {
  items: AccountListItem[];
  pagination: AccountListPagination;
}

export interface MovementsListPagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface MovementsListResult {
  items: AccountMovementDto[];
  pagination: MovementsListPagination;
}

// ============================================================================
// DTO helpers
// ============================================================================

export function toMovementDto(doc: AccountMovementDocument): AccountMovementDto {
  const signed = signedContribution(doc.direction, doc.amountMinor);
  return {
    id: doc._id.toString(),
    clientId: doc.clientId.toString(),
    direction: doc.direction,
    amountMinor: doc.amountMinor,
    signedAmountMinor: signed,
    movementType: doc.movementType,
    description: doc.description,
    occurredAt: doc.occurredAt,
    sourceType: doc.sourceType,
    sourceId: doc.sourceId ? doc.sourceId.toString() : null,
    idempotencyKey: doc.idempotencyKey ?? null,
    reversesMovementId: doc.reversesMovementId
      ? doc.reversesMovementId.toString()
      : null,
    createdBy: doc.createdBy ? doc.createdBy.toString() : null,
    createdAt: doc.createdAt,
  };
}

// ============================================================================
// Idempotency strategy
// ============================================================================

export class IdempotencyConflictError extends ConflictError {
  constructor(public readonly existing: AccountMovementDocument) {
    super('Operación idempotente en conflicto con un movimiento existente');
  }
}

/**
 * Idempotency strategy:
 *
 *   1. If no `idempotencyKey` is provided, write a fresh movement every call.
 *
 *   2. If a key is provided:
 *      a. We first try to find an existing movement with that key.
 *      b. If none exists, we attempt to insert. The unique partial index on
 *         `idempotencyKey` guarantees at most one document per key under
 *         concurrency — a duplicate key error translates to a re-fetch.
 *      c. Once we have the existing document we compare the canonical
 *         payload (direction, amountMinor, movementType, clientId). If all
 *         four match, we return the existing movement as a safe no-op. If
 *         any field differs, we throw `IdempotencyConflictError` so callers
 *         can decide whether to surface 409 CONFLICT.
 *
 * This guarantees the ledger never silently duplicates a financial effect.
 */
function buildCanonicalPayload(input: {
  clientId: Types.ObjectId;
  direction: Direction;
  amountMinor: number;
  movementType: MovementType;
}): string {
  return JSON.stringify({
    clientId: input.clientId.toString(),
    direction: input.direction,
    amountMinor: input.amountMinor,
    movementType: input.movementType,
  });
}

function matchesCanonical(
  doc: AccountMovementDocument,
  canonical: string,
): boolean {
  return (
    buildCanonicalPayload({
      clientId: doc.clientId,
      direction: doc.direction,
      amountMinor: doc.amountMinor,
      movementType: doc.movementType,
    }) === canonical
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function toObjectIdOrNull(value: string | null | undefined): Types.ObjectId | null {
  if (!value) return null;
  if (!Types.ObjectId.isValid(value)) return null;
  return new Types.ObjectId(value);
}

function isDuplicateKeyError(err: unknown, keyName: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code !== 11000) return false;
  const keyPattern = (err as { keyPattern?: Record<string, unknown> }).keyPattern;
  if (!keyPattern) return false;
  return Object.prototype.hasOwnProperty.call(keyPattern, keyName);
}

async function findExistingByIdempotency(
  key: string,
): Promise<AccountMovementDocument | null> {
  return AccountMovement.findOne({ idempotencyKey: key });
}

// ============================================================================
// Core: postMovement
// ============================================================================

export interface PostMovementArgs {
  clientId: string;
  direction: Direction;
  amountMinor: number;
  movementType: MovementType;
  description: string;
  sourceType?: SourceType;
  sourceId?: string | null;
  idempotencyKey?: string | null;
  createdBy?: string | null;
  occurredAt?: Date;
  reversesMovementId?: string | null;
  session?: ClientSession;
}

/**
 * Single entry point for registering AccountMovement entries. Future phases
 * (Orders, Payments) reuse this function.
 */
export async function postMovement(
  args: PostMovementArgs,
): Promise<AccountMovementDocument> {
  if (!Types.ObjectId.isValid(args.clientId)) {
    throw new ValidationError('Identificador de cliente inválido');
  }
  if (!Number.isInteger(args.amountMinor) || args.amountMinor <= 0) {
    throw new ValidationError('amountMinor debe ser un entero positivo');
  }
  if (!args.description || !args.description.trim()) {
    throw new ValidationError('La descripción es obligatoria');
  }

  const clientObjectId = new Types.ObjectId(args.clientId);
  const sourceObjectId = toObjectIdOrNull(args.sourceId ?? null);
  const createdByObjectId = toObjectIdOrNull(args.createdBy ?? null);
  const reversesObjectId = toObjectIdOrNull(args.reversesMovementId ?? null);
  const occurredAt = args.occurredAt ?? new Date();
  const sourceType: SourceType = args.sourceType ?? 'SYSTEM';

  const canonical = buildCanonicalPayload({
    clientId: clientObjectId,
    direction: args.direction,
    amountMinor: args.amountMinor,
    movementType: args.movementType,
  });

  const idempotencyKey =
    args.idempotencyKey && args.idempotencyKey.trim().length > 0
      ? args.idempotencyKey.trim()
      : null;

  if (idempotencyKey) {
    const existing = await findExistingByIdempotency(idempotencyKey);
    if (existing) {
      if (matchesCanonical(existing, canonical)) {
        return existing;
      }
      throw new IdempotencyConflictError(existing);
    }
  }

  try {
    const created = await AccountMovement.create(
      [
        {
          clientId: clientObjectId,
          direction: args.direction,
          amountMinor: args.amountMinor,
          movementType: args.movementType,
          description: args.description.trim(),
          occurredAt,
          sourceType,
          sourceId: sourceObjectId,
          idempotencyKey,
          reversesMovementId: reversesObjectId,
          createdBy: createdByObjectId,
        },
      ],
      { session: args.session },
    );
    const doc = created[0];
    if (!doc) {
      throw new ValidationError('No se pudo registrar el movimiento');
    }
    return doc;
  } catch (err) {
    if (idempotencyKey && isDuplicateKeyError(err, 'idempotencyKey')) {
      const existing = await findExistingByIdempotency(idempotencyKey);
      if (existing) {
        if (matchesCanonical(existing, canonical)) {
          return existing;
        }
        throw new IdempotencyConflictError(existing);
      }
    }
    if (
      reversesObjectId &&
      isDuplicateKeyError(err, 'reversesMovementId')
    ) {
      throw new ConflictError(
        'El movimiento ya fue revertido y no puede revertirse nuevamente',
      );
    }
    throw err;
  }
}

// ============================================================================
// Summary / balance calculation
// ============================================================================

interface AggregateResult {
  totalDebitsMinor: number;
  totalCreditsMinor: number;
  lastMovementAt: Date | null;
}

async function aggregateClientTotals(
  clientObjectId: Types.ObjectId,
): Promise<AggregateResult> {
  const [result] = await AccountMovement.aggregate<{
    _id: null;
    totalDebitsMinor: number;
    totalCreditsMinor: number;
    lastMovementAt: Date | null;
  }>([
    { $match: { clientId: clientObjectId } },
    {
      $group: {
        _id: null,
        totalDebitsMinor: {
          $sum: { $cond: [{ $eq: ['$direction', 'DEBIT'] }, '$amountMinor', 0] },
        },
        totalCreditsMinor: {
          $sum: { $cond: [{ $eq: ['$direction', 'CREDIT'] }, '$amountMinor', 0] },
        },
        lastMovementAt: { $max: '$occurredAt' },
      },
    },
  ]);

  if (!result) {
    return { totalDebitsMinor: 0, totalCreditsMinor: 0, lastMovementAt: null };
  }

  return {
    totalDebitsMinor: result.totalDebitsMinor,
    totalCreditsMinor: result.totalCreditsMinor,
    lastMovementAt: result.lastMovementAt,
  };
}

export async function getClientAccountSummary(
  clientId: string,
): Promise<AccountSummary> {
  if (!Types.ObjectId.isValid(clientId)) {
    throw new ValidationError('Identificador de cliente inválido');
  }
  const totals = await aggregateClientTotals(new Types.ObjectId(clientId));
  const balanceMinor = totals.totalDebitsMinor - totals.totalCreditsMinor;
  return {
    clientId,
    totalDebitsMinor: totals.totalDebitsMinor,
    totalCreditsMinor: totals.totalCreditsMinor,
    balanceMinor,
    status: statusFromBalance(balanceMinor),
    lastMovementAt: totals.lastMovementAt,
  };
}

export async function getClientAccountSummaryResponse(
  client: ClientDocument,
): Promise<AccountSummaryResponse> {
  const summary = await getClientAccountSummary(client._id.toString());
  return {
    client: {
      id: client._id.toString(),
      firstName: client.firstName,
      lastName: client.lastName,
      fullName: `${client.firstName} ${client.lastName}`.trim(),
      documentType: client.documentType,
      documentNumber: client.documentNumber,
      clientType: client.clientType,
      active: client.active,
      hasUserAccount: Boolean(client.userId),
    },
    account: summary,
  };
}

// ============================================================================
// Movements listing
// ============================================================================

export interface ListMovementsArgs {
  clientId: string;
  page: number;
  limit: number;
  direction?: Direction;
  movementType?: MovementType;
  dateFrom?: Date;
  dateTo?: Date;
}

export async function listClientMovements(
  args: ListMovementsArgs,
): Promise<MovementsListResult> {
  if (!Types.ObjectId.isValid(args.clientId)) {
    throw new ValidationError('Identificador de cliente inválido');
  }

  const filter: Record<string, unknown> = {
    clientId: new Types.ObjectId(args.clientId),
  };
  if (args.direction) {
    filter.direction = args.direction;
  }
  if (args.movementType) {
    filter.movementType = args.movementType;
  }
  if (args.dateFrom || args.dateTo) {
    const range: Record<string, Date> = {};
    if (args.dateFrom) range.$gte = args.dateFrom;
    if (args.dateTo) range.$lte = args.dateTo;
    filter.occurredAt = range;
  }

  const skip = (args.page - 1) * args.limit;
  const [docs, total] = await Promise.all([
    AccountMovement.find(filter)
      .sort({ occurredAt: -1, _id: -1 })
      .skip(skip)
      .limit(args.limit),
    AccountMovement.countDocuments(filter),
  ]);

  const pages = args.limit > 0 ? Math.max(1, Math.ceil(total / args.limit)) : 1;
  return {
    items: docs.map(toMovementDto),
    pagination: { page: args.page, limit: args.limit, total, pages },
  };
}

// ============================================================================
// Reverse movement
// ============================================================================

export interface ReverseMovementArgs {
  movementId: string;
  description: string;
  createdBy?: string | null;
  session?: ClientSession;
}

export async function reverseMovement(
  args: ReverseMovementArgs,
): Promise<AccountMovementDocument> {
  if (!Types.ObjectId.isValid(args.movementId)) {
    throw new ValidationError('Identificador de movimiento inválido');
  }
  if (!args.description || !args.description.trim()) {
    throw new ValidationError('La descripción es obligatoria');
  }

  const original = await AccountMovement.findById(args.movementId);
  if (!original) {
    throw new NotFoundError('Movimiento no encontrado');
  }

  if (original.movementType === 'REVERSAL') {
    throw new ValidationError(
      'No se puede revertir un movimiento que ya es una reversión',
    );
  }

  // Race-condition guard at the application layer. The unique partial index
  // on `reversesMovementId` is the authoritative guarantee — but checking
  // here lets us return a clean 409 instead of a raw duplicate-key error.
  const alreadyReversed = await AccountMovement.findOne({
    reversesMovementId: original._id,
  });
  if (alreadyReversed) {
    throw new ConflictError(
      'El movimiento ya fue revertido y no puede revertirse nuevamente',
    );
  }

  return postMovement({
    clientId: original.clientId.toString(),
    direction: inverseDirection(original.direction),
    amountMinor: original.amountMinor,
    movementType: 'REVERSAL',
    description: args.description.trim(),
    sourceType: 'REVERSAL',
    sourceId: original._id.toString(),
    reversesMovementId: original._id.toString(),
    createdBy: args.createdBy ?? null,
    occurredAt: new Date(),
    session: args.session,
  });
}

// ============================================================================
// Adjustment convenience (admin)
// ============================================================================

export interface CreateManualAdjustmentArgs {
  clientId: string;
  direction: Direction;
  amountMinor: number;
  description: string;
  createdBy?: string | null;
}

export async function createManualAdjustment(
  args: CreateManualAdjustmentArgs,
): Promise<AccountMovementDocument> {
  if (!Types.ObjectId.isValid(args.clientId)) {
    throw new ValidationError('Identificador de cliente inválido');
  }
  const client = await Client.findById(args.clientId);
  if (!client) {
    throw new NotFoundError('Cliente no encontrado');
  }

  return postMovement({
    clientId: args.clientId,
    direction: args.direction,
    amountMinor: args.amountMinor,
    movementType: 'MANUAL_ADJUSTMENT',
    description: args.description,
    sourceType: 'MANUAL',
    createdBy: args.createdBy ?? null,
  });
}

// ============================================================================
// Accounts list (admin)
// ============================================================================

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildClientSearchFilter(search: string | undefined) {
  if (!search) return undefined;
  const safe = escapeRegex(search);
  const re = new RegExp(safe, 'i');
  return {
    $or: [
      { firstName: re },
      { lastName: re },
      { documentNumber: re },
      { 'address.street': re },
    ],
  };
}

const SEARCH_COLLATION = { locale: 'es', strength: 2 } as const;

interface ClientWithTotals {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  documentType: string | null;
  documentNumber: string | null;
  clientType: ClientType;
  active: boolean;
  userId: Types.ObjectId | null;
  totalDebitsMinor: number;
  totalCreditsMinor: number;
  balanceMinor: number;
  status: AccountStatus;
  lastMovementAt: Date | null;
}

interface AccountCountsRow {
  _id: AccountStatus;
  count: number;
}

async function aggregateAccountsForClients(
  clientIds: Types.ObjectId[],
): Promise<Map<string, { debits: number; credits: number; last: Date | null }>> {
  if (clientIds.length === 0) return new Map();
  const rows = await AccountMovement.aggregate<{
    _id: Types.ObjectId;
    totalDebitsMinor: number;
    totalCreditsMinor: number;
    lastMovementAt: Date | null;
  }>([
    { $match: { clientId: { $in: clientIds } } },
    {
      $group: {
        _id: '$clientId',
        totalDebitsMinor: {
          $sum: { $cond: [{ $eq: ['$direction', 'DEBIT'] }, '$amountMinor', 0] },
        },
        totalCreditsMinor: {
          $sum: { $cond: [{ $eq: ['$direction', 'CREDIT'] }, '$amountMinor', 0] },
        },
        lastMovementAt: { $max: '$occurredAt' },
      },
    },
  ]);
  const map = new Map<
    string,
    { debits: number; credits: number; last: Date | null }
  >();
  for (const row of rows) {
    map.set(row._id.toString(), {
      debits: row.totalDebitsMinor,
      credits: row.totalCreditsMinor,
      last: row.lastMovementAt,
    });
  }
  return map;
}

export async function listAccounts(
  query: AccountsListQuery,
): Promise<AccountListResult> {
  const page = query.page ?? 1;
  const limit = query.limit ?? ACCOUNTS_LIST_DEFAULT_LIMIT;

  const clientFilter: Record<string, unknown> = {};
  if (query.clientType) clientFilter.clientType = query.clientType;
  if (query.clientActive !== undefined) clientFilter.active = query.clientActive;
  const search = buildClientSearchFilter(query.search);
  if (search) Object.assign(clientFilter, search);

  // Step 1: total matching clients BEFORE balance filter (used for metadata).
  const totalClients = await Client.countDocuments(clientFilter);

  // Step 2: load the page of clients.
  const clientDocs = await Client.find(clientFilter)
    .sort({ lastName: 1, firstName: 1 })
    .collation(SEARCH_COLLATION)
    .skip((page - 1) * limit)
    .limit(limit);

  const ids = clientDocs.map((c) => c._id);
  const totalsMap = await aggregateAccountsForClients(ids);

  // Step 3: build per-client summary with balance.
  let pageItems: ClientWithTotals[] = clientDocs.map((c) => {
    const totals = totalsMap.get(c._id.toString());
    const debits = totals?.debits ?? 0;
    const credits = totals?.credits ?? 0;
    const balance = debits - credits;
    return {
      _id: c._id,
      firstName: c.firstName,
      lastName: c.lastName,
      documentType: c.documentType,
      documentNumber: c.documentNumber,
      clientType: c.clientType,
      active: c.active,
      userId: c.userId ?? null,
      totalDebitsMinor: debits,
      totalCreditsMinor: credits,
      balanceMinor: balance,
      status: statusFromBalance(balance),
      lastMovementAt: totals?.last ?? null,
    };
  });

  // Step 4: balance filter, if requested, must be applied BEFORE the metadata
  // recomputation so the pagination totals reflect the filtered dataset.
  let total = totalClients;
  if (query.balanceStatus) {
    pageItems = pageItems.filter((c) => c.status === query.balanceStatus);

    // Recompute `total` only when balance filtering is in play: paginate over
    // the filtered dataset using a bounded aggregation.
    const matchStage: Record<string, unknown> = {};
    if (Object.keys(clientFilter).length > 0) {
      Object.assign(matchStage, clientFilter);
    }
    const pipeline: PipelineStage[] = [];
    if (Object.keys(matchStage).length > 0) {
      pipeline.push({ $match: matchStage });
    }
    pipeline.push(
      {
        $lookup: {
          from: AccountMovement.collection.name,
          let: { cid: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$clientId', '$$cid'] } } },
            {
              $group: {
                _id: null,
                totalDebitsMinor: {
                  $sum: {
                    $cond: [{ $eq: ['$direction', 'DEBIT'] }, '$amountMinor', 0],
                  },
                },
                totalCreditsMinor: {
                  $sum: {
                    $cond: [{ $eq: ['$direction', 'CREDIT'] }, '$amountMinor', 0],
                  },
                },
              },
            },
          ],
          as: 'totals',
        },
      },
      {
        $addFields: {
          totals: { $arrayElemAt: ['$totals', 0] },
        },
      },
      {
        $addFields: {
          balanceMinor: {
            $subtract: [
              { $ifNull: ['$totals.totalDebitsMinor', 0] },
              { $ifNull: ['$totals.totalCreditsMinor', 0] },
            ],
          },
        },
      },
      {
        $addFields: {
          status: {
            $switch: {
              branches: [
                { case: { $gt: ['$balanceMinor', 0] }, then: 'DEBT' },
                { case: { $lt: ['$balanceMinor', 0] }, then: 'CREDIT' },
              ],
              default: 'SETTLED',
            },
          },
        },
      },
      { $match: { status: query.balanceStatus } },
      { $count: 'count' },
    );

    const counts = await Client.aggregate<{ count: number }>(pipeline);
    total = counts[0]?.count ?? 0;
  }

  const items: AccountListItem[] = pageItems.map((c) => ({
    clientId: c._id.toString(),
    firstName: c.firstName,
    lastName: c.lastName,
    fullName: `${c.firstName} ${c.lastName}`.trim(),
    documentType: c.documentType,
    documentNumber: c.documentNumber,
    clientType: c.clientType,
    active: c.active,
    hasUserAccount: Boolean(c.userId),
    totalDebitsMinor: c.totalDebitsMinor,
    totalCreditsMinor: c.totalCreditsMinor,
    balanceMinor: c.balanceMinor,
    status: c.status,
    lastMovementAt: c.lastMovementAt,
  }));

  const pages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;

  // Quick global counts for diagnostics — not exposed in the response.
  void (await countAccountsByStatus());

  return {
    items,
    pagination: { page, limit, total, pages },
  };
}

/**
 * Optional helper: counts accounts grouped by status. Exposed for future
 * dashboards and used internally to keep the module self-contained. Not
 * currently returned by any endpoint.
 */
export async function countAccountsByStatus(): Promise<AccountCountsRow[]> {
  const rows = await AccountMovement.aggregate<{
    _id: AccountStatus;
    count: number;
  }>([
    {
      $group: {
        _id: '$clientId',
        totalDebitsMinor: {
          $sum: { $cond: [{ $eq: ['$direction', 'DEBIT'] }, '$amountMinor', 0] },
        },
        totalCreditsMinor: {
          $sum: { $cond: [{ $eq: ['$direction', 'CREDIT'] }, '$amountMinor', 0] },
        },
      },
    },
    {
      $project: {
        balance: { $subtract: ['$totalDebitsMinor', '$totalCreditsMinor'] },
      },
    },
    {
      $group: {
        _id: {
          $switch: {
            branches: [
              { case: { $gt: ['$balance', 0] }, then: 'DEBT' },
              { case: { $lt: ['$balance', 0] }, then: 'CREDIT' },
            ],
            default: 'SETTLED',
          },
        },
        count: { $sum: 1 },
      },
    },
  ]);
  return rows.map((r) => ({ _id: r._id, count: r.count }));
}

// ============================================================================
// Lookups
// ============================================================================

export async function findMovementById(
  movementId: string,
): Promise<AccountMovementDocument | null> {
  if (!Types.ObjectId.isValid(movementId)) return null;
  return AccountMovement.findById(movementId);
}

export async function getMovementOrThrow(
  movementId: string,
): Promise<AccountMovementDocument> {
  const movement = await findMovementById(movementId);
  if (!movement) throw new NotFoundError('Movimiento no encontrado');
  return movement;
}

// Internal: ensure client exists. Used by controllers that have only an id.
export async function getClientOrThrowInternal(
  clientId: string,
): Promise<ClientDocument> {
  if (!Types.ObjectId.isValid(clientId)) {
    throw new ValidationError('Identificador de cliente inválido');
  }
  const client = await Client.findById(clientId);
  if (!client) throw new NotFoundError('Cliente no encontrado');
  return client;
}

// Helper to find the Client linked to the authenticated user.
export async function findClientByUserId(
  userId: string,
): Promise<ClientDocument | null> {
  if (!Types.ObjectId.isValid(userId)) return null;
  return Client.findOne({ userId: new Types.ObjectId(userId) });
}

// silence unused-imports warning while keeping a friendly export surface
export { Client };
