/**
 * Driver history controller — `/api/delivery/me/history`.
 *
 *   GET /api/delivery/me/history       (delivery.read)
 *   GET /api/delivery/me/history.xlsx  (delivery.read)
 *
 * Both endpoints always scope to the authenticated repartidor; there is no
 * way to ask for another driver's movements through this surface.
 */
import type { Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { asyncHandler } from '../../middlewares/error.js';
import { ok } from '../../shared/api-response.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { driverHistoryQuerySchema } from './driver-history.validation.js';
import { buildDriverHistory } from './driver-history.service.js';
import {
  buildDriverHistoryFilename,
  buildDriverHistoryWorkbook,
} from './driver-history.workbook.js';
import { resolveReportPeriod } from '../reports/reports.period.js';
import type { DriverHistoryFilters } from './driver-history.types.js';

function requireUserId(req: Request): string {
  const id = req.user?.id;
  if (!id) throw new NotFoundError('No autenticado');
  return id;
}

function parseFilters(query: unknown): DriverHistoryFilters {
  const parsed = driverHistoryQuerySchema.parse(query);
  return {
    period: parsed.period as DriverHistoryFilters['period'],
    dateFrom: parsed.dateFrom,
    dateTo: parsed.dateTo,
  };
}

/**
 * `resolveReportPeriod` can still reject a syntactically valid but
 * unusable range. Surface it as a 400 instead of letting it bubble up as a
 * 500 from the service. Same guard the admin reports download uses.
 */
function assertPeriodResolvable(filters: DriverHistoryFilters): void {
  try {
    resolveReportPeriod(filters);
  } catch (err) {
    throw new ValidationError(
      err instanceof Error ? err.message : 'Período inválido',
    );
  }
}

export const getMyHistoryController = asyncHandler(
  async (req: Request, res: Response) => {
    const driverUserId = requireUserId(req);
    const filters = parseFilters(req.query);
    const history = await buildDriverHistory(driverUserId, filters);
    res.json(ok(history));
  },
);

export const downloadMyHistoryXlsxController = asyncHandler(
  async (req: Request, res: Response) => {
    const driverUserId = requireUserId(req);
    const filters = parseFilters(req.query);
    assertPeriodResolvable(filters);
    const history = await buildDriverHistory(driverUserId, filters);
    const wb = buildDriverHistoryWorkbook(history);
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${buildDriverHistoryFilename(filters)}"`,
    );
    res.send(buffer);
  },
);