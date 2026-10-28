/**
 * Matriz de precios: productos × tipos de cliente.
 *
 * Es la vista operativa que usa el administrador para cargar precios
 * EXACTOS por tipo de cliente (porcentaje o importe fijo) y para revisar
 * de un vistazo el precio vigente de cada producto.
 *
 * Toda la maths vive en `pricing.resolve.ts`; este módulo solo arma la
 * grilla y persiste los cambios.
 */

import { Types } from 'mongoose';
import { Product, type ProductDocument } from '../products/products.model.js';
import { PricingRule, type PricingRuleDocument } from './pricing.rules.model.js';
import { resolveUnitPrice } from './pricing.resolve.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { ALL_CLIENT_TYPES, type ClientType } from '../clients/clients.types.js';
import type { ProductType } from '../products/products.types.js';
import {
  PRICE_MATRIX_LIST_DEFAULT_LIMIT,
  PRICE_MATRIX_LIST_MAX_LIMIT,
  PRICE_MATRIX_MAX_UPDATES,
  type PriceSource,
} from './pricing.types.js';

export {
  PRICE_MATRIX_LIST_DEFAULT_LIMIT,
  PRICE_MATRIX_LIST_MAX_LIMIT,
  PRICE_MATRIX_MAX_UPDATES,
};

export interface PriceMatrixQuery {
  search?: string;
  productType?: ProductType;
  active?: boolean;
  page: number;
  limit: number;
}

export interface PriceMatrixCell {
  clientType: ClientType;
  /** Precio final vigente (minor units). */
  priceMinor: number;
  /** De dónde sale el precio. */
  source: PriceSource;
  /** Margen real del precio respecto del precio base. */
  impliedPercentage: number;
  /** Regla que se aplicaría si no hubiera precio fijo. */
  ruleId: string | null;
  ruleName: string | null;
  /**
   * Precio que se cobraría siguiendo el porcentaje de la regla, sin el
   * precio exacto cargado. Sirve para previsualizar "volver al %".
   */
  rulePriceMinor: number | null;
  /** Hay un precio exacto cargado para este tipo de cliente. */
  hasFixedPrice: boolean;
  /** Precio exacto cargado (si hay). */
  fixedPriceMinor: number | null;
  /**
   * El precio base cambió después de que se cargó el precio exacto.
   * El precio NO se modifica solo: hay que revisarlo.
   */
  stale: boolean;
}

export interface PriceMatrixRow {
  productId: string;
  productCode: string;
  productName: string;
  productType: ProductType;
  basePriceMinor: number;
  active: boolean;
  cells: PriceMatrixCell[];
}

