import { Types } from 'mongoose';
import { PricingRule, type PricingRuleDocument } from './pricing.rules.model.js';
import { Product, type ProductDocument } from '../products/products.model.js';
import { type PricingRuleListQuery } from './pricing.validation.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import {
  PRICING_RULE_LIST_DEFAULT_LIMIT,
  type PricingAdjustmentType,
  type PricingRuleSortableField,
  type PricingScope,
  type ClientType,
  type ProductType,
} from './pricing.types.js';

export interface PricingRuleListPagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface PricingRuleListResult {
  items: PricingRuleDto[];
  pagination: PricingRuleListPagination;
}

export interface PricingRuleDto {
  id: string;
  name: string;
  clientType: ClientType;
  scope: PricingScope;
  productType: ProductType | null;
  productId: string | null;
  adjustmentType: PricingAdjustmentType;
  adjustmentValue: number;
  priority: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface CreatePricingRuleArgs {
  name: string;
  clientType: ClientType;
  scope: PricingScope;
  productType?: ProductType | null;
  productId?: string | null;
  adjustmentType: PricingAdjustmentType;
  adjustmentValue: number;
  priority?: number;
  active?: boolean;
  createdBy?: string | null;
}

export interface UpdatePricingRuleArgs {
  name?: string;
  clientType?: ClientType;
  scope?: PricingScope;
  productType?: ProductType | null;
  productId?: string | null;
  adjustmentType?: PricingAdjustmentType;
  adjustmentValue?: number;
  priority?: number;
  active?: boolean;
  updatedBy?: string | null;
}

export function toPricingRuleDto(doc: PricingRuleDocument): PricingRuleDto {
  return {
    id: doc._id.toString(),
    name: doc.name,
    clientType: doc.clientType,
    scope: doc.scope,
    productType: doc.productType ?? null,
    productId: doc.productId ? doc.productId.toString() : null,
    adjustmentType: doc.adjustmentType,
    adjustmentValue: doc.adjustmentValue,
    priority: doc.priority,
    active: doc.active,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: doc.createdBy ? doc.createdBy.toString() : null,
    updatedBy: doc.updatedBy ? doc.updatedBy.toString() : null,
  };
}

function toObjectIdOrNull(value: string | null | undefined): Types.ObjectId | null {
  if (!value) return null;
  if (!Types.ObjectId.isValid(value)) return null;
  return new Types.ObjectId(value);
}

async function ensureValidTarget(
  scope: PricingScope,
  productType: ProductType | null | undefined,
  productId: string | null | undefined,
): Promise<{
  productType: ProductType | null;
  productId: Types.ObjectId | null;
}> {
  if (scope === 'ALL_PRODUCTS') {
    if (productType || productId) {
      throw new ValidationError(
        'Cuando scope es ALL_PRODUCTS no debe especificarse producto',
      );
    }
    return { productType: null, productId: null };
  }
  if (scope === 'PRODUCT_TYPE') {
    if (!productType) {
      throw new ValidationError(
        'Cuando scope es PRODUCT_TYPE debe especificar productType',
      );
    }
    if (productId) {
      throw new ValidationError(
        'Cuando scope es PRODUCT_TYPE no debe especificarse productId',
      );
    }
    return { productType, productId: null };
  }
  if (!productId) {
    throw new ValidationError(
      'Cuando scope es PRODUCT debe especificar productId',
    );
  }
  if (!Types.ObjectId.isValid(productId)) {
    throw new ValidationError('productId inválido');
  }
  const exists: ProductDocument | null = await Product.findById(productId);
  if (!exists) {
    throw new NotFoundError('Producto objetivo no encontrado');
  }
  return { productType: null, productId: new Types.ObjectId(productId) };
}

async function ensureNoConflict(
  args: {
    clientType: ClientType;
    scope: PricingScope;
    productType: ProductType | null;
    productId: Types.ObjectId | null;
    priority: number;
    active: boolean;
  },
  excludeId?: Types.ObjectId,
): Promise<void> {
  const filter: Record<string, unknown> = {
    clientType: args.clientType,
    scope: args.scope,
    productType: args.productType,
    productId: args.productId,
    priority: args.priority,
    active: args.active,
  };
  if (excludeId) {
    filter._id = { $ne: excludeId };
  }
  const conflict = await PricingRule.findOne(filter);
  if (conflict) {
    throw new ConflictError(
      'Ya existe una regla activa equivalente (clientType, scope, objetivo, prioridad)',
      {
        conflictingRuleId: conflict._id.toString(),
        conflictingRuleName: conflict.name,
      },
    );
  }
}

export async function listPricingRules(
  query: PricingRuleListQuery,
): Promise<PricingRuleListResult> {
  const page = 1;
  const limit = PRICING_RULE_LIST_DEFAULT_LIMIT;

  const filter: Record<string, unknown> = {};
  if (query.clientType) filter.clientType = query.clientType;
  if (query.scope) filter.scope = query.scope;
  if (query.productType) filter.productType = query.productType;
  if (query.productId) {
    if (!Types.ObjectId.isValid(query.productId)) {
      filter.productId = null;
    } else {
      filter.productId = new Types.ObjectId(query.productId);
    }
  }
  if (query.active !== undefined) filter.active = query.active;

  const sortField: PricingRuleSortableField = query.sortBy ?? 'priority';
  const sort: Record<string, 1 | -1> = {
    [sortField]: query.sortOrder === 'asc' ? 1 : -1,
  };
  if (sortField !== 'priority') sort.priority = -1;
  if (sortField !== 'name') sort.name = 1;

  const [docs, total] = await Promise.all([
    PricingRule.find(filter).sort(sort).skip((page - 1) * limit).limit(limit),
    PricingRule.countDocuments(filter),
  ]);

  const pages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;
  return {
    items: docs.map(toPricingRuleDto),
    pagination: { page, limit, total, pages },
  };
}

export async function findPricingRuleById(
  id: string,
): Promise<PricingRuleDocument | null> {
  if (!Types.ObjectId.isValid(id)) {
    return null;
  }
  return PricingRule.findById(id);
}

export async function getPricingRuleOrThrow(
  id: string,
): Promise<PricingRuleDocument> {
  const rule = await findPricingRuleById(id);
  if (!rule) {
    throw new NotFoundError('Regla no encontrada');
  }
  return rule;
}

export async function createPricingRule(
  args: CreatePricingRuleArgs,
): Promise<PricingRuleDocument> {
  const target = await ensureValidTarget(
    args.scope,
    args.productType,
    args.productId,
  );

  const active = args.active ?? true;
  const priority = args.priority ?? 0;

  await ensureNoConflict({
    clientType: args.clientType,
    scope: args.scope,
    productType: target.productType,
    productId: target.productId,
    priority,
    active,
  });

  const createdById =
    args.createdBy && Types.ObjectId.isValid(args.createdBy)
      ? new Types.ObjectId(args.createdBy)
      : null;

  return PricingRule.create({
    name: args.name,
    clientType: args.clientType,
    scope: args.scope,
    productType: target.productType,
    productId: target.productId,
    adjustmentType: args.adjustmentType,
    adjustmentValue: args.adjustmentValue,
    priority,
    active,
    createdBy: createdById,
    updatedBy: createdById,
  });
}

export async function updatePricingRule(
  id: string,
  args: UpdatePricingRuleArgs,
): Promise<PricingRuleDocument> {
  const rule = await getPricingRuleOrThrow(id);

  const nextScope = args.scope ?? rule.scope;
  const nextProductType =
    args.productType !== undefined ? args.productType : rule.productType ?? null;
  const nextProductId =
    args.productId !== undefined
      ? toObjectIdOrNull(args.productId)
      : rule.productId ?? null;

  let validatedTarget: {
    productType: ProductType | null;
    productId: Types.ObjectId | null;
  };
  try {
    validatedTarget = await ensureValidTarget(
      nextScope,
      nextProductType,
      args.productId !== undefined ? args.productId : nextProductId?.toString() ?? null,
    );
  } catch (err) {
    if (err instanceof ValidationError || err instanceof NotFoundError) {
      throw err;
    }
    throw err;
  }

  // Ensure target product still exists if PRODUCT scope
  if (nextScope === 'PRODUCT') {
    const exists = await Product.findById(validatedTarget.productId);
    if (!exists) {
      throw new NotFoundError('Producto objetivo no encontrado');
    }
  }

  const conflictActive = args.active ?? rule.active;
  const conflictPriority = args.priority ?? rule.priority;
  await ensureNoConflict(
    {
      clientType: args.clientType ?? rule.clientType,
      scope: nextScope,
      productType: validatedTarget.productType,
      productId: validatedTarget.productId,
      priority: conflictPriority,
      active: conflictActive,
    },
    rule._id,
  );

  if (args.name !== undefined) rule.name = args.name;
  if (args.clientType !== undefined) rule.clientType = args.clientType;
  if (args.scope !== undefined) rule.scope = args.scope;
  rule.productType = validatedTarget.productType;
  rule.productId = validatedTarget.productId;
  if (args.adjustmentType !== undefined) rule.adjustmentType = args.adjustmentType;
  if (args.adjustmentValue !== undefined) rule.adjustmentValue = args.adjustmentValue;
  if (args.priority !== undefined) rule.priority = args.priority;
  if (args.active !== undefined) rule.active = args.active;

  if (args.updatedBy && Types.ObjectId.isValid(args.updatedBy)) {
    rule.updatedBy = new Types.ObjectId(args.updatedBy);
  }

  await rule.save();
  return rule;
}

/**
 * Find active rules that apply to a (clientType, product) pair.
 *
 * Returns PRODUCT-specific, PRODUCT_TYPE-specific and ALL_PRODUCTS rules
 * (all of them). The Pricing Engine is responsible for selecting the most
 * specific.
 */
export async function findApplicableRules(
  clientType: ClientType,
  productType: ProductType,
  productId: Types.ObjectId,
): Promise<PricingRuleDocument[]> {
  return PricingRule.find({
    active: true,
    clientType,
    $or: [
      { scope: 'ALL_PRODUCTS' },
      { scope: 'PRODUCT_TYPE', productType },
      { scope: 'PRODUCT', productId },
    ],
  }).sort({ priority: -1, createdAt: 1 });
}
