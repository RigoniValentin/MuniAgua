/**
 * Orders service — FASE 7.
 *
 * Lifecycle:
 *   1. CITIZEN or STAFF posts items (no prices).
 *   2. Service re-prices via the Pricing Engine and freezes a snapshot on the
 *      Order. Frontend prices are NEVER trusted.
 *   3. If totalFinalMinor > 0, an AccountMovement (DEBIT, ORDER_CHARGE) is
 *      posted in the SAME transaction as the Order write. Idempotency key
 *      `ORDER:<id>:CHARGE` guarantees a single DEBIT per Order.
 *   4. Initial status for CITIZEN orders:
 *      - If client's zona delivers today → PENDING (visible to drivers).
 *      - Otherwise → CONFIRMED. The daily sweep
 *        `promoteConfirmedToPendingOnDayRoll` flips CONFIRMED → PENDING
 *        when the matching weekday rolls around.
 *      Staff direct-orders (with assignTo) start as OUT_FOR_DELIVERY.
 *   5. Drivers claim PENDING orders via `claimOrder` → ASSIGNED → start →
 *      deliver → DELIVERED.
 *   6. Cancellation reverses the DEBIT (if any) inside a transaction.
 *      $0 orders skip the ledger entirely.
 *
 * The service is fully decoupled from HTTP. Controllers map exceptions.
 */
import { Types, type ClientSession } from 'mongoose';
import {
  Order,
  type OrderDocument,
  type OrderItem,
  type OrderDeliveryAddress,
} from './orders.model.js';
import { Client, type ClientDocument } from '../clients/clients.model.js';
import { Product, type ProductDocument } from '../products/products.model.js';
import { User, type UserDocument } from '../users/users.model.js';
import {
  buildQuote,
} from '../pricing/pricing.engine.js';
import type { QuoteLineItem } from '../pricing/pricing.types.js';
import {
  postMovement,
  reverseMovement,
} from '../accounts/accounts.service.js';
import {
  canTransition,
  ORDER_STATUSES,
  ORDER_DELIVERY_CHARGE_IDEMPOTENCY_PREFIX,
  ORDER_DELIVERY_CHARGE_IDEMPOTENCY_SUFFIX,
  type OrderOrigin,
  type OrderStatus,
} from './orders.types.js';
import type { ClientType } from '../clients/clients.types.js';
import type { ProductType } from '../products/products.types.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import { runAtomicOperation } from '../../shared/transactions.js';
import type { ZoneCode } from '../delivery-zones/delivery-zones.types.js';
import {
  isKnownZone,
  zoneDeliversOn,
} from '../delivery-zones/delivery-zones.helpers.js';
import { getAppToday } from '../../shared/app-date.js';

// ============================================================================
// Public DTOs
// ============================================================================

export interface OrderItemDto {
  productId: string;
  productCode: string;
  productName: string;
  productType: ProductType;
  quantity: number;
  unitBasePriceMinor: number;
  adjustmentPercentage: number;
  unitFinalPriceMinor: number;
  subtotalBaseMinor: number;
  subtotalFinalMinor: number;
  appliedRuleId: string | null;
  appliedRuleName: string | null;
}

export interface OrderDeliveryAddressDto {
  street: string;
  number: string | null;
  floor: string | null;
  apartment: string | null;
  neighborhood: string | null;
  locality: string;
  postalCode: string | null;
  references: string | null;
}

export interface OrderDto {
  id: string;
  clientId: string;
  client?: {
    id: string;
    firstName: string;
    lastName: string;
    fullName: string;
    documentType: string | null;
    documentNumber: string | null;
    clientType: ClientType;
    active: boolean;
  };
  origin: OrderOrigin;
  status: OrderStatus;
  items: OrderItemDto[];
  totalBaseMinor: number;
  totalFinalMinor: number;
  deliveryAddress: OrderDeliveryAddressDto;
  /**
   * Frozen zone of the client when the order was placed. Drivers consult
   * this to know which day each order belongs to.
   */
  zona: string | null;
  customerNote: string | null;

  accountMovementId?: string | null;
  cancellationMovementId?: string | null;

  assignedTo?: string | null;
  assignedToName?: string | null;
  assignedAt?: Date | null;

