import type { Request, Response } from 'express';
import {
  login as loginService,
  refresh as refreshService,
  me as meService,
  register as registerService,
  revokeRefresh,
} from './auth.service.js';
import { loginSchema, registerSchema } from './auth.validation.js';
import { ok } from '../../shared/api-response.js';
import { asyncHandler } from '../../middlewares/error.js';
import { getEnv } from '../../config/env.js';
import { UnauthorizedError } from '../../shared/errors.js';
import { verifyRefreshToken } from './auth.tokens.js';

export const loginController = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = loginSchema.parse(req.body);
  const result = await loginService(email, password);

  setRefreshCookie(res, result.refreshToken);

  res.json(ok({ user: result.user, accessToken: result.accessToken }));
});

export const registerController = asyncHandler(async (req: Request, res: Response) => {
  const data = registerSchema.parse(req.body);
  const result = await registerService({
    firstName: data.firstName,
    lastName: data.lastName,
    email: data.email,
    password: data.password,
    phone: data.phone,
    documentNumber: data.documentNumber,
  });

  setRefreshCookie(res, result.refreshToken);

  res.status(201).json(
    ok({
      user: result.user,
      accessToken: result.accessToken,
      linked: result.linked,
    }),
  );
});

export const refreshController = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[getEnv().REFRESH_COOKIE_NAME];
  if (!token) {
    throw new UnauthorizedError('Refresh token ausente');
  }
  const result = await refreshService(token);
  setRefreshCookie(res, result.refreshToken);
  res.json(ok({ user: result.user, accessToken: result.accessToken }));
});

export const logoutController = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[getEnv().REFRESH_COOKIE_NAME];
  if (token) {
    try {
      const payload = verifyRefreshToken(token);
      revokeRefresh(payload.jti);
    } catch {
      // Ignore invalid token on logout
    }
  }
  clearRefreshCookie(res);
  res.json(ok({ message: 'Sesión cerrada' }));
});

export const meController = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new UnauthorizedError('No autenticado');
  }
  const user = await meService(req.user.id);
  res.json(ok({ user }));
});

function setRefreshCookie(res: Response, token: string): void {
  const env = getEnv();
  res.cookie(env.REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: env.NODE_ENV === 'production' ? 'strict' : 'lax',
    path: '/api/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res: Response): void {
  const env = getEnv();
  res.clearCookie(env.REFRESH_COOKIE_NAME, { path: '/api/auth' });
}
