import { z } from 'zod';
import {
  ALL_REPORT_PERIOD_PRESETS,
  REPORT_PERIOD_PRESETS,
} from '../reports/reports.types.js';

const REPORT_PERIOD_TUPLE = ALL_REPORT_PERIOD_PRESETS as unknown as [
  string,
  ...string[],
];

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener formato YYYY-MM-DD');

/**
 * Query schema for the driver history endpoints. Mirrors the admin reports
 * filter (same presets, same CUSTOM range rules) so both UIs feel identical.
 */
export const driverHistoryQuerySchema = z
  .object({
    period: z
      .enum(REPORT_PERIOD_TUPLE)
      .default(REPORT_PERIOD_PRESETS.TODAY),
    dateFrom: isoDateSchema.optional(),
    dateTo: isoDateSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.period !== REPORT_PERIOD_PRESETS.CUSTOM) return;
    if (!data.dateFrom) {
      ctx.addIssue({
        path: ['dateFrom'],
        code: z.ZodIssueCode.custom,
        message: 'dateFrom es obligatorio en período personalizado',
      });
    }
    if (!data.dateTo) {
      ctx.addIssue({
        path: ['dateTo'],
        code: z.ZodIssueCode.custom,
        message: 'dateTo es obligatorio en período personalizado',
      });
    }
    if (data.dateFrom && data.dateTo && data.dateFrom > data.dateTo) {
      ctx.addIssue({
        path: ['dateTo'],
        code: z.ZodIssueCode.custom,
        message: 'dateTo debe ser igual o posterior a dateFrom',
      });
    }
  });

export type DriverHistoryQuery = z.infer<typeof driverHistoryQuerySchema>;