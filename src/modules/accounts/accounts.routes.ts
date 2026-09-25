import { Router } from 'express';
import {
  createAdjustmentController,
  getClientSummaryController,
  getSelfSummaryController,
  listAccountsController,
  listClientMovementsController,
  listSelfMovementsController,
  reverseMovementController,
} from './accounts.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { requirePermission } from '../../middlewares/authorize.js';
import { PERMISSIONS } from '../users/users.types.js';

const router = Router();

router.use(authenticate);

// IMPORTANT: /me/* routes MUST be registered BEFORE any /:clientId wildcard so
// Express never interprets "me" as an ObjectId.
router.get(
  '/me/summary',
  requirePermission(PERMISSIONS.ACCOUNTS_SELF),
  getSelfSummaryController,
);
router.get(
  '/me/movements',
  requirePermission(PERMISSIONS.ACCOUNTS_SELF),
  listSelfMovementsController,
);

// Staff list with per-client summary.
router.get(
  '/',
  requirePermission(PERMISSIONS.ACCOUNTS_READ),
  listAccountsController,
);

// Staff — per-client detail.
router.get(
  '/:clientId/summary',
  requirePermission(PERMISSIONS.ACCOUNTS_READ),
  getClientSummaryController,
);
router.get(
  '/:clientId/movements',
  requirePermission(PERMISSIONS.ACCOUNTS_READ),
  listClientMovementsController,
);
router.post(
  '/:clientId/adjustments',
  requirePermission(PERMISSIONS.ACCOUNTS_ADJUST),
  createAdjustmentController,
);

// Staff — reversal of a single movement (no clientId in path).
router.post(
  '/movements/:movementId/reverse',
  requirePermission(PERMISSIONS.ACCOUNTS_REVERSE),
  reverseMovementController,
);

export default router;
