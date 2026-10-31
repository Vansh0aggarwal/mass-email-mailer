import mongoose, { Schema, Document } from 'mongoose';

/** Per-user configuration for the simple To-Do List window. */
export interface ITodoList extends Document {
  organizationId: string;
  userId: string;
  title: string;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_TODO_LIST_TITLE = 'My To-Do List';

const TodoListSchema = new Schema<ITodoList>(
  {
    organizationId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    title: { type: String, default: DEFAULT_TODO_LIST_TITLE, trim: true, maxlength: 80 },
    timezone: { type: String, default: 'UTC', trim: true, maxlength: 60 },
  },
  { timestamps: true }
);

TodoListSchema.index({ organizationId: 1, userId: 1 }, { unique: true });

export const TodoList = mongoose.model<ITodoList>('TodoList', TodoListSchema);
