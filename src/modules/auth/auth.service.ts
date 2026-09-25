import { randomUUID } from 'node:crypto';
import {
  createUser,
  findUserByEmailWithPassword,
  findUserById,
  toSafeUser,
  verifyPassword,
} from '../users/users.service.js';
import { UnauthorizedError, ForbiddenError, ConflictError } from '../../shared/errors.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  refreshTokenExpiryMs,
} from './auth.tokens.js';
import type { SafeUser } from '../users/users.service.js';
import type { Role } from '../users/users.types.js';
import {
  defaultPermissionsForRole,
  ROLES,
} from '../users/users.types.js';
import { Client } from '../clients/clients.model.js';
import { User } from '../users/users.model.js';
import { normalizePhone } from '../clients/clients.validation.js';
import { syncClientFromUser } from '../clients/clients.service.js';

interface RefreshTokenRecord {
  jti: string;
  userId: string;
  revoked: boolean;
  expiresAt: number;
}

// In-memory refresh token store. Adequate for the foundation phase.
// Will be replaced by a persistent store in a later phase.
const refreshStore = new Map<string, RefreshTokenRecord>();

export function issueRefresh(userId: string): { token: string; jti: string } {
  const jti = randomUUID();
  const token = signRefreshToken({ sub: userId, jti });
  refreshStore.set(jti, {
    jti,
    userId,
    revoked: false,
    expiresAt: Date.now() + refreshTokenExpiryMs(),
  });
  return { token, jti };
}

export function revokeRefresh(jti: string): void {
  const record = refreshStore.get(jti);
  if (record) {
    record.revoked = true;
  }
}

export function revokeAllForUser(userId: string): void {
  for (const record of refreshStore.values()) {
    if (record.userId === userId) {
      record.revoked = true;
    }
  }
}

export interface AuthSuccess {
  user: SafeUser;
  accessToken: string;
  refreshToken: string;
}

export async function login(email: string, password: string): Promise<AuthSuccess> {
  const user = await findUserByEmailWithPassword(email);
  if (!user || !user.active) {
    throw new UnauthorizedError('Credenciales inválidas');
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw new UnauthorizedError('Credenciales inválidas');
  }

  return buildAuthSuccess(user);
}

/**
 * Effective permissions used to mint the access token. Always includes the
 * current role defaults so that role-only additions (e.g. a new
 * `delivery.claim`) propagate to every operator on their next login
 * without a manual DB migration. Custom permissions stored on the user
 * are preserved.
 */
function effectivePermissions(user: import('../users/users.model.js').UserDocument) {
  return Array.from(new Set([...user.permissions, ...defaultPermissionsForRole(user.role)]));
}

async function buildAuthSuccess(user: import('../users/users.model.js').UserDocument): Promise<AuthSuccess> {
  const userId = user._id.toString();
  const accessToken = signAccessToken({
    sub: userId,
    role: user.role,
    permissions: effectivePermissions(user),
  });
  const { token: refreshToken } = issueRefresh(userId);
  return {
    user: { ...toSafeUser(user), permissions: effectivePermissions(user) },
    accessToken,
    refreshToken,
  };
}

export async function refresh(refreshToken: string): Promise<AuthSuccess> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new UnauthorizedError('Refresh token inválido o expirado');
  }

  const record = refreshStore.get(payload.jti);
  if (!record || record.revoked || record.userId !== payload.sub) {
    throw new UnauthorizedError('Refresh token inválido o expirado');
  }
  if (record.expiresAt < Date.now()) {
    refreshStore.delete(payload.jti);
    throw new UnauthorizedError('Refresh token expirado');
  }

  const user = await findUserById(payload.sub);
  if (!user || !user.active) {
    refreshStore.delete(payload.jti);
    throw new UnauthorizedError('Usuario no disponible');
  }

  // Rotate refresh token
  record.revoked = true;
  return buildAuthSuccess(user);
}

