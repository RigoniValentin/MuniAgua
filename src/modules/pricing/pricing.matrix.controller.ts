import type { Request, Response } from 'express';
import {
  priceMatrixQuerySchema,
  priceMatrixUpdateSchema,
} from './pricing.validation.js';
import {
  buildPriceMatrix,
  updatePriceMatrix,
} from './pricing.matrix.service.js';
import { ok } from '../../shared/api-response.js';
import { asyncHandler } from '../../middlewares/error.js';

export const getPriceMatrixController = asyncHandler(
  async (req: Request, res: Response) => {
    const query = priceMatrixQuerySchema.parse(req.query);
    const result = await buildPriceMatrix({
      search: query.search,
      productType: query.productType,
      active: query.active,
      page: query.page,
      limit: query.limit,
    });
    res.json(ok(result));
  },
);

export const updatePriceMatrixController = asyncHandler(
  async (req: Request, res: Response) => {
    const data = priceMatrixUpdateSchema.parse(req.body);
    const updatedBy = req.user?.id ?? null;
    const result = await updatePriceMatrix(data.items, updatedBy);
    res.json(ok(result));
  },
);
