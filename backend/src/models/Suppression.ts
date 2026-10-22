import mongoose, { Schema, Document } from 'mongoose';

export type SuppressionReason = 'unsubscribed' | 'bounced' | 'manual_block' | 'competitor';

export interface ISuppression extends Document {
  organizationId: string;
  email: string;
  reason: SuppressionReason;
  createdAt: Date;
}

const SuppressionSchema = new Schema<ISuppression>(
  {
    organizationId: { type: String, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    reason: {
      type: String,
      enum: ['unsubscribed', 'bounced', 'manual_block', 'competitor'],
      default: 'manual_block',
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

SuppressionSchema.index({ organizationId: 1, email: 1 }, { unique: true });

export const Suppression = mongoose.model<ISuppression>('Suppression', SuppressionSchema);
