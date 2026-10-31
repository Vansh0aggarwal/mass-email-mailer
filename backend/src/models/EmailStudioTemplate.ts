import mongoose, { Schema, Document } from 'mongoose';

/**
 * A reusable email design saved by an organization. Presets ship in code;
 * this collection only stores operator-authored templates.
 */
export interface IEmailStudioTemplate extends Document {
  organizationId: string;
  name: string;
  description?: string;
  tone: 'professional' | 'friendly' | 'concise' | 'consultative' | 'urgent';
  subject: string;
  design: Record<string, any>;
  createdBy?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const EmailStudioTemplateSchema = new Schema<IEmailStudioTemplate>(
  {
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 400 },
    tone: {
      type: String,
      enum: ['professional', 'friendly', 'concise', 'consultative', 'urgent'],
      default: 'consultative',
    },
    subject: { type: String, required: true, trim: true, maxlength: 220 },
    design: { type: Schema.Types.Mixed, required: true },
    createdBy: { type: String },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

EmailStudioTemplateSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export const EmailStudioTemplate = mongoose.model<IEmailStudioTemplate>(
  'EmailStudioTemplate',
  EmailStudioTemplateSchema
);
