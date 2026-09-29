/**
 * Cash collections service.
 *
 * Owns writes to the `CashMovement` collection (and only this collection).
 * Cash movements NEVER touch the `AccountMovement` ledger, so the
 * client's cuenta corriente balance is unaffected by CASH deliveries.
 *
 * Idempotency is enforced at the application layer using a unique
 * `idempotencyKey`. Concurrent duplicates are caught by the unique
 * partial index in the schema.
 */
import { Types, type ClientSession, type PipelineStage } from 'mongoose';
import {
  CashMovement,
  type CashMovementDocument,
} from './cash-movements.model.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import { Client, type ClientDocument } from '../clients/clients.model.js';
import type { OrderDocument } from '../orders/orders.model.js';
import { User, type UserDocument } from '../users/users.model.js';
import type { ClientType } from '../clients/clients.types.js';
import {
  CASH_LIST_DEFAULT_LIMIT,
  CASH_MOVEMENT_TYPES,
  type CashMovementDto,
  type CashMovementListResult,
  type CashMovementType,
  type CashSourceType,
  type CashSummary,
  type CashSummaryResponse,
} from './cash.types.js';

// ============================================================================
// DTO helpers
// ============================================================================

export function toCashMovementDto(doc: CashMovementDocument): CashMovementDto {
  return {
    id: doc._id.toString(),
    clientId: doc.clientId.toString(),
    driverId: doc.driverId ? doc.driverId.toString() : null,
    amountMinor: doc.amountMinor,
    movementType: doc.movementType,
    description: doc.description,
    occurredAt: doc.occurredAt,
    sourceType: doc.sourceType,
    sourceId: doc.sourceId ? doc.sourceId.toString() : null,
    orderId: doc.orderId ? doc.orderId.toString() : null,
    idempotencyKey: doc.idempotencyKey ?? null,
    createdBy: doc.createdBy ? doc.createdBy.toString() : null,
    createdAt: doc.createdAt,
  };
}

// ============================================================================
// Idempotency strategy (mirrors accounts.service)
// ============================================================================

export class CashIdempotencyConflictError extends ConflictError {
  constructor(public readonly existing: CashMovementDocument) {
    super('Operación idempotente en conflicto con un movimiento de efectivo existente');
  }
}

function isDuplicateKeyError(err: unknown, keyName: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code !== 11000) return false;
  const keyPattern = (err as { keyPattern?: Record<string, unknown> }).keyPattern;
  if (!keyPattern) return false;
  return Object.prototype.hasOwnProperty.call(keyPattern, keyName);
}

function buildCanonicalPayload(input: {
  clientId: Types.ObjectId;
  amountMinor: number;
  movementType: string;
  orderId: Types.ObjectId | null;
}): string {
  return JSON.stringify({
    clientId: input.clientId.toString(),
    amountMinor: input.amountMinor,
    movementType: input.movementType,
    orderId: input.orderId ? input.orderId.toString() : null,
  });
}

function matchesCanonical(
  doc: CashMovementDocument,
  canonical: string,
): boolean {
  return (
    buildCanonicalPayload({
      clientId: doc.clientId,
      amountMinor: doc.amountMinor,
      movementType: doc.movementType,
      orderId: doc.orderId ?? null,
    }) === canonical
  );
}

// ============================================================================
// postCashCollection
// ============================================================================

export interface PostCashCollectionArgs {
  clientId: string;
  amountMinor: number;
  description: string;
  /** When posting from an Order, the order's _id. */
  orderId?: string | null;
  /** When posting from an Order, the assigned driver (or null if unknown). */
  driverId?: string | null;
  /** Optional idempotency key. When supplied the post is idempotent. */
  idempotencyKey?: string | null;
  /** Source type — defaults to 'ORDER'. */
  sourceType?: CashSourceType;
  /** Movement type. Defaults to CASH_COLLECTION. */
  movementType?: CashMovementType;
  createdBy?: string | null;
  session?: ClientSession;
}

