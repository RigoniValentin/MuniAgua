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
  quantity: number;
  unitBasePriceMinor: number;
  appliedRule: AppliedRuleSnapshot | null;
  adjustmentPercentage: number;
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
