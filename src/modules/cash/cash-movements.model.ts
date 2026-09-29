import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import {
  ALL_CASH_MOVEMENT_TYPES,
  ALL_CASH_SOURCE_TYPES,
  type CashMovementType,
  type CashSourceType,
} from './cash.types.js';

export interface CashMovementDocument extends Document {
  _id: Types.ObjectId;
  /** Client who paid the cash. */
  clientId: Types.ObjectId;
  /** Repartidor who collected the cash (null for manual entries). */
  driverId: Types.ObjectId | null;
  /** Always positive integer (minor units). Cash is always incoming. */
  amountMinor: number;
  movementType: CashMovementType;
  description: string;
  occurredAt: Date;
  sourceType: CashSourceType;
  /** ObjectId of the source document (e.g. Order) when sourceType === 'ORDER'. */
  sourceId: Types.ObjectId | null;
  /** Denormalized for fast lookups ("all cash movements of this Order"). */
  orderId: Types.ObjectId | null;
  /** Idempotency key for collection posts (unique, sparse). */
  idempotencyKey: string | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CashMovementModel extends Model<CashMovementDocument> {
  findByIdempotencyKey(key: string): Promise<CashMovementDocument | null>;
}

const cashMovementSchema = new Schema<CashMovementDocument, CashMovementModel>(
  {
    clientId: {
      type: Schema.Types.ObjectId,
      ref: 'Client',
      required: true,
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: (v: number) => Number.isInteger(v),
        message: 'amountMinor debe ser un entero positivo',
      },
    },
    movementType: {
      type: String,
      required: true,
      enum: ALL_CASH_MOVEMENT_TYPES,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    occurredAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    sourceType: {
      type: String,
      required: true,
      enum: ALL_CASH_SOURCE_TYPES,
      default: 'ORDER',
    },
    sourceId: { type: Schema.Types.ObjectId, default: null },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    idempotencyKey: {
      type: String,
      default: null,
      trim: true,
      maxlength: 200,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true, versionKey: false },
);

// Primary read paths.
cashMovementSchema.index(
  { clientId: 1, occurredAt: -1, _id: -1 },
  { name: 'clientId_occurredAt_desc' },
);
cashMovementSchema.index(
  { driverId: 1, occurredAt: -1, _id: -1 },
  { name: 'driverId_occurredAt_desc' },
);
cashMovementSchema.index(
  { orderId: 1 },
  {
    name: 'orderId',
    partialFilterExpression: { orderId: { $type: 'objectId' } },
  },
);
cashMovementSchema.index(
  { idempotencyKey: 1 },
  {
    name: 'idempotencyKey_unique',
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
  },
);
cashMovementSchema.index({ createdAt: -1 }, { name: 'createdAt_desc' });

cashMovementSchema.statics.findByIdempotencyKey = function (key: string) {
  return this.findOne({ idempotencyKey: key });
};

export const CashMovement: CashMovementModel =
  (mongoose.models.CashMovement as CashMovementModel | undefined) ??
  mongoose.model<CashMovementDocument, CashMovementModel>(
    'CashMovement',
    cashMovementSchema,
  );