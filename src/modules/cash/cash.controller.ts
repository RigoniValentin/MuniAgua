/**
 * Cash collections controller — FASE 9 (cash-on-delivery).
 *
 * Endpoints:
 *   GET    /api/cash/me/summary                 (cash.self)
 *   GET    /api/cash/me/movements               (cash.self)
 *
 *   GET    /api/cash/admin/movements            (cash.read)
 *   GET    /api/cash/admin/clients/:id/summary  (cash.read)
 *   GET    /api/cash/admin/clients/:id/movements (cash.read)
 *   GET    /api/cash/admin/aggregate/by-client  (cash.read)
 *   GET    /api/cash/admin/aggregate/by-driver  (cash.read)
 *
 *   GET    /api/cash/driver/me/summary          (cash.read)
 *   GET    /api/cash/driver/me/movements        (cash.read)
 */
import type { Request } from 'express';
import { asyncHandler } from '../../middlewares/error.js';
import { ok } from '../../shared/api-response.js';
import { NotFoundError } from '../../shared/errors.js';
import {
  aggregateCashByClient,
  aggregateCashByDriver,
  getClientCashSummary,
  getClientCashSummaryResponse,
  getDriverCashSummary,
  getDriverCashSummaryResponse,
  listCashMovements,
  listClientCashMovements,
  listDriverCashMovements,
} from './cash.service.js';
import { Client } from '../clients/clients.model.js';
import { User } from '../users/users.model.js';
import { getClientOrThrow, getSelfClientOrThrow } from '../clients/clients.service.js';
import {
  aggregateByClientQuerySchema,
  aggregateByDriverQuerySchema,
  listCashMovementsQuerySchema,
  listClientCashMovementsQuerySchema,
  listDriverCashMovementsQuerySchema,
} from './cash.validation.js';

function requireUserId(req: Request): string {
  const id = req.user?.id;
  if (!id) throw new NotFoundError('No autenticado');
  return id;
}

// ---------- Citizen /me ----------

export const getMyCashSummaryController = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const client = await getSelfClientOrThrow(userId);
  const summary = await getClientCashSummary(client._id.toString());
  res.json(ok({ summary }));
});

export const listMyCashMovementsController = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const client = await getSelfClientOrThrow(userId);
  const query = listClientCashMovementsQuerySchema.parse(req.query);
  const result = await listClientCashMovements({
    clientId: client._id.toString(),
    page: query.page,
    limit: query.limit,
  });
  res.json(ok(result));
});

// ---------- Admin ----------

export const listAllCashMovementsController = asyncHandler(async (req, res) => {
  const query = listCashMovementsQuerySchema.parse(req.query);
  const result = await listCashMovements({
    page: query.page,
    limit: query.limit,
    clientId: query.clientId,
    driverId: query.driverId,
    orderId: query.orderId,
    movementType: query.movementType,
    sourceType: query.sourceType,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
  });
  res.json(ok(result));
});

export const getClientCashSummaryController = asyncHandler(async (req, res) => {
  const client = await getClientOrThrow(req.params.clientId!);
  const data = await getClientCashSummaryResponse(client);
  res.json(ok(data));
});

export const listClientCashMovementsController = asyncHandler(
  async (req, res) => {
    const query = listClientCashMovementsQuerySchema.parse(req.query);
    const result = await listClientCashMovements({
      clientId: req.params.clientId!,
      page: query.page,
      limit: query.limit,
    });
    res.json(ok(result));
  },
);

export const aggregateCashByClientController = asyncHandler(
  async (req, res) => {
    const query = aggregateByClientQuerySchema.parse(req.query);
    const result = await aggregateCashByClient({
      page: query.page,
      limit: query.limit,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      clientType: query.clientType as
        | 'LOCAL'
        | 'JUBILADO'
        | 'NO_LOCAL'
        | 'AYUDA_SOCIAL'
        | undefined,
    });
    res.json(ok(result));
  },
);

export const aggregateCashByDriverController = asyncHandler(
  async (req, res) => {
    const query = aggregateByDriverQuerySchema.parse(req.query);
    const items = await aggregateCashByDriver({
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
    res.json(ok({ items }));
  },
);

// ---------- Driver self ----------

export const getMyDriverCashSummaryController = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const driver = await User.findById(userId);
  if (!driver) throw new NotFoundError('Repartidor no encontrado');
  const data = await getDriverCashSummaryResponse(driver);
  res.json(ok(data));
});

export const listMyDriverCashMovementsController = asyncHandler(
  async (req, res) => {
    const userId = requireUserId(req);
    const query = listDriverCashMovementsQuerySchema.parse(req.query);
    const result = await listDriverCashMovements({
      driverId: userId,
      page: query.page,
      limit: query.limit,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
    res.json(ok(result));
  },
);

// silence unused-import warning while keeping the symbol close.
void Client;
void getDriverCashSummary;