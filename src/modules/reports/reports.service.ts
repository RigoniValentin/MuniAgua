/**
 * Reports service — single source for "what was sold and how much was
 * collected over a given period".
 *
 * Anchored to `Order.deliveredAt` (the day the cycle closes). Cancelled
 * orders drop out naturally because they never reach DELIVERED.
 */
import mongoose, { Types } from 'mongoose';
import { Order } from '../orders/orders.model.js';
import { Client } from '../clients/clients.model.js';
import { User } from '../users/users.model.js';
import type { ClientType } from '../clients/clients.types.js';
import {
  type PeriodReport,
  type ReportDeliveryRow,
  type ReportFilters,
  type ReportOrderItemRow,
  type ReportOrderRow,
  type ReportPeriodSummary,
  type ReportProductRow,
  type ReportTotals,
  type ReportAvailableDriver,
} from './reports.types.js';
import { periodDateLabels, resolveReportPeriod } from './reports.period.js';

interface FlatProductAgg {
  _id: Types.ObjectId;
  productCode: string;
  productName: string;
  productType: string;
  totalQuantity: number;
  totalSubtotalFinalMinor: number;
  orderIds: Set<string>;
}

interface FlatDeliveryAgg {
  key: string;
  driverId: string | null;
  driverName: string;
  deliveredOrdersCount: number;
  unitsDelivered: number;
  cashCollectedMinor: number;
  totalDeliveredMinor: number;
}

function buildOrderPipeline(
  periodFrom: Date,
  periodTo: Date,
  clientIdsFilter: Types.ObjectId[] | undefined,
): mongoose.PipelineStage[] {
  const match: Record<string, unknown> = {
    status: 'DELIVERED',
    deliveredAt: { $gte: periodFrom, $lt: periodTo },
  };
  if (clientIdsFilter) {
    match.clientId = { $in: clientIdsFilter };
  }
  return [
    { $match: match },
    {
      $project: {
        _id: 1,
        clientId: 1,
        origin: 1,
        status: 1,
        paymentMethod: 1,
        deliveredAt: 1,
        assignedTo: 1,
        zonaSnapshot: 1,
        totalFinalMinor: 1,
        items: 1,
      },
    },
    { $sort: { deliveredAt: 1, _id: 1 } },
  ];
}

async function resolveClientIdsByType(
  clientType?: ClientType,
): Promise<Types.ObjectId[] | undefined> {
  if (!clientType) return undefined;
  const docs = await Client.find({ clientType }).select('_id');
  return docs.map((d) => d._id);
}

