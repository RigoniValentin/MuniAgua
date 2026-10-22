/**
 * xlsx builder for the repartidor's movement history.
 *
 * Two sheets:
 *   - `Resumen`     → who the driver is, which period, and the totals.
 *   - `Movimientos` → one row per operation, newest first.
 *
 * Reuses the cell/format helpers from the reports workbook so both
 * downloads look identical in Excel.
 */
import * as XLSX from 'xlsx';
import type { WorkSheet } from 'xlsx';
import {
  CURRENCY_FMT,
  DATE_FMT,
  colWidth,
  isoDateOnly,
  setCell,
  writeTitle,
} from '../reports/reports.workbook.js';
import { REPORT_PERIOD_PRESETS } from '../reports/reports.types.js';
import type {
  DriverHistory,
  DriverHistoryEntry,
  DriverHistoryFilters,
} from './driver-history.types.js';

const HEADER_FILL = 'FF1F3864';
const HEADER_FONT_COLOR = 'FFFFFFFF';
const SECTION_FILL = 'FFD9E1F2';
const LABEL_FILL = 'FFF2F2F2';
const ZEBRA_FILL = 'FFF8F8F8';

/** Driver-facing wording — matches `ORDER_PAYMENT_METHOD_LABEL` in the app. */
function friendlyPaymentMethod(value: string | null): string {
  if (value === 'CASH') return 'Contado';
  if (value === 'ACCOUNT') return 'Cuenta corriente';
  return '';
}

function friendlyOrigin(value: string | null): string {
  if (value === 'CITIZEN') return 'Vecino';
  if (value === 'STAFF') return 'Personal';
  return '';
}

function writeHeaderRow(sheet: WorkSheet, rowIdx: number, columns: string[]): void {
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

function moneyCell(sheet: WorkSheet, r: number, c: number, minor: number, fill: string): void {
  setCell(sheet, r, c, minor / 100, {
    fill,
    border: true,
    align: 'right',
    numFmt: CURRENCY_FMT,
  });
}

function buildResumen(wb: XLSX.WorkBook, history: DriverHistory): void {
  const sheet: WorkSheet = {};
  const lastCol = 1;
  writeTitle(
    sheet,
    'Historial de movimientos',
    `Municipalidad de Buchardo · ${history.driver.fullName} · ${history.period.label}`,
    lastCol,
  );

  let r = 3;
  setCell(sheet, r, 0, 'Período', { bold: true, fill: SECTION_FILL, border: true, align: 'left' });
  setCell(sheet, r, 1, '', { fill: SECTION_FILL, border: true });
  r++;

  const infoRows: Array<[string, string]> = [
    ['Repartidor', history.driver.fullName],
    ['Período', history.period.label],
    ['Desde', isoDateOnly(history.period.dateFrom)],
    ['Hasta (inclusive)', isoDateOnly(history.period.dateTo)],
  ];
  for (const [label, value] of infoRows) {
    setCell(sheet, r, 0, label, { bold: true, fill: LABEL_FILL, border: true, align: 'left' });
    setCell(sheet, r, 1, value, { fill: ZEBRA_FILL, border: true, align: 'left' });
    r++;
  }
  r++;

  setCell(sheet, r, 0, 'Totales', { bold: true, fill: SECTION_FILL, border: true, align: 'left' });
  setCell(sheet, r, 1, '', { fill: SECTION_FILL, border: true });
  r++;

  const s = history.summary;
  const countRows: Array<[string, number]> = [
    ['Operaciones registradas', s.operationCount],
    ['Pedidos tomados', s.ordersClaimed],
    ['Repartos iniciados', s.deliveriesStarted],
    ['Pedidos entregados', s.ordersDelivered],
    ['Entregas nuevas (venta en el domicilio)', s.directOrders],
    ['Pedidos cancelados', s.ordersCancelled],
    ['Cobros manuales en efectivo', s.manualCashCollections],
    ['Reversiones de cobros', s.manualCashReversals],
    ['Clientes atendidos', s.distinctClients],
    ['Unidades entregadas', s.unitsDelivered],
  ];
  for (const [label, value] of countRows) {
    setCell(sheet, r, 0, label, { bold: true, fill: LABEL_FILL, border: true, align: 'left' });
    setCell(sheet, r, 1, value, {
      bold: true,
      fill: ZEBRA_FILL,
      border: true,
      align: 'right',
      numFmt: '#,##0',
    });
    r++;
  }

  const moneyRows: Array<[string, number]> = [
    ['Total entregado', s.totalDeliveredMinor],
    ['Efectivo cobrado', s.cashCollectedMinor],
    ['Cargado a cuenta corriente', s.accountChargedMinor],
    ['Cta cte revertida', s.accountReversedMinor],
  ];
  for (const [label, value] of moneyRows) {
    setCell(sheet, r, 0, label, { bold: true, fill: LABEL_FILL, border: true, align: 'left' });
    setCell(sheet, r, 1, value / 100, {
      bold: true,
      fontColor: 'FF1F3864',
      fill: ZEBRA_FILL,
      border: true,
      align: 'right',
      numFmt: CURRENCY_FMT,
    });
    r++;
  }

  if (history.truncated) {
    r++;
    setCell(sheet, r, 0, 'Se muestran sólo los primeros movimientos del período.', {
      fontColor: 'FF777777',
      align: 'left',
    });
    r++;
  }

  sheet['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: r - 1, c: lastCol },
  });
  sheet['!cols'] = [42, 26].map(colWidth);
  wb.SheetNames.push('Resumen');
  wb.Sheets['Resumen'] = sheet;
}

