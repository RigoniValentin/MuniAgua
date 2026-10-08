import { Router } from 'express';
import {
  getBankInfoController,
  updateBankInfoController,
} from './bank-info.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { requirePermission } from '../../middlewares/authorize.js';
import { PERMISSIONS } from '../users/users.types.js';

const router = Router();

router.use(authenticate);

router.get('/', requirePermission(PERMISSIONS.BANK_INFO_READ), getBankInfoController);
router.put(
  '/',
  requirePermission(PERMISSIONS.BANK_INFO_MANAGE),
  updateBankInfoController,
);

export default router;
