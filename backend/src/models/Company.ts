import mongoose, { Schema, Document } from 'mongoose';

export type AssessmentRating = 'A' | 'B' | 'C' | 'D' | 'F' | 'unrated';

export interface ICompany extends Document {
  organizationId: string;
  name: string;
  domain?: string;
  websiteUrl?: string;
  industry?: string;
  city?: string;
  country?: string;
  overallRating: AssessmentRating;
  rawRating?: string;
  notes?: string;
  services: string[];
  customFields: Map<string, string>;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CompanySchema = new Schema<ICompany>(
  {
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    domain: { type: String, trim: true, lowercase: true },
    websiteUrl: { type: String, trim: true },
    industry: { type: String, trim: true },
    city: { type: String, trim: true },
    country: { type: String, trim: true },
    overallRating: {
      type: String,
      enum: ['A', 'B', 'C', 'D', 'F', 'unrated'],
      default: 'unrated',
    },
    rawRating: { type: String, trim: true },
    notes: { type: String, trim: true },
    services: { type: [String], default: [] },
    customFields: { type: Map, of: String, default: () => new Map() },
    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Compound indexes for tenant isolation, searching, and filtering
CompanySchema.index({ organizationId: 1, name: 1 });
CompanySchema.index({ organizationId: 1, domain: 1 });
CompanySchema.index({ organizationId: 1, overallRating: 1 });
CompanySchema.index({ organizationId: 1, isArchived: 1, createdAt: -1 });

export const Company = mongoose.model<ICompany>('Company', CompanySchema);
