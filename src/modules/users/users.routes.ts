import { Router } from 'express';
import {
  listUsersController,
  createUserController,
  updateUserController,
} from './users.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { requirePermission } from '../../middlewares/authorize.js';
import { PERMISSIONS } from './users.types.js';

const router = Router();

router.use(authenticate);

router.get('/', requirePermission(PERMISSIONS.USERS_MANAGE), listUsersController);
router.post('/', requirePermission(PERMISSIONS.USERS_MANAGE), createUserController);
router.patch('/:id', requirePermission(PERMISSIONS.USERS_MANAGE), updateUserController);

export default router;
