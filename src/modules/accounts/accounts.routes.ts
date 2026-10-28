import { Router } from 'express';
import {
  createAdjustmentController,
  createDriverAdjustmentController,
  getClientSummaryController,
  getSelfSummaryController,
  listAccountsController,
  listClientMovementsController,
  listMyDriverMovementsController,
  listSelfMovementsController,
  reverseMovementController,
} from './accounts.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { requirePermission } from '../../middlewares/authorize.js';
import { driverAdjustmentLimiter } from '../../middlewares/rate-limit.js';
import { PERMISSIONS } from '../users/users.types.js';

const router = Router();

router.use(authenticate);

// IMPORTANT: /me/* and /driver/* routes MUST be registered BEFORE any
// /:clientId wildcard so Express never interprets "me" or "driver" as an
// ObjectId.
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

// Repartidor — sus propios ajustes (siempre acotados a su propio user id).
router.get(
  '/driver/me/movements',
  requirePermission(PERMISSIONS.ACCOUNTS_READ),
  listMyDriverMovementsController,
);

// Repartidor — ajuste manual de cuenta corriente (cobro en el domicilio).
// Uses its own permission on purpose: the repartidor must never reach the
// admin adjustment flow (`accounts.adjust`), and the ledger must be able to
// tell both origins apart (`DRIVER_ADJUSTMENT` vs `MANUAL_ADJUSTMENT`).
router.post(
  '/driver/:clientId/adjustments',
  requirePermission(PERMISSIONS.ACCOUNTS_DRIVER_ADJUST),
  driverAdjustmentLimiter,
  createDriverAdjustmentController,
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
