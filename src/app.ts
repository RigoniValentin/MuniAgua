import express, { type Application } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { getEnv } from './config/env.js';
import { errorHandler, notFoundHandler } from './middlewares/error.js';
import { generalLimiter } from './middlewares/rate-limit.js';
import { ok } from './shared/api-response.js';
import healthRoutes from './modules/health/health.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import clientsRoutes from './modules/clients/clients.routes.js';
import productsRoutes from './modules/products/products.routes.js';
import pricingRoutes from './modules/pricing/pricing.routes.js';
import accountsRoutes from './modules/accounts/accounts.routes.js';
import paymentsRoutes from './modules/payments/payments.routes.js';
import ordersRoutes from './modules/orders/orders.routes.js';
import deliveryRoutes from './modules/orders/delivery.routes.js';
import { paymentSubmitLimiter } from './middlewares/rate-limit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(): Application {
  const app = express();
  const env = getEnv();

  // Behind proxies (nginx, render, etc.) we should trust proxy when present.
  if (env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  app.use(helmet());
  app.use(
    cors({
      origin: env.FRONTEND_URL,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());
  app.use(generalLimiter);

  // ====== API ======
  const apiRouter = express.Router();
  apiRouter.get('/', (_req, res) => {
    res.json(ok({ name: 'MuniBack API', version: '0.1.0' }));
  });
  apiRouter.use('/health', healthRoutes);
  apiRouter.use('/auth', authRoutes);
  apiRouter.use('/users', usersRoutes);
  apiRouter.use('/clients', clientsRoutes);
  apiRouter.use('/products', productsRoutes);
  apiRouter.use('/pricing', pricingRoutes);
  apiRouter.use('/accounts', accountsRoutes);
  // Payments — submit limiter only applies to the citizen upload endpoint.
  apiRouter.use('/payments', (req, res, next) => {
    if (req.method === 'POST' && req.path === '/me') {
      return paymentSubmitLimiter(req, res, next);
    }
    next();
  }, paymentsRoutes);
  apiRouter.use('/orders', ordersRoutes);
  apiRouter.use('/delivery', deliveryRoutes);

  // Mount /api BEFORE static so the API always wins.
  app.use('/api', apiRouter);

  // 404 for unknown /api routes (must return JSON, NOT index.html)
  app.use('/api', (_req, res) => {
    res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Ruta de API no encontrada',
      },
    });
  });

  // ====== Static / SPA ======
  const publicDir = path.resolve(__dirname, '..', 'public');
  app.use(
    express.static(publicDir, {
      index: false,
      fallthrough: true,
      maxAge: env.NODE_ENV === 'production' ? '1d' : 0,
    }),
  );

  // SPA fallback: serve index.html for any non-API route
  app.get(/^\/(?!api).*/, (_req, res, next) => {
    const indexPath = path.join(publicDir, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        next();
      }
    });
  });

  // Final JSON 404 fallback (for any unknown path that wasn't SPA-handled)
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Ruta no encontrada: ${req.method} ${req.originalUrl}` },
      });
      return;
    }
    // For non-API unknown routes, return JSON 404 as well
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Ruta no encontrada: ${req.method} ${req.originalUrl}` },
    });
    next();
  });

  // Error handler (last)
  app.use(errorHandler);

  return app;
}

// Export notFoundHandler to keep import non-unused warning free in case of future refactors.
export { notFoundHandler };
