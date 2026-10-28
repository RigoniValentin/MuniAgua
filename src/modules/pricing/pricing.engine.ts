import { Types } from 'mongoose';
import { Client, type ClientDocument } from '../clients/clients.model.js';
import { Product, type ProductDocument } from '../products/products.model.js';
import type { PricingRuleDocument } from './pricing.rules.model.js';
import { findApplicableRules } from './pricing.rules.service.js';
import { pickBestRule, resolveUnitPrice } from './pricing.resolve.js';
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

export { pickBestRule };

export interface QuoteRequestItem {
  productId: string;
  quantity: number;
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
  clientType: ClientType;
  rules: PricingRuleDocument[];
}): QuoteLineItem {
  const { product, quantity, clientType, rules } = args;

  const unitBasePriceMinor = product.basePriceMinor;
  const resolved = resolveUnitPrice({ product, clientType, rules });

  const subtotalBaseMinor = unitBasePriceMinor * quantity;
  const subtotalFinalMinor = resolved.priceMinor * quantity;

  return {
    productId: product._id.toString(),
    productCode: product.code,
    productName: product.name,
    productType: product.productType,
    clientType,
    quantity,
    unitBasePriceMinor,
    appliedRule: resolved.appliedRule
      ? toAppliedRuleSnapshot(resolved.appliedRule)
      : null,
    adjustmentPercentage: resolved.impliedPercentage,
    priceSource: resolved.source,
    unitFinalPriceMinor: resolved.priceMinor,
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
    lineItems.push(
      computeLineItem({
        product,
        quantity: item.quantity,
        clientType: client.clientType,
        rules,
      }),
    );
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
