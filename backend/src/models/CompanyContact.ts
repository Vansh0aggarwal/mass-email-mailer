import mongoose, { Schema, Document } from 'mongoose';

export interface ICompanyContact extends Document {
  organizationId: string;
  companyId: mongoose.Types.ObjectId;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email: string;
  phone?: string;
  role?: string;
  isPrimary: boolean;
  isSuppressed: boolean;
  suppressionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CompanyContactSchema = new Schema<ICompanyContact>(
  {
    organizationId: { type: String, required: true, index: true },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    fullName: { type: String, trim: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: [/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, 'Invalid email format'],
    },
    phone: { type: String, trim: true },
    role: { type: String, trim: true, default: 'Executive' },
    isPrimary: { type: Boolean, default: false },
    isSuppressed: { type: Boolean, default: false },
    suppressionReason: { type: String },
  },
  { timestamps: true }
);

// Compound indexes
CompanyContactSchema.index({ organizationId: 1, email: 1 });
CompanyContactSchema.index({ organizationId: 1, companyId: 1 });

export const CompanyContact = mongoose.model<ICompanyContact>('CompanyContact', CompanyContactSchema);
