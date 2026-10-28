import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import {
  createAdjustmentSchema,
  createDriverAdjustmentSchema,
  reverseMovementSchema,
  accountsListQuerySchema,
  driverMovementsListQuerySchema,
  movementsListQuerySchema,
  MOVEMENTS_LIST_DEFAULT_LIMIT,
} from './accounts.validation.js';
import {
  createDriverAdjustment,
  createManualAdjustment,
  getClientAccountSummary,
  getClientAccountSummaryResponse,
  getClientOrThrowInternal,
  getMovementOrThrow,
  listAccounts,
  listClientMovements,
  listDriverMovements,
  resolveMovementActors,
  reverseMovement,
  toMovementDto,
  IdempotencyConflictError,
} from './accounts.service.js';
import { ok } from '../../shared/api-response.js';
import { asyncHandler } from '../../middlewares/error.js';
import { ValidationError } from '../../shared/errors.js';
import { ConflictError } from '../../shared/errors.js';
import { findClientByUserId } from './accounts.service.js';
import { ClientNotLinkedError } from '../clients/clients.service.js';
import type { AccountMovementDocument } from './account-movements.model.js';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function requireUserId(req: Request): string {
  const id = req.user?.id;
  if (!id) {
    throw new ValidationError('No autenticado');
  }
  return id;
}

function requireObjectIdParam(value: string | undefined, fieldLabel: string): string {
  if (!value) {
    throw new ValidationError(`${fieldLabel} requerido`);
  }
  if (!Types.ObjectId.isValid(value)) {
    throw new ValidationError(`${fieldLabel} inválido`);
  }
  return value;
}

/**
 * Maps a single movement to its DTO, resolving who registered it so the
 * admin always sees the author of every financial effect.
 */
async function toMovementResponse(
  doc: AccountMovementDocument,
): Promise<ReturnType<typeof toMovementDto>> {
  const createdBy = doc.createdBy ? doc.createdBy.toString() : null;
  const actors = await resolveMovementActors([createdBy]);
  return toMovementDto(doc, createdBy ? actors.get(createdBy) : undefined);
}

// ----------------------------------------------------------------------------
// Staff — list accounts (with per-client summary)
// ----------------------------------------------------------------------------

export const listAccountsController = asyncHandler(
  async (req: Request, res: Response) => {
    const query = accountsListQuerySchema.parse(req.query);
    const result = await listAccounts(query);
    res.json(ok(result));
  },
);

// ----------------------------------------------------------------------------
// Staff — single client summary
// ----------------------------------------------------------------------------

export const getClientSummaryController = asyncHandler(
  async (req: Request, res: Response) => {
    const clientId = requireObjectIdParam(req.params.clientId, 'Identificador de cliente');
    const client = await getClientOrThrowInternal(clientId);
    const summary = await getClientAccountSummaryResponse(client);
    res.json(ok(summary));
  },
);

// ----------------------------------------------------------------------------
// Staff — single client movements
// ----------------------------------------------------------------------------

