import mongoose, { Schema, Document } from 'mongoose';

export interface IProject extends Document {
  organizationId: string;
  userId: string;
  name: string;
  description?: string;
  color: string;
  icon: string;
  archived: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export const PROJECT_ICONS = ['folder', 'briefcase', 'book', 'heart', 'wallet', 'sparkles'] as const;
export const PROJECT_COLORS = ['slate', 'blue', 'green', 'amber', 'rose', 'violet'] as const;

const ProjectSchema = new Schema<IProject>(
  {
    organizationId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 1000 },
    color: { type: String, enum: PROJECT_COLORS, default: 'slate' },
    icon: { type: String, enum: PROJECT_ICONS, default: 'folder' },
    archived: { type: Boolean, default: false, index: true },
    position: { type: Number, default: 0 },
  },
  { timestamps: true }
);

ProjectSchema.index({ organizationId: 1, userId: 1, archived: 1, createdAt: -1 });

export const Project = mongoose.model<IProject>('Project', ProjectSchema);
