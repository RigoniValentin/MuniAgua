/**
 * Reports module — period-based reporting for `/admin/informes`.
 *
 * Every endpoint anchored to `deliveredAt` (the day the order actually
 * closed its cycle): cancelled orders drop out naturally because they
 * never reach DELIVERED, and a CASH order picked up today is reported
 * under today's period regardless of when the order was created.
 */

export const REPORT_PERIOD_PRESETS = {
  TODAY: 'TODAY',
  YESTERDAY: 'YESTERDAY',
  THIS_WEEK: 'THIS_WEEK',
  THIS_MONTH: 'THIS_MONTH',
  LAST_MONTH: 'LAST_MONTH',
  CUSTOM: 'CUSTOM',
} as const;

export type ReportPeriodPreset =
  (typeof REPORT_PERIOD_PRESETS)[keyof typeof REPORT_PERIOD_PRESETS];

export const ALL_REPORT_PERIOD_PRESETS: ReportPeriodPreset[] = Object.values(
  REPORT_PERIOD_PRESETS,
);

export const REPORT_PERIOD_LABEL: Record<ReportPeriodPreset, string> = {
  TODAY: 'Hoy',
  YESTERDAY: 'Ayer',
  THIS_WEEK: 'Esta semana',
  THIS_MONTH: 'Este mes',
  LAST_MONTH: 'Mes pasado',
  CUSTOM: 'Personalizado',
};

// ----------------------------------------------------------------------------
// Filters
// ----------------------------------------------------------------------------

export interface ReportFilters {
  period: ReportPeriodPreset;
  /** Required when period === 'CUSTOM'. ISO date (YYYY-MM-DD). Inclusive. */
  dateFrom?: string;
  /** Required when period === 'CUSTOM'. ISO date (YYYY-MM-DD). Exclusive end-of-day. */
  dateTo?: string;
  driverId?: string;
  clientType?: 'LOCAL' | 'JUBILADO' | 'NO_LOCAL' | 'AYUDA_SOCIAL';
}

export interface ResolvedReportPeriod {
  preset: ReportPeriodPreset;
  /** Date in the app's timezone. */
  dateFrom: Date;
  /** Date in the app's timezone. */
  dateTo: Date;
  label: string;
}

// ----------------------------------------------------------------------------
// Report payload
// ----------------------------------------------------------------------------

export interface ReportPeriodSummary {
  preset: ReportPeriodPreset;
  label: string;
  dateFrom: string;
  dateTo: string;
  filters: {
    driverId: string | null;
    driverName: string | null;
    clientType: string | null;
  };
}

export interface ReportTotals {
  deliveredOrdersCount: number;
  unitsSold: number;
  distinctProducts: number;
  grossSalesMinor: number;
  cashCollectedMinor: number;
  accountChargedMinor: number;
}

export interface ReportProductRow {
  productId: string;
  productCode: string;
  productName: string;
  productType: string;
  totalQuantity: number;
  totalSubtotalFinalMinor: number;
  orderCount: number;
}

export interface ReportDeliveryRow {
  driverId: string | null;
  driverName: string;
  deliveredOrdersCount: number;
  unitsDelivered: number;
  cashCollectedMinor: number;
  totalDeliveredMinor: number;
}

export interface ReportOrderItemRow {
  productCode: string;
  productName: string;
  quantity: number;
  subtotalFinalMinor: number;
}

export interface ReportOrderRow {
  id: string;
  deliveredAt: string;
  clientId: string;
  clientName: string;
  documentNumber: string | null;
  clientType: string;
  zona: string | null;
  origin: 'CITIZEN' | 'STAFF';
  status: 'DELIVERED';
  paymentMethod: 'CASH' | 'ACCOUNT';
  driverId: string | null;
  driverName: string | null;
  totalFinalMinor: number;
  items: ReportOrderItemRow[];
}

export interface PeriodReport {
  period: ReportPeriodSummary;
  totals: ReportTotals;
  productBreakdown: ReportProductRow[];
  deliveryBreakdown: ReportDeliveryRow[];
  orders: ReportOrderRow[];
}

export interface ReportAvailableDriver {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
}
