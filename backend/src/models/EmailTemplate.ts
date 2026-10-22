import mongoose, { Schema, Document } from 'mongoose';

export interface IEmailTemplate extends Document {
  organizationId: string;
  name: string;
  category: 'first_contact' | 'website_redesign' | 'social_media' | 'follow_up' | 'general';
  tone: 'professional' | 'friendly' | 'concise' | 'consultative' | 'urgent';
  subject: string;
  body: string;
  variables: string[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const EmailTemplateSchema = new Schema<IEmailTemplate>(
  {
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ['first_contact', 'website_redesign', 'social_media', 'follow_up', 'general'],
      default: 'first_contact',
    },
    tone: {
      type: String,
      enum: ['professional', 'friendly', 'concise', 'consultative', 'urgent'],
      default: 'consultative',
    },
    subject: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    variables: { type: [String], default: [] },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

EmailTemplateSchema.index({ organizationId: 1, name: 1 });

export const EmailTemplate = mongoose.model<IEmailTemplate>('EmailTemplate', EmailTemplateSchema);
