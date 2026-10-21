/**
 * Reports controller — JSON + xlsx download for `/admin/informes`.
 */
import type { Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { asyncHandler } from '../../middlewares/error.js';
import { ok } from '../../shared/api-response.js';
import { ValidationError } from '../../shared/errors.js';
import {
  buildPeriodReport,
  listAvailableDriversForReports,
} from './reports.service.js';
import { reportPeriodQuerySchema } from './reports.validation.js';
import { REPORT_PERIOD_PRESETS, type ReportFilters } from './reports.types.js';
import { resolveReportPeriod } from './reports.period.js';
import {
  CURRENCY_FMT,
  DATE_FMT,
  colWidth,
  friendlyClientType,
  friendlyClientTypeFilter,
  friendlyOrigin,
  friendlyPaymentMethod,
  friendlyProductType,
  isoDateOnly,
  setCell,
  shortId,
  writeTitle,
} from './reports.workbook.js';

function parseFilters(query: unknown): ReportFilters {
  const parsed = reportPeriodQuerySchema.parse(query);
  return {
    period: parsed.period as ReportFilters['period'],
    dateFrom: parsed.dateFrom,
    dateTo: parsed.dateTo,
    driverId: parsed.driverId,
    clientType: parsed.clientType as ReportFilters['clientType'],
  };
}

const HEADER_FILL = 'FF1F3864';
const HEADER_FONT_COLOR = 'FFFFFFFF';
const SECTION_FILL = 'FFD9E1F2';
const LABEL_FILL = 'FFF2F2F2';

function buildFilename(prefix: string, filters: ReportFilters): string {
  const safePeriod =
    filters.period === REPORT_PERIOD_PRESETS.CUSTOM && filters.dateFrom
      ? `${filters.dateFrom}_a_${filters.dateTo ?? filters.dateFrom}`
      : filters.period.toLowerCase();
  return `informe-${prefix}-${safePeriod}.xlsx`;
}

function writeHeaderRow(
  sheet: XLSX.WorkSheet,
  rowIdx: number,
  columns: string[],
): void {
  for (let c = 0; c < columns.length; c++) {
    setCell(sheet, rowIdx, c, columns[c] ?? '', {
      bold: true,
      fontColor: HEADER_FONT_COLOR,
      fill: HEADER_FILL,
      align: 'center',
      border: true,
    });
  }
}

function autosize(sheet: XLSX.WorkSheet, widths: number[]): void {
  sheet['!cols'] = widths.map((w) => colWidth(w));
}

function freeze(sheet: XLSX.WorkSheet, ySplit: number, xSplit = 0): void {
  sheet['!freeze'] = { xSplit, ySplit };
}

function setRange(
  sheet: XLSX.WorkSheet,
  ref: string,
): void {
  sheet['!ref'] = ref;
}

function applyAutoFilter(
  sheet: XLSX.WorkSheet,
  rangeRef: string,
): void {
  sheet['!autofilter'] = { ref: rangeRef };
}

function buildWorkbook(
  report: Awaited<ReturnType<typeof buildPeriodReport>>,
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  buildResumen(wb, report);
  buildProductos(wb, report);
  buildRepartos(wb, report);
  buildPedidos(wb, report);

  return wb;
}

function buildResumen(
  wb: XLSX.WorkBook,
  report: Awaited<ReturnType<typeof buildPeriodReport>>,
): void {
  const sheet: XLSX.WorkSheet = {};
  const lastColIdx = 1;
  const titleSubtitle = `Municipalidad de Buchardo · ${report.period.label}`;
  writeTitle(sheet, 'Informe de entregas', titleSubtitle, lastColIdx);

  let r = 3;

  // Section: Período
  setCell(sheet, r, 0, 'Período', {
    bold: true,
    fill: SECTION_FILL,
    border: true,
    align: 'left',
  });
  setCell(sheet, r, 1, '', { fill: SECTION_FILL, border: true });
  r++;

  const periodRows: Array<[string, string]> = [
    ['Período', report.period.label],
    ['Desde', isoDateOnly(report.period.dateFrom)],
    ['Hasta (inclusive)', isoDateOnly(report.period.dateTo)],
    ['Repartidor', report.period.filters.driverName ?? 'Todos'],
    [
      'Tipo de cliente',
      friendlyClientTypeFilter(report.period.filters.clientType),
    ],
  ];
  for (const [label, value] of periodRows) {
    const isOdd = (r - 4) % 2 === 1;
    setCell(sheet, r, 0, label, {
      bold: true,
      fill: LABEL_FILL,
      border: true,
      align: 'left',
    });
    setCell(sheet, r, 1, value, {
      fill: isOdd ? 'FFFFFFFF' : 'FFF8F8F8',
      border: true,
      align: 'left',
    });
    r++;
  }
  r++; // spacer

  // Section: Totales
  setCell(sheet, r, 0, 'Totales', {
    bold: true,
    fill: SECTION_FILL,
    border: true,
    align: 'left',
  });
  setCell(sheet, r, 1, '', { fill: SECTION_FILL, border: true });
  r++;

  const totalsRows: Array<[string, number, 'n' | 'c']> = [
    ['Pedidos entregados', report.totals.deliveredOrdersCount, 'n'],
    ['Unidades vendidas', report.totals.unitsSold, 'n'],
    ['Productos distintos', report.totals.distinctProducts, 'n'],
    ['Venta bruta', report.totals.grossSalesMinor / 100, 'c'],
    ['Efectivo cobrado', report.totals.cashCollectedMinor / 100, 'c'],
    ['Cargado a cuenta corriente', report.totals.accountChargedMinor / 100, 'c'],
  ];
  for (const [label, value, kind] of totalsRows) {
    const isOdd = (r - 10) % 2 === 1;
    setCell(sheet, r, 0, label, {
      bold: true,
      fill: LABEL_FILL,
      border: true,
      align: 'left',
    });
    const preset = {
      bold: true,
      fontColor: kind === 'c' ? 'FF1F3864' : 'FF222222',
      fill: isOdd ? 'FFFFFFFF' : 'FFF8F8F8',
      border: true,
      align: 'right' as const,
    };
    if (kind === 'c') {
      setCell(sheet, r, 1, value, { ...preset, numFmt: CURRENCY_FMT });
    } else {
      setCell(sheet, r, 1, value, preset);
    }
    r++;
  }

  setRange(sheet, XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: r - 1, c: lastColIdx } }));
  autosize(sheet, [32, 28]);
  // Two columns. Logo/title already gave us a long column 0.
  wb.SheetNames.push('Resumen');
  wb.Sheets['Resumen'] = sheet;
}

