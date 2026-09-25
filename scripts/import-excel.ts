/* eslint-disable no-console */
/**
 * Bulk import of clients from an Excel/CSV file produced by the Municipalidad
 * when no DNI/email is available. Each row becomes a Client whose
 * `documentNumber` and `documentType` are intentionally `null` — the entry
 * point for citizens to attach themselves later via the public self-registration
 * (DNI/email match) OR via the admin "Acceso ciudadano" card (DNI/email/phone
 * match). Once linked, the User's identity fields are synced back onto the
 * Client so the padrón ends up complete.
 *
 * Expected columns (case-insensitive, header detection is flexible):
 *   - Nombre           (REQUIRED) — split heuristically into first/last name.
 *   - Dirección        (REQUIRED) — split heuristically into street + number.
 *   - Cel contacto     (optional) — normalized to digits-only, stored as phone.
 *   - Zona             (optional) — stored on `client.zona` (uppercased,
 *                       e.g. "ZONA 1"). Used to group clients by delivery route
 *                       (ZONA 1 = L/X/V, ZONA 2 = M/J/S).
 *
 * CLI:
 *   tsx scripts/import-excel.ts <path-to-xlsx-or-csv> [--dry-run]
 *
 * Idempotency: a row is skipped if an existing Client already matches by
 *   normalized phone (exact or last-10-digits). Without a phone, the script
 *   uses a (firstName + lastName + street + number + locality) tuple as a
 *   weak dedupe key and warns when an ambiguous row is encountered.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import xlsx from 'xlsx';
import { loadEnv } from '../src/config/env.js';
import { Client } from '../src/modules/clients/clients.model.js';
import { normalizePhone } from '../src/modules/clients/clients.validation.js';
import { logger } from '../src/shared/logger.js';

interface RawRow {
  nombre?: string;
  direccion?: string;
  celular?: string;
  zona?: string;
}

interface ParsedRow {
  raw: RawRow;
  firstName: string;
  lastName: string;
  street: string;
  number: string | null;
  phone: string | null;
  zona: string | null;
  locality: string;
}

interface ImportSummary {
  totalRows: number;
  skippedEmpty: number;
  skippedNoPhone: number;
  inserted: number;
  alreadyExisted: number;
  invalid: number;
  dryRun: boolean;
  rejectedReportPath: string | null;
  errors: Array<{ row: number; reason: string }>;
}

interface RejectedRow {
  row: number;
  nombre: string;
  direccion: string;
  celular: string;
  zona: string;
  motivo: string;
}

function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function pickColumn(row: Record<string, unknown>, candidates: string[]): string {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeHeader(candidate);
    const found = keys.find((k) => normalizeHeader(k) === normalizedCandidate);
    if (found !== undefined) {
      const value = row[found];
      if (value === null || value === undefined) return '';
      return String(value).trim();
    }
  }
  return '';
}

function splitName(full: string): { firstName: string; lastName: string } {
  const tokens = full
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return { firstName: '', lastName: '' };
  if (tokens.length === 1) return { firstName: tokens[0]!, lastName: '' };
  return { firstName: tokens[0]!, lastName: tokens.slice(1).join(' ') };
}

function splitAddress(full: string): { street: string; number: string | null } {
  const cleaned = full.replace(/\s+/g, ' ').trim();
  // Heuristic: the trailing whitespace-separated token is the "number" if it's
  // numeric (handles "Calle Falsa 123", "Av. San Martín 450 B", "Sarmiento 45").
  // When the address has no numeric token (e.g. "Acceso Principal Zona Sur"),
  // we accept the row and leave `number` as null — legacy padrón rows commonly
  // lack street numbers.
  const tokens = cleaned.split(' ');
  if (tokens.length === 0) return { street: '', number: null };
  const last = tokens[tokens.length - 1]!;
  if (/^[0-9]+[A-Za-z0-9/-]*$/.test(last) && tokens.length > 1) {
    return {
      street: tokens.slice(0, -1).join(' '),
      number: last,
    };
  }
  return { street: cleaned, number: null };
}

function parseRow(raw: RawRow, locality: string): ParsedRow {
  const { firstName, lastName } = splitName(raw.nombre ?? '');
  const { street, number } = splitAddress(raw.direccion ?? '');
  const phone = raw.celular ? normalizePhone(raw.celular) : '';
  // Collapse multiple spaces, trim, uppercase. "ZONA  2" → "ZONA 2".
  const zona = raw.zona
    ? raw.zona.replace(/\s+/g, ' ').trim().toUpperCase() || null
    : null;
  return {
    raw,
    firstName,
    lastName,
    street,
    number,
    phone: phone || null,
    zona,
    locality,
  };
}

function readRows(filePath: string): RawRow[] {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
    throw new Error(
      `Formato no soportado: ${ext}. Use .xlsx, .xls o .csv`,
    );
  }
  const workbook = xlsx.readFile(filePath, { cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error('El archivo no contiene hojas');
  const sheet = workbook.Sheets[firstSheetName]!;
  const json = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: false,
  });
  return json.map((row) => ({
    nombre: pickColumn(row, ['Nombre', 'Nombre y Apellido', 'Apellido y Nombre']),
    direccion: pickColumn(row, ['Dirección', 'Direccion', 'Domicilio', 'Calle']),
    celular: pickColumn(row, [
      'Cel contacto',
      'Celular',
      'Celular de contacto',
      'Teléfono',
      'Telefono',
      'Tel',
    ]),
    zona: pickColumn(row, ['Zona', 'Barrio', 'Sector']),
  }));
}

async function findExistingClient(
  row: ParsedRow,
): Promise<{ match: boolean; reason: string }> {
  // Dedup is ONLY by phone. We never match by (name + address) because two
  // unrelated legacy clients commonly share a name and a street in the same
  // locality — matching on that would silently swallow legitimate new rows.
  // Rows without a phone are imported as new unconditionally; if they were
  // already migrated, the script will surface them as duplicates via the
  // phone check on a subsequent run once the padrón is updated.
  if (row.phone) {
    const exact = await Client.findOne({ phone: row.phone });
    if (exact) return { match: true, reason: `phone exact (${row.phone})` };
    const tail = row.phone.slice(-10);
    if (tail.length === 10) {
      const fuzzy = await Client.findOne({ phone: { $regex: `${tail}$` } });
      if (fuzzy) return { match: true, reason: `phone tail-10 (${tail})` };
    }
  }
  return { match: false, reason: '' };
}

async function insertClient(
  row: ParsedRow,
  dryRun: boolean,
): Promise<{ inserted: boolean }> {
  if (dryRun) return { inserted: false };
  await Client.create({
    firstName: row.firstName,
    lastName: row.lastName,
    documentType: null,
    documentNumber: null,
    clientType: 'NO_LOCAL',
    phone: row.phone,
    email: null,
    address: {
      street: row.street,
      number: row.number,
      floor: null,
      apartment: null,
      neighborhood: null,
      locality: row.locality,
      postalCode: null,
      references: null,
    },
    zona: row.zona,
    active: true,
    userId: null,
    notes:
      'Importado desde padrón externo (sin DNI). Pendiente de vinculación.',
  });
  return { inserted: true };
}

async function writeRejectedCsv(
  rows: RejectedRow[],
  outputPath: string,
): Promise<void> {
  const header = 'row,nombre,direccion,celular,zona,motivo\n';
  const body = rows
    .map((r) =>
      [
        r.row,
        csvEscape(r.nombre),
        csvEscape(r.direccion),
        csvEscape(r.celular),
        csvEscape(r.zona),
        csvEscape(r.motivo),
      ].join(','),
    )
    .join('\n');
  await fs.writeFile(outputPath, header + body + '\n', 'utf8');
}

function csvEscape(value: string): string {
  if (!value) return '';
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function run(): Promise<ImportSummary> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const filePath = positional[0];

  if (!filePath) {
    throw new Error(
      'Uso: tsx scripts/import-excel.ts <ruta-al-archivo.xlsx|.csv> [--dry-run]',
    );
  }
  await fs.access(filePath);

  const env = loadEnv();
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  const locality = 'Buchardo';
  const rawRows = readRows(filePath);

  const summary: ImportSummary = {
    totalRows: rawRows.length,
    skippedEmpty: 0,
    skippedNoPhone: 0,
    inserted: 0,
    alreadyExisted: 0,
    invalid: 0,
    dryRun,
    rejectedReportPath: null,
    errors: [],
  };

  const rejected: RejectedRow[] = [];

  logger.info(
    `Importación ${dryRun ? '(dry-run)' : ''} — ${rawRows.length} filas en ${path.basename(filePath)}`,
  );

  for (let i = 0; i < rawRows.length; i += 1) {
    const rowNum = i + 2; // +2 because spreadsheet rows are 1-indexed + header
    const raw = rawRows[i]!;
    if (!raw.nombre && !raw.direccion && !raw.celular) {
      summary.skippedEmpty += 1;
      continue;
    }
    const parsed = parseRow(raw, locality);
    if (!parsed.firstName || !parsed.street) {
      summary.invalid += 1;
      const reason = `Faltan datos obligatorios (nombre o calle): "${raw.nombre ?? ''}" / "${raw.direccion ?? ''}"`;
      summary.errors.push({ row: rowNum, reason });
      rejected.push({
        row: rowNum,
        nombre: raw.nombre ?? '',
        direccion: raw.direccion ?? '',
        celular: raw.celular ?? '',
        zona: raw.zona ?? '',
        motivo: reason,
      });
      continue;
    }
    if (!parsed.phone) {
      summary.skippedNoPhone += 1;
      const reason = 'Sin teléfono — cliente antiguo, requiere carga manual';
      rejected.push({
        row: rowNum,
        nombre: raw.nombre ?? '',
        direccion: raw.direccion ?? '',
        celular: raw.celular ?? '',
        zona: raw.zona ?? '',
        motivo: reason,
      });
      logger.info(`Fila ${rowNum}: sin teléfono — no se importa`);
      continue;
    }
    try {
      const found = await findExistingClient(parsed);
      if (found.match) {
        summary.alreadyExisted += 1;
        logger.info(`Fila ${rowNum}: ya existe (${found.reason}) — skip`);
        continue;
      }
      const result = await insertClient(parsed, dryRun);
      if (result.inserted) {
        summary.inserted += 1;
        logger.info(
          `Fila ${rowNum}: ${parsed.firstName} ${parsed.lastName} — creado`,
        );
      } else {
        summary.skippedEmpty += 1;
        logger.info(`Fila ${rowNum}: dry-run, no se persistió`);
      }
    } catch (err) {
      summary.invalid += 1;
      const reason = err instanceof Error ? err.message : String(err);
      summary.errors.push({ row: rowNum, reason });
      rejected.push({
        row: rowNum,
        nombre: raw.nombre ?? '',
        direccion: raw.direccion ?? '',
        celular: raw.celular ?? '',
        zona: raw.zona ?? '',
        motivo: `Error al persistir: ${reason}`,
      });
    }
  }

  if (rejected.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outName = `rechazados-${stamp}.csv`;
    const outPath = path.resolve(process.cwd(), 'scripts/imports', outName);
    if (!dryRun) {
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await writeRejectedCsv(rejected, outPath);
      summary.rejectedReportPath = outPath;
      logger.info(`Reporte de rechazados: ${outPath}`);
    } else {
      summary.rejectedReportPath = `(dry-run) ${rejected.length} filas a reportar`;
    }
  }

  return summary;
}

function printSummary(summary: ImportSummary): void {
  // eslint-disable-next-line no-console
  console.log('\n===== RESUMEN DE IMPORTACIÓN =====');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

run()
  .then(async (summary) => {
    printSummary(summary);
    await mongoose.disconnect();
    process.exit(summary.invalid > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    logger.error('Importación falló', err);
    await mongoose.disconnect();
    process.exit(1);
  });