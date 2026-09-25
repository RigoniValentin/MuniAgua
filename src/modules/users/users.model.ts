import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import {
  ALL_ROLES,
  ALL_PERMISSIONS,
  ROLES,
  type Permission,
  type Role,
  defaultPermissionsForRole,
} from './users.types.js';

export interface UserDocument extends Document {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  documentNumber?: string | null;
  passwordHash: string;
  role: Role;
  permissions: Permission[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface UserModel extends Model<UserDocument> {
  findByEmail(email: string): Promise<UserDocument | null>;
  findByDocumentNumber(documentNumber: string): Promise<UserDocument | null>;
}

const userSchema = new Schema<UserDocument, UserModel>(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      maxlength: 160,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    phone: {
      type: String,
      trim: true,
      maxlength: 40,
      default: null,
      index: true,
    },
    documentNumber: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
      maxlength: 32,
      index: true,
    },
    role: {
      type: String,
      required: true,
      enum: ALL_ROLES,
      default: ROLES.CIUDADANO,
    },
    permissions: {
      type: [String],
      default: function (this: UserDocument) {
        return defaultPermissionsForRole(this.role);
      },
      validate: {
        validator(perms: string[]) {
          return perms.every((p) => (ALL_PERMISSIONS as string[]).includes(p));
        },
        message: 'Permiso desconocido',
      },
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// documentNumber has a sparse unique index: enforces 1-to-1 between users
// when set, but lets existing users (without documentNumber) coexist.
// Matches the sparse pattern used in Client.userId.
userSchema.index(
  { documentNumber: 1 },
  {
    unique: true,
    name: 'documentNumber_unique_sparse',
    partialFilterExpression: { documentNumber: { $type: 'string' } },
  },
);

userSchema.statics.findByEmail = function (email: string) {
  return this.findOne({ email: email.toLowerCase().trim() }).select('+passwordHash');
};

userSchema.statics.findByDocumentNumber = function (documentNumber: string) {
  const normalized = documentNumber
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/-/g, '')
    .replace(/\./g, '');
  return this.findOne({ documentNumber: normalized }).select('+passwordHash');
};

userSchema.methods.toSafeJSON = function () {
  const obj = this.toObject({ versionKey: false });
  delete obj.passwordHash;
  return obj;
};

export const User: UserModel =
  (mongoose.models.User as UserModel | undefined) ??
  mongoose.model<UserDocument, UserModel>('User', userSchema);