function buildProductos(
  wb: XLSX.WorkBook,
  report: Awaited<ReturnType<typeof buildPeriodReport>>,
): void {
  const sheet: XLSX.WorkSheet = {};
  const headerRow = 0;
  const columns = ['Código', 'Producto', 'Tipo', 'Cantidad', 'Subtotal (ARS)', 'Pedidos'];
  writeHeaderRow(sheet, headerRow, columns);

  let r = headerRow + 1;
  if (report.productBreakdown.length === 0) {
    setCell(sheet, r, 0, 'Sin productos vendidos en el período.', {
      fontColor: 'FF777777',
      align: 'left',
    });
    r++;
  } else {
    for (const row of report.productBreakdown) {
      const isOdd = (r - headerRow - 1) % 2 === 1;
      const fill = isOdd ? 'FFFFFFFF' : 'FFF8F8F8';
      setCell(sheet, r, 0, row.productCode, { fill, border: true });
      setCell(sheet, r, 1, row.productName, { fill, border: true });
      setCell(sheet, r, 2, friendlyProductType(row.productType), {
        fill,
        border: true,
        align: 'center',
      });
      setCell(sheet, r, 3, row.totalQuantity, {
        fill,
        border: true,
        align: 'right',
        numFmt: '#,##0',
      });
      setCell(sheet, r, 4, row.totalSubtotalFinalMinor / 100, {
        fill,
        border: true,
        align: 'right',
        numFmt: CURRENCY_FMT,
      });
      setCell(sheet, r, 5, row.orderCount, {
        fill,
        border: true,
        align: 'right',
        numFmt: '#,##0',
      });
      r++;
    }
  }

  const lastC = columns.length - 1;
  const dataEnd = r - 1;
  setRange(sheet, XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: dataEnd, c: lastC } }));
  autosize(sheet, [12, 32, 18, 12, 20, 12]);
  freeze(sheet, headerRow + 1);
  if (dataEnd > headerRow) {
    applyAutoFilter(
      sheet,
      XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: dataEnd, c: lastC } }),
    );
  }
  wb.SheetNames.push('Productos');
  wb.Sheets['Productos'] = sheet;
}

