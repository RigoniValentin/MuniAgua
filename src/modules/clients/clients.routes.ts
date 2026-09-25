import { Router } from 'express';
import {
  createClientController,
  deleteCitizenAccessController,
  getCitizenAccessController,
  getClientController,
  getSelfClientController,
  listClientsController,
  postCitizenAccessController,
  updateClientController,
  updateSelfClientController,
} from './clients.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { requirePermission } from '../../middlewares/authorize.js';
import { PERMISSIONS } from '../users/users.types.js';

const router = Router();

router.use(authenticate);

// IMPORTANT: /me MUST be registered before /:id so Express never interprets
// "me" as an ObjectId.
router.get(
  '/me',
  requirePermission(PERMISSIONS.CLIENTS_SELF),
  getSelfClientController,
);
router.patch(
  '/me',
  requirePermission(PERMISSIONS.CLIENTS_SELF),
  updateSelfClientController,
);

// Administrative citizen-access (link / unlink / inspect).
router.get(
  '/:clientId/citizen-access',
  requirePermission(PERMISSIONS.CLIENTS_LINK_USER),
  getCitizenAccessController,
);
router.post(
  '/:clientId/citizen-access',
  requirePermission(PERMISSIONS.CLIENTS_LINK_USER),
  postCitizenAccessController,
);
router.delete(
  '/:clientId/citizen-access',
  requirePermission(PERMISSIONS.CLIENTS_LINK_USER),
  deleteCitizenAccessController,
);

// Staff CRUD.
router.get('/', requirePermission(PERMISSIONS.CLIENTS_READ), listClientsController);
router.get('/:id', requirePermission(PERMISSIONS.CLIENTS_READ), getClientController);
router.post('/', requirePermission(PERMISSIONS.CLIENTS_CREATE), createClientController);
router.patch('/:id', requirePermission(PERMISSIONS.CLIENTS_UPDATE), updateClientController);

export default router;