import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import mongoose from 'mongoose';
import multer from 'multer';
import { AppError } from '../shared/errors.js';
import { fail } from '../shared/api-response.js';
import { getEnv } from '../config/env.js';
import { logger } from '../shared/logger.js';

interface ErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  // Only fallback to JSON 404 for API routes. Static/SPA is handled in app.ts
  if (req.path.startsWith('/api/')) {
    res.status(404).json(fail('NOT_FOUND', `Ruta no encontrada: ${req.method} ${req.originalUrl}`));
    return;
  }
  // For non-API routes, the SPA fallback in app.ts will serve index.html
  res.status(404).json(fail('NOT_FOUND', `Ruta no encontrada: ${req.method} ${req.originalUrl}`));
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const env = getEnv();

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error(`[${req.method} ${req.originalUrl}] ${err.code}: ${err.message}`, err);
    } else {
      logger.warn(`[${req.method} ${req.originalUrl}] ${err.code}: ${err.message}`);
    }
    const body: ErrorBody = { success: false, error: err.toPayload() };
    res.status(err.status).json(body);
    return;
  }

  if (err instanceof ZodError) {
    const message = 'Datos inválidos';
    const details = err.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
    }));
    logger.warn(`[${req.method} ${req.originalUrl}] VALIDATION_ERROR`, details);
    res.status(400).json(fail('VALIDATION_ERROR', message, details));
    return;
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({
      path: e.path,
      message: e.message,
    }));
    logger.warn(`[${req.method} ${req.originalUrl}] DB_VALIDATION_ERROR`, details);
    res
      .status(400)
      .json(fail('VALIDATION_ERROR', 'Datos inválidos', details));
    return;
  }

  if (err instanceof mongoose.Error.CastError) {
    logger.warn(`[${req.method} ${req.originalUrl}] CAST_ERROR ${err.path}`);
    res
      .status(400)
      .json(fail('VALIDATION_ERROR', `Valor inválido para ${err.path}`));
    return;
  }

  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json(fail('INVALID_JSON', 'JSON inválido en el cuerpo de la solicitud'));
    return;
  }

  if (err instanceof multer.MulterError) {
    logger.warn(`[${req.method} ${req.originalUrl}] MULTER ${err.code}: ${err.message}`);
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json(
        fail(
          'VALIDATION_ERROR',
          'El comprobante supera el tamaño máximo permitido (8 MB)',
        ),
      );
      return;
    }
    res.status(400).json(fail('VALIDATION_ERROR', err.message));
    return;
  }

  const message =
    env.NODE_ENV === 'production'
      ? 'Error interno del servidor'
      : err instanceof Error
        ? err.message
        : 'Error interno del servidor';

  logger.error(`[${req.method} ${req.originalUrl}] UNHANDLED`, err);
  res.status(500).json(fail('INTERNAL_ERROR', message));
}

export function asyncHandler<TReq extends Request = Request>(
  fn: (req: TReq, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: TReq, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
