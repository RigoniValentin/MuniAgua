import type { Request, Response } from 'express';
import { createUserSchema, updateUserSchema } from './users.validation.js';
import {
  createUser,
  findUserByEmailWithPassword,
  findUserById,
  toSafeUser,
} from './users.service.js';
import { ok } from '../../shared/api-response.js';
import { asyncHandler } from '../../middlewares/error.js';
import { ConflictError, NotFoundError, ForbiddenError } from '../../shared/errors.js';
import { ROLES } from './users.types.js';

export const listUsersController = asyncHandler(async (_req: Request, res: Response) => {
  const { User } = await import('./users.model.js');
  const users = await User.find().sort({ createdAt: -1 }).lean();
  const safe = users.map((u) => ({
    id: u._id.toString(),
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    phone: u.phone ?? null,
    role: u.role,
    permissions: u.permissions,
    active: u.active,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  }));
  res.json(ok({ users: safe }));
});

export const createUserController = asyncHandler(async (req: Request, res: Response) => {
  const data = createUserSchema.parse(req.body);

  const existing = await findUserByEmailWithPassword(data.email);
  if (existing) {
    throw new ConflictError('Ya existe un usuario con ese email');
  }

  const user = await createUser(data);
  res.status(201).json(ok({ user: toSafeUser(user) }));
});

export const updateUserController = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) {
    throw new NotFoundError();
  }
  const data = updateUserSchema.parse(req.body);
  const user = await findUserById(id);
  if (!user) {
    throw new NotFoundError('Usuario no encontrado');
  }

  if (data.role && data.role !== user.role && req.user?.role !== ROLES.SUPER_ADMIN) {
    throw new ForbiddenError('Solo SUPER_ADMIN puede cambiar roles');
  }

  if (data.firstName !== undefined) user.firstName = data.firstName;
  if (data.lastName !== undefined) user.lastName = data.lastName;
  if (data.active !== undefined) user.active = data.active;
  if (data.phone !== undefined) user.phone = data.phone?.trim() || null;
  if (data.role !== undefined) user.role = data.role;
  if (data.permissions !== undefined) user.permissions = data.permissions as typeof user.permissions;

  await user.save();
  res.json(ok({ user: toSafeUser(user) }));
});
