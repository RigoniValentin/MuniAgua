/* eslint-disable no-console */
/**
 * Migración del padrón de saldos de cuenta corriente y tipo de cliente.
 *
 * El municipio entrega un CSV (`Nombre;TipoCliente;Saldo CTA CTE`) con el
 * saldo de cuenta corriente de cada cliente del padrón y su tipo de cliente.
 * Este script:
 *
 *   1. Aplica el `TipoCliente` al `Client.clientType`.
 *   2. Registra el `Saldo CTA CTE` como un movimiento `OPENING_BALANCE`
 *      (DEBIT cuando el saldo es positivo) en el ledger `AccountMovement`.
 *
 * El saldo NUNCA se escribe como campo en `Client`: la cuenta corriente se
 * deriva siempre del ledger (`accounts.service.ts` → `aggregateClientTotals`).
 * Por eso la migración crea un movimiento y no hace un `UPDATE` de saldo.
 *
 * ── Formato del CSV ────────────────────────────────────────────────────────
 *   - Delimitador `;` (puede venir entrecomillado).
 *   - `Nombre` viene en formato `Apellido,Nombre` (mismo criterio que el
 *     padrón original: "Toledo,Juana" → apellido Toledo, nombre Juana).
 *   - `Saldo CTA CTE` está en PESOS (unidades mayores), no en centavos. El
 *     backend trabaja en minor units (×100) — ver `src/shared/money.ts`.
 *   - `TipoCliente` NO usa los valores exactos del enum del backend:
 *       LOCAL         → LOCAL
 *       JUBILADO      → JUBILADO
 *       JIBILADO      → JUBILADO   (typo en el padrón)
 *       AYUDA SOCIAL  → AYUDA_SOCIAL
 *       NOLOCAL       → NO_LOCAL
 *
 * ── Matching de clientes ───────────────────────────────────────────────────
 * El CSV no trae DNI, así que el matching es por nombre. El padrón se
 * importó con el apellido en `firstName` (ver `scripts/import-excel.ts` →
 * `splitName`), por eso el script indexa los clientes en DOS orientaciones:
 *
 *   A) `firstName|lastName` → orientación actual de la base.
 *   B) `lastName|firstName` → orientación corregida.
 *
 * Se busca el CSV en A y luego en B, de modo que el script sigue funcionando
 * si más adelante se corrigen los nombres de los clientes importados.
 *
 * ── Seguridad / idempotencia ───────────────────────────────────────────────
 *   - Sin `--confirm` no se escribe NADA (hace falta `--dry-run` o
 *     `--confirm` explícito).
 *   - Cada movimiento usa `idempotencyKey = import:saldos-cta-cte:<slug>`.
 *     Re-correr el script con el mismo CSV es un no-op (el `postMovement`
 *     devuelve el movimiento existente). Si el saldo cambió, se reporta
 *     `CONFLICTO` — nunca se duplica el efecto financiero.
 *   - Antes de escribir se guarda un snapshot JSON con el `clientType`
 *     anterior y el `movementId` creado, para poder revertir con
 *     `--rollback <snapshot.json>`.
 *
 * ── CLI ────────────────────────────────────────────────────────────────────
 *   tsx scripts/import-saldos-cta-cte.ts <ruta.csv> [--dry-run|--confirm]
 *       [--only-types] [--only-balances] [--skip-test-clients]
 *       [--out-dir <dir>]
 *   tsx scripts/import-saldos-cta-cte.ts --rollback <snapshot.json> [--confirm]
 *
 *   --dry-run            simula todo y escribe sólo el reporte (sin tocar la BD)
 *   --confirm            aplica los cambios
 *   --only-types         aplica sólo el tipo de cliente
 *   --only-balances      aplica sólo los saldos
 *   --skip-test-clients  ignora filas cuyo nombre empieza con "Test Client"
 *   --out-dir <dir>      dónde escribir el reporte y el snapshot
 *                       (default: storage/imports — gitignored)
 *
 * ── Notas de despliegue ────────────────────────────────────────────────────
 *   - `scripts/` no se compila (`tsconfig.build.json` sólo incluye `src/`),
 *     así que el script se corre desde el código fuente con `tsx`.
 *   - Correr siempre desde la raíz de `MuniBack/` (dotenv lee `.env` del CWD).
 *   - `MONGO_TRANSACTION_MODE` debe quedar en `auto` (el servidor es
 *     standalone y no soporta transacciones).
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Types, type AnyBulkWriteOperation } from 'mongoose';
import { loadEnv } from '../src/config/env.js';
import { connectMongo, disconnectMongo } from '../src/config/mongo.js';
import { Client, type ClientDocument } from '../src/modules/clients/clients.model.js';
import { User } from '../src/modules/users/users.model.js';
import { AccountMovement } from '../src/modules/accounts/account-movements.model.js';
import {
  IdempotencyConflictError,
  postMovement,
  reverseMovement,
} from '../src/modules/accounts/accounts.service.js';
import type { ClientType } from '../src/modules/clients/clients.types.js';
import { toMinorUnits } from '../src/shared/money.js';
import { logger } from '../src/shared/logger.js';

// ============================================================================
// Constantes
// ============================================================================

const DELIMITER = ';';

/**
 * Mapa explícito `TipoCliente` del CSV → enum `ClientType` del backend.
 * Los valores con espacio o sin underscore son los que trae el padrón.
 */
