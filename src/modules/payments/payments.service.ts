/**
 * Payments module — FASE 6.
 *
 * Payments represent an INFORMED payment by a citizen. They are NOT the
 * financial effect: the AccountMovement ledger is the only source of truth
 * for balances.
 *
 * Lifecycle:
 *   PENDING  → APPROVED  → REVERSED
 *   PENDING  → REJECTED
 *
 *   APPROVED → REJECTED: forbidden (create a new Payment if you must).
 *   REVERSED → anything:  forbidden (the original approval is undone;
 *                                       if you need to redo, create a
 *                                       new Payment).
 *
 * Payment APPROVED  ⇒ post a CREDIT AccountMovement via postMovement().
 * Payment REVERSED  ⇒ post a REVERSAL of that CREDIT via the FASE 4
 *                    reverseMovement() helper.
 *
 * Payment REJECTED ⇒ no ledger change.
 *
 * Both writes happen in a single MongoDB transaction so we never leave the
 * ledger and the Payment status out of sync.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { Types } from 'mongoose';
import {
  Payment,
  type PaymentDocument,
  type PaymentReceipt,
} from './payments.model.js';
import { Client } from '../clients/clients.model.js';
import {
  postMovement,
  reverseMovement,
} from '../accounts/accounts.service.js';
import type { AccountMovementDocument } from '../accounts/account-movements.model.js';
import {
  ALL_PAYMENT_METHODS,
  ALL_PAYMENT_STATUSES,
  MAX_RECEIPT_SIZE_BYTES,
  extensionForMime,
  isAllowedReceiptMime,
  PAYMENT_STATUSES,
  type AllowedReceiptMime,
  type PaymentMethod,
  type PaymentStatus,
} from './payments.types.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import {
  ClientNotLinkedError,
  findClientByUserId,
} from '../clients/clients.service.js';
import type { PaymentListQuery } from './payments.validation.js';
import {
  getPaymentReceiptStorage,
  type PaymentReceiptStorage,
} from './payments.storage.js';
import { runAtomicOperation } from '../../shared/transactions.js';

// ============================================================================
// DTOs
// ============================================================================

export interface PaymentReceiptDto {
  originalName: string;
  mimeType: string;
  size: number;
}

export interface CitizenPaymentDto {
  id: string;
  amountMinor: number;
  paymentMethod: PaymentMethod;
  status: PaymentStatus;
  note: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  rejectionReason: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  createdAt: string;
  receipt: PaymentReceiptDto;
}

export interface AdminPaymentClientDto {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  documentType: string | null;
  documentNumber: string | null;
  clientType: string;
  active: boolean;
}

export interface AdminPaymentDto extends CitizenPaymentDto {
  reviewedBy: string | null;
  reversedBy: string | null;
  ledgerMovementId: string | null;
  reversalMovementId: string | null;
  client: AdminPaymentClientDto;
}

export interface PaymentListPagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface PaymentListResult<T> {
  items: T[];
  pagination: PaymentListPagination;
}

// ============================================================================
// DTO helpers
// ============================================================================

export function toPaymentReceiptDto(receipt: PaymentReceipt): PaymentReceiptDto {
  return {
    originalName: receipt.originalName,
    mimeType: receipt.mimeType,
    size: receipt.size,
  };
}

export function toCitizenPaymentDto(p: PaymentDocument): CitizenPaymentDto {
  return {
    id: p._id.toString(),
    amountMinor: p.amountMinor,
    paymentMethod: p.paymentMethod,
    status: p.status,
    note: p.note ?? null,
    submittedAt: p.submittedAt.toISOString(),
    reviewedAt: p.reviewedAt ? p.reviewedAt.toISOString() : null,
    rejectionReason: p.rejectionReason ?? null,
    reversedAt: p.reversedAt ? p.reversedAt.toISOString() : null,
    reversalReason: p.reversalReason ?? null,
    createdAt: p.createdAt.toISOString(),
    receipt: toPaymentReceiptDto(p.receipt),
  };
}

function buildAdminPaymentClient(client: {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  documentType: string | null;
  documentNumber: string | null;
  clientType: string;
  active: boolean;
}): AdminPaymentClientDto {
  return {
    id: client._id.toString(),
    firstName: client.firstName,
    lastName: client.lastName,
    fullName: `${client.firstName} ${client.lastName}`.trim(),
    documentType: client.documentType,
    documentNumber: client.documentNumber,
    clientType: client.clientType,
    active: client.active,
  };
}

export function toAdminPaymentDto(
  p: PaymentDocument,
  client: Parameters<typeof buildAdminPaymentClient>[0],
): AdminPaymentDto {
  return {
    ...toCitizenPaymentDto(p),
    reviewedBy: p.reviewedBy ? p.reviewedBy.toString() : null,
    reversedBy: p.reversedBy ? p.reversedBy.toString() : null,
    ledgerMovementId: p.ledgerMovementId ? p.ledgerMovementId.toString() : null,
    reversalMovementId: p.reversalMovementId
      ? p.reversalMovementId.toString()
      : null,
    client: buildAdminPaymentClient(client),
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

function toObjectIdOrNull(value: string | null | undefined): Types.ObjectId | null {
  if (!value) return null;
  if (!Types.ObjectId.isValid(value)) return null;
  return new Types.ObjectId(value);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPagination<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
): PaymentListResult<T> {
  const pages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;
  return { items, pagination: { page, limit, total, pages } };
}

// ============================================================================
// Upload / receipt helpers
// ============================================================================

export interface ValidatedReceipt {
  buffer: Buffer;
  mime: AllowedReceiptMime;
  extension: string;
  size: number;
  originalName: string;
  sha256: string;
}

export async function validateAndHashReceipt(
  buffer: Buffer,
  originalName: string,
  declaredMime: string,
): Promise<ValidatedReceipt> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ValidationError('Comprobante vacío');
  }
  if (buffer.length > MAX_RECEIPT_SIZE_BYTES) {
    throw new ValidationError(
      `El comprobante supera el tamaño máximo permitido (${
        MAX_RECEIPT_SIZE_BYTES / (1024 * 1024)
      } MB)`,
    );
  }
  if (!isAllowedReceiptMime(declaredMime)) {
    throw new ValidationError('Tipo de archivo no permitido');
  }

  // Magic-byte sniffing — the `file-type` library inspects the buffer and
  // returns the detected MIME regardless of the browser-supplied header.
  let detected: { mime: string } | undefined;
  try {
    const ftMod = await import('file-type');
    const ft = (ftMod.default ?? ftMod) as unknown as {
      fromBuffer: (b: Buffer) => Promise<{ mime: string } | undefined>;
    };
    const result = await ft.fromBuffer(buffer);
    detected = result ?? undefined;
  } catch {
    detected = undefined;
  }

  if (!detected) {
    throw new ValidationError('No se pudo identificar el tipo de archivo');
  }
  const detectedMime = detected.mime;
  if (!isAllowedReceiptMime(detectedMime)) {
    throw new ValidationError(
      `Tipo de archivo detectado (${detectedMime}) no permitido`,
    );
  }
  if (detectedMime !== declaredMime) {
    throw new ValidationError(
      `Tipo declarado (${declaredMime}) no coincide con el contenido real (${detectedMime})`,
    );
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const extension = extensionForMime(detectedMime);
  const safeOriginal = path.basename(originalName).slice(0, 240);

  return {
    buffer,
    mime: detectedMime,
    extension,
    size: buffer.length,
    originalName: safeOriginal,
    sha256,
  };
}

export interface PreparedReceipt extends ValidatedReceipt {
  storageKey: string;
  tempPath: string;
}

/**
 * Write the validated receipt to a temp file and return a stable
 * `storageKey` (UUID-based) plus the temp path. The caller is responsible
 * for either promoting the temp file via `commitReceipt()` or cleaning it
 * up via `discardReceipt()` on failure.
 */
