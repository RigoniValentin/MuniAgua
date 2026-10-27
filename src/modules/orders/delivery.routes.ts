import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { requirePermission } from '../../middlewares/authorize.js';
import { PERMISSIONS } from '../users/users.types.js';
import {
  annulMyDeliveryController,
  changeMyDeliveryPaymentMethodController,
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
import {
  createDriverClientController,
  updateDriverClientController,
} from '../clients/clients.controller.js';

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
// Corrections on a delivery the repartidor already closed: annul it
// (reversing the settlement) or fix the way it was paid. Both only work
// on the repartidor's own deliveries — the check lives in the service.
router.post(
  '/me/orders/:id/cancel',
  requirePermission(PERMISSIONS.DELIVERY_UPDATE),
  annulMyDeliveryController,
);
router.post(
  '/me/orders/:id/payment-method',
  requirePermission(PERMISSIONS.DELIVERY_UPDATE),
  changeMyDeliveryPaymentMethodController,
);
router.post(
  '/me/direct-order',
  requirePermission(PERMISSIONS.DELIVERY_CREATE),
  createDirectOrderController,
);

// Client management from the driver surface: the repartidor registers a
// neighbour that is not in the padrón yet, or fixes a wrong address/phone
// while standing at the door.
// IMPORTANT: these use their own `delivery.clients.*` permissions on purpose —
// the driver never inherits `clients.create` / `clients.update`, so the bulk
// editor and the citizen-access linking stay out of reach.
router.post(
  '/me/clients',
  requirePermission(PERMISSIONS.DELIVERY_CLIENTS_CREATE),
  createDriverClientController,
);
router.patch(
  '/me/clients/:id',
  requirePermission(PERMISSIONS.DELIVERY_CLIENTS_UPDATE),
  updateDriverClientController,
);

export default router;
