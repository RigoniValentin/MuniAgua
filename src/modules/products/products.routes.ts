import { Router } from 'express';
import {
  createProductController,
  getProductController,
  listProductsController,
  updateProductController,
} from './products.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { requirePermission } from '../../middlewares/authorize.js';
import { PERMISSIONS } from '../users/users.types.js';

const router = Router();

router.use(authenticate);

router.get('/', requirePermission(PERMISSIONS.PRODUCTS_READ), listProductsController);
router.get('/:id', requirePermission(PERMISSIONS.PRODUCTS_READ), getProductController);
router.post('/', requirePermission(PERMISSIONS.PRODUCTS_CREATE), createProductController);
router.patch('/:id', requirePermission(PERMISSIONS.PRODUCTS_UPDATE), updateProductController);

export default router;
