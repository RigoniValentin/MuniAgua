export const PRODUCT_TYPES = {
  WATER_REFILL: 'WATER_REFILL',
  CONTAINER: 'CONTAINER',
  DISPENSER: 'DISPENSER',
  OTHER: 'OTHER',
} as const;

export type ProductType = (typeof PRODUCT_TYPES)[keyof typeof PRODUCT_TYPES];

export const ALL_PRODUCT_TYPES: ProductType[] = Object.values(PRODUCT_TYPES);

export interface ProductTypeMeta {
  value: ProductType;
  label: string;
  description: string;
}

export const PRODUCT_TYPE_META: Record<ProductType, ProductTypeMeta> = {
  WATER_REFILL: {
    value: 'WATER_REFILL',
    label: 'Recarga de agua',
    description: 'Recarga de agua por bidón del cliente',
  },
  CONTAINER: {
    value: 'CONTAINER',
    label: 'Bidón',
    description: 'Envase retornable / bidón',
  },
  DISPENSER: {
    value: 'DISPENSER',
    label: 'Dispenser',
    description: 'Dispensador de agua',
  },
  OTHER: {
    value: 'OTHER',
    label: 'Otro',
    description: 'Otro producto o servicio',
  },
};

export const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  WATER_REFILL: PRODUCT_TYPE_META.WATER_REFILL.label,
  CONTAINER: PRODUCT_TYPE_META.CONTAINER.label,
  DISPENSER: PRODUCT_TYPE_META.DISPENSER.label,
  OTHER: PRODUCT_TYPE_META.OTHER.label,
};

export const SORTABLE_PRODUCT_FIELDS = [
  'code',
  'name',
  'productType',
  'basePriceMinor',
  'createdAt',
  'updatedAt',
] as const;

export type ProductSortableField = (typeof SORTABLE_PRODUCT_FIELDS)[number];

export const DEFAULT_PRODUCT_SORT_FIELD: ProductSortableField = 'name';
export const DEFAULT_PRODUCT_SORT_ORDER: 'asc' | 'desc' = 'asc';

/**
 * Maximum defensive base price in minor units (10 million ARS).
 */
export const MAX_BASE_PRICE_MINOR = 10_000_000 * 100;
