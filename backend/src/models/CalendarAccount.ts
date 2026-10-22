import mongoose, { Schema, Document } from 'mongoose';

export interface ICalendarAccount extends Document {
  organizationId: string;
  userId: string;
  emailAddress: string;
  displayName: string;
  provider: 'google' | 'mock';
  status: 'connected' | 'error' | 'disconnected';
  encryptedAccessToken?: string;
  encryptedRefreshToken?: string;
  tokenExpiryDate?: Date;
  grantedScopes?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const CalendarAccountSchema = new Schema<ICalendarAccount>(
  {
    organizationId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    emailAddress: { type: String, required: true, trim: true, lowercase: true },
    displayName: { type: String, required: true },
    provider: { type: String, enum: ['google', 'mock'], default: 'mock' },
    status: { type: String, enum: ['connected', 'error', 'disconnected'], default: 'connected' },
    encryptedAccessToken: { type: String },
    encryptedRefreshToken: { type: String },
    tokenExpiryDate: { type: Date },
    grantedScopes: [{ type: String }],
  },
  { timestamps: true }
);

CalendarAccountSchema.index({ organizationId: 1, emailAddress: 1 }, { unique: true });

export const CalendarAccount = mongoose.model<ICalendarAccount>('CalendarAccount', CalendarAccountSchema);
