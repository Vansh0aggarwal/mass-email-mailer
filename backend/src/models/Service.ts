import mongoose, { Schema, Document } from 'mongoose';

export interface IService extends Document {
  organizationId: string;
  name: string;
  code: string;
  description: string;
  valueProposition: string;
  triggerKeywords: string[];
  isActive: boolean;
  defaultPriceRange?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ServiceSchema = new Schema<IService>(
  {
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, lowercase: true },
    description: { type: String, required: true, trim: true },
    valueProposition: { type: String, required: true, trim: true },
    triggerKeywords: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    defaultPriceRange: { type: String, trim: true },
  },
  { timestamps: true }
);

ServiceSchema.index({ organizationId: 1, code: 1 }, { unique: true });

export const Service = mongoose.model<IService>('Service', ServiceSchema);
