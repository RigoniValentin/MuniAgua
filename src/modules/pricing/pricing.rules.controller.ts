import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import {
  createPricingRuleSchema,
  pricingRuleListQuerySchema,
  updatePricingRuleSchema,
} from './pricing.validation.js';
import {
  createPricingRule,
  getPricingRuleOrThrow,
  listPricingRules,
  toPricingRuleDto,
  updatePricingRule,
} from './pricing.rules.service.js';
import { ok } from '../../shared/api-response.js';
import { asyncHandler } from '../../middlewares/error.js';
import { ValidationError } from '../../shared/errors.js';

export const listPricingRulesController = asyncHandler(
  async (req: Request, res: Response) => {
    const query = pricingRuleListQuerySchema.parse(req.query);
    const result = await listPricingRules(query);
    res.json(ok(result));
  },
);

export const getPricingRuleController = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) {
      throw new ValidationError('Identificador requerido');
    }
    if (!Types.ObjectId.isValid(id)) {
      throw new ValidationError('Identificador de regla inválido');
    }
    const rule = await getPricingRuleOrThrow(id);
    res.json(ok({ rule: toPricingRuleDto(rule) }));
  },
);

export const createPricingRuleController = asyncHandler(
  async (req: Request, res: Response) => {
    const data = createPricingRuleSchema.parse(req.body);
    const createdBy = req.user?.id ?? null;
    const rule = await createPricingRule({ ...data, createdBy });
    res.status(201).json(ok({ rule: toPricingRuleDto(rule) }));
  },
);

export const updatePricingRuleController = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) {
      throw new ValidationError('Identificador requerido');
    }
    if (!Types.ObjectId.isValid(id)) {
      throw new ValidationError('Identificador de regla inválido');
    }
    const data = updatePricingRuleSchema.parse(req.body);
    const updatedBy = req.user?.id ?? null;
    const rule = await updatePricingRule(id, { ...data, updatedBy });
    res.json(ok({ rule: toPricingRuleDto(rule) }));
  },
);
