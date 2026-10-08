import { BankInfo, type BankInfoDocument } from './bank-info.model.js';
import {
  BANK_INFO_DOC_ID,
  DEFAULT_BANK_INFO,
  type BankInfoDto,
  type UpdateBankInfoInput,
} from './bank-info.types.js';

export function toBankInfoDto(doc: BankInfoDocument): BankInfoDto {
  return {
    bankName: doc.bankName,
    razonSocial: doc.razonSocial,
    cuit: doc.cuit,
    cbu: doc.cbu,
    alias: doc.alias,
    updatedAt: doc.updatedAt.toISOString(),
    updatedBy: doc.updatedBy ? doc.updatedBy.toString() : null,
  };
}

/**
 * Returns the current bank account info, seeding the singleton with the
 * BANCOR defaults the first time it is requested.
 */
export async function getBankInfo(): Promise<BankInfoDocument> {
  const existing = await BankInfo.findById(BANK_INFO_DOC_ID).exec();
  if (existing) return existing;
  return BankInfo.findByIdAndUpdate(
    BANK_INFO_DOC_ID,
    { $setOnInsert: { ...DEFAULT_BANK_INFO, updatedBy: null } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).exec();
}

export async function updateBankInfo(
  input: UpdateBankInfoInput,
  updatedById: string | null,
): Promise<BankInfoDocument> {
  const doc = await BankInfo.findByIdAndUpdate(
    BANK_INFO_DOC_ID,
    {
      $set: {
        bankName: input.bankName,
        razonSocial: input.razonSocial,
        cuit: input.cuit,
        cbu: input.cbu,
        alias: input.alias,
        updatedBy: updatedById,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).exec();
  if (!doc) {
    throw new Error('No se pudo guardar la información bancaria');
  }
  return doc;
}
