import type { Request, Response } from 'express';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import {
  submitPaymentMetadataSchema,
  rejectPaymentSchema,
  reversePaymentSchema,
  paymentListQuerySchema,
  myPaymentsListQuerySchema,
} from './payments.validation.js';
import {
  approvePayment,
  getAdminPayment,
  getAdminPaymentReceiptStream,
  getMyPayment,
  getMyPaymentReceiptStream,
  listMyPayments,
  listPayments,
  rejectPayment,
  reversePaymentApproval,
  submitPayment,
  validateAndHashReceipt,
  discardReceipt,
} from './payments.service.js';
import { ok } from '../../shared/api-response.js';
import { asyncHandler } from '../../middlewares/error.js';
import { ForbiddenError, ValidationError } from '../../shared/errors.js';
import { MAX_RECEIPT_SIZE_BYTES } from './payments.types.js';
import { PERMISSIONS } from '../users/users.types.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_SIZE_BYTES, files: 1 },
});

export const receiptUploadMiddleware = upload.single('receipt');

function requireUserId(req: Request): string {
  const id = req.user?.id;
  if (!id) {
    throw new ValidationError('No autenticado');
  }
  return id;
}

function getTempDir(req: Request): string {
  // Per-request isolated temp directory — cleaned up by the storage layer
  // (or by the OS) once the upload completes or fails.
  const base = process.env.PAYMENT_UPLOAD_TMP_DIR ?? path.join(os.tmpdir(), 'muni-payments');
  const reqId = (req as Request & { id?: string | number }).id ?? Date.now();
  return path.join(base, `req-${reqId}`);
}

// ============================================================================
// Citizen endpoints
// ============================================================================

export const submitMyPaymentController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      throw new ValidationError('Comprobante obligatorio');
    }

    const metadata = submitPaymentMetadataSchema.parse(req.body);
    const validated = await validateAndHashReceipt(
      file.buffer,
      file.originalname,
      file.mimetype,
    );
    const tempDir = getTempDir(req);

    const payment = await submitPayment({
      userId,
      amountMinor: metadata.amountMinor,
      paymentMethod: metadata.paymentMethod,
      note: metadata.note ?? null,
      receipt: validated,
      tempDir,
    });
    res.status(201).json(ok({ payment: { id: payment._id.toString() } }));
    void discardReceipt; // exported for tests
    void ForbiddenError; // keep import side-effect-free
    void PERMISSIONS; // imported for type clarity
  },
);

export const listMyPaymentsController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const query = myPaymentsListQuerySchema.parse(req.query);
    const result = await listMyPayments(userId, query);
    res.json(ok(result));
  },
);

export const getMyPaymentController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const { id } = req.params;
    if (!id) {
      throw new ValidationError('Identificador requerido');
    }
    const payment = await getMyPayment(userId, id);
    res.json(ok({ payment }));
  },
);

export const streamMyPaymentReceiptController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUserId(req);
    const { id } = req.params;
    if (!id) {
      throw new ValidationError('Identificador requerido');
    }
    const { stream, mimeType, payment } = await getMyPaymentReceiptStream(
      userId,
      id,
    );

    res.setHeader('Content-Type', mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    if (mimeType === 'application/pdf') {
      res.setHeader('Content-Disposition', `inline; filename="receipt-${payment._id}.pdf"`);
    } else {
      res.setHeader(
        'Content-Disposition',
        `inline; filename="receipt-${payment._id}${path.extname(payment.receipt.originalName) || ''}"`,
      );
    }
    stream.pipe(res);
  },
);

// ============================================================================
// Admin endpoints
// ============================================================================

export const listPaymentsController = asyncHandler(
  async (req: Request, res: Response) => {
    const query = paymentListQuerySchema.parse(req.query);
    const result = await listPayments(query);
    res.json(ok(result));
  },
);

export const getPaymentController = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) {
      throw new ValidationError('Identificador requerido');
    }
    const payment = await getAdminPayment(id);
    res.json(ok({ payment }));
  },
);

export const approvePaymentController = asyncHandler(
  async (req: Request, res: Response) => {
    const reviewerId = requireUserId(req);
    const { id } = req.params;
    if (!id) {
      throw new ValidationError('Identificador requerido');
    }
    const payment = await approvePayment(id, reviewerId);
    res.json(ok({ payment: { id: payment._id.toString(), status: payment.status } }));
  },
);

export const rejectPaymentController = asyncHandler(
  async (req: Request, res: Response) => {
    const reviewerId = requireUserId(req);
    const { id } = req.params;
    if (!id) {
      throw new ValidationError('Identificador requerido');
    }
    const data = rejectPaymentSchema.parse(req.body);
    const payment = await rejectPayment(id, reviewerId, data.reason);
    res.json(ok({ payment: { id: payment._id.toString(), status: payment.status } }));
  },
);

export const reversePaymentController = asyncHandler(
  async (req: Request, res: Response) => {
    const reviewerId = requireUserId(req);
    const { id } = req.params;
    if (!id) {
      throw new ValidationError('Identificador requerido');
    }
    const data = reversePaymentSchema.parse(req.body);
    const payment = await reversePaymentApproval(id, reviewerId, data.reason);
    res.json(ok({ payment: { id: payment._id.toString(), status: payment.status } }));
  },
);

export const streamPaymentReceiptController = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) {
      throw new ValidationError('Identificador requerido');
    }
    const { stream, mimeType, payment } = await getAdminPaymentReceiptStream(id);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    if (mimeType === 'application/pdf') {
      res.setHeader('Content-Disposition', `inline; filename="receipt-${payment._id}.pdf"`);
    } else {
      res.setHeader(
        'Content-Disposition',
        `inline; filename="receipt-${payment._id}${path.extname(payment.receipt.originalName) || ''}"`,
      );
    }
    stream.pipe(res);
  },
);