function buildMovimientos(wb: XLSX.WorkBook, history: DriverHistory): void {
  const sheet: WorkSheet = {};
  const headerRow = 0;
  const columns = [
    'Fecha y hora',
    'Operación',
    'Pedido',
    'Cliente',
    'Documento',
    'Zona',
    'Origen',
    'Medio de pago',
    'Detalle',
    'Unidades',
    'Total (ARS)',
    'Efectivo (ARS)',
    'Cta cte (ARS)',
    'Reversión cta cte (ARS)',
  ];
  writeHeaderRow(sheet, headerRow, columns);

  let r = headerRow + 1;
  if (history.operations.length === 0) {
    setCell(sheet, r, 0, 'Sin movimientos en el período.', {
      fontColor: 'FF777777',
      align: 'left',
    });
    r++;
  } else {
    for (const op of history.operations) {
      writeOperationRow(sheet, r, op);
      r++;
    }
  }

  const lastC = columns.length - 1;
  const dataEnd = r - 1;
  const range = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: dataEnd, c: lastC },
  });
  sheet['!ref'] = range;
  sheet['!cols'] = [
    18, 22, 10, 26, 14, 10, 12, 18, 34, 10, 16, 16, 16, 22,
  ].map(colWidth);
  sheet['!freeze'] = { xSplit: 0, ySplit: headerRow + 1 };
  if (dataEnd > headerRow) {
    sheet['!autofilter'] = { ref: range };
  }
  wb.SheetNames.push('Movimientos');
  wb.Sheets['Movimientos'] = sheet;
}

function writeOperationRow(
  sheet: WorkSheet,
  r: number,
  op: DriverHistoryEntry,
): void {
  const fill = (r - 1) % 2 === 1 ? 'FFFFFFFF' : ZEBRA_FILL;
  const border = { fill, border: true };

  setCell(sheet, r, 0, new Date(op.occurredAt), {
    ...border,
    align: 'center',
    numFmt: DATE_FMT,
  });
  setCell(sheet, r, 1, op.label, { ...border, bold: true });
  setCell(sheet, r, 2, op.orderReference ?? '', { ...border, align: 'center' });
  setCell(sheet, r, 3, op.clientName ?? '', border);
  setCell(sheet, r, 4, op.documentNumber ?? '', { ...border, align: 'center' });
  setCell(sheet, r, 5, op.zona ?? '', { ...border, align: 'center' });
  setCell(sheet, r, 6, friendlyOrigin(op.origin), { ...border, align: 'center' });
  setCell(sheet, r, 7, friendlyPaymentMethod(op.paymentMethod), {
    ...border,
    align: 'center',
  });
  setCell(sheet, r, 8, op.detail ?? '', { ...border, align: 'left' });
  setCell(sheet, r, 9, op.units ?? '', { ...border, align: 'right' });
  moneyCell(sheet, r, 10, op.totalFinalMinor ?? 0, fill);
  moneyCell(sheet, r, 11, op.cashCollectedMinor, fill);
  moneyCell(sheet, r, 12, op.accountChargedMinor, fill);
  moneyCell(sheet, r, 13, op.accountReversedMinor, fill);
}

export function buildDriverHistoryWorkbook(
  history: DriverHistory,
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  buildResumen(wb, history);
  buildMovimientos(wb, history);
  return wb;
}

export function buildDriverHistoryFilename(
  filters: DriverHistoryFilters,
): string {
  const safePeriod =
    filters.period === REPORT_PERIOD_PRESETS.CUSTOM && filters.dateFrom
      ? `${filters.dateFrom}_a_${filters.dateTo ?? filters.dateFrom}`
      : filters.period.toLowerCase();
  return `mis-movimientos-${safePeriod}.xlsx`;
}