function buildRepartos(
  wb: XLSX.WorkBook,
  report: Awaited<ReturnType<typeof buildPeriodReport>>,
): void {
  const sheet: XLSX.WorkSheet = {};
  const headerRow = 0;
  const columns = [
    'Repartidor',
    'Pedidos',
    'Unidades',
    'Efectivo cobrado (ARS)',
    'Total entregado (ARS)',
  ];
  writeHeaderRow(sheet, headerRow, columns);

  let r = headerRow + 1;
  if (report.deliveryBreakdown.length === 0) {
    setCell(sheet, r, 0, 'Sin entregas registradas en el período.', {
      fontColor: 'FF777777',
      align: 'left',
    });
    r++;
  } else {
    let totalPedidos = 0;
    let totalUnidades = 0;
    let totalEfectivo = 0;
    let totalEntregado = 0;
    for (const row of report.deliveryBreakdown) {
      const isOdd = (r - headerRow - 1) % 2 === 1;
      const fill = isOdd ? 'FFFFFFFF' : 'FFF8F8F8';
      setCell(sheet, r, 0, row.driverName ?? '—', { fill, border: true });
      setCell(sheet, r, 1, row.deliveredOrdersCount, {
        fill,
        border: true,
        align: 'right',
        numFmt: '#,##0',
      });
      setCell(sheet, r, 2, row.unitsDelivered, {
        fill,
        border: true,
        align: 'right',
        numFmt: '#,##0',
      });
      setCell(sheet, r, 3, row.cashCollectedMinor / 100, {
        fill,
        border: true,
        align: 'right',
        numFmt: CURRENCY_FMT,
      });
      setCell(sheet, r, 4, row.totalDeliveredMinor / 100, {
        fill,
        border: true,
        align: 'right',
        numFmt: CURRENCY_FMT,
      });
      totalPedidos += row.deliveredOrdersCount;
      totalUnidades += row.unitsDelivered;
      totalEfectivo += row.cashCollectedMinor;
      totalEntregado += row.totalDeliveredMinor;
      r++;
    }
    // Total row at the bottom (only if >1 driver).
    if (report.deliveryBreakdown.length > 1) {
      setCell(sheet, r, 0, 'Total', {
        bold: true,
        fill: SECTION_FILL,
        border: true,
      });
      setCell(sheet, r, 1, totalPedidos, {
        bold: true,
        fill: SECTION_FILL,
        border: true,
        align: 'right',
        numFmt: '#,##0',
      });
      setCell(sheet, r, 2, totalUnidades, {
        bold: true,
        fill: SECTION_FILL,
        border: true,
        align: 'right',
        numFmt: '#,##0',
      });
      setCell(sheet, r, 3, totalEfectivo / 100, {
        bold: true,
        fill: SECTION_FILL,
        border: true,
        align: 'right',
        numFmt: CURRENCY_FMT,
      });
      setCell(sheet, r, 4, totalEntregado / 100, {
        bold: true,
        fill: SECTION_FILL,
        border: true,
        align: 'right',
        numFmt: CURRENCY_FMT,
      });
      r++;
    }
  }

  const lastC = columns.length - 1;
  const dataEnd = r - 1;
  setRange(sheet, XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: dataEnd, c: lastC } }));
  autosize(sheet, [28, 12, 12, 22, 22]);
  freeze(sheet, headerRow + 1);
  if (dataEnd > headerRow) {
    applyAutoFilter(
      sheet,
      XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: dataEnd, c: lastC } }),
    );
  }
  wb.SheetNames.push('Repartos');
  wb.Sheets['Repartos'] = sheet;
}

