import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  loginController,
  refreshController,
  logoutController,
  meController,
  registerController,
} from './auth.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import {
  loginLimiter,
  registerLimiter,
  passwordRecoveryLimiter,
} from '../../middlewares/rate-limit.js';
import {
  requestResetController,
  resetPasswordController,
  validateResetTokenController,
} from '../password-recovery/password-recovery.controller.js';

const router = Router();

router.post('/login', loginLimiter, loginController);
router.post('/register', registerLimiter, registerController);
router.post('/refresh', refreshController);
router.post('/logout', logoutController);
router.get('/me', authenticate, meController);

router.post(
  '/forgot-password',
  passwordRecoveryLimiter,
  requestResetController,
);
router.get(
  '/reset-password/validate',
  passwordRecoveryLimiter,
  validateResetTokenController,
);
router.post(
  '/reset-password',
  passwordRecoveryLimiter,
  resetPasswordController,
);

export default router;

// Re-export for tests
export { rateLimit };
