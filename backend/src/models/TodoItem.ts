import mongoose, { Schema, Document } from 'mongoose';

export type TodoStatus = 'open' | 'completed';
export type TodoPriority = 'low' | 'medium' | 'high';
/** Where a Google Meet link came from, so generated links can be revoked safely. */
export type MeetLinkSource = 'google' | 'manual';

export interface ITodoSubtask {
  _id?: mongoose.Types.ObjectId;
  title: string;
  completed: boolean;
}

export interface ITodoItem extends Document {
  organizationId: string;
  title: string;
  notes?: string;
  description?: string;
  status: TodoStatus;
  priority: TodoPriority;
  dueDate?: Date;
  scheduledTime?: string;
  scheduledEndTime?: string;
  timezone?: string;
  addToCalendar: boolean;
  addMeetLink: boolean;
  reminderEnabled: boolean;
  reminderMinutes: number;
  reminderSentAt?: Date;
  category?: string;
  tags: string[];
  projectId?: string;
  subtasks: ITodoSubtask[];
  position: number;
  assignedTo: string;
  createdBy: string;
  completedAt?: Date;
  googleTaskId?: string;
  googleTaskListId?: string;
  googleEventId?: string;
  googleCalendarId?: string;
  googleMeetLink?: string;
  googleMeetSource?: MeetLinkSource;
  calendarAccountId?: string;
  googleUpdatedAt?: Date;
  lastSyncedAt?: Date;
  lastSyncError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SubtaskSchema = new Schema<ITodoSubtask>(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    completed: { type: Boolean, default: false },
  },
  { _id: true }
);

const TodoItemSchema = new Schema<ITodoItem>(
  {
    organizationId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    notes: { type: String, trim: true, maxlength: 2000 },
    description: { type: String, trim: true, maxlength: 4000 },
    status: { type: String, enum: ['open', 'completed'], default: 'open', index: true },
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    dueDate: { type: Date, index: true },
    scheduledTime: {
      type: String,
      match: [/^([01]\d|2[0-3]):[0-5]\d$/, 'Scheduled time must be HH:mm'],
    },
    scheduledEndTime: {
      type: String,
      match: [/^([01]\d|2[0-3]):[0-5]\d$/, 'Scheduled end time must be HH:mm'],
    },
    timezone: { type: String, trim: true, maxlength: 60 },
    addToCalendar: { type: Boolean, default: true },
    addMeetLink: { type: Boolean, default: false },
    reminderEnabled: { type: Boolean, default: false },
    reminderMinutes: { type: Number, default: 10, min: 0, max: 10080 },
    reminderSentAt: { type: Date },
    category: { type: String, trim: true, maxlength: 60 },
    tags: { type: [{ type: String, trim: true, maxlength: 30 }], default: [] },
    projectId: { type: String, index: true },
    subtasks: { type: [SubtaskSchema], default: [] },
    position: { type: Number, default: 0 },
    assignedTo: { type: String, required: true, index: true },
    createdBy: { type: String, required: true },
    completedAt: { type: Date },
    googleTaskId: { type: String },
    googleTaskListId: { type: String },
    googleEventId: { type: String },
    googleCalendarId: { type: String },
    googleMeetLink: { type: String, maxlength: 500 },
    googleMeetSource: { type: String, enum: ['google', 'manual'] },
    calendarAccountId: { type: String },
    googleUpdatedAt: { type: Date },
    lastSyncedAt: { type: Date },
    lastSyncError: { type: String, maxlength: 500 },
  },
  { timestamps: true }
);

TodoItemSchema.index({ organizationId: 1, assignedTo: 1, status: 1, dueDate: 1 });
TodoItemSchema.index({ organizationId: 1, createdBy: 1, createdAt: -1 });
TodoItemSchema.index({ organizationId: 1, projectId: 1, status: 1 });
TodoItemSchema.index({ organizationId: 1, googleTaskId: 1 }, { sparse: true });
TodoItemSchema.index({ organizationId: 1, googleEventId: 1 }, { sparse: true });

export const TodoItem = mongoose.model<ITodoItem>('TodoItem', TodoItemSchema);
