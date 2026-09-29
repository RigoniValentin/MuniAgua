/**
 * Orders module — FASE 7.
 *
 * Orders carry a frozen price snapshot per line item and (when > 0) an
 * associated ledger entry. Money is always integer minor units. Origins
 * are CITIZEN (created by a vecino) or STAFF (created by a driver/admin).
 * `createdBy` records the actor ObjectId and is never exposed to the
 * citizen who created the order.
 *
 * Lifecycle (MVP — driver-centric):
 *   CONFIRMED → PENDING → ASSIGNED → OUT_FOR_DELIVERY → DELIVERED
 *   CONFIRMED / PENDING / ASSIGNED → CANCELLED
 *
 *   CONFIRMED  - Created, waiting for the day that matches its zona.
 *   PENDING    - Zona delivers today; visible to drivers in the pool.
 *                A driver "claims" it → ASSIGNED.
 *   ASSIGNED   - A driver claimed it; ready to start delivery.
 *   OUT_FOR_DELIVERY - In progress.
 *   DELIVERED  - Terminal.
 *   CANCELLED  - Terminal (reverses the DEBIT when applicable).
 *
 * Admin NO longer assigns drivers — repartidores gestionan y reparten.
 */

export const ORDER_STATUSES = {
  CONFIRMED: 'CONFIRMED',
  PENDING: 'PENDING',
  ASSIGNED: 'ASSIGNED',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
} as const;

export type OrderStatus = (typeof ORDER_STATUSES)[keyof typeof ORDER_STATUSES];
export const ALL_ORDER_STATUSES: OrderStatus[] = Object.values(ORDER_STATUSES);

export const ORDER_ORIGINS = {
  CITIZEN: 'CITIZEN',
  STAFF: 'STAFF',
} as const;

export type OrderOrigin = (typeof ORDER_ORIGINS)[keyof typeof ORDER_ORIGINS];
export const ALL_ORDER_ORIGINS: OrderOrigin[] = Object.values(ORDER_ORIGINS);

/**
 * State machine transitions allowed in the MVP.
 * DELIVERED and CANCELLED are terminal.
 * OUT_FOR_DELIVERY → CANCELLED is not allowed for MVP.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CONFIRMED: [ORDER_STATUSES.PENDING, ORDER_STATUSES.CANCELLED],
  PENDING: [ORDER_STATUSES.ASSIGNED, ORDER_STATUSES.CANCELLED],
  ASSIGNED: [ORDER_STATUSES.OUT_FOR_DELIVERY, ORDER_STATUSES.CANCELLED],
  OUT_FOR_DELIVERY: [ORDER_STATUSES.DELIVERED],
  DELIVERED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  CONFIRMED: 'Confirmado',
  PENDING: 'Pendiente',
  ASSIGNED: 'Asignado',
  OUT_FOR_DELIVERY: 'En reparto',
  DELIVERED: 'Entregado',
  CANCELLED: 'Cancelado',
};

export const ORDER_ORIGIN_LABEL: Record<OrderOrigin, string> = {
  CITIZEN: 'Vecino',
  STAFF: 'Personal',
};

export const ORDER_LIST_DEFAULT_LIMIT = 20;
export const ORDER_LIST_MAX_LIMIT = 100;

export const MAX_CUSTOMER_NOTE_LENGTH = 500;
export const MAX_CANCELLATION_REASON_LENGTH = 500;
export const MAX_QUANTITY_PER_LINE = 1000;
export const MIN_QUANTITY_PER_LINE = 1;

export const ORDER_DELIVERY_CHARGE_IDEMPOTENCY_PREFIX = 'ORDER';
export const ORDER_DELIVERY_CHARGE_IDEMPOTENCY_SUFFIX = 'CHARGE';
export const ORDER_CASH_COLLECTION_IDEMPOTENCY_PREFIX = 'ORDER';
export const ORDER_CASH_COLLECTION_IDEMPOTENCY_SUFFIX = 'CASH_COLLECTION';

/**
 * How a delivery's payment is settled when the order is finalized.
 *
 *   ACCOUNT  - The customer is debited on their cuenta corriente (DEBIT
 *              ORDER_CHARGE). This is the historical default.
 *   CASH     - The repartidor collects cash on delivery. The ledger gets a
 *              single CREDIT CASH_COLLECTION entry (no DEBIT) so the
 *              client's cta cte is untouched while the cash receipt is
 *              audited. When a CITIZEN order is flipped to CASH at deliver
 *              time, the existing DEBIT is reversed and replaced.
 */
export const ORDER_PAYMENT_METHODS = {
  ACCOUNT: 'ACCOUNT',
  CASH: 'CASH',
} as const;

export type OrderPaymentMethod =
  (typeof ORDER_PAYMENT_METHODS)[keyof typeof ORDER_PAYMENT_METHODS];
export const ALL_ORDER_PAYMENT_METHODS: OrderPaymentMethod[] =
  Object.values(ORDER_PAYMENT_METHODS);

export const ORDER_PAYMENT_METHOD_LABEL: Record<OrderPaymentMethod, string> = {
  ACCOUNT: 'Cuenta corriente',
  CASH: 'Contado',
};