export async function postCashCollection(
  args: PostCashCollectionArgs,
): Promise<CashMovementDocument> {
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
  const orderObjectId =
    args.orderId && Types.ObjectId.isValid(args.orderId)
      ? new Types.ObjectId(args.orderId)
      : null;
  const driverObjectId =
    args.driverId && Types.ObjectId.isValid(args.driverId)
      ? new Types.ObjectId(args.driverId)
      : null;

  const idempotencyKey =
    args.idempotencyKey && args.idempotencyKey.trim().length > 0
      ? args.idempotencyKey.trim()
      : null;

  const movementType: CashMovementType =
    args.movementType ?? CASH_MOVEMENT_TYPES.CASH_COLLECTION;

  const canonical = buildCanonicalPayload({
    clientId: clientObjectId,
    amountMinor: args.amountMinor,
    movementType,
    orderId: orderObjectId,
  });

  if (idempotencyKey) {
    const existing = await CashMovement.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (matchesCanonical(existing, canonical)) return existing;
      throw new CashIdempotencyConflictError(existing);
    }
  }

  try {
    const [created] = await CashMovement.create(
      [
        {
          clientId: clientObjectId,
          driverId: driverObjectId,
          amountMinor: args.amountMinor,
          movementType,
          description: args.description.trim(),
          sourceType: args.sourceType ?? 'ORDER',
          sourceId: orderObjectId,
          orderId: orderObjectId,
          idempotencyKey,
          createdBy:
            args.createdBy && Types.ObjectId.isValid(args.createdBy)
              ? new Types.ObjectId(args.createdBy)
              : null,
        },
      ],
      { session: args.session },
    );
    if (!created) {
      throw new ValidationError('No se pudo registrar el movimiento de efectivo');
    }
    return created;
  } catch (err) {
    if (idempotencyKey && isDuplicateKeyError(err, 'idempotencyKey')) {
      const existing = await CashMovement.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (matchesCanonical(existing, canonical)) return existing;
        throw new CashIdempotencyConflictError(existing);
      }
    }
    throw err;
  }
}

// ============================================================================
// Reversal — nullifies a previously-recorded cash collection (e.g. cancel).
// ============================================================================

export interface ReverseCashMovementArgs {
  movementId: string;
  description: string;
  createdBy?: string | null;
  session?: ClientSession;
}

/**
 * Compensates a CashMovement by posting a matching CASH_REVERSAL
 * movement (same positive amount, opposite semantic). Returns the
 * reversal doc. The original movement is NOT mutated.
 */
export async function reverseCashMovement(
  args: ReverseCashMovementArgs,
): Promise<CashMovementDocument> {
  if (!Types.ObjectId.isValid(args.movementId)) {
    throw new ValidationError('Identificador de movimiento inválido');
  }
  if (!args.description || !args.description.trim()) {
    throw new ValidationError('La descripción es obligatoria');
  }

  const original = await CashMovement.findById(args.movementId);
  if (!original) throw new NotFoundError('Movimiento de efectivo no encontrado');
  if (original.movementType !== CASH_MOVEMENT_TYPES.CASH_COLLECTION) {
    throw new ValidationError(
      'Sólo se pueden revertir cobros en efectivo (CASH_COLLECTION)',
    );
  }

  // Idempotency: each original cash movement may be reversed at most once.
  const reversalKey = `CASH_REVERSAL:${original._id.toString()}`;
  const existing = await CashMovement.findOne({
    idempotencyKey: reversalKey,
  });
  if (existing) {
    return existing;
  }

  return postCashCollection({
    clientId: original.clientId.toString(),
    amountMinor: original.amountMinor,
    description: args.description.trim(),
    orderId: null,
    driverId: original.driverId?.toString() ?? null,
    idempotencyKey: reversalKey,
    sourceType: 'MANUAL',
    movementType: CASH_MOVEMENT_TYPES.CASH_REVERSAL,
    createdBy: args.createdBy ?? null,
    session: args.session,
  }).catch((err) => {
    if (err instanceof CashIdempotencyConflictError) {
      return err.existing;
    }
    throw err;
  });
}