export async function me(userId: string): Promise<SafeUser> {
  const user = await findUserById(userId);
  if (!user) {
    throw new UnauthorizedError('Usuario no encontrado');
  }
  if (!user.active) {
    throw new ForbiddenError('Usuario inactivo');
  }
  return toSafeUser(user);
}

export interface RegisterArgs {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string;
  documentNumber?: string;
}

export interface RegisterResult {
  user: SafeUser;
  accessToken: string;
  refreshToken: string;
  linked: boolean;
}

/**
 * Public self-registration. Always creates a User with role CIUDADANO.
 *
 * Auto-linking strategy, in order of priority:
 *   1. Match by `documentNumber` against an unlinked active Client.
 *   2. Otherwise match by `phone` against an unlinked active Client. Useful when
 *      the padrón was imported from an Excel that only had phone (no DNI).
 *
 * On a successful match, the Client is linked AND its email/phone/document
 * fields are synced from the User (User is the source of truth, with a
 * non-destructive fallback — see `syncClientFromUser` in clients.service).
 *
 * Throws `ConflictError` (409) if the email or documentNumber is already in
 * use by another User.
 */
export async function register(args: RegisterArgs): Promise<RegisterResult> {
  const existingByEmail = await findUserByEmailWithPassword(args.email);
  if (existingByEmail) {
    throw new ConflictError('Ya existe una cuenta con ese email');
  }

  const documentNumber = args.documentNumber?.trim() || undefined;
  const phone = args.phone?.trim() || undefined;

  if (documentNumber) {
    const existingByDni = await User.findByDocumentNumber(documentNumber);
    if (existingByDni) {
      throw new ConflictError('Ya existe una cuenta con ese documento');
    }
  }

  const user = await createUser({
    firstName: args.firstName,
    lastName: args.lastName,
    email: args.email,
    password: args.password,
    role: ROLES.CIUDADANO,
    phone: phone ?? null,
    documentNumber: documentNumber ?? null,
  });

  let linked = false;
  if (user.documentNumber) {
    const normalized = user.documentNumber; // already uppercased + cleaned
    const unlinkedClient = await Client.findOne({
      documentNumber: normalized,
      userId: null,
      active: true,
    });
    if (unlinkedClient) {
      const updated = await Client.findOneAndUpdate(
        { _id: unlinkedClient._id, userId: null },
        { $set: { userId: user._id, updatedBy: user._id } },
        { new: true },
      );
      if (updated) {
        syncClientFromUser(updated, user);
        await updated.save();
        linked = true;
      }
    }
  }

  // Fallback: link by phone if no DNI match found.
  if (!linked && user.phone) {
    const phoneNormalized = normalizePhone(user.phone);
    let unlinkedClient = await Client.findOne({
      phone: phoneNormalized,
      userId: null,
      active: true,
    });
    if (!unlinkedClient) {
      // Tail-10 fallback: try matching just the last 10 digits (covers +54 country code).
      const tail = phoneNormalized.slice(-10);
      if (tail.length === 10) {
        unlinkedClient = await Client.findOne({
          phone: { $regex: `${tail}$` },
          userId: null,
          active: true,
        });
      }
    }
    if (unlinkedClient) {
      const updated = await Client.findOneAndUpdate(
        { _id: unlinkedClient._id, userId: null },
        { $set: { userId: user._id, updatedBy: user._id } },
        { new: true },
      );
      if (updated) {
        syncClientFromUser(updated, user);
        await updated.save();
        linked = true;
      }
    }
  }

  const userId = user._id.toString();
  const accessToken = signAccessToken({
    sub: userId,
    role: user.role,
    permissions: effectivePermissions(user),
  });
  const { token: refreshToken } = issueRefresh(userId);

  return {
    user: { ...toSafeUser(user), permissions: effectivePermissions(user) },
    accessToken,
    refreshToken,
    linked,
  };
}

export function requireRole(userRole: Role, allowed: Role[]): void {
  if (!allowed.includes(userRole)) {
    throw new ForbiddenError('Rol no permitido');
  }
}
