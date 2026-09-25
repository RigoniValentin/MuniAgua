import type { Request, Response } from 'express';
import { quoteRequestSchema } from './pricing.validation.js';
import { buildQuote, ensureClientQuoteAccess } from './pricing.engine.js';
import { ok } from '../../shared/api-response.js';
import { asyncHandler } from '../../middlewares/error.js';

export const quoteController = asyncHandler(
  async (req: Request, res: Response) => {
    const data = quoteRequestSchema.parse(req.body);
    await ensureClientQuoteAccess(req.user, data.clientId);
    const result = await buildQuote(data.clientId, data.items);
    res.json(ok(result));
  },
);
