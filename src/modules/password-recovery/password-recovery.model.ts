import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export interface PasswordResetTokenDocument extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  usedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

interface PasswordResetTokenModel
  extends Model<PasswordResetTokenDocument> {
  findActiveByHash(tokenHash: string): Promise<PasswordResetTokenDocument | null>;
  invalidatePendingForUser(userId: Types.ObjectId): Promise<number>;
}

const passwordResetTokenSchema = new Schema<
  PasswordResetTokenDocument,
  PasswordResetTokenModel
>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    usedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
      // Mongo TTL monitor evicts the doc once expiresAt is in the past.
      // `expireAfterSeconds: 0` means: delete when expiresAt <= now.
      index: { expireAfterSeconds: 0 },
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);

passwordResetTokenSchema.statics.findActiveByHash = function (tokenHash: string) {
  return this.findOne({
    tokenHash,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  });
};

passwordResetTokenSchema.statics.invalidatePendingForUser = function (
  userId: Types.ObjectId,
) {
  return this.updateMany(
    { userId, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  ).then((res) => res.modifiedCount ?? 0);
};

export const PasswordResetToken: PasswordResetTokenModel =
  (mongoose.models.PasswordResetToken as
    | PasswordResetTokenModel
    | undefined) ??
  mongoose.model<
    PasswordResetTokenDocument,
    PasswordResetTokenModel
  >('PasswordResetToken', passwordResetTokenSchema);
