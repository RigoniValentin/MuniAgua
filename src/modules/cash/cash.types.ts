/**
 * Cash collections ledger — independent from the cta cte.
 *
 * Cash collected by a repartidor on delivery (CASH orders) is recorded
 * here as `CASH_COLLECTION` movements. This ledger NEVER feeds the
 * client's cta cte balance — it is a separate audit trail used by:
 *   - citizens to confirm what they paid in cash,
 *   - admins to track un-rendered cash and reconcile cash-ups,
 *   - drivers to audit their daily collections.
 *
 * Rounding/signed conventions:
 *   - `amountMinor` is always a positive integer.
 *   - There is no `direction` field. CASH_REVERSAL movements record a
 *     refund/reversal that offsets a previous CASH_COLLECTION.
 */

import type { ClientType } from '../clients/clients.types.js';

export const CASH_MOVEMENT_TYPES = {
  CASH_COLLECTION: 'CASH_COLLECTION',
  CASH_REVERSAL: 'CASH_REVERSAL',
} as const;

export type CashMovementType =
  (typeof CASH_MOVEMENT_TYPES)[keyof typeof CASH_MOVEMENT_TYPES];
export const ALL_CASH_MOVEMENT_TYPES: CashMovementType[] =
  Object.values(CASH_MOVEMENT_TYPES);

export const CASH_MOVEMENT_TYPE_LABEL: Record<CashMovementType, string> = {
  CASH_COLLECTION: 'Cobro en efectivo',
  CASH_REVERSAL: 'Reversión de cobro en efectivo',
};

export const CASH_SOURCE_TYPES = {
  ORDER: 'ORDER',
  MANUAL: 'MANUAL',
} as const;

export type CashSourceType =
  (typeof CASH_SOURCE_TYPES)[keyof typeof CASH_SOURCE_TYPES];
export const ALL_CASH_SOURCE_TYPES: CashSourceType[] =
  Object.values(CASH_SOURCE_TYPES);

export const CASH_SOURCE_LABEL: Record<CashSourceType, string> = {
  ORDER: 'Pedido',
  MANUAL: 'Manual',
};

/** Allowed MIME types / limits (forward-compat). Not used yet. */
export const CASH_LIST_DEFAULT_LIMIT = 20;
export const CASH_LIST_MAX_LIMIT = 100;

// ---------------------------------------------------------------------------
// Public DTOs
// ---------------------------------------------------------------------------

export interface CashMovementDto {
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
  driverId: string | null;
  driverName?: string | null;
  amountMinor: number;
  movementType: CashMovementType;
  description: string;
  occurredAt: Date;
  sourceType: CashSourceType;
  sourceId: string | null;
  orderId: string | null;
  idempotencyKey: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface CashMovementListPagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface CashMovementListResult {
  items: CashMovementDto[];
  pagination: CashMovementListPagination;
}

/**
 * Aggregate totals for a client (or for a driver in their dashboard).
 * Cash is always incoming, so the total is the sum of all `amountMinor`.
 */
export interface CashSummary {
  totalCollectedMinor: number;
  movementCount: number;
  lastMovementAt: Date | null;
}

export interface CashSummaryResponse {
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
  driver?: {
    id: string;
    firstName: string;
    lastName: string;
    fullName: string;
  };
  summary: CashSummary;
}