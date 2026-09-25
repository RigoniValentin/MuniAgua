import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import {
  createAdjustmentSchema,
  reverseMovementSchema,
  accountsListQuerySchema,
  movementsListQuerySchema,
  MOVEMENTS_LIST_DEFAULT_LIMIT,
} from './accounts.validation.js';
import {
  createManualAdjustment,
  getClientAccountSummary,
  getClientAccountSummaryResponse,
  getClientOrThrowInternal,
  getMovementOrThrow,
  listAccounts,
  listClientMovements,
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
      });
      res.status(201).json(ok({ movement: toMovementDto(movement) }));
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
      });
      res.status(201).json(ok({ reversal: toMovementDto(reversal) }));
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
