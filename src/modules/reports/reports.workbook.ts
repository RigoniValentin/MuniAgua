/**
 * Helper utilities for the /admin/informes xlsx workbook.
 *
 * Kept separate from the controller so the SheetJS-specific code (cell
 * styles, number formats, alignment) is easy to maintain in one place.
 */
import * as XLSX from 'xlsx';
import type { CellObject, WorkSheet } from 'xlsx';

export const CURRENCY_FMT = '"$"#,##0.00';
export const DATE_FMT = 'dd/mm/yyyy hh:mm';

/** Map enums from the domain to user-facing Spanish labels. */
export function friendlyClientType(t: string): string {
  switch (t) {
    case 'LOCAL':
      return 'Local';
    case 'JUBILADO':
      return 'Jubilado';
    case 'NO_LOCAL':
      return 'No local';
    case 'AYUDA_SOCIAL':
      return 'Ayuda social';
    default:
      return t;
  }
}

export function friendlyProductType(t: string): string {
  switch (t) {
    case 'WATER_REFILL':
      return 'Recarga de agua';
    case 'CONTAINER':
      return 'Bidón';
    case 'DISPENSER':
      return 'Dispenser';
    case 'OTHER':
      return 'Otro';
    default:
      return t;
  }
}

export function friendlyOrigin(o: string): string {
  switch (o) {
    case 'CITIZEN':
      return 'Vecino';
    case 'STAFF':
      return 'Oficina';
    default:
      return o;
  }
}

export function friendlyPaymentMethod(p: string): string {
  switch (p) {
    case 'CASH':
      return 'Efectivo';
    case 'ACCOUNT':
      return 'Cuenta corriente';
    default:
      return p;
  }
}

export function friendlyClientTypeFilter(t: string | null | undefined): string {
  if (!t) return 'Todos';
  return friendlyClientType(t);
}

/** Last 6 chars of an ObjectId-like id — short and Excel-friendly. */
export function shortId(id: string | null | undefined): string {
  if (!id) return '';
  return id.slice(-6).toUpperCase();
}

/** Pretty date string used in summary / filename: yyyy-mm-dd. */
export function isoDateOnly(s: string): string {
  if (!s) return '';
  return s.length >= 10 ? s.slice(0, 10) : s;
}

interface StylePreset {
  bold?: boolean;
  fontSize?: number;
  fontColor?: string;
  fill?: string;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  wrap?: boolean;
  numFmt?: string;
  border?: boolean;
}

interface BorderEdge {
  style: 'thin';
  color: { rgb: string };
}
interface BorderDef {
  top: BorderEdge;
  bottom: BorderEdge;
  left: BorderEdge;
  right: BorderEdge;
}
const BORDER_THIN: BorderDef = {
  top: { style: 'thin', color: { rgb: 'FFBFBFBF' } },
  bottom: { style: 'thin', color: { rgb: 'FFBFBFBF' } },
  left: { style: 'thin', color: { rgb: 'FFBFBFBF' } },
  right: { style: 'thin', color: { rgb: 'FFBFBFBF' } },
};

function applyStyle(cell: CellObject, preset: StylePreset): void {
  cell.s = {
    ...(cell.s ?? {}),
    font: {
      bold: preset.bold ?? false,
      sz: preset.fontSize ?? 11,
      color: preset.fontColor ? { rgb: preset.fontColor } : { rgb: 'FF1F3864' },
      name: 'Calibri',
    },
    alignment: {
      horizontal: preset.align ?? 'left',
      vertical: preset.valign ?? 'middle',
      wrapText: preset.wrap ?? false,
    },
  };
  if (preset.fill) {
    cell.s.fill = { patternType: 'solid', fgColor: { rgb: preset.fill } };
  }
  if (preset.border) {
    cell.s.border = BORDER_THIN;
  }
  if (preset.numFmt) {
    cell.z = preset.numFmt;
  }
}

function styledCell(
  value: string | number | boolean,
  preset: StylePreset = {},
): CellObject {
  const cell: CellObject = { v: value, t: typeof value === 'number' ? 'n' : 's' };
  applyStyle(cell, preset);
  return cell;
}

/** Place a styled cell at (rowIdx, colIdx) of the given worksheet. */
export function setCell(
  sheet: WorkSheet,
  rowIdx: number,
  colIdx: number,
  value: string | number | Date | boolean,
  preset: StylePreset = {},
): void {
  const addr = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
  if (value instanceof Date) {
    const cell: CellObject = { v: value, t: 'd' };
    applyStyle(cell, preset);
    sheet[addr] = cell;
    return;
  }
  sheet[addr] = styledCell(value as string | number | boolean, preset);
}

export function colWidth(wch: number): { wch: number } {
  return { wch };
}

/**
 * Place a top header row (merged title) and a thin subtitle, then return
 * the next empty row index. Useful for the Resumen sheet.
 */
export function writeTitle(
  sheet: WorkSheet,
  title: string,
  subtitle: string,
  lastCol: number,
): void {
  setCell(sheet, 0, 0, title, {
    bold: true,
    fontSize: 16,
    fontColor: 'FFFFFFFF',
    fill: 'FF1F3864',
    align: 'left',
  });
  for (let c = 1; c <= lastCol; c++) {
    setCell(sheet, 0, c, '', {
      bold: true,
      fontSize: 16,
      fontColor: 'FFFFFFFF',
      fill: 'FF1F3864',
      align: 'left',
    });
  }
  if (!sheet['!merges']) sheet['!merges'] = [];
  sheet['!merges'].push({ s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } });

  setCell(sheet, 1, 0, subtitle, {
    fontSize: 11,
    fontColor: 'FF555555',
    align: 'left',
  });
  for (let c = 1; c <= lastCol; c++) {
    setCell(sheet, 1, c, '', {
      fontSize: 11,
      fontColor: 'FF555555',
      align: 'left',
    });
  }
  sheet['!merges'].push({ s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } });
}
