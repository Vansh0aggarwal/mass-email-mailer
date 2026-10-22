import mongoose, { Schema, Document } from 'mongoose';

export interface IWorkspaceSettings extends Document {
  organizationId: string;
  senderDisplayName: string;
  businessName: string;
  businessDescription: string;
  authorizedMailbox?: string;
  defaultGreeting: string;
  missingNameFallback: string;
  defaultSignOff: string;
  emailSignature: string;
  contactDetails: string;
  defaultTimezone: string;
  sendingWindowStartHour: number;
  sendingWindowEndHour: number;
  dailySendCap: number;
  batchSize: number;
  paceMinutes: number;
  defaultFollowUpIntervalDays: number;
  preferredTone: 'professional' | 'friendly' | 'concise' | 'consultative' | 'urgent';
  preferredLength: 'short' | 'medium' | 'detailed';
  preferredLanguage: string;
  defaultServiceOffering: string;
  createdAt: Date;
  updatedAt: Date;
}

const WorkspaceSettingsSchema = new Schema<IWorkspaceSettings>(
  {
    organizationId: { type: String, required: true, unique: true, index: true },
    senderDisplayName: { type: String, default: 'Vansh Aggarwal', trim: true },
    businessName: { type: String, default: 'Swaniki New Business Radar', trim: true },
    businessDescription: {
      type: String,
      default: 'B2B Sales Intelligence, Website Audit & Outreach Modernization',
      trim: true,
    },
    authorizedMailbox: { type: String, trim: true, lowercase: true },
    defaultGreeting: { type: String, default: 'Hi {{contact_first_name}},', trim: true },
    missingNameFallback: { type: String, default: 'Hello,', trim: true },
    defaultSignOff: { type: String, default: 'Best regards,', trim: true },
    emailSignature: {
      type: String,
      default: 'Vansh Aggarwal\nSwaniki New Business Radar\nhttps://swaniki.com',
      trim: true,
    },
    contactDetails: { type: String, default: 'team@swaniki.com', trim: true },
    defaultTimezone: { type: String, default: 'Asia/Kolkata', trim: true },
    sendingWindowStartHour: { type: Number, default: 9, min: 0, max: 23 },
    sendingWindowEndHour: { type: Number, default: 18, min: 0, max: 23 },
    dailySendCap: { type: Number, default: 100, min: 1, max: 2000 },
    batchSize: { type: Number, default: 25, min: 1, max: 200 },
    paceMinutes: { type: Number, default: 15, min: 0, max: 1440 },
    defaultFollowUpIntervalDays: { type: Number, default: 3, min: 1, max: 90 },
    preferredTone: {
      type: String,
      enum: ['professional', 'friendly', 'concise', 'consultative', 'urgent'],
      default: 'consultative',
    },
    preferredLength: {
      type: String,
      enum: ['short', 'medium', 'detailed'],
      default: 'medium',
    },
    preferredLanguage: { type: String, default: 'en', trim: true },
    defaultServiceOffering: { type: String, default: 'Website Modernization', trim: true },
  },
  { timestamps: true }
);

export const WorkspaceSettings = mongoose.model<IWorkspaceSettings>('WorkspaceSettings', WorkspaceSettingsSchema);