export const listClientMovementsController = asyncHandler(
  async (req: Request, res: Response) => {
    const clientId = requireObjectIdParam(req.params.clientId, 'Identificador de cliente');
    // Make sure the client exists — keeps responses consistent with /summary.
    await getClientOrThrowInternal(clientId);
    const query = movementsListQuerySchema.parse(req.query);
    const result = await listClientMovements({
      clientId,
      page: query.page,
      limit: query.limit ?? MOVEMENTS_LIST_DEFAULT_LIMIT,
      direction: query.direction,
      movementType: query.movementType,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
    res.json(ok(result));
  },
);

// ----------------------------------------------------------------------------
// Staff — manual adjustment (DEBIT/CREDIT)
// ----------------------------------------------------------------------------

export const createAdjustmentController = asyncHandler(
  async (req: Request, res: Response) => {
    const clientId = requireObjectIdParam(req.params.clientId, 'Identificador de cliente');
    const data = createAdjustmentSchema.parse(req.body);
    const createdBy = req.user?.id ?? null;
    try {
      const movement = await createManualAdjustment({
        clientId,
        direction: data.direction,
        amountMinor: data.amountMinor,
        description: data.description,
        createdBy,
        createdByRole: req.user?.role ?? null,
      });
      res.status(201).json(ok({ movement: await toMovementResponse(movement) }));
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        throw new ConflictError(
          'La clave de idempotencia ya fue utilizada con datos distintos',
        );
      }
      throw err;
    }
  },
);

// ----------------------------------------------------------------------------
// Staff — reverse movement
// ----------------------------------------------------------------------------

export const reverseMovementController = asyncHandler(
  async (req: Request, res: Response) => {
    const movementId = requireObjectIdParam(
      req.params.movementId,
      'Identificador de movimiento',
    );
    const data = reverseMovementSchema.parse(req.body);
    const createdBy = req.user?.id ?? null;
    try {
      const reversal = await reverseMovement({
        movementId,
        description: data.description,
        createdBy,
        createdByRole: req.user?.role ?? null,
      });
      res.status(201).json(ok({ reversal: await toMovementResponse(reversal) }));
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        throw new ConflictError(
          'La clave de idempotencia ya fue utilizada con datos distintos',
        );
      }
      throw err;
    }
  },
);

// ----------------------------------------------------------------------------
// Repartidor — ajuste manual en la cuenta corriente (cobro en el domicilio)
// ----------------------------------------------------------------------------

export const createDriverAdjustmentController = asyncHandler(
  async (req: Request, res: Response) => {
    const clientId = requireObjectIdParam(
      req.params.clientId,
      'Identificador de cliente',
    );
    const data = createDriverAdjustmentSchema.parse(req.body);
    // The actor is NEVER taken from the payload — it comes from the session
    // (JWT), so a driver can only register movements under their own name.
    const driverId = requireUserId(req);
    try {
      const movement = await createDriverAdjustment({
        clientId,
        direction: data.direction,
        amountMinor: data.amountMinor,
        description: data.description,
        driverId,
        driverRole: req.user?.role ?? 'REPARTIDOR',
        idempotencyKey: data.idempotencyKey ?? null,
      });
      res.status(201).json(ok({ movement: await toMovementResponse(movement) }));
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        throw new ConflictError(
          'La clave de idempotencia ya fue utilizada con datos distintos',
        );
      }
      throw err;
    }
  },
);

export const listMyDriverMovementsController = asyncHandler(
  async (req: Request, res: Response) => {
    const driverId = requireUserId(req);
    const query = driverMovementsListQuerySchema.parse(req.query);
    const result = await listDriverMovements({
      driverId,
      page: query.page,
      limit: query.limit ?? MOVEMENTS_LIST_DEFAULT_LIMIT,
      direction: query.direction,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
    res.json(ok(result));
  },
);

// ----------------------------------------------------------------------------
// Citizen — own summary
// ----------------------------------------------------------------------------

export const getSelfSummaryController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const client = await findClientByUserId(userId);
    if (!client) {
      throw new ClientNotLinkedError();
    }
    const summary = await getClientAccountSummary(client._id.toString());
    res.json(
      ok({
        client: {
          id: client._id.toString(),
          firstName: client.firstName,
          lastName: client.lastName,
          fullName: `${client.firstName} ${client.lastName}`.trim(),
          clientType: client.clientType,
        },
        account: summary,
      }),
    );
  },
);

// ----------------------------------------------------------------------------
// Citizen — own movements
// ----------------------------------------------------------------------------

export const listSelfMovementsController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const client = await findClientByUserId(userId);
    if (!client) {
      throw new ClientNotLinkedError();
    }
    const query = movementsListQuerySchema.parse(req.query);
    const result = await listClientMovements({
      clientId: client._id.toString(),
      page: query.page,
      limit: query.limit ?? MOVEMENTS_LIST_DEFAULT_LIMIT,
      direction: query.direction,
      movementType: query.movementType,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
    res.json(ok(result));
  },
);

// Internal helpers re-exported for tests / controllers.
export { getMovementOrThrow, getClientAccountSummary };
