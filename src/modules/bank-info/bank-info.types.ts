/**
 * Bank account information displayed to citizens when reporting a payment.
 *
 * The system stores a SINGLE document (singleton) so the municipality can
 * edit the destination account without a code deploy. If the document does
 * not exist, `bank-info.service` seeds it with the BANCOR defaults.
 */
export const BANK_INFO_DOC_ID = 'singleton';

export const DEFAULT_BANK_INFO = {
  bankName: 'BANCOR',
  razonSocial: 'Municipalidad de Buchardo',
  cuit: '30999098939',
  cbu: '0200367001000001020347',
  alias: 'aguamuni.bancor',
} as const;

export interface BankInfoDto {
  bankName: string;
  razonSocial: string;
  cuit: string;
  cbu: string;
  alias: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface UpdateBankInfoInput {
  bankName: string;
  razonSocial: string;
  cuit: string;
  cbu: string;
  alias: string;
}
