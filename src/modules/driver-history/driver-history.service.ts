/**
 * Driver history service — builds the repartidor's chronological timeline.
 *
 * Data sources (all read-only):
 *   - `Order`            → claim / start / deliver / direct-order / cancel.
 *   - `CashMovement`     → cash movements that are NOT attached to an order.
 *   - `AccountMovement`  → only to resolve the amount of REVERSAL entries
 *                          referenced by an order.
 *   - `Client`           → display names, resolved in a single batched query.
 *
 * The timeline is anchored to each operation's own timestamp so a driver
 * filtering by "Esta semana" sees exactly the steps they took that week, even
 * when an order spans two days.
 */
import { Types } from 'mongoose';
import { Order } from '../orders/orders.model.js';
import { ORDER_STATUSES } from '../orders/orders.types.js';
import { CashMovement } from '../cash/cash-movements.model.js';
import { CASH_MOVEMENT_TYPES } from '../cash/cash.types.js';
import { AccountMovement } from '../accounts/account-movements.model.js';
import { Client } from '../clients/clients.model.js';
import { User } from '../users/users.model.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { periodDateLabels, resolveReportPeriod } from '../reports/reports.period.js';
import {
  DRIVER_HISTORY_MAX_OPERATIONS,
  DRIVER_OPERATION_KINDS,
  DRIVER_OPERATION_LABEL,
  type DriverHistory,
  type DriverHistoryDriver,
  type DriverHistoryEntry,
  type DriverHistoryFilters,
  type DriverHistoryItemRow,
  type DriverHistorySummary,
  type DriverOperationKind,
} from './driver-history.types.js';

/**
 * A direct order ("Nueva entrega") is registered at the client's door, so the
 * service stamps `assignedAt`, `startedDeliveryAt` and `deliveredAt` with the
 * same instant. We collapse that into a single DIRECT_ORDER entry instead of
 * showing three indistinguishable rows a second apart.
 */
const DIRECT_ORDER_WINDOW_MS = 60_000;

type OrderProjection = Pick<
  import('../orders/orders.model.js').OrderDocument,
  | '_id'
  | 'clientId'
  | 'origin'
  | 'status'
  | 'items'
  | 'totalFinalMinor'
  | 'paymentMethod'
  | 'zonaSnapshot'
  | 'customerNote'
  | 'cancellationReason'
  | 'cancellationMovementId'
  | 'assignedAt'
  | 'startedDeliveryAt'
  | 'deliveredAt'
  | 'cancelledAt'
  | 'createdAt'
>;

interface ClientMeta {
  fullName: string;
  documentNumber: string | null;
}

/**
 * Entries are sorted newest-first. When two operations share the exact same
 * instant (very common: the service stamps a whole circuit with one `now`),
 * this rank restores the logical order so the driver reads
 * "canceló → entregó → inició → tomó" instead of an arbitrary one.
 */
const OPERATION_SEQUENCE: Record<DriverOperationKind, number> = {
  [DRIVER_OPERATION_KINDS.ORDER_CLAIMED]: 1,
  [DRIVER_OPERATION_KINDS.DELIVERY_STARTED]: 2,
  [DRIVER_OPERATION_KINDS.ORDER_DELIVERED]: 3,
  [DRIVER_OPERATION_KINDS.DIRECT_ORDER]: 3,
  [DRIVER_OPERATION_KINDS.CASH_COLLECTED]: 0,
  [DRIVER_OPERATION_KINDS.CASH_REVERSED]: 4,
  [DRIVER_OPERATION_KINDS.ORDER_CANCELLED]: 5,
};

/** Internal row: the public DTO plus the sort rank. */
type TimelineRow = DriverHistoryEntry & { seq: number };

/** Drops the internal sort rank before the row leaves the service. */
function toEntryDto({ seq: _seq, ...entry }: TimelineRow): DriverHistoryEntry {
  return entry;
}

function emptySummary(): DriverHistorySummary {
  return {
    operationCount: 0,
    ordersClaimed: 0,
    deliveriesStarted: 0,
    ordersDelivered: 0,
    directOrders: 0,
    ordersCancelled: 0,
    manualCashCollections: 0,
    manualCashReversals: 0,
    distinctClients: 0,
    unitsDelivered: 0,
    totalDeliveredMinor: 0,
    cashCollectedMinor: 0,
    accountChargedMinor: 0,
    accountReversedMinor: 0,
  };
}

