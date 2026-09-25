import { Types } from 'mongoose';
import { Client, type ClientDocument } from '../clients/clients.model.js';
import { Product, type ProductDocument } from '../products/products.model.js';
import type { PricingRuleDocument } from './pricing.rules.model.js';
import { findApplicableRules } from './pricing.rules.service.js';
import { computeAdjustment } from '../../shared/money.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors.js';
import type {
  AppliedRuleSnapshot,
  QuoteLineItem,
  QuoteResult,
  QuoteTotals,
  PricingScope,
  ClientType,
  ProductType,
} from './pricing.types.js';

const SPECIFICITY_RANK: Record<PricingScope, number> = {
  PRODUCT: 3,
  PRODUCT_TYPE: 2,
  ALL_PRODUCTS: 1,
};

export interface QuoteRequestItem {
  productId: string;
  quantity: number;
}

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

function toAppliedRuleSnapshot(
  rule: PricingRuleDocument,
): AppliedRuleSnapshot {
  return {
    id: rule._id.toString(),
    name: rule.name,
    scope: rule.scope,
    clientType: rule.clientType,
    productType: rule.productType ?? null,
    productId: rule.productId ? rule.productId.toString() : null,
    adjustmentType: rule.adjustmentType,
    adjustmentValue: rule.adjustmentValue,
    priority: rule.priority,
  };
}

/**
 * Compute a line item price for a (product, quantity, clientType) tuple
 * given an already-resolved rule list. Pure function (no DB) — used by tests.
 */
export function computeLineItem(args: {
  product: ProductDocument;
  quantity: number;
  rules: PricingRuleDocument[];
}): QuoteLineItem {
  const { product, quantity, rules } = args;
  const rule = pickBestRule(rules);

  const unitBasePriceMinor = product.basePriceMinor;
  const adjustmentPercentage = rule ? rule.adjustmentValue : 0;

  let unitFinalPriceMinor = unitBasePriceMinor;

  if (rule) {
    const computed = computeAdjustment(unitBasePriceMinor, rule.adjustmentValue);
    unitFinalPriceMinor = computed.finalMinor;
  }

  const subtotalBaseMinor = unitBasePriceMinor * quantity;
  const subtotalFinalMinor = unitFinalPriceMinor * quantity;

  return {
    productId: product._id.toString(),
    productCode: product.code,
    productName: product.name,
    productType: product.productType,
    quantity,
    unitBasePriceMinor,
    appliedRule: rule ? toAppliedRuleSnapshot(rule) : null,
    adjustmentPercentage,
    unitFinalPriceMinor,
    subtotalBaseMinor,
    subtotalFinalMinor,
  };
}

function computeTotals(items: QuoteLineItem[]): QuoteTotals {
  let base = 0;
  let final = 0;
  for (const item of items) {
    base += item.subtotalBaseMinor;
    final += item.subtotalFinalMinor;
  }
  return {
    baseMinor: base,
    finalMinor: final,
    adjustmentMinor: final - base,
  };
}

/**
 * Build a full quote. Loads client + products + rules from the database.
 */
export async function buildQuote(
  clientId: string,
  items: QuoteRequestItem[],
): Promise<QuoteResult> {
  if (!Types.ObjectId.isValid(clientId)) {
    throw new ValidationError('Identificador de cliente inválido');
  }
  for (const item of items) {
    if (!Types.ObjectId.isValid(item.productId)) {
      throw new ValidationError('Identificador de producto inválido');
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new ValidationError('La cantidad debe ser un entero positivo');
    }
  }

  const client: ClientDocument | null = await Client.findById(clientId);
  if (!client) {
    throw new NotFoundError('Cliente no encontrado');
  }
  if (!client.active) {
    throw new ValidationError('El cliente está inactivo y no puede cotizarse');
  }

  const productIds = items.map((i) => new Types.ObjectId(i.productId));
  const products = await Product.find({ _id: { $in: productIds } });
  const productMap = new Map<string, ProductDocument>(
    products.map((p) => [p._id.toString(), p]),
  );

  const lineItems: QuoteLineItem[] = [];
  for (const item of items) {
    const product = productMap.get(item.productId);
    if (!product) {
      throw new NotFoundError(`Producto no encontrado: ${item.productId}`);
    }
    if (!product.active) {
      throw new ValidationError(
        `El producto "${product.name}" está inactivo y no puede cotizarse`,
      );
    }
    const rules = await findApplicableRules(
      client.clientType,
      product.productType,
      product._id,
    );
    lineItems.push(computeLineItem({ product, quantity: item.quantity, rules }));
  }

  const totals = computeTotals(lineItems);

  const fullName = `${client.firstName} ${client.lastName}`.trim();

  return {
    client: {
      id: client._id.toString(),
      name: fullName,
      clientType: client.clientType,
      active: client.active,
      hasUserAccount: Boolean(client.userId),
    },
    items: lineItems,
    totals,
  };
}

/**
 * Ensure a citizen is allowed to quote the given client.
 * Returns the loaded client document if allowed.
 */
export async function ensureClientQuoteAccess(
  user: { id: string; role: string; permissions: string[] } | undefined,
  clientId: string,
): Promise<ClientDocument> {
  if (!user) {
    throw new NotFoundError('Cliente no encontrado');
  }
  if (!Types.ObjectId.isValid(clientId)) {
    throw new ValidationError('Identificador de cliente inválido');
  }
  const client: ClientDocument | null = await Client.findById(clientId);
  if (!client) {
    throw new NotFoundError('Cliente no encontrado');
  }

  if (user.role === 'CIUDADANO') {
    if (!client.userId) {
      throw new ForbiddenError(
        'El ciudadano no está vinculado a este cliente',
      );
    }
    if (client.userId.toString() !== user.id) {
      throw new ForbiddenError(
        'El ciudadano no tiene acceso a este cliente',
      );
    }
  }

  return client;
}

export type { ClientType, ProductType, PricingScope };