export async function buildPeriodReport(
  filters: ReportFilters,
  now: Date = new Date(),
): Promise<PeriodReport> {
  const period = resolveReportPeriod(filters, now);
  const periodLabels = periodDateLabels(period);
  const clientIdsFilter = await resolveClientIdsByType(
    filters.clientType,
  );

  const pipeline = buildOrderPipeline(
    period.dateFrom,
    period.dateTo,
    clientIdsFilter,
  );

  // Restrict by driver post-query because the index on `assignedTo` is
  // already used; projecting assignedTo keeps the cursor small.
  type OrderRow = {
    _id: Types.ObjectId;
    clientId: Types.ObjectId;
    origin: 'CITIZEN' | 'STAFF';
    status: 'DELIVERED';
    paymentMethod: 'CASH' | 'ACCOUNT';
    deliveredAt: Date;
    assignedTo: Types.ObjectId | null;
    zonaSnapshot: string | null;
    totalFinalMinor: number;
    items: Array<{
      productId: Types.ObjectId;
      productCode: string;
      productName: string;
      productType: string;
      quantity: number;
      subtotalFinalMinor: number;
    }>;
  };

  const rows = await Order.aggregate<OrderRow>(pipeline);
  const filteredRows = filters.driverId
    ? rows.filter((r) =>
        r.assignedTo ? r.assignedTo.toString() === filters.driverId : false,
      )
    : rows;

  // Resolve client info for the listing in one query (avoid N+1).
  const clientIds = Array.from(
    new Set(filteredRows.map((r) => r.clientId.toString())),
  );
  const clients =
    clientIds.length > 0
      ? await Client.find({ _id: { $in: clientIds } }).select(
          'firstName lastName documentType documentNumber clientType',
        )
      : [];
  const clientById = new Map(
    clients.map((c) => [
      c._id.toString(),
      {
        fullName: `${c.firstName} ${c.lastName}`.trim(),
        documentNumber: c.documentNumber ?? null,
        clientType: c.clientType,
      },
    ]),
  );

  // Resolve driver display names from the users collection (orders do not
  // store a denormalized driver name snapshot).
  const driverIds = Array.from(
    new Set(
      filteredRows
        .map((r) => (r.assignedTo ? r.assignedTo.toString() : null))
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const drivers =
    driverIds.length > 0
      ? await User.find({ _id: { $in: driverIds } }).select(
          'firstName lastName',
        )
      : [];
  const driverNameById = new Map(
    drivers.map((u) => [
      u._id.toString(),
      `${u.firstName} ${u.lastName}`.trim(),
    ]),
  );

  // Build the three breakdowns in a single pass.
  const productMap = new Map<string, FlatProductAgg>();
  const deliveryMap = new Map<string, FlatDeliveryAgg>();
  let grossSalesMinor = 0;
  let cashCollectedMinor = 0;
  let accountChargedMinor = 0;
  let unitsSold = 0;
  const distinctProducts = new Set<string>();

  const orders: ReportOrderRow[] = [];

  for (const row of filteredRows) {
    const clientMeta = clientById.get(row.clientId.toString());
    const driverName = row.assignedTo
      ? driverNameById.get(row.assignedTo.toString()) ?? null
      : null;

    // Totals
    grossSalesMinor += row.totalFinalMinor;
    if (row.paymentMethod === 'CASH') {
      cashCollectedMinor += row.totalFinalMinor;
    } else if (row.paymentMethod === 'ACCOUNT') {
      accountChargedMinor += row.totalFinalMinor;
    }

    // Per-driver aggregation
    const driverKey = row.assignedTo ? row.assignedTo.toString() : 'UNASSIGNED';
    let deliveryRow = deliveryMap.get(driverKey);
    if (!deliveryRow) {
      deliveryRow = {
        key: driverKey,
        driverId: row.assignedTo ? row.assignedTo.toString() : null,
        driverName: driverName ?? 'Sin asignar',
        deliveredOrdersCount: 0,
        unitsDelivered: 0,
        cashCollectedMinor: 0,
        totalDeliveredMinor: 0,
      };
      deliveryMap.set(driverKey, deliveryRow);
    }
    deliveryRow.deliveredOrdersCount += 1;
    deliveryRow.totalDeliveredMinor += row.totalFinalMinor;
    if (row.paymentMethod === 'CASH') {
      deliveryRow.cashCollectedMinor += row.totalFinalMinor;
    }

    // Items + listing
    const itemRows: ReportOrderItemRow[] = [];
    let orderUnits = 0;
    for (const item of row.items) {
      orderUnits += item.quantity;
      unitsSold += item.quantity;
      distinctProducts.add(item.productId.toString());
      const productKey = item.productId.toString();
      let productRow = productMap.get(productKey);
      if (!productRow) {
        productRow = {
          _id: item.productId,
          productCode: item.productCode,
          productName: item.productName,
          productType: item.productType,
          totalQuantity: 0,
          totalSubtotalFinalMinor: 0,
          orderIds: new Set<string>(),
        };
        productMap.set(productKey, productRow);
      }
      productRow.totalQuantity += item.quantity;
      productRow.totalSubtotalFinalMinor += item.subtotalFinalMinor;
      productRow.orderIds.add(row._id.toString());

      itemRows.push({
        productCode: item.productCode,
        productName: item.productName,
        quantity: item.quantity,
        subtotalFinalMinor: item.subtotalFinalMinor,
      });
    }
    deliveryRow.unitsDelivered += orderUnits;

    orders.push({
      id: row._id.toString(),
      deliveredAt: row.deliveredAt.toISOString(),
      clientId: row.clientId.toString(),
      clientName: clientMeta?.fullName ?? '—',
      documentNumber: clientMeta?.documentNumber ?? null,
      clientType: clientMeta?.clientType ?? 'LOCAL',
      zona: row.zonaSnapshot ?? null,
      origin: row.origin,
      status: 'DELIVERED',
      paymentMethod: row.paymentMethod,
      driverId: row.assignedTo ? row.assignedTo.toString() : null,
      driverName,
      totalFinalMinor: row.totalFinalMinor,
      items: itemRows,
    });
  }

  const productBreakdown: ReportProductRow[] = Array.from(productMap.values())
    .map((row) => ({
      productId: row._id.toString(),
      productCode: row.productCode,
      productName: row.productName,
      productType: row.productType,
      totalQuantity: row.totalQuantity,
      totalSubtotalFinalMinor: row.totalSubtotalFinalMinor,
      orderCount: row.orderIds.size,
    }))
    .sort((a, b) => b.totalSubtotalFinalMinor - a.totalSubtotalFinalMinor);

  const deliveryBreakdown: ReportDeliveryRow[] = Array.from(deliveryMap.values())
    .map((row) => ({
      driverId: row.driverId,
      driverName: row.driverName,
      deliveredOrdersCount: row.deliveredOrdersCount,
      unitsDelivered: row.unitsDelivered,
      cashCollectedMinor: row.cashCollectedMinor,
      totalDeliveredMinor: row.totalDeliveredMinor,
    }))
    .sort((a, b) => b.totalDeliveredMinor - a.totalDeliveredMinor);

  const totals: ReportTotals = {
    deliveredOrdersCount: filteredRows.length,
    unitsSold,
    distinctProducts: distinctProducts.size,
    grossSalesMinor,
    cashCollectedMinor,
    accountChargedMinor,
  };

  const driverDisplay: ReportPeriodSummary['filters'] = {
    driverId: filters.driverId ?? null,
    driverName: null,
    clientType: filters.clientType ?? null,
  };
  if (filters.driverId) {
    const d = await User.findById(filters.driverId).select('firstName lastName');
    if (d) {
      driverDisplay.driverName = `${d.firstName} ${d.lastName}`.trim();
    }
  }

  return {
    period: {
      preset: period.preset,
      label: period.label,
      dateFrom: periodLabels.dateFrom,
      dateTo: periodLabels.displayedTo,
      filters: driverDisplay,
    },
    totals,
    productBreakdown,
    deliveryBreakdown,
    orders,
  };
}

export async function listAvailableDriversForReports(): Promise<
  ReportAvailableDriver[]
> {
  const users = await User.find({ role: 'REPARTIDOR', active: true })
    .sort({ lastName: 1, firstName: 1 })
    .select('firstName lastName');
  return users.map((u) => ({
    id: u._id.toString(),
    firstName: u.firstName,
    lastName: u.lastName,
    fullName: `${u.firstName} ${u.lastName}`.trim(),
  }));
}

