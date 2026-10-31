import mongoose, { Schema, Document } from 'mongoose';

export const NOTE_COLORS = ['yellow', 'green', 'pink', 'purple', 'blue', 'orange'] as const;

export interface IStickyNote extends Document {
  organizationId: string;
  userId: string;
  title: string;
  content: string;
  color: (typeof NOTE_COLORS)[number];
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

const StickyNoteSchema = new Schema<IStickyNote>(
  {
    organizationId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    title: { type: String, trim: true, maxlength: 120, default: '' },
    content: { type: String, trim: true, maxlength: 8000, default: '' },
    color: { type: String, enum: NOTE_COLORS, default: 'yellow' },
    position: { type: Number, default: 0 },
  },
  { timestamps: true }
);

StickyNoteSchema.index({ organizationId: 1, userId: 1, position: 1, createdAt: -1 });

export const StickyNote = mongoose.model<IStickyNote>('StickyNote', StickyNoteSchema);