function buildPedidos(
  wb: XLSX.WorkBook,
  report: Awaited<ReturnType<typeof buildPeriodReport>>,
): void {
  const sheet: XLSX.WorkSheet = {};
  const headerRow = 0;
  const columns = [
    'Pedido',
    'Fecha de entrega',
    'Cliente',
    'Documento',
    'Tipo de cliente',
    'Zona',
    'Origen',
    'Medio de pago',
    'Repartidor',
    'Total (ARS)',
    'Items',
  ];
  writeHeaderRow(sheet, headerRow, columns);

  let r = headerRow + 1;
  if (report.orders.length === 0) {
    setCell(sheet, r, 0, 'Sin pedidos entregados en el período.', {
      fontColor: 'FF777777',
      align: 'left',
    });
    r++;
  } else {
    for (const row of report.orders) {
      const isOdd = (r - headerRow - 1) % 2 === 1;
      const fill = isOdd ? 'FFFFFFFF' : 'FFF8F8F8';
      const deliveredAtDate = new Date(row.deliveredAt);
      const itemsText = row.items
        .map((it) => `${it.productCode} × ${it.quantity}`)
        .join('\n');

      setCell(sheet, r, 0, shortId(row.id), {
        fill,
        border: true,
        align: 'center',
      });
      setCell(sheet, r, 1, deliveredAtDate, {
        fill,
        border: true,
        align: 'center',
        numFmt: DATE_FMT,
      });
      setCell(sheet, r, 2, row.clientName, { fill, border: true });
      setCell(sheet, r, 3, row.documentNumber ?? '', {
        fill,
        border: true,
        align: 'center',
      });
      setCell(sheet, r, 4, friendlyClientType(row.clientType), {
        fill,
        border: true,
        align: 'center',
      });
      setCell(sheet, r, 5, row.zona ?? '', {
        fill,
        border: true,
        align: 'center',
      });
      setCell(sheet, r, 6, friendlyOrigin(row.origin), {
        fill,
        border: true,
        align: 'center',
      });
      setCell(sheet, r, 7, friendlyPaymentMethod(row.paymentMethod), {
        fill,
        border: true,
        align: 'center',
      });
      setCell(sheet, r, 8, row.driverName ?? '—', { fill, border: true });
      setCell(sheet, r, 9, row.totalFinalMinor / 100, {
        fill,
        border: true,
        align: 'right',
        numFmt: CURRENCY_FMT,
      });
      setCell(sheet, r, 10, itemsText, {
        fill,
        border: true,
        align: 'left',
        valign: 'top',
        wrap: true,
      });
      r++;
    }
  }

  const lastC = columns.length - 1;
  const dataEnd = r - 1;
  setRange(sheet, XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: dataEnd, c: lastC } }));
  autosize(sheet, [10, 18, 26, 14, 14, 10, 10, 14, 26, 14, 36]);
  freeze(sheet, headerRow + 1, 1);
  if (dataEnd > headerRow) {
    applyAutoFilter(
      sheet,
      XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: dataEnd, c: lastC } }),
    );
  }
  wb.SheetNames.push('Pedidos entregados');
  wb.Sheets['Pedidos entregados'] = sheet;
}

export const getPeriodReportController = asyncHandler(
  async (req: Request, res: Response) => {
    const filters = parseFilters(req.query);
    const report = await buildPeriodReport(filters);
    res.json(ok(report));
  },
);

export const downloadPeriodReportXlsxController = asyncHandler(
  async (req: Request, res: Response) => {
    const filters = parseFilters(req.query);
    try {
      resolveReportPeriod(filters);
    } catch (err) {
      throw new ValidationError(
        err instanceof Error ? err.message : 'Período inválido',
      );
    }
    const report = await buildPeriodReport(filters);
    const wb = buildWorkbook(report);
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${buildFilename('periodo', filters)}"`,
    );
    res.send(buffer);
  },
);

export const getReportDriversController = asyncHandler(
  async (_req: Request, res: Response) => {
    const drivers = await listAvailableDriversForReports();
    res.json(ok({ drivers }));
  },
);

void ({} as Request);