export interface PriceMatrixResult {
  items: PriceMatrixRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface PriceMatrixUpdateItem {
  productId: string;
  clientType: ClientType;
  /** Precio exacto a cargar; `null` borra el precio fijo y vuelve al %. */
  priceMinor: number | null;
}

export interface PriceMatrixUpdateResult {
  updated: number;
  items: Array<{
    productId: string;
    clientType: ClientType;
    priceMinor: number | null;
  }>;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchFilter(search: string | undefined) {
  if (!search) return undefined;
  const safe = escapeRegex(search);
  const re = new RegExp(safe, 'i');
  return { $or: [{ code: re }, { name: re }] };
}

const SEARCH_COLLATION = { locale: 'es', strength: 2 } as const;

/**
 * Reglas que pueden aplicar a un producto, para un tipo de cliente dado.
 */
function rulesForProduct(
  rulesByClientType: Map<ClientType, PricingRuleDocument[]>,
  clientType: ClientType,
  product: Pick<ProductDocument, 'productType' | '_id'>,
): PricingRuleDocument[] {
  const rules = rulesByClientType.get(clientType) ?? [];
  const productId = product._id.toString();
  return rules.filter((rule) => {
    if (rule.scope === 'ALL_PRODUCTS') return true;
    if (rule.scope === 'PRODUCT_TYPE') return rule.productType === product.productType;
    if (rule.scope === 'PRODUCT') {
      return rule.productId ? rule.productId.toString() === productId : false;
    }
    return false;
  });
}

function buildCell(args: {
  product: ProductDocument;
  clientType: ClientType;
  rules: PricingRuleDocument[];
}): PriceMatrixCell {
  const { product, clientType, rules } = args;
  const resolved = resolveUnitPrice({ product, clientType, rules });
  const fixed = resolved.fixedPrice;

  // Precio que se cobraría si NO hubiera precio exacto (solo regla % / base).
  const withoutFixed = resolveUnitPrice({
    product: { basePriceMinor: product.basePriceMinor, clientTypePrices: [] },
    clientType,
    rules,
  });

  return {
    clientType,
    priceMinor: resolved.priceMinor,
    source: resolved.source,
    impliedPercentage: resolved.impliedPercentage,
    ruleId: resolved.appliedRule ? resolved.appliedRule._id.toString() : null,
    ruleName: resolved.appliedRule ? resolved.appliedRule.name : null,
    rulePriceMinor:
      withoutFixed.source === 'PERCENTAGE' ? withoutFixed.priceMinor : null,
    hasFixedPrice: Boolean(fixed),
    fixedPriceMinor: fixed ? fixed.priceMinor : null,
    stale: fixed ? fixed.basePriceMinorAtSet !== product.basePriceMinor : false,
  };
}

/**
 * Arma la grilla de precios: una fila por producto, una celda por tipo
 * de cliente.
 */
export async function buildPriceMatrix(
  query: PriceMatrixQuery,
): Promise<PriceMatrixResult> {
  const page = query.page;
  const limit = query.limit;

  const filter: Record<string, unknown> = {};
  if (query.productType) filter.productType = query.productType;
  if (query.active !== undefined) filter.active = query.active;
  const searchFilter = buildSearchFilter(query.search);
  if (searchFilter) Object.assign(filter, searchFilter);

  const [products, total, allRules] = await Promise.all([
    Product.find(filter)
      .sort({ name: 1, code: 1 })
      .collation(SEARCH_COLLATION)
      .skip((page - 1) * limit)
      .limit(limit),
    Product.countDocuments(filter),
    PricingRule.find({ active: true }),
  ]);

  const rulesByClientType = new Map<ClientType, PricingRuleDocument[]>();
  for (const clientType of ALL_CLIENT_TYPES) {
    rulesByClientType.set(clientType, []);
  }
  for (const rule of allRules) {
    const bucket = rulesByClientType.get(rule.clientType);
    if (bucket) bucket.push(rule);
  }

  const items: PriceMatrixRow[] = products.map((product) => ({
    productId: product._id.toString(),
    productCode: product.code,
    productName: product.name,
    productType: product.productType,
    basePriceMinor: product.basePriceMinor,
    active: product.active,
    cells: ALL_CLIENT_TYPES.map((clientType) => {
      if (clientType === 'LOCAL') {
        // El precio base ES el precio local: no admite precio fijo.
        return {
          clientType,
          priceMinor: product.basePriceMinor,
          source: 'BASE' as PriceSource,
          impliedPercentage: 0,
          ruleId: null,
          ruleName: null,
          rulePriceMinor: null,
          hasFixedPrice: false,
          fixedPriceMinor: null,
          stale: false,
        };
      }
      return buildCell({
        product,
        clientType,
        rules: rulesForProduct(rulesByClientType, clientType, product),
      });
    }),
  }));

  const pages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;
  return {
    items,
    pagination: { page, limit, total, pages },
  };
}

/**
 * Aplica cambios de la matriz.
 *
 * Semántica por celda (no reemplaza arrays):
 *   - LOCAL: actualiza el precio base del producto (el precio local).
 *   - otro tipo de cliente con precio: carga/sella el precio exacto.
 *   - otro tipo de cliente con `null`: borra el precio exacto y vuelve al %.
 *
 * Los precios exactos que NO vienen en el payload no se tocan, así que un
 * cambio de precio base los deja marcados como "desactualizados" en vez de
 * moverlos por debajo de la mesa.
 */
export async function updatePriceMatrix(
  items: PriceMatrixUpdateItem[],
  updatedBy?: string | null,
): Promise<PriceMatrixUpdateResult> {
  if (items.length === 0) {
    throw new ValidationError('No hay cambios para guardar');
  }
  if (items.length > PRICE_MATRIX_MAX_UPDATES) {
    throw new ValidationError(
      `Máximo ${PRICE_MATRIX_MAX_UPDATES} cambios por operación`,
    );
  }

  const byProduct = new Map<string, PriceMatrixUpdateItem[]>();
  for (const item of items) {
    const bucket = byProduct.get(item.productId);
    if (bucket) bucket.push(item);
    else byProduct.set(item.productId, [item]);
  }

  const productIds = [...byProduct.keys()];
  const products = await Product.find({ _id: { $in: productIds } });
  const byId = new Map<string, ProductDocument>(
    products.map((p) => [p._id.toString(), p]),
  );

  // Se validan TODOS los productos antes de aplicar nada: si uno no existe,
  // no se aplica ningún cambio (no hay aplicación parcial).
  for (const productId of productIds) {
    if (!byId.has(productId)) {
      throw new NotFoundError(`Producto no encontrado: ${productId}`);
    }
  }

  const updatedById =
    updatedBy && Types.ObjectId.isValid(updatedBy)
      ? new Types.ObjectId(updatedBy)
      : null;

  const applied: PriceMatrixUpdateResult['items'] = [];

  for (const productId of productIds) {
    const product = byId.get(productId)!;
    const productItems = byProduct.get(productId) ?? [];

    // 1) El precio local (columna LOCAL) es el precio base.
    const localItems = productItems.filter((i) => i.clientType === 'LOCAL');
    for (const item of localItems) {
      if (item.priceMinor === null) {
        throw new ValidationError(
          'El precio base no puede vaciarse',
        );
      }
      product.basePriceMinor = item.priceMinor;
    }

    // 2) Precios exactos del resto de los tipos de cliente.
    const fixedItems = productItems.filter((i) => i.clientType !== 'LOCAL');
    for (const item of fixedItems) {
      const current = product.clientTypePrices ?? [];
      const others = current.filter(
        (price) => price.clientType !== item.clientType,
      );
      if (item.priceMinor === null) {
        product.clientTypePrices = others;
      } else {
        product.clientTypePrices = [
          ...others,
          {
            clientType: item.clientType,
            priceMinor: item.priceMinor,
            basePriceMinorAtSet: product.basePriceMinor,
          },
        ];
      }
    }

    if (updatedById) product.updatedBy = updatedById;
    await product.save();

    for (const item of productItems) {
      applied.push({
        productId: item.productId,
        clientType: item.clientType,
        priceMinor: item.priceMinor,
      });
    }
  }

  return { updated: applied.length, items: applied };
}
