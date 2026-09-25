import { Router } from 'express';
import {
  approvePaymentController,
  getPaymentController,
  getMyPaymentController,
  listMyPaymentsController,
  listPaymentsController,
  receiptUploadMiddleware,
  rejectPaymentController,
  reversePaymentController,
  streamMyPaymentReceiptController,
  streamPaymentReceiptController,
  submitMyPaymentController,
} from './payments.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { requirePermission } from '../../middlewares/authorize.js';
import { PERMISSIONS } from '../users/users.types.js';

const router = Router();

router.use(authenticate);

// IMPORTANT: /me/* MUST be registered BEFORE /:paymentId wildcards so
// Express never interprets "me" as an ObjectId.
router.post(
  '/me',
  requirePermission(PERMISSIONS.PAYMENTS_SELF),
  receiptUploadMiddleware,
  submitMyPaymentController,
);
router.get(
  '/me',
  requirePermission(PERMISSIONS.PAYMENTS_SELF),
  listMyPaymentsController,
);
router.get(
  '/me/:id',
  requirePermission(PERMISSIONS.PAYMENTS_SELF),
  getMyPaymentController,
);
router.get(
  '/me/:id/receipt',
  requirePermission(PERMISSIONS.PAYMENTS_SELF),
  streamMyPaymentReceiptController,
);

// Admin
router.get('/', requirePermission(PERMISSIONS.PAYMENTS_READ), listPaymentsController);
router.get('/:id', requirePermission(PERMISSIONS.PAYMENTS_READ), getPaymentController);
router.post(
  '/:id/approve',
  requirePermission(PERMISSIONS.PAYMENTS_REVIEW),
  approvePaymentController,
);
router.post(
  '/:id/reject',
  requirePermission(PERMISSIONS.PAYMENTS_REVIEW),
  rejectPaymentController,
);
router.post(
  '/:id/reverse-approval',
  requirePermission(PERMISSIONS.PAYMENTS_REVERSE),
  reversePaymentController,
);
router.get(
  '/:id/receipt',
  requirePermission(PERMISSIONS.PAYMENTS_READ),
  streamPaymentReceiptController,
);

export default router;