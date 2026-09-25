export const PAYMENT_STATUSES = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  REVERSED: 'REVERSED',
} as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[keyof typeof PAYMENT_STATUSES];

export const ALL_PAYMENT_STATUSES: PaymentStatus[] = Object.values(PAYMENT_STATUSES);

export const PAYMENT_METHODS = {
  BANK_TRANSFER: 'BANK_TRANSFER',
  BANK_DEPOSIT: 'BANK_DEPOSIT',
  OTHER: 'OTHER',
} as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[keyof typeof PAYMENT_METHODS];

export const ALL_PAYMENT_METHODS: PaymentMethod[] = Object.values(PAYMENT_METHODS);

export interface PaymentStatusMeta {
  value: PaymentStatus;
  label: string;
}

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  PENDING: 'Pendiente',
  APPROVED: 'Aprobado',
  REJECTED: 'Rechazado',
  REVERSED: 'Revertido',
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  BANK_TRANSFER: 'Transferencia bancaria',
  BANK_DEPOSIT: 'Depósito bancario',
  OTHER: 'Otro',
};

export const PAYMENT_STATUS_TONE: Record<
  PaymentStatus,
  'primary' | 'success' | 'danger' | 'warning' | 'neutral' | 'info'
> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  REVERSED: 'neutral',
};

export const SORTABLE_PAYMENT_FIELDS = [
  'submittedAt',
  'amountMinor',
  'status',
  'paymentMethod',
  'reviewedAt',
  'reversedAt',
] as const;

export type PaymentSortableField = (typeof SORTABLE_PAYMENT_FIELDS)[number];

export const DEFAULT_PAYMENT_SORT_FIELD: PaymentSortableField = 'submittedAt';
export const DEFAULT_PAYMENT_SORT_ORDER: 'asc' | 'desc' = 'desc';

export const PAYMENTS_LIST_DEFAULT_LIMIT = 20;
export const PAYMENTS_LIST_MAX_LIMIT = 100;

/** Maximum receipt size in bytes (8 MB). */
export const MAX_RECEIPT_SIZE_BYTES = 8 * 1024 * 1024;

/** Allowed MIME types for receipt upload. */
export const ALLOWED_RECEIPT_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export type AllowedReceiptMime = (typeof ALLOWED_RECEIPT_MIME)[number];

export const RECEIPT_MIME_LABEL: Record<AllowedReceiptMime, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
  'application/pdf': 'PDF',
};

export function isAllowedReceiptMime(value: string): value is AllowedReceiptMime {
  return (ALLOWED_RECEIPT_MIME as readonly string[]).includes(value);
}

export function extensionForMime(mime: AllowedReceiptMime): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'application/pdf':
      return 'pdf';
  }
}