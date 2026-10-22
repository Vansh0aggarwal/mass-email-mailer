import mongoose, { Schema, Document } from 'mongoose';

export type UserOrgRole = 'owner' | 'admin' | 'manager' | 'sales_rep' | 'viewer';
export type UserStatus = 'active' | 'invited' | 'disabled';

export function normalizeUserStatus(status?: string | null): UserStatus {
  if (!status) return 'active';
  const s = status.trim().toLowerCase();
  if (s === 'active') return 'active';
  if (s === 'invited') return 'invited';
  if (s === 'disabled' || s === 'inactive') return 'disabled';
  return 'active';
}

export interface IUserOrgMembership {
  organizationId: string;
  role: UserOrgRole;
}

export interface IUser extends Document {
  email: string;
  fullName: string;
  avatarUrl?: string;
  googleSub?: string;
  status: UserStatus;
  organizations: IUserOrgMembership[];
  defaultOrgId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    fullName: { type: String, required: true, trim: true },
    avatarUrl: { type: String },
    googleSub: { type: String, sparse: true, index: true },
    status: { type: String, enum: ['active', 'invited', 'disabled'], default: 'active' },
    organizations: [
      {
        organizationId: { type: String, required: true },
        role: {
          type: String,
          enum: ['owner', 'admin', 'manager', 'sales_rep', 'viewer'],
          default: 'owner',
        },
      },
    ],
    defaultOrgId: { type: String },
  },
  { timestamps: true }
);

export const User = mongoose.model<IUser>('User', UserSchema);