const TIPO_CLIENTE_MAP: Record<string, ClientType> = {
  LOCAL: 'LOCAL',
  JUBILADO: 'JUBILADO',
  JIBILADO: 'JUBILADO',
  'AYUDA SOCIAL': 'AYUDA_SOCIAL',
  AYUDA_SOCIAL: 'AYUDA_SOCIAL',
  NOLOCAL: 'NO_LOCAL',
  'NO LOCAL': 'NO_LOCAL',
  NO_LOCAL: 'NO_LOCAL',
};

const MOVEMENT_TYPE = 'OPENING_BALANCE' as const;
const SOURCE_TYPE = 'SYSTEM' as const;
const IDEMPOTENCY_PREFIX = 'import:saldos-cta-cte';
const MOVEMENT_DESCRIPTION = 'Saldo inicial migrado desde SaldosCtaCte.csv';
const REVERSAL_DESCRIPTION =
  'Reversión de saldo inicial migrado desde SaldosCtaCte.csv';

const DEFAULT_OUT_DIR = 'storage/imports';

/** Nombres de columna aceptados en el header, ya normalizados. */
const COLUMN_ALIASES = {
  nombre: ['nombre', 'nombreyapellido', 'apellidoynombre', 'apellidonombre'],
  tipo: ['tipocliente', 'tipodecliente', 'tipo', 'cliente', 'categoriacliente'],
  saldo: ['saldoctacte', 'saldocuenta', 'saldocta', 'saldo', 'deuda'],
};

// ============================================================================
// Tipos
// ============================================================================

type RowStatus =
  | 'OK'
  | 'YA_APLICADO'
  | 'SIN_SALDO'
  | 'CONFLICTO'
  | 'NO_ENCONTRADO'
  | 'AMBIGUO'
  | 'TIPO_INVALIDO'
  | 'SALDO_INVALIDO'
  | 'NOMBRE_INVALIDO'
  | 'CLIENTE_DUPLICADO'
  | 'CLAVE_DUPLICADA'
  | 'OMITIDO_TEST';

type Orientation = 'ACTUAL' | 'CORREGIDA';

interface ClientRow {
  id: string;
  firstName: string;
  lastName: string;
  clientType: ClientType;
}

interface CsvRow {
  line: number;
  nombre: string;
  lastName: string;
  firstName: string;
  tipoRaw: string;
  clientType: ClientType;
  saldoMajor: number;
  /** Monto en minor units con signo: positivo = el cliente debe. */
  signedMinor: number;
  amountMinor: number;
  direction: 'DEBIT' | 'CREDIT';
}

interface ProcessedRow {
  line: number;
  nombre: string;
  tipoRaw: string;
  clientType: ClientType | null;
  orientation: Orientation | null;
  clientId: string | null;
  clientTypeBefore: ClientType | null;
  clientTypeAfter: ClientType | null;
  typeApplied: boolean;
  saldoMajor: number;
  signedMinor: number;
  amountMinor: number;
  direction: 'DEBIT' | 'CREDIT';
  movementApplied: boolean;
  saldoPrevioMinor: number;
  esperadoMinor: number;
  balanceFinalMinor: number | null;
  diferenciaMinor: number | null;
  movimientoId: string | null;
  idempotencyKey: string | null;
  status: RowStatus;
  detalle: string;
}

interface SnapshotEntry {
  clientId: string;
  nombre: string;
  previousClientType: ClientType;
  newClientType: ClientType;
  movementId: string | null;
  idempotencyKey: string | null;
}

interface Snapshot {
  generatedAt: string;
  csvPath: string | null;
  operatorEmail: string | null;
  entries: SnapshotEntry[];
  uncoveredClients: Array<{ clientId: string; nombre: string }>;
}

interface RunSummary {
  dryRun: boolean;
  totalRows: number;
  matched: number;
  appliedTypes: number;
  unchangedTypes: number;
  movementsCreated: number;
  movementsAlreadyApplied: number;
  conflicts: number;
  errors: number;
  uncoveredClients: number;
  totalSaldoMinor: number;
  statusCounts: Record<string, number>;
  reportPath: string | null;
  snapshotPath: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

/** Normaliza un texto para comparar: sin acentos, minúsculas, espacios colapsados. */
function normalize(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Normaliza un header de columna: sin acentos ni puntuación. */
function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * Divide una línea CSV respetando campos entrecomillados con `""` como escape.
 * El padrón no usa comillas, pero un export de otra herramienta sí podría.
 */
function splitDelimited(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      fields.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields;
}

/** Slug estable para la `idempotencyKey`. */
function buildSlug(lastName: string, firstName: string): string {
  const slug = `${normalize(lastName)}-${normalize(firstName)}`
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'sin-nombre';
}

/** CSV escape RFC 4180 para el reporte de reconciliación. */
function csvEscape(value: string | number | null): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

// ============================================================================
// Lectura del CSV
// ============================================================================

interface CsvTable {
  headers: string[];
  rows: string[][];
}

interface CsvColumns {
  nombre: number;
  tipo: number;
  saldo: number;
}

async function readCsv(filePath: string): Promise<CsvTable> {
  const raw = await fs.readFile(filePath, 'utf8');
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = withoutBom.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new Error('El CSV está vacío');
  }

  const headers = splitDelimited(lines[0]!, DELIMITER).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => splitDelimited(line, DELIMITER));
  return { headers, rows };
}

