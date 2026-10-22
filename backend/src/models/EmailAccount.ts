import mongoose, { Schema, Document } from 'mongoose';

export interface IEmailAccount extends Document {
  organizationId: string;
  userId?: string;
  emailAddress: string;
  displayName: string;
  provider: 'mock' | 'gmail' | 'smtp';
  status: 'connected' | 'paused' | 'error' | 'disconnected';
  googleSub?: string;
  encryptedAccessToken?: string;
  encryptedRefreshToken?: string;
  tokenExpiryDate?: Date;
  grantedScopes?: string[];
  historyId?: string;
  initialSyncCompleted?: boolean;
  syncStatus?: 'idle' | 'syncing' | 'error';
  lastSyncError?: string;
  dailySendLimit: number;
  sendsToday: number;
  /** When the daily send counter was last rolled over. */
  sendsTodayResetAt?: Date;
  /** Sends performed inside the current hourly rate window. */
  sendsThisHour: number;
  /** When the current hourly rate window started. */
  hourWindowStartedAt?: Date;
  /** Timestamp of the most recent successful send from this account. */
  lastSendAt?: Date;
  /**
   * Send slots currently claimed by workers but not yet completed. Reservations
   * make the daily/hourly caps safe when several workers dispatch at once.
   */
  reservedSends: number;
  isPaused: boolean;
  pausedReason?: string;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EmailAccountSchema = new Schema<IEmailAccount>(
  {
    organizationId: { type: String, required: true, index: true },
    userId: { type: String, index: true },
    emailAddress: { type: String, required: true, trim: true, lowercase: true },
    displayName: { type: String, required: true },
    provider: { type: String, enum: ['mock', 'gmail', 'smtp'], default: 'mock' },
    status: { type: String, enum: ['connected', 'paused', 'error', 'disconnected'], default: 'connected' },
    googleSub: { type: String },
    encryptedAccessToken: { type: String },
    encryptedRefreshToken: { type: String },
    tokenExpiryDate: { type: Date },
    grantedScopes: [{ type: String }],
    historyId: { type: String },
    initialSyncCompleted: { type: Boolean, default: false },
    syncStatus: { type: String, enum: ['idle', 'syncing', 'error'], default: 'idle' },
    lastSyncError: { type: String },
    dailySendLimit: { type: Number, default: 100 },
    sendsToday: { type: Number, default: 0 },
    sendsTodayResetAt: { type: Date },
    sendsThisHour: { type: Number, default: 0 },
    hourWindowStartedAt: { type: Date },
    lastSendAt: { type: Date },
    reservedSends: { type: Number, default: 0 },
    isPaused: { type: Boolean, default: false },
    pausedReason: { type: String },
    lastSyncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

EmailAccountSchema.index({ organizationId: 1, emailAddress: 1 }, { unique: true });
EmailAccountSchema.index({ emailAddress: 1 });

export const EmailAccount = mongoose.model<IEmailAccount>('EmailAccount', EmailAccountSchema);
