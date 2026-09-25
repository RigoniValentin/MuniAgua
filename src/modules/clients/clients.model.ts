import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import {
  ALL_CLIENT_TYPES,
  ALL_DOCUMENT_TYPES,
  type ClientType,
  type DocumentType,
} from './clients.types.js';

export interface ClientAddress {
  street: string;
  number?: string | null;
  floor?: string | null;
  apartment?: string | null;
  neighborhood?: string | null;
  locality: string;
  postalCode?: string | null;
  references?: string | null;
}

export interface ClientDocument extends Document {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  documentType: DocumentType | null;
  documentNumber: string | null;
  phone?: string | null;
  email?: string | null;
  clientType: ClientType;
  address: ClientAddress;
  /**
   * Delivery zone label as it appears in the municipal padrón (e.g. "ZONA 1",
   * "ZONA 2"). Stored uppercased and trimmed. Free-form for now — when the
   * DeliveryZone module is introduced later, this column gets migrated.
   */
  zona?: string | null;
  userId?: Types.ObjectId | null;
  notes?: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: Types.ObjectId | null;
  updatedBy?: Types.ObjectId | null;
}

interface ClientModel extends Model<ClientDocument> {
  findByDocument(documentType: DocumentType, documentNumber: string): Promise<ClientDocument | null>;
}

const addressSchema = new Schema<ClientAddress>(
  {
    street: { type: String, required: true, trim: true, maxlength: 120 },
    number: { type: String, required: false, trim: true, maxlength: 20, default: null },
    floor: { type: String, trim: true, maxlength: 10, default: null },
    apartment: { type: String, trim: true, maxlength: 10, default: null },
    neighborhood: { type: String, trim: true, maxlength: 80, default: null },
    locality: { type: String, required: true, trim: true, maxlength: 80 },
    postalCode: { type: String, trim: true, maxlength: 20, default: null },
    references: { type: String, trim: true, maxlength: 240, default: null },
  },
  { _id: false },
);

const clientSchema = new Schema<ClientDocument, ClientModel>(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    documentType: {
      type: String,
      required: false,
      enum: ALL_DOCUMENT_TYPES,
      default: null,
    },
    documentNumber: {
      type: String,
      required: false,
      trim: true,
      maxlength: 32,
      default: null,
    },
    phone: {
      type: String,
      trim: true,
      maxlength: 40,
      default: null,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 160,
      default: null,
    },
    clientType: {
      type: String,
      required: true,
      enum: ALL_CLIENT_TYPES,
      default: 'LOCAL',
      index: true,
    },
    address: {
      type: addressSchema,
      required: true,
    },
    zona: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 32,
      default: null,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },
    active: {
      type: Boolean,
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

clientSchema.index(
  { documentType: 1, documentNumber: 1 },
  {
    unique: true,
    name: 'documentType_documentNumber_unique',
    partialFilterExpression: { documentNumber: { $type: 'string' } },
  },
);

clientSchema.index({ lastName: 1, firstName: 1 });
clientSchema.index(
  { userId: 1 },
  {
    unique: true,
    name: 'userId_unique_sparse',
    partialFilterExpression: { userId: { $type: 'objectId' } },
  },
);

clientSchema.statics.findByDocument = function (
  documentType: DocumentType,
  documentNumber: string,
) {
  return this.findOne({
    documentType,
    documentNumber: documentNumber.toUpperCase().replace(/\s+/g, ''),
  });
};

export const Client: ClientModel =
  (mongoose.models.Client as ClientModel | undefined) ??
  mongoose.model<ClientDocument, ClientModel>('Client', clientSchema);
