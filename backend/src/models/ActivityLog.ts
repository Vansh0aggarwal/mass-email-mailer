import mongoose, { Schema, Document } from 'mongoose';

export interface IActivityLog extends Document {
  organizationId: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  action: string;
  targetType: 'campaign' | 'company' | 'contact' | 'draft' | 'thread' | 'member' | 'suppression' | 'import' | 'deliverability';
  targetId?: string;
  targetName?: string;
  details?: Record<string, any>;
  createdAt: Date;
}

const ActivityLogSchema = new Schema<IActivityLog>(
  {
    organizationId: { type: String, required: true, index: true },
    userId: { type: String, trim: true },
    userName: { type: String, trim: true },
    userEmail: { type: String, trim: true, lowercase: true },
    action: { type: String, required: true, trim: true },
    targetType: {
      type: String,
      required: true,
      enum: ['campaign', 'company', 'contact', 'draft', 'thread', 'member', 'suppression', 'import', 'deliverability'],
    },
    targetId: { type: String, trim: true },
    targetName: { type: String, trim: true },
    details: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ActivityLogSchema.index({ organizationId: 1, createdAt: -1 });
ActivityLogSchema.index({ organizationId: 1, targetType: 1 });
ActivityLogSchema.index({ organizationId: 1, action: 1 });

export const ActivityLog = mongoose.model<IActivityLog>('ActivityLog', ActivityLogSchema);
