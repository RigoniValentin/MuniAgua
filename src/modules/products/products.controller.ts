import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import {
  createProductSchema,
  productListQuerySchema,
  updateProductSchema,
} from './products.validation.js';
import {
  createProduct,
  getProductOrThrow,
  listProducts,
  toProductDto,
  updateProduct,
} from './products.service.js';
import { ok } from '../../shared/api-response.js';
import { asyncHandler } from '../../middlewares/error.js';
import { ValidationError } from '../../shared/errors.js';

export const listProductsController = asyncHandler(
  async (req: Request, res: Response) => {
    const query = productListQuerySchema.parse(req.query);
    const result = await listProducts(query);
    res.json(ok(result));
  },
);

export const getProductController = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) {
      throw new ValidationError('Identificador requerido');
    }
    if (!Types.ObjectId.isValid(id)) {
      throw new ValidationError('Identificador de producto inválido');
    }
    const product = await getProductOrThrow(id);
    res.json(ok({ product: toProductDto(product) }));
  },
);

export const createProductController = asyncHandler(
  async (req: Request, res: Response) => {
    const data = createProductSchema.parse(req.body);
    const createdBy = req.user?.id ?? null;
    const product = await createProduct({ ...data, createdBy });
    res.status(201).json(ok({ product: toProductDto(product) }));
  },
);

export const updateProductController = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) {
      throw new ValidationError('Identificador requerido');
    }
    if (!Types.ObjectId.isValid(id)) {
      throw new ValidationError('Identificador de producto inválido');
    }
    const data = updateProductSchema.parse(req.body);
    const updatedBy = req.user?.id ?? null;
    const product = await updateProduct(id, { ...data, updatedBy });
    res.json(ok({ product: toProductDto(product) }));
  },
);