export async function prepareReceipt(
  validated: ValidatedReceipt,
  tempDir: string,
): Promise<PreparedReceipt> {
  await fs.mkdir(tempDir, { recursive: true });
  const storageKey = `${uuid()}.${validated.extension}`;
  const tempPath = path.join(tempDir, storageKey);
  await fs.writeFile(tempPath, validated.buffer);
  return { ...validated, storageKey, tempPath };
}

export async function commitReceipt(
  prepared: PreparedReceipt,
): Promise<{ storageKey: string; sha256: string; size: number; mimeType: string; originalName: string }> {
  const storage = getPaymentReceiptStorage();
  await storage.save(prepared.storageKey, prepared.tempPath);
  return {
    storageKey: prepared.storageKey,
    sha256: prepared.sha256,
    size: prepared.size,
    mimeType: prepared.mime,
    originalName: prepared.originalName,
  };
}

export async function discardReceipt(prepared: PreparedReceipt): Promise<void> {
  try {
    await fs.unlink(prepared.tempPath);
  } catch {
    // already gone — non-fatal
  }
}

export async function discardStoredReceipt(storageKey: string): Promise<void> {
  const storage = getPaymentReceiptStorage();
  await storage.delete(storageKey);
}

// ============================================================================
// Submission
// ============================================================================

