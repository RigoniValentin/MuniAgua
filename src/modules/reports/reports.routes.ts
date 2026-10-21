import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { requirePermission } from '../../middlewares/authorize.js';
import { PERMISSIONS } from '../users/users.types.js';
import {
  downloadPeriodReportXlsxController,
  getPeriodReportController,
  getReportDriversController,
} from './reports.controller.js';

const router = Router();
router.use(authenticate);

router.get(
  '/available-drivers',
  requirePermission(PERMISSIONS.ORDERS_READ),
  getReportDriversController,
);

router.get(
  '/period',
  requirePermission(PERMISSIONS.ORDERS_READ),
  getPeriodReportController,
);

router.get(
  '/period.xlsx',
  requirePermission(PERMISSIONS.ORDERS_READ),
  downloadPeriodReportXlsxController,
);

export default router;
