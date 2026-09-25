import { Types } from 'mongoose';
import { Product, type ProductDocument } from './products.model.js';
import {
  PRODUCTS_LIST_DEFAULT_LIMIT,
  type ProductListQuery,
} from './products.validation.js';
import { ConflictError, NotFoundError } from '../../shared/errors.js';
import type { ProductType } from './products.types.js';

export interface ProductListPagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface ProductListResult {
  items: ProductDto[];
  pagination: ProductListPagination;
}

export interface ProductDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  productType: ProductType;
  basePriceMinor: number;
  tracksStock: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface CreateProductArgs {
  code: string;
  name: string;
  description?: string | null;
  productType: ProductType;
  basePriceMinor: number;
  tracksStock?: boolean;
  active?: boolean;
  createdBy?: string | null;
}

export interface UpdateProductArgs {
  code?: string;
  name?: string;
  description?: string | null;
  productType?: ProductType;
  basePriceMinor?: number;
  tracksStock?: boolean;
  active?: boolean;
  updatedBy?: string | null;
}

export function toProductDto(doc: ProductDocument): ProductDto {
  return {
    id: doc._id.toString(),
    code: doc.code,
    name: doc.name,
    description: doc.description ?? null,
    productType: doc.productType,
    basePriceMinor: doc.basePriceMinor,
    tracksStock: doc.tracksStock,
    active: doc.active,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: doc.createdBy ? doc.createdBy.toString() : null,
    updatedBy: doc.updatedBy ? doc.updatedBy.toString() : null,
  };
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchFilter(search: string | undefined) {
  if (!search) return undefined;
  const safe = escapeRegex(search);
  const re = new RegExp(safe, 'i');
  return {
    $or: [{ code: re }, { name: re }],
  };
}

const SEARCH_COLLATION = { locale: 'es', strength: 2 } as const;

export async function listProducts(
  query: ProductListQuery,
): Promise<ProductListResult> {
  const page = query.page ?? 1;
  const limit = query.limit ?? PRODUCTS_LIST_DEFAULT_LIMIT;

  const filter: Record<string, unknown> = {};
  if (query.productType) {
    filter.productType = query.productType;
  }
  if (query.active !== undefined) {
    filter.active = query.active;
  }
  const searchFilter = buildSearchFilter(query.search);
  if (searchFilter) {
    Object.assign(filter, searchFilter);
  }

  const sort: Record<string, 1 | -1> = {
    [query.sortBy]: query.sortOrder === 'desc' ? -1 : 1,
  };
  if (query.sortBy !== 'name') {
    sort.name = 1;
  }
  if (query.sortBy !== 'code') {
    sort.code = 1;
  }

  const [docs, total] = await Promise.all([
    Product.find(filter)
      .sort(sort)
      .collation(SEARCH_COLLATION)
      .skip((page - 1) * limit)
      .limit(limit),
    Product.countDocuments(filter),
  ]);

  const pages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;
  return {
    items: docs.map(toProductDto),
    pagination: { page, limit, total, pages },
  };
}

export async function findProductById(id: string): Promise<ProductDocument | null> {
  if (!Types.ObjectId.isValid(id)) {
    return null;
  }
  return Product.findById(id);
}

export async function getProductOrThrow(id: string): Promise<ProductDocument> {
  const product = await findProductById(id);
  if (!product) {
    throw new NotFoundError('Producto no encontrado');
  }
  return product;
}

export async function findProductByCode(
  code: string,
): Promise<ProductDocument | null> {
  return Product.findByCode(code);
}

export async function createProduct(
  args: CreateProductArgs,
): Promise<ProductDocument> {
  const existing = await Product.findByCode(args.code);
  if (existing) {
    throw new ConflictError('Ya existe un producto con ese código');
  }

  const createdById =
    args.createdBy && Types.ObjectId.isValid(args.createdBy)
      ? new Types.ObjectId(args.createdBy)
      : null;

  return Product.create({
    code: args.code,
    name: args.name,
    description: args.description ?? null,
    productType: args.productType,
    basePriceMinor: args.basePriceMinor,
    tracksStock: args.tracksStock ?? false,
    active: args.active ?? true,
    createdBy: createdById,
    updatedBy: createdById,
  });
}

export async function updateProduct(
  id: string,
  args: UpdateProductArgs,
): Promise<ProductDocument> {
  const product = await getProductOrThrow(id);

  if (args.code && args.code !== product.code) {
    const conflict = await Product.findOne({
      _id: { $ne: product._id },
      code: args.code,
    });
    if (conflict) {
      throw new ConflictError('Ya existe un producto con ese código');
    }
  }

  if (args.code !== undefined) product.code = args.code;
  if (args.name !== undefined) product.name = args.name;
  if (args.description !== undefined) product.description = args.description;
  if (args.productType !== undefined) product.productType = args.productType;
  if (args.basePriceMinor !== undefined) {
    product.basePriceMinor = args.basePriceMinor;
  }
  if (args.tracksStock !== undefined) {
    product.tracksStock = args.tracksStock;
  }
  if (args.active !== undefined) product.active = args.active;

  if (args.updatedBy && Types.ObjectId.isValid(args.updatedBy)) {
    product.updatedBy = new Types.ObjectId(args.updatedBy);
  }

  await product.save();
  return product;
}
