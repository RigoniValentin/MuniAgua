import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import { ALL_CLIENT_TYPES, type ClientType } from '../clients/clients.types.js';
import {
  ALL_PRODUCT_TYPES,
  MAX_PRICE_MINOR,
  type ProductType,
} from './products.types.js';

/**
 * Precio final EXACTO para un tipo de cliente, cargado por el administrador.
 *
 * Tiene prioridad sobre las reglas de porcentaje: si existe, el precio final
 * es exactamente `priceMinor` (sin decimales ni redondeos).
 *
 * El precio base (LOCAL) no puede fijarse de esta forma: el precio base ES el
 * precio local.
 */
export interface ProductClientTypePrice {
  clientType: ClientType;
  /** Precio final unitario en minor units (centavos). */
  priceMinor: number;
  /**
   * Precio base del producto en el momento en que se fijó este precio.
   * Si el base cambia después, la matriz de precios lo marca como
   * "desactualizado" para que el administrador lo revise (el precio fijo
   * NUNCA se modifica solo).
   */
  basePriceMinorAtSet: number;
}

export interface ProductDocument extends Document {
  _id: Types.ObjectId;
  code: string;
  name: string;
  description?: string | null;
  productType: ProductType;
  basePriceMinor: number;
  clientTypePrices: ProductClientTypePrice[];
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
      max: MAX_PRICE_MINOR,
    },
    clientTypePrices: {
      type: [
        {
          _id: false,
          clientType: {
            type: String,
            required: true,
            enum: ALL_CLIENT_TYPES,
          },
          priceMinor: {
            type: Number,
            required: true,
            min: 0,
            max: MAX_PRICE_MINOR,
          },
          basePriceMinorAtSet: {
            type: Number,
            required: true,
            min: 0,
            max: MAX_PRICE_MINOR,
          },
        },
      ],
      required: false,
      default: [],
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