/** Resuelve los índices de columna por nombre (tolerante a variaciones). */
function resolveColumns(headers: string[]): CsvColumns {
  const normalized = headers.map(normalizeHeader);
  const find = (aliases: string[]): number => {
    for (const alias of aliases) {
      const index = normalized.indexOf(alias);
      if (index >= 0) return index;
    }
    return -1;
  };

  const nombre = find(COLUMN_ALIASES.nombre);
  const tipo = find(COLUMN_ALIASES.tipo);
  const saldo = find(COLUMN_ALIASES.saldo);

  const missing: string[] = [];
  if (nombre < 0) missing.push('Nombre');
  if (tipo < 0) missing.push('TipoCliente');
  if (saldo < 0) missing.push('Saldo CTA CTE');

  if (missing.length > 0) {
    throw new Error(
      `El CSV no tiene las columnas requeridas (${missing.join(', ')}). ` +
        `Headers encontrados: ${headers.join(' | ')}`,
    );
  }
  return { nombre, tipo, saldo };
}

/** Convierte una fila cruda en una `CsvRow` validada. */
function parseRow(
  fields: string[],
  columns: CsvColumns,
  line: number,
): { row: CsvRow | null; status: RowStatus | null; detalle: string } {
  const nombreRaw = (fields[columns.nombre] ?? '').trim();
  const tipoRaw = (fields[columns.tipo] ?? '').trim();
  const saldoRaw = (fields[columns.saldo] ?? '').trim();

  if (!nombreRaw) {
    return { row: null, status: 'NOMBRE_INVALIDO', detalle: 'Nombre vacío' };
  }

  const commaIndex = nombreRaw.indexOf(',');
  if (commaIndex < 0) {
    return {
      row: null,
      status: 'NOMBRE_INVALIDO',
      detalle: `Nombre sin coma (se espera "Apellido,Nombre"): "${nombreRaw}"`,
    };
  }

  const lastName = nombreRaw.slice(0, commaIndex).trim();
  const firstName = nombreRaw.slice(commaIndex + 1).trim();
  if (!lastName || !firstName) {
    return {
      row: null,
      status: 'NOMBRE_INVALIDO',
      detalle: `Nombre incompleto: "${nombreRaw}"`,
    };
  }

  const tipoNormalized = tipoRaw.toUpperCase().replace(/\s+/g, ' ').trim();
  const clientType = TIPO_CLIENTE_MAP[tipoNormalized] ?? null;

  if (!clientType) {
    return {
      row: null,
      status: 'TIPO_INVALIDO',
      detalle: `Tipo de cliente desconocido: "${tipoRaw}"`,
    };
  }

  if (!/^-?\d+(\.\d{1,2})?$/.test(saldoRaw)) {
    return {
      row: null,
      status: 'SALDO_INVALIDO',
      detalle: `Saldo no numérico: "${saldoRaw}"`,
    };
  }

  const saldoMajor = Number(saldoRaw);
  if (!Number.isFinite(saldoMajor)) {
    return {
      row: null,
      status: 'SALDO_INVALIDO',
      detalle: `Saldo no numérico: "${saldoRaw}"`,
    };
  }

  // Convención del ledger: saldo positivo = el cliente DEBE (DEBIT).
  const signedMinor = toMinorUnits(saldoMajor);
  const direction: 'DEBIT' | 'CREDIT' = signedMinor < 0 ? 'CREDIT' : 'DEBIT';

  return {
    row: {
      line,
      nombre: nombreRaw,
      lastName,
      firstName,
      tipoRaw,
      clientType,
      saldoMajor,
      signedMinor,
      amountMinor: Math.abs(signedMinor),
      direction,
    },
    status: null,
    detalle: '',
  };
}

// ============================================================================
// Matching de clientes
// ============================================================================

interface ClientIndex {
  /** Orientación actual de la base: `firstName` contiene el apellido. */
  byCurrent: Map<string, ClientRow[]>;
  /** Orientación corregida: `lastName` contiene el apellido. */
  byCorrected: Map<string, ClientRow[]>;
}

