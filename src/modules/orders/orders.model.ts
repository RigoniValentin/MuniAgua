import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import {
  ALL_ORDER_ORIGINS,
  ALL_ORDER_STATUSES,
  type OrderOrigin,
  type OrderStatus,
} from './orders.types.js';
import type { ClientType } from '../clients/clients.types.js';
import type { ProductType } from '../products/products.types.js';

export interface OrderAppliedRuleSnapshot {
  id: string;
  name: string;
  scope: string;
  clientType: ClientType;
  productType: ProductType | null;
  productId: string | null;
  adjustmentType: string;
  adjustmentValue: number;
  priority: number;
}

export interface OrderItem {
  productId: Types.ObjectId;
  productCode: string;
  productName: string;
  productType: ProductType;
  quantity: number;
  unitBasePriceMinor: number;
  adjustmentPercentage: number;
  unitFinalPriceMinor: number;
  subtotalBaseMinor: number;
  subtotalFinalMinor: number;
  appliedRuleId?: Types.ObjectId | null;
  appliedRuleName?: string | null;
}

export interface OrderDeliveryAddress {
  street: string;
  number?: string | null;
  floor?: string | null;
  apartment?: string | null;
  neighborhood?: string | null;
  locality: string;
  postalCode?: string | null;
  references?: string | null;
}

export interface OrderDocument extends Document {
  _id: Types.ObjectId;

  clientId: Types.ObjectId;

  origin: OrderOrigin;

  status: OrderStatus;

  items: OrderItem[];

  totalBaseMinor: number;
  totalFinalMinor: number;

  deliveryAddressSnapshot: OrderDeliveryAddress;

  /**
   * Delivery zone of the client AT THE TIME the order was created.
   * Copy of `Client.zona`, uppercased/trimmed or null. Frozen so changing
   * the padrón later doesn't move this order to a different day.
   */
  zonaSnapshot?: string | null;

  customerNote?: string | null;

  accountMovementId?: Types.ObjectId | null;

  assignedTo?: Types.ObjectId | null;
  assignedAt?: Date | null;

  startedDeliveryAt?: Date | null;
  deliveredAt?: Date | null;

  cancelledAt?: Date | null;
  cancellationReason?: string | null;
  cancellationMovementId?: Types.ObjectId | null;

  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

interface OrderModel extends Model<OrderDocument> {
  /** For tests/smoke only — counts orders in a given status (used in dashboards). */
  countByStatus(): Promise<Array<{ _id: OrderStatus; count: number }>>;
}

const orderItemSchema = new Schema<OrderItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productCode: { type: String, required: true, trim: true, maxlength: 40 },
    productName: { type: String, required: true, trim: true, maxlength: 120 },
    productType: { type: String, required: true },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: (v: number) => Number.isInteger(v),
        message: 'La cantidad debe ser un entero positivo',
      },
    },
    unitBasePriceMinor: { type: Number, required: true, min: 0 },
    adjustmentPercentage: { type: Number, required: true, default: 0 },
    unitFinalPriceMinor: { type: Number, required: true, min: 0 },
    subtotalBaseMinor: { type: Number, required: true, min: 0 },
    subtotalFinalMinor: { type: Number, required: true, min: 0 },
    appliedRuleId: { type: Schema.Types.ObjectId, ref: 'PricingRule', default: null },
    appliedRuleName: { type: String, trim: true, maxlength: 120, default: null },
  },
  { _id: false },
);

const orderDeliveryAddressSchema = new Schema<OrderDeliveryAddress>(
  {
    street: { type: String, required: true, trim: true, maxlength: 120 },
    number: { type: String, required: true, trim: true, maxlength: 20 },
    floor: { type: String, trim: true, maxlength: 10, default: null },
    apartment: { type: String, trim: true, maxlength: 10, default: null },
    neighborhood: { type: String, trim: true, maxlength: 80, default: null },
    locality: { type: String, required: true, trim: true, maxlength: 80 },
    postalCode: { type: String, trim: true, maxlength: 20, default: null },
    references: { type: String, trim: true, maxlength: 240, default: null },
  },
  { _id: false },
);

const orderSchema = new Schema<OrderDocument, OrderModel>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    origin: { type: String, required: true, enum: ALL_ORDER_ORIGINS },
    status: {
      type: String,
      required: true,
      enum: ALL_ORDER_STATUSES,
      default: 'CONFIRMED',
    },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (v: OrderItem[]) => Array.isArray(v) && v.length > 0,
        message: 'El pedido debe contener al menos un item',
      },
    },
    totalBaseMinor: { type: Number, required: true, min: 0 },
    totalFinalMinor: { type: Number, required: true, min: 0 },
    deliveryAddressSnapshot: {
      type: orderDeliveryAddressSchema,
      required: true,
    },
    zonaSnapshot: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 32,
      default: null,
      index: true,
    },
    customerNote: { type: String, trim: true, maxlength: 500, default: null },
    accountMovementId: {
      type: Schema.Types.ObjectId,
      ref: 'AccountMovement',
      default: null,
    },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },
    startedDeliveryAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, trim: true, maxlength: 500, default: null },
    cancellationMovementId: {
      type: Schema.Types.ObjectId,
      ref: 'AccountMovement',
      default: null,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, versionKey: false },
);

// History of a client: createdAt DESC.
orderSchema.index(
  { clientId: 1, createdAt: -1 },
  { name: 'orders_clientId_createdAt_desc' },
);

// Admin listing: filter by status.
orderSchema.index(
  { status: 1, createdAt: -1 },
  { name: 'orders_status_createdAt_desc' },
);

// Driver view: assigned to me, ordered by assignedAt.
orderSchema.index(
  { assignedTo: 1, status: 1, assignedAt: 1 },
  { name: 'orders_assignedTo_status_assignedAt' },
);

// Catch-all for "all orders" list.
orderSchema.index({ createdAt: -1 }, { name: 'orders_createdAt_desc' });

// Idempotency: accountMovementId and cancellationMovementId must each be unique
// when present, mirroring the AccountMovement ledger guarantees.
orderSchema.index(
  { accountMovementId: 1 },
  {
    name: 'orders_accountMovementId_unique',
    unique: true,
    partialFilterExpression: { accountMovementId: { $type: 'objectId' } },
  },
);

orderSchema.index(
  { cancellationMovementId: 1 },
  {
    name: 'orders_cancellationMovementId_unique',
    unique: true,
    partialFilterExpression: { cancellationMovementId: { $type: 'objectId' } },
  },
);

orderSchema.statics.countByStatus = function (): Promise<
  Array<{ _id: OrderStatus; count: number }>
> {
  return this.aggregate<{ _id: OrderStatus; count: number }>([
    { $group: { _id: '$status', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
};

export const Order: OrderModel =
  (mongoose.models.Order as OrderModel | undefined) ??
  mongoose.model<OrderDocument, OrderModel>('Order', orderSchema);