/** Last 6 chars of an ObjectId — matches the short reference used in the UI. */
function orderReference(id: string): string {
  return id.slice(-6).toUpperCase();
}

function isDirectOrder(order: OrderProjection): boolean {
  if (order.origin !== 'STAFF') return false;
  if (order.status !== ORDER_STATUSES.DELIVERED) return false;
  if (!order.assignedAt || !order.startedDeliveryAt || !order.deliveredAt) {
    return false;
  }
  const base = order.assignedAt.getTime();
  return (
    Math.abs(order.startedDeliveryAt.getTime() - base) <=
      DIRECT_ORDER_WINDOW_MS &&
    Math.abs(order.deliveredAt.getTime() - base) <= DIRECT_ORDER_WINDOW_MS
  );
}

function toItemRows(
  items: OrderProjection['items'],
): DriverHistoryItemRow[] {
  return items.map((item) => ({
    productCode: item.productCode,
    productName: item.productName,
    quantity: item.quantity,
    subtotalFinalMinor: item.subtotalFinalMinor,
  }));
}

function summarizeItems(items: DriverHistoryItemRow[]): string {
  return items.map((it) => `${it.productCode} × ${it.quantity}`).join(' · ');
}

export async function buildDriverHistory(
  driverUserId: string,
  filters: DriverHistoryFilters,
  now: Date = new Date(),
): Promise<DriverHistory> {
  if (!Types.ObjectId.isValid(driverUserId)) {
    throw new ValidationError('Identificador de repartidor inválido');
  }

  const driverObjectId = new Types.ObjectId(driverUserId);
  const driverDoc = await User.findById(driverObjectId).select(
    'firstName lastName role active',
  );
  if (!driverDoc) throw new NotFoundError('Repartidor no encontrado');
  const driver: DriverHistoryDriver = {
    id: driverDoc._id.toString(),
    firstName: driverDoc.firstName,
    lastName: driverDoc.lastName,
    fullName: `${driverDoc.firstName} ${driverDoc.lastName}`.trim(),
  };

  const period = resolveReportPeriod(filters, now);
  const periodLabels = periodDateLabels(period);
  const range = { $gte: period.dateFrom, $lt: period.dateTo };
  /**
   * The `$or` below only proves an order has SOME operation inside the
   * period. Each entry is still emitted individually, so every timestamp is
   * re-checked here — otherwise an order claimed in June and delivered in
   * July would leak its July delivery into the June timeline.
   */
  const inRange = (date: Date | null | undefined): date is Date =>
    date !== null &&
    date !== undefined &&
    date.getTime() >= period.dateFrom.getTime() &&
    date.getTime() < period.dateTo.getTime();

  // Any order where at least one operation timestamp falls inside the period.
  const orders = await Order.find({
    assignedTo: driverObjectId,
    $or: [
      { assignedAt: range },
      { startedDeliveryAt: range },
      { deliveredAt: range },
      { cancelledAt: range },
    ],
  }).select(
    'clientId origin status items totalFinalMinor paymentMethod zonaSnapshot ' +
      'customerNote cancellationReason cancellationMovementId assignedAt ' +
      'startedDeliveryAt deliveredAt cancelledAt createdAt',
  );

  // Cash movements without an attached order become their own entries.
  // Order-attached collections are already folded into the delivery row.
  const cashMovements = await CashMovement.find({
    driverId: driverObjectId,
    orderId: null,
    occurredAt: range,
  }).sort({ occurredAt: -1, _id: -1 });

  // Amounts of the REVERSAL movements referenced by these orders, so the
  // timeline can show "se anuló un cargo de $X" instead of a bare id.
  const referencedReversalIds = orders
    .map((o) => o.cancellationMovementId)
    .filter((id): id is Types.ObjectId => Boolean(id))
    .map((id) => id.toString());
  const reversalAmountById = new Map<string, number>();
  if (referencedReversalIds.length > 0) {
    const reversals = await AccountMovement.find({
      _id: { $in: referencedReversalIds.map((id) => new Types.ObjectId(id)) },
    }).select('amountMinor');
    for (const movement of reversals) {
      reversalAmountById.set(movement._id.toString(), movement.amountMinor);
    }
  }

  const clientIds = new Set<string>();
  for (const order of orders) clientIds.add(order.clientId.toString());
  for (const movement of cashMovements) clientIds.add(movement.clientId.toString());

  const clients =
    clientIds.size > 0
      ? await Client.find({
          _id: { $in: Array.from(clientIds).map((id) => new Types.ObjectId(id)) },
        }).select('firstName lastName documentNumber')
      : [];
  const clientById = new Map<string, ClientMeta>(
    clients.map((c) => [
      c._id.toString(),
      {
        fullName: `${c.firstName} ${c.lastName}`.trim(),
        documentNumber: c.documentNumber ?? null,
      },
    ]),
  );

  const entries: TimelineRow[] = [];
  const summary = emptySummary();
  const clientsWithActivity = new Set<string>();

  const baseEntry = (
    order: OrderProjection,
    kind: keyof typeof DRIVER_OPERATION_KINDS,
    occurredAt: Date,
  ): TimelineRow => {
    const clientId = order.clientId.toString();
    const meta = clientById.get(clientId);
    return {
      id: `${kind}:${order._id.toString()}:${occurredAt.getTime()}`,
      kind: DRIVER_OPERATION_KINDS[kind],
      label: DRIVER_OPERATION_LABEL[DRIVER_OPERATION_KINDS[kind]],
      seq: OPERATION_SEQUENCE[DRIVER_OPERATION_KINDS[kind]],
      occurredAt: occurredAt.toISOString(),
      orderId: order._id.toString(),
      orderReference: orderReference(order._id.toString()),
      clientId,
      clientName: meta?.fullName ?? null,
      documentNumber: meta?.documentNumber ?? null,
      zona: order.zonaSnapshot ?? null,
      origin: order.origin,
      status: order.status,
      paymentMethod: order.paymentMethod,
      totalFinalMinor: null,
      units: null,
      cashCollectedMinor: 0,
      accountChargedMinor: 0,
      accountReversedMinor: 0,
      detail: null,
      items: [],
    };
  };

  for (const order of orders) {
    const direct = isDirectOrder(order);

    if (direct && inRange(order.deliveredAt)) {
      const entry = baseEntry(order, 'DIRECT_ORDER', order.deliveredAt);
      const items = toItemRows(order.items);
      const units = items.reduce((acc, it) => acc + it.quantity, 0);
      entry.items = items;
      entry.units = units;
      entry.totalFinalMinor = order.totalFinalMinor;
      entry.detail =
        summarizeItems(items) || 'Entrega registrada en el domicilio';
      if (order.paymentMethod === 'CASH' && order.totalFinalMinor > 0) {
        entry.cashCollectedMinor = order.totalFinalMinor;
      } else if (order.totalFinalMinor > 0) {
        entry.accountChargedMinor = order.totalFinalMinor;
      }
      entries.push(entry);

      summary.directOrders += 1;
      summary.ordersDelivered += 1;
      summary.unitsDelivered += units;
      summary.totalDeliveredMinor += order.totalFinalMinor;
      summary.cashCollectedMinor += entry.cashCollectedMinor;
      summary.accountChargedMinor += entry.accountChargedMinor;
      clientsWithActivity.add(order.clientId.toString());
      continue;
    }

    if (inRange(order.assignedAt)) {
      const entry = baseEntry(order, 'ORDER_CLAIMED', order.assignedAt);
      entry.detail = 'Pedido tomado del pool';
      entries.push(entry);
      summary.ordersClaimed += 1;
      clientsWithActivity.add(order.clientId.toString());
    }

    if (inRange(order.startedDeliveryAt)) {
      const entry = baseEntry(order, 'DELIVERY_STARTED', order.startedDeliveryAt);
      entry.detail = 'Salida a repartir';
      entries.push(entry);
      summary.deliveriesStarted += 1;
    }

    if (inRange(order.deliveredAt)) {
      const entry = baseEntry(order, 'ORDER_DELIVERED', order.deliveredAt);
      const items = toItemRows(order.items);
      const units = items.reduce((acc, it) => acc + it.quantity, 0);
      entry.items = items;
      entry.units = units;
      entry.totalFinalMinor = order.totalFinalMinor;
      entry.detail = summarizeItems(items) || null;

      if (order.paymentMethod === 'CASH') {
        if (order.totalFinalMinor > 0) {
          entry.cashCollectedMinor = order.totalFinalMinor;
        }
        // A citizen order created on account and paid in cash keeps a
        // REVERSAL in `cancellationMovementId`.
        if (order.cancellationMovementId) {
          entry.accountReversedMinor =
            reversalAmountById.get(order.cancellationMovementId.toString()) ?? 0;
        }
      } else if (order.totalFinalMinor > 0) {
        entry.accountChargedMinor = order.totalFinalMinor;
      }
      entries.push(entry);

      summary.ordersDelivered += 1;
      summary.unitsDelivered += units;
      summary.totalDeliveredMinor += order.totalFinalMinor;
      summary.cashCollectedMinor += entry.cashCollectedMinor;
      summary.accountChargedMinor += entry.accountChargedMinor;
      summary.accountReversedMinor += entry.accountReversedMinor;
      clientsWithActivity.add(order.clientId.toString());
    }

    if (inRange(order.cancelledAt)) {
      const entry = baseEntry(order, 'ORDER_CANCELLED', order.cancelledAt);
      if (order.cancellationMovementId) {
        entry.accountReversedMinor =
          reversalAmountById.get(order.cancellationMovementId.toString()) ?? 0;
      }
      entry.detail =
        order.cancellationReason?.trim() || 'Pedido cancelado por la administración';
      entries.push(entry);

      summary.ordersCancelled += 1;
      summary.accountReversedMinor += entry.accountReversedMinor;
    }
  }

  for (const movement of cashMovements) {
    const clientId = movement.clientId.toString();
    const meta = clientById.get(clientId);
    const isReversal = movement.movementType === CASH_MOVEMENT_TYPES.CASH_REVERSAL;
    const kind = isReversal
      ? DRIVER_OPERATION_KINDS.CASH_REVERSED
      : DRIVER_OPERATION_KINDS.CASH_COLLECTED;
    const entry: TimelineRow = {
      id: `CASH:${movement._id.toString()}`,
      kind,
      label: DRIVER_OPERATION_LABEL[kind],
      seq: OPERATION_SEQUENCE[kind],
      occurredAt: movement.occurredAt.toISOString(),
      orderId: null,
      orderReference: null,
      clientId,
      clientName: meta?.fullName ?? null,
      documentNumber: meta?.documentNumber ?? null,
      zona: null,
      origin: null,
      status: null,
      paymentMethod: 'CASH',
      totalFinalMinor: movement.amountMinor,
      units: null,
      cashCollectedMinor: isReversal ? 0 : movement.amountMinor,
      accountChargedMinor: 0,
      accountReversedMinor: 0,
      detail: movement.description,
      items: [],
    };
    entries.push(entry);

    if (isReversal) {
      summary.manualCashReversals += 1;
    } else {
      summary.manualCashCollections += 1;
      summary.cashCollectedMinor += movement.amountMinor;
    }
    clientsWithActivity.add(clientId);
  }

  entries.sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) {
      return a.occurredAt < b.occurredAt ? 1 : -1;
    }
    if (a.seq !== b.seq) return b.seq - a.seq;
    return a.id < b.id ? 1 : -1;
  });

  summary.operationCount = entries.length;
  summary.distinctClients = clientsWithActivity.size;

  const truncated = entries.length > DRIVER_HISTORY_MAX_OPERATIONS;
  const visible = truncated ? entries.slice(0, DRIVER_HISTORY_MAX_OPERATIONS) : entries;

  return {
    period: {
      preset: period.preset,
      label: period.label,
      dateFrom: periodLabels.dateFrom,
      dateTo: periodLabels.displayedTo,
    },
    driver,
    summary,
    operations: visible.map(toEntryDto),
    truncated,
  };
}