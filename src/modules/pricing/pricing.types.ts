import { ALL_CLIENT_TYPES, type ClientType } from '../clients/clients.types.js';
import { ALL_PRODUCT_TYPES, type ProductType } from '../products/products.types.js';

export type { ClientType, ProductType };
export { ALL_CLIENT_TYPES, ALL_PRODUCT_TYPES };

export const PRICING_SCOPES = {
  ALL_PRODUCTS: 'ALL_PRODUCTS',
  PRODUCT_TYPE: 'PRODUCT_TYPE',
  PRODUCT: 'PRODUCT',
} as const;

export type PricingScope = (typeof PRICING_SCOPES)[keyof typeof PRICING_SCOPES];

export const ALL_PRICING_SCOPES: PricingScope[] = Object.values(PRICING_SCOPES);

export const PRICING_ADJUSTMENT_TYPES = {
  PERCENTAGE: 'PERCENTAGE',
} as const;

export type PricingAdjustmentType =
  (typeof PRICING_ADJUSTMENT_TYPES)[keyof typeof PRICING_ADJUSTMENT_TYPES];

export const ALL_PRICING_ADJUSTMENT_TYPES: PricingAdjustmentType[] =
  Object.values(PRICING_ADJUSTMENT_TYPES);

export const SORTABLE_PRICING_RULE_FIELDS = [
  'priority',
  'name',
  'clientType',
  'scope',
  'createdAt',
  'updatedAt',
] as const;

export type PricingRuleSortableField =
  (typeof SORTABLE_PRICING_RULE_FIELDS)[number];

export const DEFAULT_PRICING_RULE_SORT_FIELD: PricingRuleSortableField = 'priority';
export const DEFAULT_PRICING_RULE_SORT_ORDER: 'asc' | 'desc' = 'desc';

export const PRICING_RULE_LIST_DEFAULT_LIMIT = 20;
export const PRICING_RULE_LIST_MAX_LIMIT = 100;

export const MAX_QUOTE_QUANTITY = 1000;
export const MIN_QUOTE_QUANTITY = 1;

/* Matriz de precios (productos × tipos de cliente) */
export const PRICE_MATRIX_LIST_DEFAULT_LIMIT = 50;
export const PRICE_MATRIX_LIST_MAX_LIMIT = 200;
export const PRICE_MATRIX_MAX_UPDATES = 200;

export const MAX_RULE_NAME_LENGTH = 120;
export const MAX_ADJUSTMENT_PERCENTAGE = 1000;
export const MIN_ADJUSTMENT_PERCENTAGE = -100;

export const SCOPE_LABEL: Record<PricingScope, string> = {
  ALL_PRODUCTS: 'Todos los productos',
  PRODUCT_TYPE: 'Tipo de producto',
  PRODUCT: 'Producto específico',
};

export const ADJUSTMENT_TYPE_LABEL: Record<PricingAdjustmentType, string> = {
  PERCENTAGE: 'Porcentaje',
};

/**
 * Origen del precio final de un ítem.
 *
 * - BASE: no hay regla ni precio fijo → se cobra el precio base.
 * - PERCENTAGE: se aplicó una regla de porcentaje.
 * - FIXED: hay un precio exacto cargado para ese tipo de cliente.
 */
export const PRICE_SOURCES = {
  BASE: 'BASE',
  PERCENTAGE: 'PERCENTAGE',
  FIXED: 'FIXED',
} as const;

export type PriceSource = (typeof PRICE_SOURCES)[keyof typeof PRICE_SOURCES];

export const ALL_PRICE_SOURCES: PriceSource[] = Object.values(PRICE_SOURCES);

export const PRICE_SOURCE_LABEL: Record<PriceSource, string> = {
  BASE: 'Precio base',
  PERCENTAGE: 'Regla %',
  FIXED: 'Precio fijo',
};

export interface PricingRuleTargetRef {
  clientType: ClientType;
  scope: PricingScope;
  productType?: ProductType | null;
  productId?: string | null;
}

export interface AppliedRuleSnapshot {
  id: string;
  name: string;
  scope: PricingScope;
  clientType: ClientType;
  productType: ProductType | null;
  productId: string | null;
  adjustmentType: PricingAdjustmentType;
  adjustmentValue: number;
  priority: number;
}

export interface QuoteLineItem {
  productId: string;
  productCode: string;
  productName: string;
  productType: ProductType;
  clientType: ClientType;
  quantity: number;
  unitBasePriceMinor: number;
  appliedRule: AppliedRuleSnapshot | null;
  /**
   * Porcentaje real del precio final respecto del precio base.
   * Con regla % es el % de la regla; con precio fijo es el margen equivalente.
   */
  adjustmentPercentage: number;
  priceSource: PriceSource;
  unitFinalPriceMinor: number;
  subtotalBaseMinor: number;
  subtotalFinalMinor: number;
}

export interface QuoteTotals {
  baseMinor: number;
  adjustmentMinor: number;
  finalMinor: number;
}

export interface QuoteClientSnapshot {
  id: string;
  name: string;
  clientType: ClientType;
  active: boolean;
  hasUserAccount: boolean;
}

export interface QuoteResult {
  client: QuoteClientSnapshot;
  items: QuoteLineItem[];
  totals: QuoteTotals;
}
