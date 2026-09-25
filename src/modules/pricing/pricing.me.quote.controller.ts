import type { Request, Response } from 'express';
import { selfQuoteRequestSchema } from './pricing.validation.js';
import { buildQuote, ensureClientQuoteAccess } from './pricing.engine.js';
import { findClientByUserId } from '../clients/clients.service.js';
import { ClientNotLinkedError } from '../clients/clients.service.js';
import { ok } from '../../shared/api-response.js';
import { asyncHandler } from '../../middlewares/error.js';
import { ValidationError } from '../../shared/errors.js';

/**
 * Citizen self-quote.
 *
 * - The endpoint NEVER accepts a clientId from the request body/query.
 * - The authenticated User MUST be linked to a Client.
 * - The resolved Client is passed to the existing Pricing Engine so the
 *   quote computation (rules, products, etc.) is unchanged.
 */
export const selfQuoteController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      throw new ValidationError('No autenticado');
    }

    const data = selfQuoteRequestSchema.parse(req.body);

    const client = await findClientByUserId(userId);
    if (!client) {
      throw new ClientNotLinkedError();
    }

    // Re-use the existing ownership/access helper for safety: it ensures the
    // user is linked to this client before pricing is computed.
    await ensureClientQuoteAccess(req.user, client._id.toString());

    const result = await buildQuote(client._id.toString(), data.items);
    res.json(ok(result));
  },
);