// ============================================================================
// Aggregations (summary + listing)
// ============================================================================

interface AggregateRow {
  totalCollectedMinor: number;
  movementCount: number;
  lastMovementAt: Date | null;
}

async function aggregateTotals(
  match: Record<string, unknown>,
): Promise<AggregateRow> {
  const [row] = await CashMovement.aggregate<{
    _id: null;
    totalCollectedMinor: number;
    movementCount: number;
    lastMovementAt: Date | null;
  }>([
    { $match: match },
    {
      $group: {
        _id: null,
        totalCollectedMinor: { $sum: '$amountMinor' },
        movementCount: { $sum: 1 },
        lastMovementAt: { $max: '$occurredAt' },
      },
    },
  ]);
  if (!row) {
    return {
      totalCollectedMinor: 0,
      movementCount: 0,
      lastMovementAt: null,
    };
  }
  return row;
}

export async function getClientCashSummary(
  clientId: string,
): Promise<CashSummary> {
  if (!Types.ObjectId.isValid(clientId)) {
    throw new ValidationError('Identificador de cliente inválido');
  }
  return aggregateTotals({
    clientId: new Types.ObjectId(clientId),
    movementType: CASH_MOVEMENT_TYPES.CASH_COLLECTION,
  });
}

export async function getDriverCashSummary(
  driverId: string,
): Promise<CashSummary> {
  if (!Types.ObjectId.isValid(driverId)) {
    throw new ValidationError('Identificador de repartidor inválido');
  }
  return aggregateTotals({
    driverId: new Types.ObjectId(driverId),
    movementType: CASH_MOVEMENT_TYPES.CASH_COLLECTION,
  });
}

export async function getClientCashSummaryResponse(
  client: ClientDocument,
): Promise<CashSummaryResponse> {
  const summary = await getClientCashSummary(client._id.toString());
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
    },
    summary,
  };
}

export async function getDriverCashSummaryResponse(
  driver: UserDocument,
): Promise<CashSummaryResponse> {
  const summary = await getDriverCashSummary(driver._id.toString());
  return {
    driver: {
      id: driver._id.toString(),
      firstName: driver.firstName,
      lastName: driver.lastName,
      fullName: `${driver.firstName} ${driver.lastName}`.trim(),
    },
    summary,
  };
}

// ============================================================================
// Listings
// ============================================================================

export interface ListCashMovementsArgs {
  page?: number;
  limit?: number;
  clientId?: string;
  driverId?: string;
  orderId?: string;
  movementType?: string;
  sourceType?: CashSourceType;
  dateFrom?: Date;
  dateTo?: Date;
}