  startedDeliveryAt?: Date | null;
  deliveredAt?: Date | null;
  cancelledAt?: Date | null;
  cancellationReason?: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface OrderListPagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface OrderListResult {
  items: OrderDto[];
  pagination: OrderListPagination;
}

export interface AvailableDriverDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

// ============================================================================
// DTO helpers
// ============================================================================

function toItemDto(item: OrderItem): OrderItemDto {
  return {
    productId: item.productId.toString(),
    productCode: item.productCode,
    productName: item.productName,
    productType: item.productType,
    quantity: item.quantity,
    unitBasePriceMinor: item.unitBasePriceMinor,
    adjustmentPercentage: item.adjustmentPercentage,
    unitFinalPriceMinor: item.unitFinalPriceMinor,
    subtotalBaseMinor: item.subtotalBaseMinor,
    subtotalFinalMinor: item.subtotalFinalMinor,
    appliedRuleId: item.appliedRuleId ? item.appliedRuleId.toString() : null,
    appliedRuleName: item.appliedRuleName ?? null,
  };
}

function toAddressDto(addr: OrderDeliveryAddress): OrderDeliveryAddressDto {
  return {
    street: addr.street,
    number: addr.number ?? null,
    floor: addr.floor ?? null,
    apartment: addr.apartment ?? null,
    neighborhood: addr.neighborhood ?? null,
    locality: addr.locality,
    postalCode: addr.postalCode ?? null,
    references: addr.references ?? null,
  };
}

export interface ToOrderDtoOptions {
  includeClient?: boolean;
  includeAccountMovementId?: boolean;
  includeCancellationMovementId?: boolean;
  assignedToName?: string | null;
}

/**
 * If `includeClient` is true and the document has not been populated yet,
 * populates `clientId` on the fly. Pass an already-populated doc when you
 * want to control the query.
 */
export async function toOrderDtoAsync(
  doc: OrderDocument,
  options: ToOrderDtoOptions = {},
): Promise<OrderDto> {
  if (options.includeClient && !doc.populated('clientId')) {
    await doc.populate('clientId');
  }
  return toOrderDto(doc, options);
}

export function toOrderDto(
  doc: OrderDocument,
  options: ToOrderDtoOptions = {},
): OrderDto {
  const dto: OrderDto = {
    id: doc._id.toString(),
    clientId: doc.clientId.toString(),
    origin: doc.origin,
    status: doc.status,
    items: doc.items.map(toItemDto),
    totalBaseMinor: doc.totalBaseMinor,
    totalFinalMinor: doc.totalFinalMinor,
    deliveryAddress: toAddressDto(doc.deliveryAddressSnapshot),
    zona: doc.zonaSnapshot ?? null,
    customerNote: doc.customerNote ?? null,
    assignedTo: doc.assignedTo ? doc.assignedTo.toString() : null,
    assignedAt: doc.assignedAt ?? null,
    startedDeliveryAt: doc.startedDeliveryAt ?? null,
    deliveredAt: doc.deliveredAt ?? null,
    cancelledAt: doc.cancelledAt ?? null,
    cancellationReason: doc.cancellationReason ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
  if (options.includeClient && doc.populated('clientId')) {
    const c = doc.clientId as unknown as ClientDocument;
    dto.client = {
      id: c._id.toString(),
      firstName: c.firstName,
      lastName: c.lastName,
      fullName: `${c.firstName} ${c.lastName}`.trim(),
      documentType: c.documentType ?? null,
      documentNumber: c.documentNumber ?? null,
      clientType: c.clientType,
      active: c.active,
    };
  }
  if (options.includeAccountMovementId) {
    dto.accountMovementId = doc.accountMovementId
      ? doc.accountMovementId.toString()
      : null;
  }
  if (options.includeCancellationMovementId) {
    dto.cancellationMovementId = doc.cancellationMovementId
      ? doc.cancellationMovementId.toString()
      : null;
  }
  if (options.assignedToName !== undefined) {
    dto.assignedToName = options.assignedToName;
  }
  return dto;
}

// ============================================================================
// Inputs / outputs of the create path
// ============================================================================

export interface CreateOrderInput {
  clientId: string;
  origin: OrderOrigin;
  items: Array<{ productId: string; quantity: number }>;
  customerNote?: string | null;
  createdBy: string;
  /**
   * Optional override for the initial status (used by staff direct-order
   * to skip the CONFIRMED → ASSIGNED trip and start at OUT_FOR_DELIVERY).
   * Must still satisfy a valid transition from CONFIRMED if non-default.
   */
  initialStatus?: OrderStatus;
  /**
   * Optional pre-assignment — staff direct-order pre-assigns to the driver.
   */
  assignTo?: string | null;
  session?: ClientSession;
}

async function buildOrderItems(
  client: ClientDocument,
  items: Array<{ productId: string; quantity: number }>,
): Promise<{
  orderItems: OrderItem[];
  totalBaseMinor: number;
  totalFinalMinor: number;
}> {
  if (items.length === 0) {
    throw new ValidationError('El pedido debe contener al menos un producto');
  }
  const productIds = items.map((i) => {
    if (!Types.ObjectId.isValid(i.productId)) {
      throw new ValidationError('Identificador de producto inválido');
    }
    return new Types.ObjectId(i.productId);
  });
  const products = await Product.find({
    _id: { $in: productIds },
    active: true,
  });
  const byId = new Map<string, ProductDocument>();
  for (const p of products) byId.set(p._id.toString(), p);
  for (const item of items) {
    if (!byId.has(item.productId)) {
      throw new NotFoundError(
        `El producto ${item.productId} no existe o no está activo`,
      );
    }
  }

  // Use the existing Pricing Engine to compute snapshot line items.
  const quote = await buildQuote(client._id.toString(), items);
  const orderItems: OrderItem[] = quote.items.map(
    (line: QuoteLineItem, idx: number) => {
      const source = items[idx]!;
      const product = byId.get(line.productId);
      if (!product) {
        throw new NotFoundError(
          `El producto ${source.productId} no existe o no está activo`,
        );
      }
      return {
        productId: new Types.ObjectId(line.productId),
        productCode: line.productCode,
        productName: line.productName,
        productType: line.productType,
        quantity: line.quantity,
        unitBasePriceMinor: line.unitBasePriceMinor,
        adjustmentPercentage: line.adjustmentPercentage,
        unitFinalPriceMinor: line.unitFinalPriceMinor,
        subtotalBaseMinor: line.subtotalBaseMinor,
        subtotalFinalMinor: line.subtotalFinalMinor,
        appliedRuleId: line.appliedRule
          ? new Types.ObjectId(line.appliedRule.id)
          : null,
        appliedRuleName: line.appliedRule?.name ?? null,
      };
    },
  );

  return {
    orderItems,
    totalBaseMinor: quote.totals.baseMinor,
    totalFinalMinor: quote.totals.finalMinor,
  };
}

function buildDeliveryAddressSnapshot(client: ClientDocument): OrderDeliveryAddress {
  return {
    street: client.address.street,
    number: client.address.number ?? null,
    floor: client.address.floor ?? null,
    apartment: client.address.apartment ?? null,
    neighborhood: client.address.neighborhood ?? null,
    locality: client.address.locality,
    postalCode: client.address.postalCode ?? null,
    references: client.address.references ?? null,
  };
}

function buildZonaSnapshot(client: ClientDocument): string | null {
  if (!client.zona) return null;
  const normalized = client.zona.replace(/\s+/g, ' ').trim().toUpperCase();
  return normalized.length === 0 ? null : normalized;
}

/**
 * Citizen order initial status:
 *   - If client's zona is known AND delivers today → PENDING (visible to drivers).
 *   - Otherwise → CONFIRMED (waiting for the matching weekday; the daily sweep
 *     `promoteConfirmedToPendingOnDayRoll` will bump it to PENDING then).
 */
function initialStatusForCitizenOrder(
  client: ClientDocument,
): OrderStatus {
  const snapshot = buildZonaSnapshot(client);
  if (isKnownZone(snapshot)) {
    const today = getAppToday();
    if (zoneDeliversOn(snapshot, today.weekday)) {
      return ORDER_STATUSES.PENDING;
    }
  }
  return ORDER_STATUSES.CONFIRMED;
}

function idempotencyKeyForOrder(orderId: Types.ObjectId): string {
  return `${ORDER_DELIVERY_CHARGE_IDEMPOTENCY_PREFIX}:${orderId.toString()}:${ORDER_DELIVERY_CHARGE_IDEMPOTENCY_SUFFIX}`;
}

// ============================================================================
// Create order (atomic with ledger)
// ============================================================================

export interface CreateOrderResult {
  order: OrderDocument;
}

export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  if (!Types.ObjectId.isValid(input.clientId)) {
    throw new ValidationError('Identificador de cliente inválido');
  }
  if (!Types.ObjectId.isValid(input.createdBy)) {
    throw new ValidationError('Identificador de usuario inválido');
  }

  const client = await Client.findById(input.clientId);
  if (!client) throw new NotFoundError('Cliente no encontrado');
  if (!client.active) {
    throw new ValidationError('El cliente no está activo');
  }

  if (input.assignTo && !Types.ObjectId.isValid(input.assignTo)) {
    throw new ValidationError('Identificador de repartidor inválido');
  }
  if (input.assignTo) {
    const driver = await User.findById(input.assignTo);
    if (!driver) throw new NotFoundError('Repartidor no encontrado');
    if (driver.role !== 'REPARTIDOR' || !driver.active) {
      throw new ValidationError('El usuario no es un repartidor activo');
    }
  }

  const { orderItems, totalBaseMinor, totalFinalMinor } = await buildOrderItems(
    client,
    input.items,
  );
  const deliveryAddressSnapshot = buildDeliveryAddressSnapshot(client);
  const zonaSnapshot = buildZonaSnapshot(client);

  // Determine initial status:
  //   - Staff direct-order (when assignTo is provided) → OUT_FOR_DELIVERY.
  //   - Citizen order (or any non-direct staff): if the client's zona
  //     delivers today → PENDING, else CONFIRMED.
  let initialStatus: OrderStatus;
  if (input.initialStatus === ORDER_STATUSES.OUT_FOR_DELIVERY) {
    if (!input.assignTo) {
      throw new ValidationError(
        'Para iniciar como OUT_FOR_DELIVERY se requiere assignTo',
      );
    }
    initialStatus = ORDER_STATUSES.OUT_FOR_DELIVERY;
  } else if (input.initialStatus) {
    throw new ValidationError(
      `Estado inicial ${input.initialStatus} no soportado en creación directa`,
    );
  } else if (input.origin === 'CITIZEN') {
    initialStatus = initialStatusForCitizenOrder(client);
  } else {
    // Staff without explicit initialStatus → CONFIRMED; admin/driver will
    // pick up the order via direct-order (which sets OUT_FOR_DELIVERY) or
    // wait for the zone day.
    initialStatus = ORDER_STATUSES.CONFIRMED;
  }

  // Run the Order + ledger write atomically. When MongoDB supports
  // transactions, both writes live inside a single session; otherwise
  // we run them sequentially with compensation (delete the Order if the
  // ledger write fails) — see `runAtomicOperation` for details.
  const { value: orderDoc } = await runAtomicOperation({
    label: 'orders.createOrder',
    transactional: async (session) => {
      const now = new Date();
      const [created] = await Order.create(
        [
          {
            clientId: client._id,
            origin: input.origin,
            status: initialStatus,
            items: orderItems,
            totalBaseMinor,
            totalFinalMinor,
            deliveryAddressSnapshot,
            zonaSnapshot,
            customerNote: input.customerNote ?? null,
            assignedTo: input.assignTo
              ? new Types.ObjectId(input.assignTo)
              : null,
            assignedAt: input.assignTo ? now : null,
            startedDeliveryAt:
              initialStatus === ORDER_STATUSES.OUT_FOR_DELIVERY ? now : null,
            createdBy: new Types.ObjectId(input.createdBy),
          },
        ],
        { session },
      );
      if (!created) throw new ValidationError('No se pudo crear el pedido');

      // Post DEBIT only if there is something to charge. $0 orders (AYUDA_SOCIAL)
      // skip the ledger entirely — Order remains valid, accountMovementId stays null.
      if (totalFinalMinor > 0) {
        const movement = await postMovement({
          clientId: client._id.toString(),
          direction: 'DEBIT',
          amountMinor: totalFinalMinor,
          movementType: 'ORDER_CHARGE',
          description: 'Pedido confirmado',
          sourceType: 'ORDER',
          sourceId: created._id.toString(),
          idempotencyKey: idempotencyKeyForOrder(created._id),
          createdBy: input.createdBy,
          session,
        });
        created.accountMovementId = movement._id;
        await created.save({ session });
      }
      return created;
    },
    fallback: async () => {
      const now = new Date();
      const created = await Order.create({
        clientId: client._id,
        origin: input.origin,
        status: initialStatus,
        items: orderItems,
        totalBaseMinor,
        totalFinalMinor,
        deliveryAddressSnapshot,
        zonaSnapshot,
        customerNote: input.customerNote ?? null,
        assignedTo: input.assignTo
          ? new Types.ObjectId(input.assignTo)
          : null,
        assignedAt: input.assignTo ? now : null,
        startedDeliveryAt:
          initialStatus === ORDER_STATUSES.OUT_FOR_DELIVERY ? now : null,
        createdBy: new Types.ObjectId(input.createdBy),
      });
      try {
        if (totalFinalMinor > 0) {
          const movement = await postMovement({
            clientId: client._id.toString(),
            direction: 'DEBIT',
            amountMinor: totalFinalMinor,
            movementType: 'ORDER_CHARGE',
            description: 'Pedido confirmado',
            sourceType: 'ORDER',
            sourceId: created._id.toString(),
            idempotencyKey: idempotencyKeyForOrder(created._id),
            createdBy: input.createdBy,
          });
          created.accountMovementId = movement._id;
          await created.save();
        }
        return created;
      } catch (err) {
        // Compensate: delete the Order we just created so we don't leak
        // an unpaid-for order. The Order.deleteOne below is best-effort;
        // a process crash before this runs would leave a $0 accountMovementId
        // Order on disk — documented as a standalone limitation.
        try {
          await Order.deleteOne({ _id: created._id });
        } catch {
          // best-effort cleanup
        }
        throw err;
      }
    },
  });

  return { order: orderDoc };
}

// ============================================================================
// Claim (driver self-assigns from the PENDING pool)
// ============================================================================

/**
 * A driver claims a PENDING order for themselves: PENDING → ASSIGNED.
 * The order must belong to a zona that delivers today; otherwise the
 * driver is taking on a delivery outside their route. We block it to keep
 * the calendar honest — drivers see only orders that match the active
 * zones.
 */
export async function claimOrder(
  orderId: string,
  driverUserId: string,
): Promise<OrderDocument> {
  if (!Types.ObjectId.isValid(orderId)) {
    throw new ValidationError('Identificador de pedido inválido');
  }
  if (!Types.ObjectId.isValid(driverUserId)) {
    throw new ValidationError('Identificador de repartidor inválido');
  }
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError('Pedido no encontrado');
  if (!canTransition(order.status, ORDER_STATUSES.ASSIGNED)) {
    throw new ConflictError(
      `No se puede tomar un pedido en estado ${order.status}`,
    );
  }
  const driver = await User.findById(driverUserId);
  if (!driver) throw new NotFoundError('Repartidor no encontrado');
  if (driver.role !== 'REPARTIDOR') {
    throw new ValidationError('El usuario no es un repartidor');
  }
  if (!driver.active) {
    throw new ValidationError('El repartidor no está activo');
  }
  // Block out-of-day claims: only PENDING orders for zones that deliver
  // today are surfaced to drivers, but defend the invariant here too.
  if (isKnownZone(order.zonaSnapshot ?? null)) {
    const today = getAppToday();
    const zone = order.zonaSnapshot as ZoneCode;
    if (!zoneDeliversOn(zone, today.weekday)) {
      throw new ConflictError(
        `La zona ${zone} no reparte hoy (${today.weekdayLabel})`,
      );
    }
  }
  order.status = ORDER_STATUSES.ASSIGNED;
  order.assignedTo = driver._id;
  order.assignedAt = new Date();
  await order.save();
  return order;
}

/**
 * Daily sweep: promote CONFIRMED → PENDING for any order whose frozen
 * `zonaSnapshot` matches a zone that delivers today. Idempotent — running
 * it twice in a row is a no-op. Safe to call from app boot, a scheduled
 * cron, or lazily before the driver list query.
 *
 * Orders whose `zonaSnapshot` is null/unknown stay as CONFIRMED so admin
 * can intervene via cta cte management.
 */
export interface PromoteResult {
  promoted: number;
  considered: number;
}

export async function promoteConfirmedToPendingOnDayRoll(
  now: Date = new Date(),
): Promise<PromoteResult> {
  const today = getAppToday(now);
  if (today.zones.length === 0) {
    // Sunday (or any future no-deliver day): nothing to promote.
    return { promoted: 0, considered: 0 };
  }
  const eligible: OrderDocument[] = await Order.find({
    status: ORDER_STATUSES.CONFIRMED,
    zonaSnapshot: { $in: [...today.zones] },
  }).select('_id status zonaSnapshot');
  if (eligible.length === 0) {
    return { promoted: 0, considered: 0 };
  }
  const result = await Order.updateMany(
    {
      _id: { $in: eligible.map((o) => o._id) },
      status: ORDER_STATUSES.CONFIRMED,
    },
    { $set: { status: ORDER_STATUSES.PENDING } },
  );
  return {
    promoted: result.modifiedCount ?? 0,
    considered: eligible.length,
  };
}

// ============================================================================
// Delivery state transitions (driver self)
// ============================================================================

export async function startDelivery(
  orderId: string,
  driverUserId: string,
): Promise<OrderDocument> {
  if (!Types.ObjectId.isValid(orderId)) {
    throw new ValidationError('Identificador de pedido inválido');
  }
  if (!Types.ObjectId.isValid(driverUserId)) {
    throw new ValidationError('Identificador de usuario inválido');
  }
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError('Pedido no encontrado');
  if (!order.assignedTo || order.assignedTo.toString() !== driverUserId) {
    throw new ForbiddenError('El pedido no está asignado a este repartidor');
  }
  if (!canTransition(order.status, ORDER_STATUSES.OUT_FOR_DELIVERY)) {
    throw new ConflictError(
      `No se puede iniciar un pedido en estado ${order.status}`,
    );
  }
  order.status = ORDER_STATUSES.OUT_FOR_DELIVERY;
  order.startedDeliveryAt = new Date();
  await order.save();
  return order;
}

export async function markDelivered(
  orderId: string,
  driverUserId: string,
): Promise<OrderDocument> {
  if (!Types.ObjectId.isValid(orderId)) {
    throw new ValidationError('Identificador de pedido inválido');
  }
  if (!Types.ObjectId.isValid(driverUserId)) {
    throw new ValidationError('Identificador de usuario inválido');
  }
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError('Pedido no encontrado');
  if (!order.assignedTo || order.assignedTo.toString() !== driverUserId) {
    throw new ForbiddenError('El pedido no está asignado a este repartidor');
  }
  if (!canTransition(order.status, ORDER_STATUSES.DELIVERED)) {
    throw new ConflictError(
      `No se puede marcar como entregado un pedido en estado ${order.status}`,
    );
  }
  order.status = ORDER_STATUSES.DELIVERED;
  order.deliveredAt = new Date();
  await order.save();
  return order;
}

// ============================================================================
// Cancellation
// ============================================================================

export interface CancelOrderInput {
  orderId: string;
  actorUserId: string;
  /** Required when called by staff, optional for citizen. */
  reason?: string | null;
  requireReason: boolean;
  /** When true, skip ownership check (staff cancelling on behalf of admin). */
  bypassOwnershipCheck?: boolean;
  /** When provided, restrict ownership to this clientId (citizen cancel). */
  ownedByClientId?: string;
}

export async function cancelOrder(
  input: CancelOrderInput,
): Promise<OrderDocument> {
  if (!Types.ObjectId.isValid(input.orderId)) {
    throw new ValidationError('Identificador de pedido inválido');
  }
  if (!Types.ObjectId.isValid(input.actorUserId)) {
    throw new ValidationError('Identificador de usuario inválido');
  }
  const order = await Order.findById(input.orderId);
  if (!order) throw new NotFoundError('Pedido no encontrado');

  if (
    !input.bypassOwnershipCheck &&
    input.ownedByClientId &&
    order.clientId.toString() !== input.ownedByClientId
  ) {
    // Citizen trying to cancel someone else's order → 404 to avoid enumeration.
    throw new NotFoundError('Pedido no encontrado');
  }

  const trimmedReason = (input.reason ?? '').trim();
  if (input.requireReason && trimmedReason.length === 0) {
    throw new ValidationError('El motivo de cancelación es obligatorio');
  }

  // MVP transition rules:
  //   CONFIRMED → CANCELLED  (citizen allowed, staff allowed)
  //   PENDING   → CANCELLED  (citizen allowed, staff allowed)
  //   ASSIGNED  → CANCELLED  (staff only — driver already claimed it)
  //   OUT_FOR_DELIVERY → CANCELLED  NOT allowed in MVP
  //   DELIVERED, CANCELLED terminal.
  if (!canTransition(order.status, ORDER_STATUSES.CANCELLED)) {
    throw new ConflictError(
      `No se puede cancelar un pedido en estado ${order.status}`,
    );
  }
  if (
    input.bypassOwnershipCheck !== true &&
    order.status === ORDER_STATUSES.ASSIGNED
  ) {
    // Citizen trying to cancel an already-assigned order.
    throw new ConflictError(
      'No podés cancelar un pedido que ya fue asignado a un repartidor',
    );
  }

  // If there's a DEBIT linked, reverse it. Atomic with the Order write
  // when Mongo supports transactions; otherwise we run sequentially and
  // compensate by flipping the Order back if the reversal fails.
  await runAtomicOperation({
    label: 'orders.cancelOrder',
    transactional: async (session) => {
      const now = new Date();
      order.status = ORDER_STATUSES.CANCELLED;
      order.cancelledAt = now;
      order.cancellationReason = trimmedReason.length > 0 ? trimmedReason : null;

      if (order.accountMovementId) {
        const reversal = await reverseMovement({
          movementId: order.accountMovementId.toString(),
          description: trimmedReason.length > 0
            ? `Pedido cancelado: ${trimmedReason}`
            : 'Pedido cancelado',
          createdBy: input.actorUserId,
          session,
        });
        order.cancellationMovementId = reversal._id;
      }
      await order.save({ session });
      return order;
    },
    fallback: async () => {
      // Snapshot the previous values so we can compensate on failure.
      const previousStatus = order.status;
      const previousCancelledAt = order.cancelledAt ?? null;
      const previousReason = order.cancellationReason ?? null;
      const previousCancellationMovementId =
        order.cancellationMovementId ?? null;

      const now = new Date();
      order.status = ORDER_STATUSES.CANCELLED;
      order.cancelledAt = now;
      order.cancellationReason = trimmedReason.length > 0 ? trimmedReason : null;

      try {
        if (order.accountMovementId) {
          const reversal = await reverseMovement({
            movementId: order.accountMovementId.toString(),
            description: trimmedReason.length > 0
              ? `Pedido cancelado: ${trimmedReason}`
              : 'Pedido cancelado',
            createdBy: input.actorUserId,
          });
          order.cancellationMovementId = reversal._id;
        }
        await order.save();
        return order;
      } catch (err) {
        // Compensate: revert the in-memory + persisted order state.
        order.status = previousStatus;
        order.cancelledAt = previousCancelledAt;
        order.cancellationReason = previousReason;
        order.cancellationMovementId = previousCancellationMovementId;
        try {
          await order.save();
        } catch {
          // best-effort compensation
        }
        throw err;
      }
    },
  });
  return order;
}

// ============================================================================
// Reads
// ============================================================================

export async function getOrderByIdOrThrow(orderId: string): Promise<OrderDocument> {
  if (!Types.ObjectId.isValid(orderId)) {
    throw new ValidationError('Identificador de pedido inválido');
  }
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError('Pedido no encontrado');
  return order;
}

export async function findOrderById(orderId: string): Promise<OrderDocument | null> {
  if (!Types.ObjectId.isValid(orderId)) return null;
  return Order.findById(orderId);
}

export interface ListOrdersInput {
  page: number;
  limit: number;
  status?: OrderStatus;
  origin?: OrderOrigin;
  clientType?: ClientType;
  assignedTo?: string;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
  /** Restrict to a specific client. Used by citizen self-list. */
  clientId?: string;
  /** Restrict to orders currently active for a driver. */
  driverUserId?: string;
  /** When set, only show non-terminal states for a driver. */
  onlyOpenForDriver?: boolean;
  sortBy?: 'createdAt' | 'assignedAt';
  sortOrder?: 'asc' | 'desc';
  /**
   * Restrict by delivery zone. When `mode === 'today'`, only orders whose
   * `zonaSnapshot` is in `zones` are returned. `includeNull` controls
   * whether orders without a snapshot are kept (true) or hidden (false).
   */
  zoneFilter?:
    | { mode: 'today'; zones: readonly ZoneCode[]; includeNull: boolean }
    | undefined;
}

export async function listOrders(input: ListOrdersInput): Promise<OrderListResult> {
  const filter: Record<string, unknown> = {};
  if (input.clientId) {
    filter.clientId = new Types.ObjectId(input.clientId);
  }
  if (input.status) {
    filter.status = input.status;
  }
  if (input.origin) {
    filter.origin = input.origin;
  }
  if (input.clientType) {
    // resolved via lookup of clients matching clientType
  }
  if (input.assignedTo) {
    filter.assignedTo = new Types.ObjectId(input.assignedTo);
  }
  if (input.onlyOpenForDriver) {
    // Driver pool: PENDING (unclaimed, any driver) + ASSIGNED + OUT_FOR_DELIVERY
    // assigned to THIS driver. Split with $or so PENDING (no assignedTo) and
    // the assigned-to-me slice both match.
    const driverId = input.driverUserId;
    if (!driverId || !Types.ObjectId.isValid(driverId)) {
      throw new ValidationError(
        'onlyOpenForDriver requiere driverUserId válido',
      );
    }
    const myActiveSlice: Record<string, unknown> = {
      status: {
        $in: [ORDER_STATUSES.ASSIGNED, ORDER_STATUSES.OUT_FOR_DELIVERY],
      },
      assignedTo: new Types.ObjectId(driverId),
    };
    const pendingSlice: Record<string, unknown> = { status: ORDER_STATUSES.PENDING };
    filter.$or = [
      ...((filter.$or as Record<string, unknown>[]) ?? []),
      myActiveSlice,
      pendingSlice,
    ];
  } else if (input.driverUserId) {
    // Without onlyOpenForDriver: a plain "show me what I'm assigned to" view
    // (used by older callers / future read endpoints).
    filter.assignedTo = new Types.ObjectId(input.driverUserId);
  }
  if (input.dateFrom || input.dateTo) {
    const range: Record<string, Date> = {};
    if (input.dateFrom) range.$gte = input.dateFrom;
    if (input.dateTo) range.$lte = input.dateTo;
    filter.createdAt = range;
  }

  if (input.zoneFilter?.mode === 'today') {
    const { zones, includeNull } = input.zoneFilter;
    const zoneOr: Record<string, unknown>[] = [];
    if (zones.length > 0) {
      zoneOr.push({ zonaSnapshot: { $in: [...zones] } });
    }
    if (includeNull) {
      zoneOr.push({ zonaSnapshot: null });
    }
    if (zoneOr.length === 0) {
      // Asked for 'today' but no zones are active (e.g. Sunday) and we
      // are not including nulls — return early with empty result.
      return {
        items: [],
        pagination: { page: input.page, limit: input.limit, total: 0, pages: 1 },
      };
    }
    if (input.onlyOpenForDriver) {
      // Driver pool: zone filter applies ONLY to PENDING (the unclaimed pool).
      // ASSIGNED / OUT_FOR_DELIVERY rows are already filtered by `assignedTo`.
      // Splice the zone condition into the pending slice of $or.
      const orBranches = (filter.$or as Record<string, unknown>[]) ?? [];
      const pendingIdx = orBranches.findIndex(
        (b) => (b.status as string | undefined) === ORDER_STATUSES.PENDING,
      );
      const zoneSlice: Record<string, unknown> = { status: ORDER_STATUSES.PENDING };
      if (zoneOr.length === 1) {
        Object.assign(zoneSlice, zoneOr[0]);
      } else {
        zoneSlice.$or = zoneOr;
      }
      if (pendingIdx === -1) {
        // No pending slice was added (shouldn't happen given the branch
        // above, but defensive): push one.
        filter.$or = [...orBranches, zoneSlice];
      } else {
        orBranches[pendingIdx] = zoneSlice;
      }
    } else if (zoneOr.length === 1) {
      Object.assign(filter, zoneOr[0]);
    } else {
      filter.$or = [...((filter.$or as Record<string, unknown>[]) ?? []), ...zoneOr];
    }
  }

  // Resolve clientType filter via a clientIds pre-fetch. Done in two steps
  // so the index on clientId is leveraged. For MVP we don't worry about the
  // very rare "many clients of one type" page.
  let restrictToClientIds: Types.ObjectId[] | undefined;
  if (input.search || input.clientType) {
    const clientFilter: Record<string, unknown> = {};
    if (input.clientType) clientFilter.clientType = input.clientType;
    if (input.search) {
      const safe = input.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(safe, 'i');
      clientFilter.$or = [
        { firstName: re },
        { lastName: re },
        { documentNumber: re },
        { 'address.street': re },
      ];
    }
    const docs = await Client.find(clientFilter).select('_id');
    restrictToClientIds = docs.map((c) => c._id);
    if (restrictToClientIds.length === 0) {
      return {
        items: [],
        pagination: { page: input.page, limit: input.limit, total: 0, pages: 1 },
      };
    }
  }

  if (restrictToClientIds) {
    filter.clientId = {
      ...((filter.clientId as Record<string, unknown>) ?? {}),
      $in: restrictToClientIds,
    };
  }

  const sortBy = input.sortBy ?? 'createdAt';
  const sortOrder = input.sortOrder ?? 'desc';
  const sort: Record<string, 1 | -1> = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

  const skip = (input.page - 1) * input.limit;
  const [docs, total] = await Promise.all([
    Order.find(filter).sort(sort).skip(skip).limit(input.limit).populate('clientId'),
    Order.countDocuments(filter),
  ]);

  // Pre-fetch assignedTo display name for driver rendering.
  let assignedNames: Map<string, string> = new Map();
  const driverIds = docs
    .map((d) => d.assignedTo?.toString())
    .filter((v): v is string => Boolean(v));
  if (driverIds.length > 0) {
    const users = await User.find({ _id: { $in: driverIds } }).select(
      'firstName lastName',
    );
    assignedNames = new Map(
      users.map((u) => [u._id.toString(), `${u.firstName} ${u.lastName}`.trim()]),
    );
  }

  const items = docs.map((doc) =>
    toOrderDto(doc, {
      includeClient: true,
      includeAccountMovementId: true,
      includeCancellationMovementId: true,
      assignedToName: doc.assignedTo
        ? assignedNames.get(doc.assignedTo.toString()) ?? null
        : null,
    }),
  );

  const pages = input.limit > 0 ? Math.max(1, Math.ceil(total / input.limit)) : 1;
  return {
    items,
    pagination: { page: input.page, limit: input.limit, total, pages },
  };
}

// ============================================================================
// Available drivers
// ============================================================================

export async function listAvailableDrivers(): Promise<AvailableDriverDto[]> {
  const docs = await User.find({ role: 'REPARTIDOR', active: true })
    .sort({ lastName: 1, firstName: 1 })
    .select('firstName lastName email');
  return docs.map((u: UserDocument) => ({
    id: u._id.toString(),
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
  }));
}