function buildClientIndex(clients: ClientRow[]): ClientIndex {
  const byCurrent = new Map<string, ClientRow[]>();
  const byCorrected = new Map<string, ClientRow[]>();

  const push = (
    map: Map<string, ClientRow[]>,
    key: string,
    client: ClientRow,
  ): void => {
    const bucket = map.get(key);
    if (bucket) bucket.push(client);
    else map.set(key, [client]);
  };

  for (const client of clients) {
    push(
      byCurrent,
      `${normalize(client.firstName)}|${normalize(client.lastName)}`,
      client,
    );
    push(
      byCorrected,
      `${normalize(client.lastName)}|${normalize(client.firstName)}`,
      client,
    );
  }
  return { byCurrent, byCorrected };
}

interface MatchResult {
  client: ClientRow | null;
  orientation: Orientation | null;
  detalle: string;
}

function matchClient(
  index: ClientIndex,
  lastName: string,
  firstName: string,
): MatchResult {
  const key = `${normalize(lastName)}|${normalize(firstName)}`;
  const current = index.byCurrent.get(key) ?? [];
  const corrected = index.byCorrected.get(key) ?? [];

  const candidates = new Map<string, ClientRow>();
  for (const client of current) candidates.set(client.id, client);
  for (const client of corrected) candidates.set(client.id, client);

  if (candidates.size === 0) {
    return {
      client: null,
      orientation: null,
      detalle: `No se encontró ningún cliente con el nombre "${lastName}, ${firstName}"`,
    };
  }
  if (candidates.size > 1) {
    const names = [...candidates.values()]
      .map((c) => `${c.firstName} ${c.lastName}`)
      .join(' / ');
    return {
      client: null,
      orientation: null,
      detalle: `Nombre ambiguo, ${candidates.size} candidatos: ${names}`,
    };
  }

  const client = [...candidates.values()][0]!;
  const matchedCurrent = current.some((c) => c.id === client.id);
  const matchedCorrected = corrected.some((c) => c.id === client.id);

  if (matchedCurrent && matchedCorrected) {
    return {
      client,
      orientation: 'ACTUAL',
      detalle: 'Coincide en ambas orientaciones',
    };
  }
  return {
    client,
    orientation: matchedCurrent ? 'ACTUAL' : 'CORREGIDA',
    detalle: '',
  };
}

// ============================================================================
// Balances
// ============================================================================

/** Saldo actual por cliente, derivado del ledger (misma fórmula que el backend). */
async function loadBalances(clientIds: string[]): Promise<Map<string, number>> {
  const balances = new Map<string, number>();
  if (clientIds.length === 0) return balances;

  const objectIds = clientIds
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));

  const rows = await AccountMovement.aggregate<{
    _id: Types.ObjectId;
    totalDebitsMinor: number;
    totalCreditsMinor: number;
  }>([
    { $match: { clientId: { $in: objectIds } } },
    {
      $group: {
        _id: '$clientId',
        totalDebitsMinor: {
          $sum: { $cond: [{ $eq: ['$direction', 'DEBIT'] }, '$amountMinor', 0] },
        },
        totalCreditsMinor: {
          $sum: { $cond: [{ $eq: ['$direction', 'CREDIT'] }, '$amountMinor', 0] },
        },
      },
    },
  ]);

  for (const row of rows) {
    balances.set(
      String(row._id),
      (row.totalDebitsMinor ?? 0) - (row.totalCreditsMinor ?? 0),
    );
  }
  return balances;
}

// ============================================================================
// Reporte
// ============================================================================

const REPORT_HEADERS = [
  'linea',
  'nombre',
  'tipo_csv',
  'tipo_aplicado',
  'orientacion',
  'client_id',
  'saldo_csv',
  'saldo_minor',
  'saldo_previo_minor',
  'esperado_minor',
  'balance_final_minor',
  'diferencia_minor',
  'estado',
  'detalle',
];

async function writeReconciliationReport(
  rows: ProcessedRow[],
  outputPath: string,
): Promise<void> {
  const body = rows
    .map((row) =>
      [
        row.line,
        csvEscape(row.nombre),
        csvEscape(row.tipoRaw),
        csvEscape(row.clientTypeAfter ?? row.clientType),
        csvEscape(row.orientation),
        csvEscape(row.clientId),
        row.saldoMajor,
        row.signedMinor,
        row.saldoPrevioMinor,
        row.esperadoMinor,
        row.balanceFinalMinor,
        row.diferenciaMinor,
        row.status,
        csvEscape(row.detalle),
      ].join(','),
    )
    .join('\n');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    `${REPORT_HEADERS.join(',')}\n${body}\n`,
    'utf8',
  );
}

// ============================================================================
// Operador
// ============================================================================

/**
 * Resuelve el `User` que queda registrado como `createdBy` / `updatedBy`.
 * Se busca por `IMPORT_OPERATOR_EMAIL` y, si no está, por
 * `TREASURY_ADMIN_EMAIL` (que ya existe en el `.env` de producción).
 */
