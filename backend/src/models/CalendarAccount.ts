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
  /** Calendar used for task time blocks. */
  calendarId: string;
  /** Google Tasks list used for task synchronization. */
  taskListId: string;
  taskListName?: string;
  syncTasks: boolean;
  syncCalendar: boolean;
  /** Allow task requests to generate Google Meet conference links. */
  syncMeet: boolean;
  autoSync: boolean;
  lastSyncedAt?: Date;
  calendarSyncToken?: string;
  lastSyncError?: string;
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
    calendarId: { type: String, default: 'primary' },
    taskListId: { type: String, default: '@default' },
    taskListName: { type: String },
    syncTasks: { type: Boolean, default: true },
    syncCalendar: { type: Boolean, default: true },
    syncMeet: { type: Boolean, default: true },
    autoSync: { type: Boolean, default: true },
    lastSyncedAt: { type: Date },
    calendarSyncToken: { type: String },
    lastSyncError: { type: String, maxlength: 500 },
  },
  { timestamps: true }
);

CalendarAccountSchema.index({ organizationId: 1, emailAddress: 1 }, { unique: true });

export const CalendarAccount = mongoose.model<ICalendarAccount>('CalendarAccount', CalendarAccountSchema);