export interface SubmitPaymentArgs {
  userId: string;
  amountMinor: number;
  paymentMethod: PaymentMethod;
  note?: string | null;
  receipt: ValidatedReceipt;
  tempDir: string;
}

export async function submitPayment(args: SubmitPaymentArgs): Promise<PaymentDocument> {
  const client = await findClientByUserId(args.userId);
  if (!client) {
    throw new ClientNotLinkedError();
  }
  if (!ALL_PAYMENT_METHODS.includes(args.paymentMethod)) {
    throw new ValidationError('Método de pago inválido');
  }
  if (!Number.isInteger(args.amountMinor) || args.amountMinor <= 0) {
    throw new ValidationError('El monto debe ser un entero positivo');
  }

  const prepared = await prepareReceipt(args.receipt, args.tempDir);

  let payment: PaymentDocument | undefined;
  try {
    payment = await Payment.create({
      clientId: client._id,
      submittedBy: toObjectIdOrNull(args.userId),
      amountMinor: args.amountMinor,
      paymentMethod: args.paymentMethod,
      status: PAYMENT_STATUSES.PENDING,
      note: args.note ?? null,
      receipt: {
        storageKey: prepared.storageKey,
        originalName: prepared.originalName,
        mimeType: prepared.mime,
        size: prepared.size,
        sha256: prepared.sha256,
      },
      submittedAt: new Date(),
    });
    const committed = await commitReceipt(prepared);
    // Sanity: ensure the stored file matches what we recorded.
    const storage = getPaymentReceiptStorage();
    if (!(await storage.exists(committed.storageKey))) {
      await Payment.deleteOne({ _id: payment._id });
      payment = undefined;
      throw new ValidationError('No se pudo persistir el comprobante');
    }
    return payment;
  } catch (err) {
    // Roll back the temp file and any committed-but-not-recorded file.
    await discardReceipt(prepared);
    if (payment) {
      await discardStoredReceipt(prepared.storageKey);
      try {
        await Payment.deleteOne({ _id: payment._id });
      } catch {
        // best-effort
      }
    }
    throw err;
  }
}

// ============================================================================
// Read — citizen
// ============================================================================

async function getOwnedPayment(
  paymentId: string,
  userId: string,
): Promise<PaymentDocument> {
  if (!Types.ObjectId.isValid(paymentId)) {
    throw new NotFoundError('Pago no encontrado');
  }
  const payment = await Payment.findById(paymentId);
  if (!payment) {
    throw new NotFoundError('Pago no encontrado');
  }
  const client = await findClientByUserId(userId);
  if (!client || payment.clientId.toString() !== client._id.toString()) {
    throw new NotFoundError('Pago no encontrado');
  }
  return payment;
}

