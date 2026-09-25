import { Router } from 'express';
import {
  createPricingRuleController,
  getPricingRuleController,
  listPricingRulesController,
  updatePricingRuleController,
} from './pricing.rules.controller.js';
import { quoteController } from './pricing.quote.controller.js';
import { selfQuoteController } from './pricing.me.quote.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { requirePermission } from '../../middlewares/authorize.js';
import { PERMISSIONS } from '../users/users.types.js';

const router = Router();

router.use(authenticate);

// IMPORTANT: /me/quote MUST be registered before any /:id wildcard so
// Express never interprets "me" as an ObjectId.
router.post(
  '/me/quote',
  requirePermission(PERMISSIONS.PRICING_QUOTE),
  selfQuoteController,
);

router.get('/rules', requirePermission(PERMISSIONS.PRICING_READ), listPricingRulesController);
router.get('/rules/:id', requirePermission(PERMISSIONS.PRICING_READ), getPricingRuleController);
router.post('/rules', requirePermission(PERMISSIONS.PRICING_MANAGE), createPricingRuleController);
router.patch('/rules/:id', requirePermission(PERMISSIONS.PRICING_MANAGE), updatePricingRuleController);

router.post('/quote', requirePermission(PERMISSIONS.PRICING_QUOTE), quoteController);

export default router;