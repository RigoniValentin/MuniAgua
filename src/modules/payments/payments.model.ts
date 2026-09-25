import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import {
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  type PaymentMethod,
  type PaymentStatus,
} from './payments.types.js';

export interface PaymentReceipt {
  storageKey: string;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface PaymentDocument extends Document {
  _id: Types.ObjectId;
  clientId: Types.ObjectId;
  submittedBy: Types.ObjectId;
  amountMinor: number;
  paymentMethod: PaymentMethod;
  status: PaymentStatus;
  note?: string | null;
  receipt: PaymentReceipt;
  submittedAt: Date;
  reviewedBy?: Types.ObjectId | null;
  reviewedAt?: Date | null;
  rejectionReason?: string | null;
  ledgerMovementId?: Types.ObjectId | null;
  reversedBy?: Types.ObjectId | null;
  reversedAt?: Date | null;
  reversalReason?: string | null;
  reversalMovementId?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

type PaymentModel = Model<PaymentDocument>;

const receiptSchema = new Schema<PaymentReceipt>(
  {
    storageKey: { type: String, required: true, maxlength: 200 },
    originalName: { type: String, required: true, maxlength: 240 },
    mimeType: { type: String, required: true, maxlength: 80 },
    size: { type: Number, required: true, min: 1 },
    sha256: { type: String, required: true, maxlength: 64 },
  },
  { _id: false },
);

const paymentSchema = new Schema<PaymentDocument, PaymentModel>(
  {
    clientId: {
      type: Schema.Types.ObjectId,
      ref: 'Client',
      required: true,
      index: true,
    },
    submittedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
    },
    paymentMethod: {
      type: String,
      required: true,
      enum: Object.values(PAYMENT_METHODS),
    },
    status: {
      type: String,
      required: true,
      enum: Object.values(PAYMENT_STATUSES),
      default: PAYMENT_STATUSES.PENDING,
      index: true,
    },
    note: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    receipt: {
      type: receiptSchema,
      required: true,
    },
    submittedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    ledgerMovementId: {
      type: Schema.Types.ObjectId,
      ref: 'AccountMovement',
      default: null,
    },
    reversedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reversedAt: {
      type: Date,
      default: null,
    },
    reversalReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    reversalMovementId: {
      type: Schema.Types.ObjectId,
      ref: 'AccountMovement',
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

paymentSchema.index({ clientId: 1, submittedAt: -1 });
paymentSchema.index({ status: 1, submittedAt: -1 });
paymentSchema.index({ reviewedAt: -1 });
paymentSchema.index(
  { ledgerMovementId: 1 },
  {
    unique: true,
    name: 'ledgerMovementId_unique_sparse',
    partialFilterExpression: { ledgerMovementId: { $type: 'objectId' } },
  },
);
paymentSchema.index(
  { reversalMovementId: 1 },
  {
    unique: true,
    name: 'reversalMovementId_unique_sparse',
    partialFilterExpression: { reversalMovementId: { $type: 'objectId' } },
  },
);

export const Payment: PaymentModel =
  (mongoose.models.Payment as PaymentModel | undefined) ??
  mongoose.model<PaymentDocument, PaymentModel>('Payment', paymentSchema);