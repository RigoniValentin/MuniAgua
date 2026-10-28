/**
 * Resolución del precio unitario de un producto.
 *
 * Es la ÚNICA fuente de verdad del precio final. La usan tanto el motor de
 * cotizaciones como la matriz de precios del panel de administración, para
 * que lo que el administrador ve sea exactamente lo que se cobra.
 *
 * Precedencia:
 *   1. Precio FIJO cargado para (producto, tipo de cliente) → precio exacto.
 *   2. Regla de PORCENTAJE más específica → base + ajuste.
 *   3. Precio base.
 */

import type { ProductClientTypePrice } from '../products/products.model.js';
import { computeAdjustment, impliedPercentage } from '../../shared/money.js';
import type { PricingRuleDocument } from './pricing.rules.model.js';
import type {
  ClientType,
  PriceSource,
  PricingScope,
} from './pricing.types.js';

const SPECIFICITY_RANK: Record<PricingScope, number> = {
  PRODUCT: 3,
  PRODUCT_TYPE: 2,
  ALL_PRODUCTS: 1,
};

/**
 * Select the most specific active rule for a product.
 *
 * Tie-breaker: higher specificity > higher priority > earlier createdAt.
 */
export function pickBestRule(
  rules: PricingRuleDocument[],
): PricingRuleDocument | null {
  if (rules.length === 0) return null;
  const sorted = [...rules].sort((a, b) => {
    const diff = SPECIFICITY_RANK[b.scope] - SPECIFICITY_RANK[a.scope];
    if (diff !== 0) return diff;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return sorted[0] ?? null;
}

export interface ResolvedUnitPrice {
  /** Precio final unitario en minor units. */
  priceMinor: number;
  /** De dónde salió el precio final. */
  source: PriceSource;
  /** Margen real del precio final respecto del precio base (entero). */
  impliedPercentage: number;
  /** Regla que se aplicó, si el precio no vino de un precio fijo. */
  appliedRule: PricingRuleDocument | null;
  /** Precio fijo cargado, si existe. */
  fixedPrice: ProductClientTypePrice | null;
}

/** Datos mínimos del producto que hacen falta para resolver el precio. */
export interface PriceableProduct {
  basePriceMinor: number;
  clientTypePrices?: ProductClientTypePrice[] | null;
}

/**
 * Resuelve el precio unitario final de un producto para un tipo de cliente.
 *
 * @param product producto con su precio base y sus precios fijos
 * @param clientType tipo de cliente del cliente que cotiza
 * @param rules reglas candidatas YA filtradas por `clientType`
 */
export function resolveUnitPrice(args: {
  product: PriceableProduct;
  clientType: ClientType;
  rules: PricingRuleDocument[];
}): ResolvedUnitPrice {
  const { product, clientType, rules } = args;
  const baseMinor = product.basePriceMinor;

  const fixedPrice =
    (product.clientTypePrices ?? []).find(
      (price) => price.clientType === clientType,
    ) ?? null;
  if (fixedPrice) {
    return {
      priceMinor: fixedPrice.priceMinor,
      source: 'FIXED',
      impliedPercentage: impliedPercentage(baseMinor, fixedPrice.priceMinor),
      appliedRule: null,
      fixedPrice,
    };
  }

  const rule = pickBestRule(rules);
  if (rule) {
    const computed = computeAdjustment(baseMinor, rule.adjustmentValue);
    return {
      priceMinor: computed.finalMinor,
      source: 'PERCENTAGE',
      impliedPercentage: rule.adjustmentValue,
      appliedRule: rule,
      fixedPrice: null,
    };
  }

  return {
    priceMinor: baseMinor,
    source: 'BASE',
    impliedPercentage: 0,
    appliedRule: null,
    fixedPrice: null,
  };
}
