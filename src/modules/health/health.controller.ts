import type { Request, Response } from 'express';
import { ok } from '../../shared/api-response.js';
import { asyncHandler } from '../../middlewares/error.js';
import { getMongoState } from '../../config/mongo.js';

export const healthController = asyncHandler(async (_req: Request, res: Response) => {
  const dbState = getMongoState();
  res.json(
    ok({
      status: 'ok',
      database: dbState,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }),
  );
});
