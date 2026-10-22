import mongoose, { Schema, Document } from 'mongoose';
import { AssessmentRating } from './Company.js';

export interface ICompanyAssessment extends Document {
  organizationId: string;
  companyId: mongoose.Types.ObjectId;
  normalizedRating: AssessmentRating;
  rawScore?: number;
  scaleUsed: string;
  source?: string;
  notes?: string;
  assessmentDate: Date;
  createdAt: Date;
}

const CompanyAssessmentSchema = new Schema<ICompanyAssessment>(
  {
    organizationId: { type: String, required: true, index: true },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    normalizedRating: {
      type: String,
      enum: ['A', 'B', 'C', 'D', 'F', 'unrated'],
      required: true,
    },
    rawScore: { type: Number },
    scaleUsed: { type: String, default: 'letter' },
    source: { type: String, trim: true },
    notes: { type: String, trim: true },
    assessmentDate: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

CompanyAssessmentSchema.index({ organizationId: 1, companyId: 1, assessmentDate: -1 });

export const CompanyAssessment = mongoose.model<ICompanyAssessment>('CompanyAssessment', CompanyAssessmentSchema);