async function resolveOperator(): Promise<string | null> {
  const candidates = [
    process.env.IMPORT_OPERATOR_EMAIL,
    process.env.TREASURY_ADMIN_EMAIL,
    process.env.ACCOUNTING_ADMIN_EMAIL,
  ].filter((value): value is string => Boolean(value && value.trim()));

  for (const email of candidates) {
    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (user) return user._id.toString();
  }
  logger.warn(
    'No se encontró un usuario operador (IMPORT_OPERATOR_EMAIL / TREASURY_ADMIN_EMAIL / ' +
      'ACCOUNTING_ADMIN_EMAIL) — los cambios quedan sin createdBy/updatedBy.',
  );
  return null;
}

// ============================================================================
// Rollback
// ============================================================================

async function runRollback(
  snapshotPath: string,
  confirm: boolean,
): Promise<{ movementsReversed: number; typesRestored: number; failures: number }> {
  const raw = await fs.readFile(snapshotPath, 'utf8');
  const snapshot = JSON.parse(raw) as Snapshot;

  const operator = await resolveOperator();
  let typesRestored = 0;
  let movementsReversed = 0;
  let failures = 0;

  for (const entry of snapshot.entries) {
    if (entry.movementId) {
      try {
        const existing = await AccountMovement.findById(entry.movementId);
        if (!existing) {
          logger.warn(
            `[rollback] ${entry.nombre}: el movimiento ${entry.movementId} no existe`,
          );
        } else {
          const alreadyReversed = await AccountMovement.findOne({
            reversesMovementId: entry.movementId,
          });
          if (alreadyReversed) {
            logger.info(`[rollback] ${entry.nombre}: ya estaba revertido — skip`);
          } else if (!confirm) {
            logger.info(
              `[rollback] ${entry.nombre}: revertir movimiento ${entry.movementId}`,
            );
          } else {
            await reverseMovement({
              movementId: entry.movementId,
              description: REVERSAL_DESCRIPTION,
              createdBy: operator,
            });
            movementsReversed += 1;
          }
        }
      } catch (err) {
        failures += 1;
        logger.error(`[rollback] ${entry.nombre}: no se pudo revertir`, err);
      }
    }

    if (
      entry.previousClientType &&
      entry.newClientType &&
      entry.previousClientType !== entry.newClientType
    ) {
      const clientExists = await Client.exists({ _id: new Types.ObjectId(entry.clientId) });
      if (!clientExists) {
        failures += 1;
        logger.warn(
          `[rollback] ${entry.nombre}: el cliente ${entry.clientId} ya no existe — ` +
            'el snapshot no corresponde a la base actual (¿se re-sembró la base?)',
        );
        continue;
      }
      if (!confirm) {
        logger.info(
          `[rollback] ${entry.nombre}: restaurar tipo ${entry.newClientType} → ${entry.previousClientType}`,
        );
      } else {
        await Client.updateOne(
          { _id: new Types.ObjectId(entry.clientId) },
          {
            $set: {
              clientType: entry.previousClientType,
              updatedAt: new Date(),
              ...(operator && Types.ObjectId.isValid(operator)
                ? { updatedBy: new Types.ObjectId(operator) }
                : {}),
            },
          },
        );
        typesRestored += 1;
      }
    }
  }

  logger.info('---');
  logger.info(`Rollback dry-run=${!confirm}`);
  logger.info(`  movimientos revertidos: ${movementsReversed}`);
  logger.info(`  tipos restaurados: ${typesRestored}`);
  logger.info(`  errores: ${failures}`);

  return { movementsReversed, typesRestored, failures };
}

// ============================================================================
// Migración
// ============================================================================

interface ImportArgs {
  csvPath: string;
  dryRun: boolean;
  onlyTypes: boolean;
  onlyBalances: boolean;
  skipTestClients: boolean;
  outDir: string;
}