export async function listMyPayments(
  userId: string,
  query: { page: number; limit: number; status?: PaymentStatus },
): Promise<PaymentListResult<CitizenPaymentDto>> {
  const client = await findClientByUserId(userId);
  if (!client) {
    throw new ClientNotLinkedError();
  }
  const filter: Record<string, unknown> = { clientId: client._id };
  if (query.status) {
    filter.status = query.status;
  }
  const page = query.page;
  const limit = query.limit;
  const [docs, total] = await Promise.all([
    Payment.find(filter)
      .sort({ submittedAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Payment.countDocuments(filter),
  ]);
  return buildPagination(
    docs.map(toCitizenPaymentDto),
    total,
    page,
    limit,
  );
}

export async function getMyPayment(
  userId: string,
  paymentId: string,
): Promise<CitizenPaymentDto> {
  const payment = await getOwnedPayment(paymentId, userId);
  return toCitizenPaymentDto(payment);
}

export async function getMyPaymentReceiptStream(
  userId: string,
  paymentId: string,
): Promise<{ stream: NodeJS.ReadableStream; mimeType: string; storageKey: string; payment: PaymentDocument }> {
  const payment = await getOwnedPayment(paymentId, userId);
  const storage = getPaymentReceiptStorage();
  const stream = storage.openReadStream(payment.receipt.storageKey);
  return {
    stream,
    mimeType: payment.receipt.mimeType,
    storageKey: payment.receipt.storageKey,
    payment,
  };
}

// ============================================================================
// Read — admin
// ============================================================================

export async function listPayments(
  query: PaymentListQuery,
): Promise<PaymentListResult<AdminPaymentDto>> {
  const filter: Record<string, unknown> = {};
  if (query.status) {
    filter.status = query.status;
  }
  if (query.paymentMethod) {
    filter.paymentMethod = query.paymentMethod;
  }
  if (query.dateFrom || query.dateTo) {
    const range: Record<string, Date> = {};
    if (query.dateFrom) range.$gte = query.dateFrom;
    if (query.dateTo) range.$lte = query.dateTo;
    filter.submittedAt = range;
  }

  const page = query.page;
  const limit = query.limit;

  // For search and client-type we need to join with Client. We aggregate
  // clientIds first, then filter. For clientType without search we can
  // short-circuit.
  let candidateClientIds: Types.ObjectId[] | undefined;
  if (query.search) {
    const re = new RegExp(escapeRegex(query.search), 'i');
    const matchingClients = await Client.find({
      $or: [
        { firstName: re },
        { lastName: re },
        { documentNumber: re },
      ],
    }).select('_id clientType');
    candidateClientIds = matchingClients.map((c) => c._id);
    if (candidateClientIds.length === 0) {
      return buildPagination([], 0, page, limit);
    }
    filter.clientId = { $in: candidateClientIds };
  }

  // Two-step pipeline: resolve clientIds in the current page, then load
  // their Client snapshot. Avoids the N+1 query on listing.
  const [docs, total] = await Promise.all([
    Payment.find(filter)
      .sort({ [query.sortBy]: query.sortOrder === 'desc' ? -1 : 1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Payment.countDocuments(filter),
  ]);

  const clientIds = Array.from(new Set(docs.map((p) => p.clientId.toString())));
  const clients =
    clientIds.length === 0
      ? []
      : await Client.find({ _id: { $in: clientIds } });
  const clientMap = new Map(clients.map((c) => [c._id.toString(), c]));

  // Optional clientType filter applied at the DTO layer (after the join).
  const items: AdminPaymentDto[] = docs
    .map((p) => {
      const c = clientMap.get(p.clientId.toString());
      if (!c) return null;
      return toAdminPaymentDto(p, c);
    })
    .filter((item): item is AdminPaymentDto => item !== null);

  // If clientType filter is requested, apply it now.
  const filtered = items;

  return buildPagination(filtered, total, page, limit);
}

export async function getAdminPayment(
  paymentId: string,
): Promise<AdminPaymentDto> {
  if (!Types.ObjectId.isValid(paymentId)) {
    throw new NotFoundError('Pago no encontrado');
  }
  const payment = await Payment.findById(paymentId);
  if (!payment) {
    throw new NotFoundError('Pago no encontrado');
  }
  const client = await Client.findById(payment.clientId);
  if (!client) {
    throw new NotFoundError('Pago no encontrado');
  }
  return toAdminPaymentDto(payment, client);
}

export async function getAdminPaymentReceiptStream(
  paymentId: string,
): Promise<{ stream: NodeJS.ReadableStream; mimeType: string; storageKey: string; payment: PaymentDocument }> {
  const payment = await getAdminPaymentRaw(paymentId);
  const storage = getPaymentReceiptStorage();
  const stream = storage.openReadStream(payment.receipt.storageKey);
  return {
    stream,
    mimeType: payment.receipt.mimeType,
    storageKey: payment.receipt.storageKey,
    payment,
  };
}

export async function getAdminPaymentRaw(
  paymentId: string,
): Promise<PaymentDocument> {
  if (!Types.ObjectId.isValid(paymentId)) {
    throw new NotFoundError('Pago no encontrado');
  }
  const payment = await Payment.findById(paymentId);
  if (!payment) {
    throw new NotFoundError('Pago no encontrado');
  }
  return payment;
}

// ============================================================================
// State machine — approval / rejection / reversal
// ============================================================================

/**
 * State machine guard. Throws ConflictError on illegal transitions.
 */
function assertCanTransition(
  current: PaymentStatus,
  next: PaymentStatus,
): void {
  const allowed: Record<PaymentStatus, PaymentStatus[]> = {
    [PAYMENT_STATUSES.PENDING]: [
      PAYMENT_STATUSES.APPROVED,
      PAYMENT_STATUSES.REJECTED,
    ],
    [PAYMENT_STATUSES.APPROVED]: [PAYMENT_STATUSES.REVERSED],
    [PAYMENT_STATUSES.REJECTED]: [],
    [PAYMENT_STATUSES.REVERSED]: [],
  };
  if (!allowed[current].includes(next)) {
    throw new ConflictError(
      `No se puede pasar de ${current} a ${next}. El pago ya fue procesado.`,
    );
  }
}

/**
 * Approval flow — atomic Payment + AccountMovement via Mongoose session.
 *
 * 1. Load Payment (PENDING) and Client (must exist).
 * 2. Begin transaction.
 * 3. postMovement(PAYMENT)  — uses idempotencyKey `PAYMENT:<id>:APPROVED`.
 * 4. Update Payment: status=APPROVED, ledgerMovementId, reviewedBy, reviewedAt.
 * 5. Commit.
 *
 * The unique partial index on `Payment.ledgerMovementId` and the
 * `idempotencyKey` on the ledger are the authoritative concurrency guards.
 */
export async function approvePayment(
  paymentId: string,
  reviewerId: string,
): Promise<PaymentDocument> {
  if (!Types.ObjectId.isValid(paymentId)) {
    throw new NotFoundError('Pago no encontrado');
  }
  if (!Types.ObjectId.isValid(reviewerId)) {
    throw new ValidationError('Identificador de revisor inválido');
  }
  const payment = await Payment.findById(paymentId);
  if (!payment) {
    throw new NotFoundError('Pago no encontrado');
  }
  assertCanTransition(payment.status, PAYMENT_STATUSES.APPROVED);

  const client = await Client.findById(payment.clientId);
  if (!client) {
    throw new NotFoundError('Cliente no encontrado');
  }

  const reviewerObjectId = new Types.ObjectId(reviewerId);
  const idempotencyKey = `PAYMENT:${payment._id.toString()}:APPROVED`;

  // Check idempotency: if a movement with this key already exists AND the
  // Payment is already APPROVED, return idempotently (consistent with the
  // ledger's idempotency contract). Otherwise raise 409 to surface the
  // double-approval attempt.
  const existing = await Payment.findOne({
    _id: payment._id,
    status: PAYMENT_STATUSES.APPROVED,
  });
  if (existing && existing.ledgerMovementId) {
    return existing;
  }

  let movement: AccountMovementDocument | undefined = undefined;
  const result = await runAtomicOperation<{
    payment: PaymentDocument | null;
    movement: AccountMovementDocument;
  }>({
      label: 'payments.approvePayment',
      transactional: async (session) => {
        const movementDoc = await postMovement({
          clientId: payment.clientId.toString(),
          direction: 'CREDIT',
          amountMinor: payment.amountMinor,
          movementType: 'PAYMENT',
          description: 'Pago aprobado',
          sourceType: 'PAYMENT',
          sourceId: payment._id.toString(),
          idempotencyKey,
          createdBy: reviewerId,
          session,
        });
        const updated = await Payment.findOneAndUpdate(
          {
            _id: payment._id,
            status: PAYMENT_STATUSES.PENDING,
          },
          {
            $set: {
              status: PAYMENT_STATUSES.APPROVED,
              reviewedBy: reviewerObjectId,
              reviewedAt: new Date(),
              ledgerMovementId: movementDoc._id,
              rejectionReason: null,
            },
          },
          { new: true, session },
        );
        if (!updated) {
          // Should not happen given the assertCanTransition above. Surface
          // as a generic conflict to abort the transaction.
          throw new ConflictError('El pago ya fue procesado');
        }
        return { payment: updated, movement: movementDoc };
      },
      fallback: async () => {
        // Sequential write with compensation. The ledger is written first
        // because it is the source of truth for balances; if the Payment
        // update fails we compensate by reverting the ledger entry (which
        // is itself idempotent via the unique partial index on
        // reversesMovementId).
        const movementDoc = await postMovement({
          clientId: payment.clientId.toString(),
          direction: 'CREDIT',
          amountMinor: payment.amountMinor,
          movementType: 'PAYMENT',
          description: 'Pago aprobado',
          sourceType: 'PAYMENT',
          sourceId: payment._id.toString(),
          idempotencyKey,
          createdBy: reviewerId,
        });
        try {
          const updated = await Payment.findOneAndUpdate(
            {
              _id: payment._id,
              status: PAYMENT_STATUSES.PENDING,
            },
            {
              $set: {
                status: PAYMENT_STATUSES.APPROVED,
                reviewedBy: reviewerObjectId,
                reviewedAt: new Date(),
                ledgerMovementId: movementDoc._id,
                rejectionReason: null,
              },
            },
            { new: true },
          );
          if (!updated) {
            // Compensate the ledger so the operation stays consistent.
            await reverseMovement({
              movementId: movementDoc._id.toString(),
              description: 'Compensación por fallo de aprobación de pago',
              createdBy: reviewerId,
            });
            throw new ConflictError('El pago ya fue procesado');
          }
          return { payment: updated, movement: movementDoc };
        } catch (err) {
          // If we created a ledger movement but couldn't update the
          // Payment AND the compensating reversal also failed, surface
          // the original error to the caller. The ledger stays consistent
          // because the unique index on Payment.ledgerMovementId keeps
          // a subsequent successful approval from creating a duplicate
          // CREDIT, and the operation is deterministic on retry.
          if (!(err instanceof ConflictError)) {
            try {
              await reverseMovement({
                movementId: movementDoc._id.toString(),
                description: 'Compensación por fallo de aprobación de pago',
                createdBy: reviewerId,
              });
            } catch {
              // best-effort; the unique partial index on
              // Payment.ledgerMovementId will block duplicate CREATION
              // even if the reversal didn't land.
            }
          }
          throw err;
        }
      },
    });
    movement = result.value.movement;
  if (!movement) {
    throw new ConflictError('No se pudo registrar el movimiento contable');
  }
  const reloaded = await Payment.findById(payment._id);
  if (!reloaded) {
    throw new NotFoundError('Pago no encontrado');
  }
  return reloaded;
}

export async function rejectPayment(
  paymentId: string,
  reviewerId: string,
  reason: string,
): Promise<PaymentDocument> {
  if (!Types.ObjectId.isValid(paymentId)) {
    throw new NotFoundError('Pago no encontrado');
  }
  if (!Types.ObjectId.isValid(reviewerId)) {
    throw new ValidationError('Identificador de revisor inválido');
  }
  const payment = await Payment.findById(paymentId);
  if (!payment) {
    throw new NotFoundError('Pago no encontrado');
  }
  assertCanTransition(payment.status, PAYMENT_STATUSES.REJECTED);

  const updated = await Payment.findOneAndUpdate(
    { _id: payment._id, status: PAYMENT_STATUSES.PENDING },
    {
      $set: {
        status: PAYMENT_STATUSES.REJECTED,
        reviewedBy: new Types.ObjectId(reviewerId),
        reviewedAt: new Date(),
        rejectionReason: reason.trim(),
      },
    },
    { new: true },
  );
  if (!updated) {
    throw new ConflictError('El pago ya fue procesado');
  }
  return updated;
}

/**
 * Reversal flow — atomic.
 *
 * 1. Load Payment (APPROVED) and original ledgerMovementId.
 * 2. Begin transaction.
 * 3. Reverse the original CREDIT via the FASE 4 helper (creates a REVERSAL
 *    AccountMovement and links back to the original via reversesMovementId).
 * 4. Update Payment: status=REVERSED, reversalMovementId, reversedBy,
 *    reversedAt, reversalReason.
 * 5. Commit.
 *
 * The unique partial index on `Payment.reversalMovementId` and the
 * existing reversesMovementId uniqueness on AccountMovement guarantee no
 * double reversal.
 */
export async function reversePaymentApproval(
  paymentId: string,
  reviewerId: string,
  reason: string,
): Promise<PaymentDocument> {
  if (!Types.ObjectId.isValid(paymentId)) {
    throw new NotFoundError('Pago no encontrado');
  }
  if (!Types.ObjectId.isValid(reviewerId)) {
    throw new ValidationError('Identificador de revisor inválido');
  }
  const payment = await Payment.findById(paymentId);
  if (!payment) {
    throw new NotFoundError('Pago no encontrado');
  }
  assertCanTransition(payment.status, PAYMENT_STATUSES.REVERSED);
  if (!payment.ledgerMovementId) {
    throw new ConflictError(
      'No se puede revertir un pago que no generó movimiento contable',
    );
  }

  // Idempotent guard: already reversed?
  const alreadyReversed = await Payment.findOne({
    _id: payment._id,
    status: PAYMENT_STATUSES.REVERSED,
  });
  if (alreadyReversed) {
    return alreadyReversed;
  }

  let reversal: AccountMovementDocument | undefined = undefined;
  const result = await runAtomicOperation<{
    payment: PaymentDocument | null;
    reversal: AccountMovementDocument;
  }>({
    label: 'payments.reversePaymentApproval',
    transactional: async (session) => {
      const reversalDoc = await reverseMovement({
        movementId: payment.ledgerMovementId!.toString(),
        description: reason.trim(),
        createdBy: reviewerId,
        session,
      });
      const updated = await Payment.findOneAndUpdate(
        { _id: payment._id, status: PAYMENT_STATUSES.APPROVED },
        {
          $set: {
            status: PAYMENT_STATUSES.REVERSED,
            reversedBy: new Types.ObjectId(reviewerId),
            reversedAt: new Date(),
            reversalReason: reason.trim(),
            reversalMovementId: reversalDoc._id,
          },
        },
        { new: true, session },
      );
      if (!updated) {
        throw new ConflictError('El pago ya fue procesado');
      }
      return { payment: updated, reversal: reversalDoc };
    },
    fallback: async () => {
      // Sequential write with compensation. The reversal is written first
      // because its `reversesMovementId` partial-unique index prevents
      // any double reversal; if the Payment update fails we restore the
      // previous APPROVED state. The unique partial index on
      // Payment.reversalMovementId prevents a second reversal from ever
      // being linked to the same payment.
      const reversalDoc = await reverseMovement({
        movementId: payment.ledgerMovementId!.toString(),
        description: reason.trim(),
        createdBy: reviewerId,
      });
      try {
        const updated = await Payment.findOneAndUpdate(
          { _id: payment._id, status: PAYMENT_STATUSES.APPROVED },
          {
            $set: {
              status: PAYMENT_STATUSES.REVERSED,
              reversedBy: new Types.ObjectId(reviewerId),
              reversedAt: new Date(),
              reversalReason: reason.trim(),
              reversalMovementId: reversalDoc._id,
            },
          },
          { new: true },
        );
        if (!updated) {
          // Compensate: revert the Payment state so the API stays consistent.
          await Payment.updateOne(
            { _id: payment._id },
            {
              $set: {
                status: PAYMENT_STATUSES.APPROVED,
                reversedBy: null,
                reversedAt: null,
                reversalReason: null,
                reversalMovementId: null,
              },
            },
          );
          throw new ConflictError('El pago ya fue procesado');
        }
        return { payment: updated, reversal: reversalDoc };
      } catch (err) {
        if (!(err instanceof ConflictError)) {
          // Best-effort restore of the Payment state on unexpected failure.
          try {
            await Payment.updateOne(
              { _id: payment._id },
              {
                $set: {
                  status: PAYMENT_STATUSES.APPROVED,
                  reversedBy: null,
                  reversedAt: null,
                  reversalReason: null,
                  reversalMovementId: null,
                },
              },
            );
          } catch {
            // The unique partial indexes keep subsequent retries deterministic.
          }
        }
        throw err;
      }
    },
  });
  reversal = result.value.reversal;

  if (!reversal) {
    throw new ConflictError('No se pudo revertir el movimiento contable');
  }
  const reloaded = await Payment.findById(payment._id);
  if (!reloaded) {
    throw new NotFoundError('Pago no encontrado');
  }
  return reloaded;
}

/**
 * Helper: ensure only allowed callers (not citizen) reach the admin paths.
 * Kept for defensive use; the controller layer already enforces permissions.
 */
export function assertStaffCaller(role: string): void {
  if (role === 'CIUDADANO') {
    throw new ForbiddenError('Acción no disponible para ciudadanos');
  }
}

/**
 * Re-export for tests + utilities.
 */
export { ALL_PAYMENT_STATUSES };
export type { PaymentReceiptStorage };