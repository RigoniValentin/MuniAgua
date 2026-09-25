import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { requirePermission } from '../../middlewares/authorize.js';
import { PERMISSIONS } from '../users/users.types.js';
import {
  cancelMyOrderController,
  cancelOrderController,
  createMyOrderController,
  getMyOrderController,
  getOrderController,
  listMyOrdersController,
  listOrdersController,
} from './orders.controller.js';

const router = Router();
router.use(authenticate);

// IMPORTANT: declare the more specific `/me/*` paths BEFORE the dynamic
// `/:id` ones so Express matches them first.
router.post(
  '/me',
  requirePermission(PERMISSIONS.ORDERS_SELF),
  createMyOrderController,
);
router.get(
  '/me',
  requirePermission(PERMISSIONS.ORDERS_SELF),
  listMyOrdersController,
);
router.get(
  '/me/:id',
  requirePermission(PERMISSIONS.ORDERS_SELF),
  getMyOrderController,
);
router.post(
  '/me/:id/cancel',
  requirePermission(PERMISSIONS.ORDERS_SELF),
  cancelMyOrderController,
);

router.get('/', requirePermission(PERMISSIONS.ORDERS_READ), listOrdersController);
router.get('/:id', requirePermission(PERMISSIONS.ORDERS_READ), getOrderController);
router.post(
  '/:id/cancel',
  requirePermission(PERMISSIONS.ORDERS_CANCEL),
  cancelOrderController,
);

export default router;
