/**
 * Account ledger domain — FASE 4.
 *
 * Convention (DO NOT INVERT in any module):
 *   balanceMinor > 0   -> the client OWES the municipality.
 *   balanceMinor === 0 -> account is SETTLED.
 *   balanceMinor < 0   -> the client has CREDIT (saldo a favor).
 *
 * AccountMovement is the source of truth for the balance.
 * `amountMinor` is ALWAYS a positive integer (minor units).
 * `direction` carries the sign.
 */

export const DIRECTIONS = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
} as const;

export type Direction = (typeof DIRECTIONS)[keyof typeof DIRECTIONS];
export const ALL_DIRECTIONS: Direction[] = Object.values(DIRECTIONS);

/**
 * Movement types supported by the ledger.
 * Only MANUAL_ADJUSTMENT and REVERSAL are exposed publicly in FASE 4.
 * The remaining values exist to keep the schema forward-compatible
 * with future Orders / Payments / Deliveries integrations.
 */
export const MOVEMENT_TYPES = {
  MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT',
  ORDER_CHARGE: 'ORDER_CHARGE',
  PAYMENT: 'PAYMENT',
  REVERSAL: 'REVERSAL',
  OPENING_BALANCE: 'OPENING_BALANCE',
} as const;

export type MovementType = (typeof MOVEMENT_TYPES)[keyof typeof MOVEMENT_TYPES];
export const ALL_MOVEMENT_TYPES: MovementType[] = Object.values(MOVEMENT_TYPES);

/**
 * Origin classification for an AccountMovement. Used for traceability and
 * future filtering by source system. Distinct from `movementType`, which
 * describes the accounting nature of the movement.
 */
export const SOURCE_TYPES = {
  MANUAL: 'MANUAL',
  ORDER: 'ORDER',
  PAYMENT: 'PAYMENT',
  SYSTEM: 'SYSTEM',
  REVERSAL: 'REVERSAL',
} as const;

export type SourceType = (typeof SOURCE_TYPES)[keyof typeof SOURCE_TYPES];
export const ALL_SOURCE_TYPES: SourceType[] = Object.values(SOURCE_TYPES);

/**
 * Account status derived from balanceMinor.
 *   DEBT    -> balance > 0
 *   CREDIT  -> balance < 0
 *   SETTLED -> balance === 0
 */
export const ACCOUNT_STATUSES = {
  DEBT: 'DEBT',
  CREDIT: 'CREDIT',
  SETTLED: 'SETTLED',
} as const;

export type AccountStatus = (typeof ACCOUNT_STATUSES)[keyof typeof ACCOUNT_STATUSES];
export const ALL_ACCOUNT_STATUSES: AccountStatus[] = Object.values(ACCOUNT_STATUSES);

/**
 * Public-facing labels for account statuses. Used in admin UI / responses.
 */
export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  DEBT: 'Con deuda',
  CREDIT: 'Saldo a favor',
  SETTLED: 'Al día',
};

export const ACCOUNT_STATUS_TONE: Record<
  AccountStatus,
  'danger' | 'success' | 'neutral'
> = {
  DEBT: 'danger',
  CREDIT: 'success',
  SETTLED: 'neutral',
};

export const DIRECTION_LABEL: Record<Direction, string> = {
  DEBIT: 'Cargo',
  CREDIT: 'Crédito',
};

export const MOVEMENT_TYPE_LABEL: Record<MovementType, string> = {
  MANUAL_ADJUSTMENT: 'Ajuste manual',
  ORDER_CHARGE: 'Cargo por pedido',
  PAYMENT: 'Pago',
  REVERSAL: 'Reversión',
  OPENING_BALANCE: 'Saldo inicial',
};

/**
 * Convert a movement direction + amountMinor into the signed contribution
 * to the client balance. DEBIT is positive (increases debt); CREDIT is
 * negative (reduces debt / creates credit balance).
 */
export function signedContribution(direction: Direction, amountMinor: number): number {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return 0;
  }
  return direction === 'DEBIT' ? amountMinor : -amountMinor;
}

/**
 * Derive the account status from a signed balance.
 */
export function statusFromBalance(balanceMinor: number): AccountStatus {
  if (!Number.isInteger(balanceMinor)) return 'SETTLED';
  if (balanceMinor > 0) return 'DEBT';
  if (balanceMinor < 0) return 'CREDIT';
  return 'SETTLED';
}

/**
 * Inverts a direction. Used when creating a REVERSAL of a movement.
 */
export function inverseDirection(direction: Direction): Direction {
  return direction === 'DEBIT' ? 'CREDIT' : 'DEBIT';
}
