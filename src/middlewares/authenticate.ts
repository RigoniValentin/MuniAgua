import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../modules/auth/auth.tokens.js';
import { UnauthorizedError } from '../shared/errors.js';
import type { Role } from '../modules/users/users.types.js';

export interface AuthenticatedUser {
  id: string;
  role: Role;
  permissions: string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(new UnauthorizedError('Token ausente'));
    return;
  }
  const token = header.substring('Bearer '.length).trim();
  if (!token) {
    next(new UnauthorizedError('Token ausente'));
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      role: payload.role,
      permissions: payload.permissions,
    };
    next();
  } catch {
    next(new UnauthorizedError('Token inválido o expirado'));
  }
}
