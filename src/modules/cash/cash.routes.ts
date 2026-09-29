import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { requirePermission } from '../../middlewares/authorize.js';
import { PERMISSIONS } from '../users/users.types.js';
import {
  aggregateCashByClientController,
  aggregateCashByDriverController,
  getClientCashSummaryController,
  getMyCashSummaryController,
  getMyDriverCashSummaryController,
  listAllCashMovementsController,
  listClientCashMovementsController,
  listMyCashMovementsController,
  listMyDriverCashMovementsController,
} from './cash.controller.js';

const router = Router();
router.use(authenticate);

// ---------- Citizen ----------
router.get(
  '/me/summary',
  requirePermission(PERMISSIONS.CASH_SELF),
  getMyCashSummaryController,
);
router.get(
  '/me/movements',
  requirePermission(PERMISSIONS.CASH_SELF),
  listMyCashMovementsController,
);

// ---------- Admin ----------
// IMPORTANT: register `/admin/aggregate/*` BEFORE `/admin/clients/:id/*`
// so the literal segments win over the dynamic `:id`.
router.get(
  '/admin/aggregate/by-client',
  requirePermission(PERMISSIONS.CASH_READ),
  aggregateCashByClientController,
);
router.get(
  '/admin/aggregate/by-driver',
  requirePermission(PERMISSIONS.CASH_READ),
  aggregateCashByDriverController,
);
router.get(
  '/admin/movements',
  requirePermission(PERMISSIONS.CASH_READ),
  listAllCashMovementsController,
);
router.get(
  '/admin/clients/:clientId/summary',
  requirePermission(PERMISSIONS.CASH_READ),
  getClientCashSummaryController,
);
router.get(
  '/admin/clients/:clientId/movements',
  requirePermission(PERMISSIONS.CASH_READ),
  listClientCashMovementsController,
);

// ---------- Driver self ----------
router.get(
  '/driver/me/summary',
  requirePermission(PERMISSIONS.CASH_READ),
  getMyDriverCashSummaryController,
);
router.get(
  '/driver/me/movements',
  requirePermission(PERMISSIONS.CASH_READ),
  listMyDriverCashMovementsController,
);

export default router;