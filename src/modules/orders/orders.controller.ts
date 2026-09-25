/**
 * Orders controller — FASE 7.
 *
 * Endpoints:
 *   POST   /api/orders/me                       (orders.self)
 *   GET    /api/orders/me                       (orders.self)
 *   GET    /api/orders/me/:id                   (orders.self)
 *   POST   /api/orders/me/:id/cancel            (orders.self)
 *
 *   GET    /api/orders                          (orders.read)
 *   GET    /api/orders/:id                      (orders.read)
 *   POST   /api/orders/:id/cancel               (orders.cancel)
 *
 *   GET    /api/delivery/me/orders              (delivery.read)
 *   GET    /api/delivery/me/orders/:id          (delivery.read)
 *   POST   /api/delivery/me/orders/:id/claim    (delivery.claim)
 *   POST   /api/delivery/me/orders/:id/start    (delivery.update)
 *   POST   /api/delivery/me/orders/:id/deliver  (delivery.update)
 *   POST   /api/delivery/me/direct-order        (delivery.create)
 */
import type { Request } from 'express';
import { asyncHandler } from '../../middlewares/error.js';
import { ok } from '../../shared/api-response.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { getAppToday } from '../../shared/app-date.js';
import { getClientOrThrow, getSelfClientOrThrow } from '../clients/clients.service.js';
import {
  cancelOrder,
  claimOrder,
  createOrder,
  getOrderByIdOrThrow,
  listOrders,
  markDelivered,
  promoteConfirmedToPendingOnDayRoll,
  startDelivery,
  toOrderDto,
  toOrderDtoAsync,
} from './orders.service.js';
import type { OrderDocument } from './orders.model.js';
import {
  adminOrdersQuerySchema,
  cancelOrderSchema,
  createMyOrderSchema,
  createStaffOrderSchema,
  driverOrdersQuerySchema,
  myOrdersQuerySchema,
  staffCancelOrderSchema,
} from './orders.validation.js';
import { ORDER_STATUSES, type OrderOrigin, type OrderStatus } from './orders.types.js';
import type { ClientType } from '../clients/clients.types.js';
import {
  isKnownZone,
  zoneDeliversOn,
} from '../delivery-zones/delivery-zones.helpers.js';

function requireUserId(req: Request): string {
  const id = req.user?.id;
  if (!id) throw new NotFoundError('No autenticado');
  return id;
}

async function formatForSelf(order: OrderDocument) {
  return toOrderDtoAsync(order, {
    includeClient: true,
    // Citizens never see raw ledger ids.
    includeAccountMovementId: false,
    includeCancellationMovementId: false,
  });
}

async function formatForAdmin(order: OrderDocument) {
  return toOrderDtoAsync(order, {
    includeClient: true,
    includeAccountMovementId: true,
    includeCancellationMovementId: true,
  });
}

async function formatForDriver(order: OrderDocument) {
  return toOrderDtoAsync(order, {
    includeClient: true,
    includeAccountMovementId: true,
    includeCancellationMovementId: true,
  });
}

// ---------- Citizen /me ----------

export const createMyOrderController = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const client = await getSelfClientOrThrow(userId);
  const payload = createMyOrderSchema.parse(req.body);
  const { order } = await createOrder({
    clientId: client._id.toString(),
    origin: 'CITIZEN',
    items: payload.items,
    customerNote: payload.customerNote ?? null,
    createdBy: userId,
  });
  const dto = await formatForSelf(order);
  res.status(201).json(ok({ order: dto }));
});

export const listMyOrdersController = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const client = await getSelfClientOrThrow(userId);
  const query = myOrdersQuerySchema.parse(req.query);
  const status =
    query.status && query.status !== 'ALL'
      ? (query.status as OrderStatus)
      : undefined;
  const result = await listOrders({
    page: query.page,
    limit: query.limit,
    status,
    clientId: client._id.toString(),
  });
  res.json(ok(result));
});

export const getMyOrderController = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const client = await getSelfClientOrThrow(userId);
  const order = await getOrderByIdOrThrow(req.params.id!);
  if (order.clientId.toString() !== client._id.toString()) {
    // Avoid enumeration: return 404 instead of 403.
    throw new NotFoundError('Pedido no encontrado');
  }
  const dto = await formatForSelf(order);
  res.json(ok({ order: dto }));
});

export const cancelMyOrderController = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const client = await getSelfClientOrThrow(userId);
  const payload = cancelOrderSchema.parse(req.body ?? {});
  const order = await cancelOrder({
    orderId: req.params.id!,
    actorUserId: userId,
    reason: payload.reason ?? null,
    requireReason: false,
    ownedByClientId: client._id.toString(),
    bypassOwnershipCheck: false,
    // Citizens can cancel CONFIRMED and PENDING. Once a repartidor took
    // it (ASSIGNED) the cancellation is admin's call (state machine).
  });
  const dto = await formatForSelf(order);
  res.json(ok({ order: dto }));
});

// ---------- Admin ----------

