import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import { ALL_CLIENT_TYPES } from '../clients/clients.types.js';
import { ALL_PRODUCT_TYPES } from '../products/products.types.js';
import {
  ALL_PRICING_ADJUSTMENT_TYPES,
  ALL_PRICING_SCOPES,
  type PricingAdjustmentType,
  type PricingScope,
  type ClientType,
  type ProductType,
} from './pricing.types.js';

export interface PricingRuleDocument extends Document {
  _id: Types.ObjectId;
  name: string;
  clientType: ClientType;
  scope: PricingScope;
  productType?: ProductType | null;
  productId?: Types.ObjectId | null;
  adjustmentType: PricingAdjustmentType;
  adjustmentValue: number;
  priority: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: Types.ObjectId | null;
  updatedBy?: Types.ObjectId | null;
}

interface PricingRuleModel extends Model<PricingRuleDocument> {
  findEquivalentActive(
    args: Partial<{
      clientType: ClientType;
      scope: PricingScope;
      productType: ProductType | null;
      productId: Types.ObjectId | null;
      priority: number;
      active: boolean;
    }>,
  ): Promise<PricingRuleDocument | null>;
}

const pricingRuleSchema = new Schema<PricingRuleDocument, PricingRuleModel>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    clientType: {
      type: String,
      required: true,
      enum: ALL_CLIENT_TYPES,
      index: true,
    },
    scope: {
      type: String,
      required: true,
      enum: ALL_PRICING_SCOPES,
      index: true,
    },
    productType: {
      type: String,
      required: false,
      enum: ALL_PRODUCT_TYPES,
      default: null,
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: false,
      default: null,
    },
    adjustmentType: {
      type: String,
      required: true,
      enum: ALL_PRICING_ADJUSTMENT_TYPES,
      default: 'PERCENTAGE',
    },
    adjustmentValue: {
      type: Number,
      required: true,
      min: -100,
      max: 1000,
    },
    priority: {
      type: Number,
      required: true,
      default: 0,
    },
    active: {
      type: Boolean,
      required: true,
      default: true,
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

pricingRuleSchema.index({ clientType: 1, active: 1 });
pricingRuleSchema.index({ scope: 1, productType: 1 });
pricingRuleSchema.index({ scope: 1, productId: 1 });
pricingRuleSchema.index({ priority: -1 });

pricingRuleSchema.statics.findEquivalentActive = function (
  args: Partial<{
    clientType: ClientType;
    scope: PricingScope;
    productType: ProductType | null;
    productId: Types.ObjectId | null;
    priority: number;
    active: boolean;
  }>,
) {
  const filter: Record<string, unknown> = {};
  if (args.clientType !== undefined) filter.clientType = args.clientType;
  if (args.scope !== undefined) filter.scope = args.scope;
  if (args.productType !== undefined) filter.productType = args.productType;
  if (args.productId !== undefined) filter.productId = args.productId;
  if (args.priority !== undefined) filter.priority = args.priority;
  if (args.active !== undefined) filter.active = args.active;
  return this.findOne(filter);
};

export const PricingRule: PricingRuleModel =
  (mongoose.models.PricingRule as PricingRuleModel | undefined) ??
  mongoose.model<PricingRuleDocument, PricingRuleModel>(
    'PricingRule',
    pricingRuleSchema,
  );