async function runImport(args: ImportArgs): Promise<RunSummary> {
  const { csvPath, dryRun, onlyTypes, onlyBalances, skipTestClients, outDir } = args;

  const table = await readCsv(csvPath);
  const columns = resolveColumns(table.headers);

  logger.info(
    `Importación de saldos ${dryRun ? '(dry-run)' : '(aplicando)'} — ` +
      `${table.rows.length} filas en ${path.basename(csvPath)}`,
  );

  // --- Clientes -------------------------------------------------------------
  const clientDocs = await Client.find({}, 'firstName lastName clientType').lean();
  const clients: ClientRow[] = clientDocs.map((doc) => ({
    id: doc._id.toString(),
    firstName: doc.firstName,
    lastName: doc.lastName,
    clientType: doc.clientType,
  }));
  const index = buildClientIndex(clients);
  logger.info(`Clientes en la base: ${clients.length}`);

  const operator = await resolveOperator();
  const operatorObjectId =
    operator && Types.ObjectId.isValid(operator)
      ? new Types.ObjectId(operator)
      : null;

  // --- Parseo + matching ----------------------------------------------------
  const processed: ProcessedRow[] = [];
  const usedClientIds = new Set<string>();
  const usedSlugs = new Set<string>();

  const blankRow = (
    line: number,
    fields: string[],
    status: RowStatus,
    detalle: string,
  ): ProcessedRow => ({
    line,
    nombre: (fields[columns.nombre] ?? '').trim(),
    tipoRaw: (fields[columns.tipo] ?? '').trim(),
    clientType: null,
    orientation: null,
    clientId: null,
    clientTypeBefore: null,
    clientTypeAfter: null,
    typeApplied: false,
    saldoMajor: 0,
    signedMinor: 0,
    amountMinor: 0,
    direction: 'DEBIT',
    movementApplied: false,
    saldoPrevioMinor: 0,
    esperadoMinor: 0,
    balanceFinalMinor: null,
    diferenciaMinor: null,
    movimientoId: null,
    idempotencyKey: null,
    status,
    detalle,
  });

  for (let i = 0; i < table.rows.length; i += 1) {
    const fields = table.rows[i]!;
    const line = i + 2; // +1 por el header, +1 porque las líneas son 1-indexed
    const parsed = parseRow(fields, columns, line);

    if (!parsed.row) {
      processed.push(
        blankRow(line, fields, parsed.status ?? 'NOMBRE_INVALIDO', parsed.detalle),
      );
      continue;
    }

    const row = parsed.row;

    if (skipTestClients && /^test\s+client/i.test(row.nombre)) {
      processed.push({
        ...blankRow(line, fields, 'OMITIDO_TEST', 'Cliente de prueba — omitido por --skip-test-clients'),
        clientType: row.clientType,
        saldoMajor: row.saldoMajor,
        signedMinor: row.signedMinor,
        amountMinor: row.amountMinor,
        direction: row.direction,
      });
      continue;
    }

    const match = matchClient(index, row.lastName, row.firstName);
    if (!match.client) {
      processed.push({
        ...blankRow(
          line,
          fields,
          match.detalle.startsWith('Nombre ambiguo') ? 'AMBIGUO' : 'NO_ENCONTRADO',
          match.detalle,
        ),
        clientType: row.clientType,
        orientation: match.orientation,
        saldoMajor: row.saldoMajor,
        signedMinor: row.signedMinor,
        amountMinor: row.amountMinor,
        direction: row.direction,
      });
      continue;
    }

    const client = match.client;

    if (usedClientIds.has(client.id)) {
      processed.push({
        ...blankRow(
          line,
          fields,
          'CLIENTE_DUPLICADO',
          `El cliente ${client.firstName} ${client.lastName} ya fue asignado a otra fila del CSV`,
        ),
        clientType: row.clientType,
        orientation: match.orientation,
        clientId: client.id,
        clientTypeBefore: client.clientType,
        clientTypeAfter: client.clientType,
        saldoMajor: row.saldoMajor,
        signedMinor: row.signedMinor,
        amountMinor: row.amountMinor,
        direction: row.direction,
      });
      continue;
    }
    usedClientIds.add(client.id);

    const slug = buildSlug(row.lastName, row.firstName);
    if (usedSlugs.has(slug)) {
      processed.push({
        ...blankRow(
          line,
          fields,
          'CLAVE_DUPLICADA',
          `La clave de idempotencia "${slug}" ya fue usada por otra fila`,
        ),
        clientType: row.clientType,
        orientation: match.orientation,
        clientId: client.id,
        clientTypeBefore: client.clientType,
        clientTypeAfter: client.clientType,
        saldoMajor: row.saldoMajor,
        signedMinor: row.signedMinor,
        amountMinor: row.amountMinor,
        direction: row.direction,
      });
      continue;
    }
    usedSlugs.add(slug);

    processed.push({
      line,
      nombre: row.nombre,
      tipoRaw: row.tipoRaw,
      clientType: row.clientType,
      orientation: match.orientation,
      clientId: client.id,
      clientTypeBefore: client.clientType,
      clientTypeAfter: row.clientType,
      typeApplied: false,
      saldoMajor: row.saldoMajor,
      signedMinor: row.signedMinor,
      amountMinor: row.amountMinor,
      direction: row.direction,
      movementApplied: false,
      saldoPrevioMinor: 0,
      esperadoMinor: 0,
      balanceFinalMinor: null,
      diferenciaMinor: null,
      movimientoId: null,
      idempotencyKey: `${IDEMPOTENCY_PREFIX}:${slug}`,
      status: 'OK',
      detalle: '',
    });
  }

  const matched = processed.filter((row) => row.clientId !== null);

  // --- Saldos previos (para la reconciliación) -------------------------------
  const balancesBefore = await loadBalances(matched.map((row) => row.clientId!));
  for (const row of matched) {
    row.saldoPrevioMinor = balancesBefore.get(row.clientId!) ?? 0;
  }

  // --- Fase 1: tipo de cliente ----------------------------------------------
  const typeOps: AnyBulkWriteOperation<ClientDocument>[] = [];
  let appliedTypes = 0;
  let unchangedTypes = 0;

  if (!onlyBalances) {
    for (const row of matched) {
      if (!row.clientType || row.clientTypeBefore === row.clientType) {
        unchangedTypes += 1;
        continue;
      }
      typeOps.push({
        updateOne: {
          filter: { _id: new Types.ObjectId(row.clientId!) },
          update: {
            $set: {
              clientType: row.clientType,
              updatedAt: new Date(),
              ...(operatorObjectId ? { updatedBy: operatorObjectId } : {}),
            },
          },
        },
      });
      appliedTypes += 1;
    }

    if (typeOps.length > 0) {
      if (dryRun) {
        logger.info(`(dry-run) Tipos de cliente a actualizar: ${typeOps.length}`);
      } else {
        await Client.bulkWrite(typeOps, { ordered: false });
        logger.info(`Tipos de cliente actualizados: ${typeOps.length}`);
      }
    }
    for (const row of matched) {
      if (row.clientType && row.clientTypeBefore !== row.clientType) {
        row.typeApplied = !dryRun;
        row.clientTypeAfter = dryRun ? row.clientTypeBefore : row.clientType;
      }
    }
  } else {
    unchangedTypes = matched.length;
  }

  // --- Fase 2: saldos (movimientos OPENING_BALANCE) --------------------------
  let movementsCreated = 0;
  let movementsAlreadyApplied = 0;
  let conflicts = 0;

  if (!onlyTypes) {
    for (const row of matched) {
      if (row.amountMinor <= 0) {
        row.status = 'SIN_SALDO';
        row.detalle = 'Saldo 0 — no se genera movimiento';
        continue;
      }
      if (!row.idempotencyKey || !row.clientId) continue;

      const existing = await AccountMovement.findOne({
        idempotencyKey: row.idempotencyKey,
      });

      if (existing) {
        const samePayload =
          existing.clientId.toString() === row.clientId &&
          existing.direction === row.direction &&
          existing.amountMinor === row.amountMinor &&
          existing.movementType === MOVEMENT_TYPE;
        row.movimientoId = existing._id.toString();
        if (samePayload) {
          row.status = 'YA_APLICADO';
          row.detalle = 'Movimiento ya existe con el mismo payload — no-op';
          row.movementApplied = true;
          movementsAlreadyApplied += 1;
        } else {
          row.status = 'CONFLICTO';
          row.detalle =
            'Ya existe un movimiento con la misma clave pero distinto payload — revisar antes de aplicar';
          conflicts += 1;
        }
        continue;
      }

      if (dryRun) {
        row.detalle = '(dry-run) movimiento a crear';
        continue;
      }

      try {
        const movement = await postMovement({
          clientId: row.clientId,
          direction: row.direction,
          amountMinor: row.amountMinor,
          movementType: MOVEMENT_TYPE,
          description: MOVEMENT_DESCRIPTION,
          sourceType: SOURCE_TYPE,
          occurredAt: new Date(),
          idempotencyKey: row.idempotencyKey,
          createdBy: operator,
        });
        row.movimientoId = movement._id.toString();
        row.movementApplied = true;
        movementsCreated += 1;
      } catch (err) {
        row.status = 'CONFLICTO';
        row.detalle =
          err instanceof IdempotencyConflictError
            ? 'Conflicto de idempotencia — revisar antes de aplicar'
            : err instanceof Error
              ? err.message
              : String(err);
        conflicts += 1;
      }
    }
  } else {
    for (const row of matched) {
      if (row.amountMinor > 0) {
        row.detalle = '--only-types: saldos no procesados';
      }
    }
  }

  // --- Esperado vs real ----------------------------------------------------
  for (const row of matched) {
    row.esperadoMinor = row.saldoPrevioMinor + (row.movementApplied ? row.signedMinor : 0);
  }

  // --- Snapshot (para rollback) ---------------------------------------------
  const snapshotEntries: SnapshotEntry[] = [];
  for (const row of matched) {
    const typeChanged =
      row.clientTypeBefore !== null &&
      row.clientTypeAfter !== null &&
      row.clientTypeBefore !== row.clientTypeAfter;
    if (!typeChanged && !row.movimientoId) continue;
    snapshotEntries.push({
      clientId: row.clientId!,
      nombre: row.nombre,
      previousClientType: row.clientTypeBefore ?? 'LOCAL',
      newClientType: row.clientTypeAfter ?? row.clientTypeBefore ?? 'LOCAL',
      movementId: row.movimientoId,
      idempotencyKey: row.idempotencyKey,
    });
  }

  // --- Verificación ---------------------------------------------------------
  const balancesAfter = await loadBalances(matched.map((row) => row.clientId!));
  for (const row of matched) {
    const final = balancesAfter.get(row.clientId!) ?? 0;
    row.balanceFinalMinor = final;
    row.diferenciaMinor = final - row.esperadoMinor;
  }

  // --- Clientes no cubiertos por el CSV -------------------------------------
  const uncovered = clients.filter((client) => !usedClientIds.has(client.id));

  // --- Reporte + snapshot ----------------------------------------------------
  const stamp = timestampSlug(new Date());
  const reportPath = path.resolve(
    process.cwd(),
    outDir,
    `reconciliacion-saldos-cta-cte-${stamp}.csv`,
  );
  const snapshotPath = path.resolve(
    process.cwd(),
    outDir,
    `snapshot-saldos-cta-cte-${stamp}.json`,
  );

  await writeReconciliationReport(processed, reportPath);
  logger.info(`Reporte de reconciliación: ${reportPath}`);

  if (!dryRun) {
    const snapshot: Snapshot = {
      generatedAt: new Date().toISOString(),
      csvPath: path.resolve(csvPath),
      operatorEmail:
        process.env.IMPORT_OPERATOR_EMAIL ?? process.env.TREASURY_ADMIN_EMAIL ?? null,
      entries: snapshotEntries,
      uncoveredClients: uncovered.map((client) => ({
        clientId: client.id,
        nombre: `${client.firstName}, ${client.lastName}`,
      })),
    };
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(
      snapshotPath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
      'utf8',
    );
    logger.info(`Snapshot para rollback: ${snapshotPath}`);
  }

  // --- Resumen --------------------------------------------------------------
  const statusCounts: Record<string, number> = {};
  for (const row of processed) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  }

  const errorStatuses = new Set<RowStatus>([
    'NO_ENCONTRADO',
    'AMBIGUO',
    'TIPO_INVALIDO',
    'SALDO_INVALIDO',
    'NOMBRE_INVALIDO',
    'CLIENTE_DUPLICADO',
    'CLAVE_DUPLICADA',
    'CONFLICTO',
  ]);
  const errors = processed.filter((row) => errorStatuses.has(row.status)).length;

  return {
    dryRun,
    totalRows: processed.length,
    matched: matched.length,
    appliedTypes,
    unchangedTypes,
    movementsCreated,
    movementsAlreadyApplied,
    conflicts,
    errors,
    uncoveredClients: uncovered.length,
    totalSaldoMinor: matched.reduce((acc, row) => acc + row.amountMinor, 0),
    statusCounts,
    reportPath,
    snapshotPath: dryRun ? null : snapshotPath,
  };
}

