import type { Request, Response, NextFunction } from 'express';
import { ForbiddenError, UnauthorizedError } from '../shared/errors.js';
import type { Role } from '../modules/users/users.types.js';
import type { Permission } from '../modules/users/users.types.js';

export function requirePermission(...required: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('No autenticado'));
      return;
    }
    const has = required.every((p) => req.user!.permissions.includes(p));
    if (!has) {
      next(new ForbiddenError(`Permisos insuficientes (${required.join(', ')})`));
      return;
    }
    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('No autenticado'));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new ForbiddenError('Rol no permitido'));
      return;
    }
    next();
  };
}
