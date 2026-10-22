import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { requirePermission } from '../../middlewares/authorize.js';
import { PERMISSIONS } from '../users/users.types.js';
import {
  claimMyDeliveryController,
  createDirectOrderController,
  deliverMyOrderController,
  getMyDeliveryController,
  listMyDeliveriesController,
  startMyDeliveryController,
} from './orders.controller.js';
import {
  downloadMyHistoryXlsxController,
  getMyHistoryController,
} from '../driver-history/driver-history.controller.js';

const router = Router();
router.use(authenticate);

// Movement history for the authenticated repartidor. Always scoped to
// `req.user` — the surface never lets a caller ask for someone else's rows.
router.get(
  '/me/history',
  requirePermission(PERMISSIONS.DELIVERY_READ),
  getMyHistoryController,
);
router.get(
  '/me/history.xlsx',
  requirePermission(PERMISSIONS.DELIVERY_READ),
  downloadMyHistoryXlsxController,
);

router.get(
  '/me/orders',
  requirePermission(PERMISSIONS.DELIVERY_READ),
  listMyDeliveriesController,
);
router.get(
  '/me/orders/:id',
  requirePermission(PERMISSIONS.DELIVERY_READ),
  getMyDeliveryController,
);
router.post(
  '/me/orders/:id/claim',
  requirePermission(PERMISSIONS.DELIVERY_CLAIM),
  claimMyDeliveryController,
);
router.post(
  '/me/orders/:id/start',
  requirePermission(PERMISSIONS.DELIVERY_UPDATE),
  startMyDeliveryController,
);
router.post(
  '/me/orders/:id/deliver',
  requirePermission(PERMISSIONS.DELIVERY_UPDATE),
  deliverMyOrderController,
);
router.post(
  '/me/direct-order',
  requirePermission(PERMISSIONS.DELIVERY_CREATE),
  createDirectOrderController,
);

export default router;
