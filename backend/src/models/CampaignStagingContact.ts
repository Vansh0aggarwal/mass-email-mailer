import mongoose, { Schema, Document } from 'mongoose';

export type StagedContactStatus = 'staged' | 'assigned';

/**
 * One validated contact belonging to a split import.
 *
 * Contacts are staged to disk-backed Mongo documents (never the whole CSV in
 * memory) so campaign generation can resume after a restart without
 * re-parsing the file or re-assigning anyone. The unique indexes are the
 * dedupe/idempotency boundary:
 *  - (jobId, rowNumber) makes a replayed analysis batch a no-op.
 *  - (jobId, email) guarantees a contact is staged at most once per import.
 */
export interface ICampaignStagingContact extends Document {
  organizationId: string;
  jobId: mongoose.Types.ObjectId;
  /** Source row number from the uploaded file (1-based data row). */
  rowNumber: number;
  email: string;
  name?: string;
  companyName: string;
  /** Normalized cleaned row, kept for CRM company/contact creation. */
  data: Record<string, unknown>;
  /** Bounded personalization snapshot, identical to recipient.customFields. */
  customFields: Record<string, string>;
  /** Campaign number this contact was deterministically assigned to. */
  assignedCampaignNumber?: number;
  /** Set once the recipient document exists in the child campaign. */
  campaignId?: mongoose.Types.ObjectId;
  status: StagedContactStatus;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignStagingContactSchema = new Schema<ICampaignStagingContact>(
  {
    organizationId: { type: String, required: true, index: true },
    jobId: {
      type: Schema.Types.ObjectId,
      ref: 'CampaignSplitJob',
      required: true,
      index: true,
    },
    rowNumber: { type: Number, required: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, trim: true },
    companyName: { type: String, trim: true, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
    customFields: { type: Schema.Types.Mixed, default: {} },
    assignedCampaignNumber: { type: Number },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign' },
    status: {
      type: String,
      enum: ['staged', 'assigned'],
      default: 'staged',
      index: true,
    },
  },
  { timestamps: true }
);

CampaignStagingContactSchema.index({ jobId: 1, rowNumber: 1 }, { unique: true });
CampaignStagingContactSchema.index({ jobId: 1, email: 1 }, { unique: true });
// Allocation pass: walk unassigned contacts in source order.
CampaignStagingContactSchema.index({ jobId: 1, assignedCampaignNumber: 1, rowNumber: 1 });
// Per-campaign generation: fetch the contacts reserved for one child campaign.
CampaignStagingContactSchema.index({ jobId: 1, assignedCampaignNumber: 1, status: 1, rowNumber: 1 });
CampaignStagingContactSchema.index({ jobId: 1, status: 1, rowNumber: 1 });

export const CampaignStagingContact = mongoose.model<ICampaignStagingContact>(
  'CampaignStagingContact',
  CampaignStagingContactSchema
);
