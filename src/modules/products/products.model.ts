import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import {
  ALL_PRODUCT_TYPES,
  type ProductType,
} from './products.types.js';

export interface ProductDocument extends Document {
  _id: Types.ObjectId;
  code: string;
  name: string;
  description?: string | null;
  productType: ProductType;
  basePriceMinor: number;
  tracksStock: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: Types.ObjectId | null;
  updatedBy?: Types.ObjectId | null;
}

interface ProductModel extends Model<ProductDocument> {
  findByCode(code: string): Promise<ProductDocument | null>;
}

const productSchema = new Schema<ProductDocument, ProductModel>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      maxlength: 40,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    productType: {
      type: String,
      required: true,
      enum: ALL_PRODUCT_TYPES,
      index: true,
    },
    basePriceMinor: {
      type: Number,
      required: true,
      min: 0,
    },
    tracksStock: {
      type: Boolean,
      required: true,
      default: false,
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

productSchema.index({ name: 1 });

productSchema.statics.findByCode = function (code: string) {
  return this.findOne({ code: code.trim().toUpperCase().replace(/\s+/g, '_') });
};

export const Product: ProductModel =
  (mongoose.models.Product as ProductModel | undefined) ??
  mongoose.model<ProductDocument, ProductModel>('Product', productSchema);
