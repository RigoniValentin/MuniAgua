import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { User, type UserDocument } from './users.model.js';
import {
  defaultPermissionsForRole,
  type Permission,
  type Role,
} from './users.types.js';

const BCRYPT_ROUNDS = 12;

export interface SafeUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  documentNumber: string | null;
  role: Role;
  permissions: Permission[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function toSafeUser(doc: UserDocument): SafeUser {
  return {
    id: doc._id.toString(),
    firstName: doc.firstName,
    lastName: doc.lastName,
    email: doc.email,
    phone: doc.phone ?? null,
    documentNumber: doc.documentNumber ?? null,
    role: doc.role,
    permissions: doc.permissions,
    active: doc.active,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function findUserByEmailWithPassword(email: string): Promise<UserDocument | null> {
  return User.findByEmail(email);
}

export async function findUserByEmail(email: string): Promise<UserDocument | null> {
  if (!email) return null;
  return User.findOne({ email: email.toLowerCase().trim() });
}

export async function findUserByDocumentNumber(
  documentNumber: string,
): Promise<UserDocument | null> {
  return User.findByDocumentNumber(documentNumber);
}

export async function findUserById(id: string): Promise<UserDocument | null> {
  if (!Types.ObjectId.isValid(id)) {
    return null;
  }
  return User.findById(id);
}

/**
 * Replace the stored password hash for an existing user.
 * Returns the updated document (with passwordHash stripped via projection),
 * or null when the user does not exist.
 *
 * Used by the password-recovery flow. The User schema declares
 * `passwordHash` with `select: false`, so a fresh findOneAndUpdate must
 * explicitly request it for callers that still want to compare against the
 * previous hash.
 */
export async function updateUserPassword(
  userId: string,
  newPassword: string,
): Promise<UserDocument | null> {
  if (!Types.ObjectId.isValid(userId)) {
    return null;
  }
  const passwordHash = await hashPassword(newPassword);
  return User.findByIdAndUpdate(
    userId,
    { $set: { passwordHash } },
    { new: true, runValidators: true },
  );
}

export interface CreateUserArgs {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  role: Role;
  phone?: string | null;
  documentNumber?: string | null;
}

/**
 * Normalize a document number: uppercase, trim, strip spaces/hyphens/dots.
 * Used by both User and Client side, so a "12.345.678" entry matches "12345678".
 */
function normalizeDocumentNumber(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/-/g, '')
    .replace(/\./g, '');
}

export async function createUser(args: CreateUserArgs): Promise<UserDocument> {
  const passwordHash = await hashPassword(args.password);
  return User.create({
    firstName: args.firstName,
    lastName: args.lastName,
    email: args.email.toLowerCase().trim(),
    phone: args.phone?.trim() || null,
    documentNumber: args.documentNumber
      ? normalizeDocumentNumber(args.documentNumber)
      : null,
    passwordHash,
    role: args.role,
    permissions: defaultPermissionsForRole(args.role),
    active: true,
  });
}