// ============================================================================
// CLI
// ============================================================================

interface CliArgs {
  csvPath: string | null;
  rollbackPath: string | null;
  dryRun: boolean;
  confirm: boolean;
  onlyTypes: boolean;
  onlyBalances: boolean;
  skipTestClients: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);

  const outDirIndex = args.indexOf('--out-dir');
  const rollbackIndex = args.indexOf('--rollback');

  const valueAfter = (index: number, flag: string): string => {
    if (index < 0) return '';
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requiere un valor`);
    }
    return value;
  };

  const outDirValue = valueAfter(outDirIndex, '--out-dir');
  const rollbackValue = valueAfter(rollbackIndex, '--rollback');

  const consumed = new Set<number>();
  if (outDirIndex >= 0) {
    consumed.add(outDirIndex);
    consumed.add(outDirIndex + 1);
  }
  if (rollbackIndex >= 0) {
    consumed.add(rollbackIndex);
    consumed.add(rollbackIndex + 1);
  }

  const positional = args.filter(
    (_arg, index) => !args[index]!.startsWith('--') && !consumed.has(index),
  );

  return {
    csvPath: positional[0] ?? null,
    rollbackPath: rollbackIndex >= 0 ? rollbackValue : null,
    dryRun: args.includes('--dry-run'),
    confirm: args.includes('--confirm'),
    onlyTypes: args.includes('--only-types'),
    onlyBalances: args.includes('--only-balances'),
    skipTestClients: args.includes('--skip-test-clients'),
    outDir: outDirValue || DEFAULT_OUT_DIR,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.rollbackPath) {
    loadEnv();
    await connectMongo();
    try {
      const result = await runRollback(args.rollbackPath, args.confirm);
      if (result.failures > 0) {
        process.exitCode = 1;
      }
    } finally {
      await disconnectMongo();
    }
    return;
  }

  if (!args.csvPath) {
    throw new Error(
      'Uso: tsx scripts/import-saldos-cta-cte.ts <ruta.csv> [--dry-run|--confirm] ' +
        '[--only-types] [--only-balances] [--skip-test-clients] [--out-dir <dir>]\n' +
        '  tsx scripts/import-saldos-cta-cte.ts --rollback <snapshot.json> [--confirm]',
    );
  }

  if (!args.dryRun && !args.confirm) {
    throw new Error(
      'Se requiere --confirm para escribir en la base de datos (o --dry-run para simular).',
    );
  }

  loadEnv();
  await connectMongo();
  try {
    const summary = await runImport({
      csvPath: args.csvPath,
      dryRun: args.dryRun,
      onlyTypes: args.onlyTypes,
      onlyBalances: args.onlyBalances,
      skipTestClients: args.skipTestClients,
      outDir: args.outDir,
    });

    console.log('\n===== RESUMEN DE MIGRACIÓN DE SALDOS =====');
    console.log(JSON.stringify(summary, null, 2));

    if (summary.uncoveredClients > 0) {
      logger.warn(
        `Hay ${summary.uncoveredClients} clientes en la base que NO están en el CSV — no fueron modificados.`,
      );
    }
  } finally {
    await disconnectMongo();
  }
}

main().catch((err) => {
  logger.error('Migración de saldos falló', err);
  process.exitCode = 1;
});
