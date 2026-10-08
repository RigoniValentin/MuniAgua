import mongoose, { Schema, Types } from 'mongoose';
import { BANK_INFO_DOC_ID } from './bank-info.types.js';

export interface BankInfoDocument {
  _id: string;
  bankName: string;
  razonSocial: string;
  cuit: string;
  cbu: string;
  alias: string;
  updatedBy: Types.ObjectId | null;
  updatedAt: Date;
}

const bankInfoSchema = new Schema<BankInfoDocument>(
  {
    _id: {
      type: String,
      required: true,
      default: BANK_INFO_DOC_ID,
    },
    bankName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    razonSocial: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    cuit: {
      type: String,
      required: true,
      trim: true,
      maxlength: 20,
    },
    cbu: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30,
    },
    alias: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: { createdAt: false, updatedAt: true },
    versionKey: false,
    _id: false,
  },
);

type BankInfoModel = mongoose.Model<BankInfoDocument>;

export const BankInfo =
  (mongoose.models.BankInfo as BankInfoModel | undefined) ??
  mongoose.model<BankInfoDocument>('BankInfo', bankInfoSchema);
