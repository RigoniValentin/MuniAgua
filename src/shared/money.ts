/**
 * Monetary helpers — single source of truth for money handling.
 *
 * Backend always works with integer MINOR units (cents in ARS).
 * 1 major unit = 100 minor units.
 *
 * Never use floating point for source-of-truth amounts.
 */

export const MINOR_UNITS_PER_MAJOR = 100;

export const MAX_ALLOWED_PERCENTAGE = 1000;
export const MIN_ALLOWED_PERCENTAGE = -100;

/**
 * Convert major units (number with decimals) to integer minor units.
 * Throws if the result would not be a safe integer.
 */
export function toMinorUnits(major: number): number {
  if (!Number.isFinite(major)) {
    throw new Error('Monto inválido');
  }
  const minor = Math.round(major * MINOR_UNITS_PER_MAJOR);
  if (!Number.isSafeInteger(minor)) {
    throw new Error('Monto fuera de rango seguro');
  }
  return minor;
}

/**
 * Convert integer minor units to major units (float, for display only).
 */
export function toMajorUnits(minor: number): number {
  return minor / MINOR_UNITS_PER_MAJOR;
}

/**
 * Assert a value is a non-negative safe integer in minor units.
 */
export function assertNonNegativeMinor(minor: number, field = 'monto'): void {
  if (!Number.isInteger(minor)) {
    throw new Error(`${field} debe ser un entero`);
  }
  if (minor < 0) {
    throw new Error(`${field} no puede ser negativo`);
  }
}

/**
 * Assert a value is a non-negative upper-bounded safe integer in minor units.
 */
export function assertMinorRange(minor: number, max: number, field = 'monto'): void {
  assertNonNegativeMinor(minor, field);
  if (minor > max) {
    throw new Error(`${field} excede el máximo permitido (${max})`);
  }
}

/**
 * Round half-up (mathematical rounding) of an integer minor amount.
 */
export function roundHalfUp(value: number): number {
  if (value >= 0) {
    return Math.floor(value + 0.5);
  }
  return -Math.floor(-value + 0.5);
}

/**
 * Percentage that a final amount represents relative to a base amount.
 *
 * Used to show the "margen equivalente" of an exact (fixed) price:
 *   base $10.000, precio fijo $6.500 → -35%
 *
 * Returns 0 when the base is 0 (there is no meaningful ratio).
 */
export function impliedPercentage(baseMinor: number, priceMinor: number): number {
  if (!Number.isInteger(baseMinor) || baseMinor < 0) {
    throw new Error('baseMinor debe ser un entero no negativo');
  }
  if (!Number.isInteger(priceMinor)) {
    throw new Error('priceMinor debe ser un entero');
  }
  if (baseMinor === 0) {
    return 0;
  }
  return roundHalfUp(((priceMinor - baseMinor) / baseMinor) * 100);
}

/**
 * Apply a percentage adjustment to a base minor amount.
 *
 * @param baseMinor integer non-negative minor units
 * @param percentage integer percentage (e.g. -50 means -50%). 0 = no change.
 * @returns the adjustment minor amount (can be negative), rounded half-up to the cent.
 */
export function applyPercentageAdjustmentMinor(
  baseMinor: number,
  percentage: number,
): number {
  if (!Number.isInteger(baseMinor) || baseMinor < 0) {
    throw new Error('baseMinor debe ser un entero no negativo');
  }
  if (!Number.isInteger(percentage)) {
    throw new Error('percentage debe ser un entero');
  }
  const raw = (baseMinor * percentage) / 100;
  return roundHalfUp(raw);
}

/**
 * Compute the final minor amount after applying a percentage adjustment.
 *
 * Result is clamped at 0 (never negative).
 *
 * @returns { adjustmentMinor, finalMinor }
 */
export function computeAdjustment(
  baseMinor: number,
  percentage: number,
): { adjustmentMinor: number; finalMinor: number } {
  const adjustmentMinor = applyPercentageAdjustmentMinor(baseMinor, percentage);
  let finalMinor = baseMinor + adjustmentMinor;
  if (finalMinor < 0) {
    finalMinor = 0;
  }
  return { adjustmentMinor, finalMinor };
}

/**
 * Format an integer minor amount for optional logging/diagnostics.
 * Use Intl.NumberFormat on the frontend for user-facing display.
 */
export function formatMinorDiagnostic(minor: number, currency = 'ARS'): string {
  return `${toMajorUnits(minor).toFixed(2)} ${currency} (${minor} minor)`;
}

/**
 * Validate a percentage value is within defensive bounds.
 */
export function isValidPercentage(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_ALLOWED_PERCENTAGE &&
    value <= MAX_ALLOWED_PERCENTAGE
  );
}
