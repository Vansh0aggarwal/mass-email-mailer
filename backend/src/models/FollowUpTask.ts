import mongoose, { Schema, Document } from 'mongoose';

export interface IFollowUpTask extends Document {
  organizationId: string;
  companyId?: mongoose.Types.ObjectId;
  companyName?: string;
  contactEmail: string;
  threadId?: string;
  dueDate: Date;
  notes: string;
  status: 'pending' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high';
  createdAt: Date;
  updatedAt: Date;
}

const FollowUpTaskSchema = new Schema<IFollowUpTask>(
  {
    organizationId: { type: String, required: true, index: true },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', index: true },
    companyName: { type: String },
    contactEmail: { type: String, required: true, lowercase: true, trim: true },
    threadId: { type: String },
    dueDate: { type: Date, required: true },
    notes: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'completed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
  },
  { timestamps: true }
);

FollowUpTaskSchema.index({ organizationId: 1, dueDate: 1, status: 1 });

export const FollowUpTask = mongoose.model<IFollowUpTask>('FollowUpTask', FollowUpTaskSchema);
