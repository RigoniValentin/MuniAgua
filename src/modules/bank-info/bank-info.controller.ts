import type { Request, Response } from 'express';
import { updateBankInfoSchema } from './bank-info.validation.js';
import { getBankInfo, toBankInfoDto, updateBankInfo } from './bank-info.service.js';
import { ok } from '../../shared/api-response.js';
import { asyncHandler } from '../../middlewares/error.js';
import { ValidationError } from '../../shared/errors.js';

export const getBankInfoController = asyncHandler(
  async (_req: Request, res: Response) => {
    const doc = await getBankInfo();
    res.json(ok({ bankInfo: toBankInfoDto(doc) }));
  },
);

export const updateBankInfoController = asyncHandler(
  async (req: Request, res: Response) => {
    const parse = updateBankInfoSchema.safeParse(req.body);
    if (!parse.success) {
      throw new ValidationError('Datos inválidos', parse.error.flatten());
    }
    const updatedBy = req.user?.id ?? null;
    if (!updatedBy) {
      throw new ValidationError('No autenticado');
    }
    const doc = await updateBankInfo(parse.data, updatedBy);
    res.json(ok({ bankInfo: toBankInfoDto(doc) }));
  },
);