export async function listCashMovements(
  args: ListCashMovementsArgs,
): Promise<CashMovementListResult> {
  const page = Math.max(1, args.page ?? 1);
  const limit = Math.min(
    100,
    Math.max(1, args.limit ?? CASH_LIST_DEFAULT_LIMIT),
  );

  const filter: Record<string, unknown> = {};
  if (args.clientId) {
    if (!Types.ObjectId.isValid(args.clientId)) {
      throw new ValidationError('Identificador de cliente inválido');
    }
    filter.clientId = new Types.ObjectId(args.clientId);
  }
  if (args.driverId) {
    if (!Types.ObjectId.isValid(args.driverId)) {
      throw new ValidationError('Identificador de repartidor inválido');
    }
    filter.driverId = new Types.ObjectId(args.driverId);
  }
  if (args.orderId) {
    if (!Types.ObjectId.isValid(args.orderId)) {
      throw new ValidationError('Identificador de pedido inválido');
    }
    filter.orderId = new Types.ObjectId(args.orderId);
  }
  if (args.movementType) {
    filter.movementType = args.movementType;
  }
  if (args.sourceType) {
    filter.sourceType = args.sourceType;
  }
  if (args.dateFrom || args.dateTo) {
    const range: Record<string, Date> = {};
    if (args.dateFrom) range.$gte = args.dateFrom;
    if (args.dateTo) range.$lte = args.dateTo;
    filter.occurredAt = range;
  }

  const skip = (page - 1) * limit;
  const [docs, total] = await Promise.all([
    CashMovement.find(filter)
      .sort({ occurredAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    CashMovement.countDocuments(filter),
  ]);

  // Pre-fetch driver names for the page (avoid N+1 on render).
  const driverIds = Array.from(
    new Set(
      docs
        .map((d) => d.driverId?.toString())
        .filter((v): v is string => Boolean(v)),
    ),
  );
  let driverNames: Map<string, string> = new Map();
  if (driverIds.length > 0) {
    const users = await User.find({ _id: { $in: driverIds } }).select(
      'firstName lastName',
    );
    driverNames = new Map(
      users.map((u) => [
        u._id.toString(),
        `${u.firstName} ${u.lastName}`.trim(),
      ]),
    );
  }

  const items: CashMovementDto[] = docs.map((doc) => {
    const base = toCashMovementDto(doc);
    if (doc.driverId) {
      base.driverName = driverNames.get(doc.driverId.toString()) ?? null;
    }
    return base;
  });

  const pages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;
  return {
    items,
    pagination: { page, limit, total, pages },
  };
}

export interface ListClientCashMovementsArgs {
  clientId: string;
  page: number;
  limit: number;
}

export async function listClientCashMovements(
  args: ListClientCashMovementsArgs,
): Promise<CashMovementListResult> {
  if (!Types.ObjectId.isValid(args.clientId)) {
    throw new ValidationError('Identificador de cliente inválido');
  }
  return listCashMovements({
    clientId: args.clientId,
    page: args.page,
    limit: args.limit,
  });
}

export interface ListDriverCashMovementsArgs {
  driverId: string;
  page: number;
  limit: number;
  dateFrom?: Date;
  dateTo?: Date;
}

export async function listDriverCashMovements(
  args: ListDriverCashMovementsArgs,
): Promise<CashMovementListResult> {
  if (!Types.ObjectId.isValid(args.driverId)) {
    throw new ValidationError('Identificador de repartidor inválido');
  }
  return listCashMovements({
    driverId: args.driverId,
    page: args.page,
    limit: args.limit,
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
  });
}

// ============================================================================
// Admin dashboard — global totals per driver / per client.
// ============================================================================

export interface CashAggregateRow {
  _id: Types.ObjectId;
  totalCollectedMinor: number;
  movementCount: number;
  lastMovementAt: Date | null;
}

export interface DriverCashAggregate {
  driverId: string;
  driverName: string;
  totalCollectedMinor: number;
  movementCount: number;
  lastMovementAt: Date | null;
}

export interface ClientCashAggregate {
  clientId: string;
  clientName: string;
  clientType: ClientType;
  totalCollectedMinor: number;
  movementCount: number;
  lastMovementAt: Date | null;
}

export async function aggregateCashByDriver(opts: {
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<DriverCashAggregate[]> {
  const match: Record<string, unknown> = {
    movementType: CASH_MOVEMENT_TYPES.CASH_COLLECTION,
    driverId: { $ne: null },
  };
  if (opts.dateFrom || opts.dateTo) {
    const range: Record<string, Date> = {};
    if (opts.dateFrom) range.$gte = opts.dateFrom;
    if (opts.dateTo) range.$lte = opts.dateTo;
    match.occurredAt = range;
  }
  const rows = await CashMovement.aggregate<{
    _id: Types.ObjectId;
    totalCollectedMinor: number;
    movementCount: number;
    lastMovementAt: Date | null;
  }>([
    { $match: match },
    {
      $group: {
        _id: '$driverId',
        totalCollectedMinor: { $sum: '$amountMinor' },
        movementCount: { $sum: 1 },
        lastMovementAt: { $max: '$occurredAt' },
      },
    },
    { $sort: { totalCollectedMinor: -1 } },
  ]);
  if (rows.length === 0) return [];
  const driverIds = rows.map((r) => r._id);
  const drivers = await User.find({ _id: { $in: driverIds } }).select(
    'firstName lastName',
  );
  const nameById = new Map(
    drivers.map((d) => [
      d._id.toString(),
      `${d.firstName} ${d.lastName}`.trim(),
    ]),
  );
  return rows.map((r) => ({
    driverId: r._id.toString(),
    driverName: nameById.get(r._id.toString()) ?? '—',
    totalCollectedMinor: r.totalCollectedMinor,
    movementCount: r.movementCount,
    lastMovementAt: r.lastMovementAt,
  }));
}

export async function aggregateCashByClient(opts: {
  dateFrom?: Date;
  dateTo?: Date;
  clientType?: ClientType;
  page?: number;
  limit?: number;
}): Promise<{ items: ClientCashAggregate[]; total: number; pages: number }> {
  const match: Record<string, unknown> = {
    movementType: CASH_MOVEMENT_TYPES.CASH_COLLECTION,
  };
  if (opts.dateFrom || opts.dateTo) {
    const range: Record<string, Date> = {};
    if (opts.dateFrom) range.$gte = opts.dateFrom;
    if (opts.dateTo) range.$lte = opts.dateTo;
    match.occurredAt = range;
  }

  // Pre-filter client ids by clientType if requested.
  let restrictToClientIds: Types.ObjectId[] | undefined;
  if (opts.clientType) {
    const docs = await Client.find({ clientType: opts.clientType }).select('_id');
    restrictToClientIds = docs.map((c) => c._id);
    if (restrictToClientIds.length === 0) {
      return { items: [], total: 0, pages: 1 };
    }
    match.clientId = { $in: restrictToClientIds };
  }

  const page = opts.page ?? 1;
  const limit = opts.limit ?? CASH_LIST_DEFAULT_LIMIT;
  const skip = (page - 1) * limit;

  const pipeline: PipelineStage[] = [
    { $match: match },
    {
      $group: {
        _id: '$clientId',
        totalCollectedMinor: { $sum: '$amountMinor' },
        movementCount: { $sum: 1 },
        lastMovementAt: { $max: '$occurredAt' },
      },
    },
    { $sort: { totalCollectedMinor: -1 } },
    {
      $facet: {
        rows: [{ $skip: skip }, { $limit: limit }],
        count: [{ $count: 'total' }],
      },
    },
  ];
  const [agg] = await CashMovement.aggregate<{
    rows: Array<{
      _id: Types.ObjectId;
      totalCollectedMinor: number;
      movementCount: number;
      lastMovementAt: Date | null;
    }>;
    count: Array<{ total: number }>;
  }>(pipeline);
  const rows = agg?.rows ?? [];
  const total = agg?.count[0]?.total ?? 0;

  if (rows.length === 0) {
    return { items: [], total, pages: Math.max(1, Math.ceil(total / limit)) };
  }
  const clientIds = rows.map((r) => r._id);
  const clients = await Client.find({ _id: { $in: clientIds } }).select(
    'firstName lastName clientType',
  );
  const nameById = new Map(
    clients.map((c) => [
      c._id.toString(),
      {
        fullName: `${c.firstName} ${c.lastName}`.trim(),
        clientType: c.clientType,
      },
    ]),
  );
  const items: ClientCashAggregate[] = rows.map((r) => {
    const meta = nameById.get(r._id.toString());
    return {
      clientId: r._id.toString(),
      clientName: meta?.fullName ?? '—',
      clientType: meta?.clientType ?? ('LOCAL' as ClientType),
      totalCollectedMinor: r.totalCollectedMinor,
      movementCount: r.movementCount,
      lastMovementAt: r.lastMovementAt,
    };
  });
  return { items, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

/**
 * Convenience for the Order module: look up the OrderDocument and
 * resolve the client + driver in a single round-trip.
 */
export async function findCashMovementForOrder(
  order: OrderDocument,
): Promise<CashMovementDocument | null> {
  if (!order.cashMovementId) return null;
  return CashMovement.findById(order.cashMovementId);
}

export type { CashMovementDocument };