export const listOrdersController = asyncHandler(async (req, res) => {
  const query = adminOrdersQuerySchema.parse(req.query);
  const status =
    query.status && query.status !== 'ALL'
      ? (query.status as OrderStatus)
      : undefined;
  const result = await listOrders({
    page: query.page,
    limit: query.limit,
    status,
    origin: query.origin as OrderOrigin | undefined,
    clientType: query.clientType as ClientType | undefined,
    assignedTo: query.assignedTo,
    search: query.search,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
  });
  res.json(ok(result));
});

export const getOrderController = asyncHandler(async (req, res) => {
  const order = await getOrderByIdOrThrow(req.params.id!);
  const dto = await formatForAdmin(order);
  res.json(ok({ order: dto }));
});

export const cancelOrderController = asyncHandler(async (req, res) => {
  const actorId = requireUserId(req);
  const payload = staffCancelOrderSchema.parse(req.body);
  const order = await cancelOrder({
    orderId: req.params.id!,
    actorUserId: actorId,
    reason: payload.reason,
    requireReason: true,
    bypassOwnershipCheck: true,
  });
  const dto = await formatForAdmin(order);
  res.json(ok({ order: dto }));
});

// ---------- Driver self ----------

export const listMyDeliveriesController = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const query = driverOrdersQuerySchema.parse(req.query);
  const today = getAppToday();
  // Lazy day-roll sweep: promote CONFIRMED → PENDING for any order whose
  // zona now delivers today. Best-effort; safe to re-run. We do this
  // before reading so drivers see freshly-pending orders without waiting
  // for a cron.
  try {
    await promoteConfirmedToPendingOnDayRoll();
  } catch {
    // Surface the orders anyway — the sweep is opportunistic.
  }
  // Drivers see the PENDING pool (filtered to today's zone below) + their
  // own ASSIGNED / OUT_FOR_DELIVERY rows.
  const result = await listOrders({
    page: query.page,
    limit: query.limit,
    driverUserId: userId,
    onlyOpenForDriver: true,
    sortBy: 'assignedAt',
    sortOrder: 'asc',
    zoneFilter: {
      mode: 'today',
      zones: today.zones,
      includeNull: true,
    },
  });
  res.json(ok({ ...result, today: { weekday: today.weekday, weekdayLabel: today.weekdayLabel, zones: today.zones } }));
});

export const getMyDeliveryController = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const order = await getOrderByIdOrThrow(req.params.id!);
  // Drivers can read PENDING (in the pool) and any order assigned to them.
  const isPendingInPool = order.status === ORDER_STATUSES.PENDING;
  const isAssignedToMe =
    order.assignedTo && order.assignedTo.toString() === userId;
  if (!isPendingInPool && !isAssignedToMe) {
    throw new NotFoundError('Pedido no encontrado');
  }
  const dto = await formatForDriver(order);
  res.json(ok({ order: dto }));
});

export const startMyDeliveryController = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const order = await startDelivery(req.params.id!, userId);
  const dto = await formatForDriver(order);
  res.json(ok({ order: dto }));
});

export const claimMyDeliveryController = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const order = await claimOrder(req.params.id!, userId);
  const dto = await formatForDriver(order);
  res.json(ok({ order: dto }));
});

export const deliverMyOrderController = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const order = await markDelivered(req.params.id!, userId);
  const dto = await formatForDriver(order);
  res.json(ok({ order: dto }));
});

export const createDirectOrderController = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const payload = createStaffOrderSchema.parse(req.body);
  // Drivers can only create direct orders for themselves.
  // If a staff admin creates one for another driver, they'd need a separate
  // field — out of scope for MVP. Always assign to req.user for drivers.

  // Block the creation when the client's known zone does not deliver today.
  // Orders with no zone still slip through (padrón incomplete — surface,
  // don't block citizens' deliveries).
  const today = getAppToday();
  const clientForZone = await getClientOrThrow(payload.clientId);
  if (isKnownZone(clientForZone.zona)) {
    const zone = clientForZone.zona as 'ZONA 1' | 'ZONA 2';
    if (!zoneDeliversOn(zone, today.weekday)) {
      throw new ValidationError(
        `Hoy reparte ${today.zones.join(' y ') || 'ninguna zona'} (${today.weekdayLabel}). ` +
          `Este cliente pertenece a ${zone}. Ajustá la zona del padrón o elegí otro cliente.`,
        {
          code: 'ZONE_NOT_DELIVERING_TODAY',
          zone,
          weekday: today.weekday,
          weekdayLabel: today.weekdayLabel,
          zonesToday: today.zones,
        },
      );
    }
  }

  const { order } = await createOrder({
    clientId: payload.clientId,
    origin: 'STAFF',
    items: payload.items,
    customerNote: payload.customerNote ?? null,
    createdBy: userId,
    initialStatus: ORDER_STATUSES.OUT_FOR_DELIVERY,
    assignTo: userId,
  });
  const dto = await formatForDriver(order);
  res.status(201).json(ok({ order: dto }));
});

// Re-export the sync helper for the few places that already have a populated
// doc in hand and want a direct DTO without an extra round-trip.
export { toOrderDto };
