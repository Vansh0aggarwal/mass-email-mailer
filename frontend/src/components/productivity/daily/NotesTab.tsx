import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';import {
  ChevronLeft,
  ChevronRight,
  GripVertical,
  NotebookPen,
  Plus,
  Search,
  StickyNote,
  Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../../lib/api';
import type { NoteColor, StickyNoteItem } from '../../../types';
import {
  NOTE_COLOR_META,
  NOTE_COLOR_OPTIONS,
  productivityKeys,
} from '../../../lib/productivity';
import { FloatingWindow } from '../FloatingWindow';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';

interface NotesTabProps {
  onError: (message: string) => void;
}

export function NotesTab({ onError }: NotesTabProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim(), 250);
  const [order, setOrder] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ note: StickyNoteItem | null } | null>(null);

  const notesQuery = useQuery({
    queryKey: productivityKeys.notes(debounced),
    queryFn: () =>
      api.get<StickyNoteItem[]>(`/notes${debounced ? `?q=${encodeURIComponent(debounced)}` : ''}`),
  });

  useEffect(() => {
    setOrder((notesQuery.data || []).map((note) => note._id));
  }, [notesQuery.data]);

  const notesById = useMemo(() => {
    const map = new Map<string, StickyNoteItem>();
    for (const note of notesQuery.data || []) map.set(note._id, note);
    return map;
  }, [notesQuery.data]);

  const notes = order
    .map((id) => notesById.get(id))
    .filter((note): note is StickyNoteItem => Boolean(note));

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.patch<{ reordered: number }>('/notes/reorder', { ids }),
    onSuccess: () => {
      onError('');
      queryClient.invalidateQueries({ queryKey: ['productivity'] });
    },
    onError: (err: Error) => {
      onError(err.message);
      notesQuery.refetch();
    },
  });

  const persistOrder = (next: string[]) => {
    setOrder(next);
    if (!debounced) reorder.mutate(next);
  };

  const move = (id: string, direction: -1 | 1) => {
    const index = order.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    persistOrder(next);
  };

  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      return;
    }
    const from = order.indexOf(dragId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0) {
      setDragId(null);
      return;
    }
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    persistOrder(next);
    setDragId(null);
  };

  return (
    <div className="space-y-3 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search notes…"
            aria-label="Search notes"
            className="input px-3 py-1.5 pl-8 text-[11px]"
          />
        </div>
        <button
          type="button"
          onClick={() => setEditor({ note: null })}
          className="ios-btn-primary inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold"
        >
          <Plus className="h-3.5 w-3.5" /> New note
        </button>
      </div>

      {!debounced && notes.length > 1 && (
        <p className="text-[10px] text-ink-subtle">Drag a note to reorder your board.</p>
      )}

      {notesQuery.isLoading ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="h-[150px] animate-pulse rounded-xl border border-line bg-surface-2"
            />
          ))}
        </div>
      ) : notesQuery.isError ? (
        <div className="empty-state gap-3 px-4 py-10">
          <p className="text-xs">Could not load notes right now.</p>
          <button
            type="button"
            onClick={() => notesQuery.refetch()}
            className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold"
          >
            Try again
          </button>
        </div>
      ) : notes.length === 0 ? (
        <div className="empty-state gap-3 px-4 py-10">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface-2 text-ink-subtle">
            <StickyNote className="h-5 w-5" />
          </span>
          <p className="text-xs font-medium">
            {debounced ? 'No notes match that search.' : 'No notes yet.'}
          </p>
          <p className="max-w-xs text-[11px] text-ink-subtle">
            {debounced
              ? 'Try a different word, or clear the search.'
              : 'Capture a thought, a link, or a reminder you want to keep.'}
          </p>
          {!debounced && (
            <button
              type="button"
              onClick={() => setEditor({ note: null })}
              className="ios-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold"
            >
              <Plus className="h-3.5 w-3.5" /> Add a note
            </button>
          )}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {notes.map((note) => {
            const meta = NOTE_COLOR_META[note.color] || NOTE_COLOR_META.yellow;
            const draggable = !debounced;
            return (
              <li
                key={note._id}
                draggable={draggable}
                onDragStart={() => setDragId(note._id)}
                onDragEnd={() => setDragId(null)}
                onDragOver={(event) => {
                  if (draggable) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggable) handleDrop(note._id);
                }}
                className={clsx('group relative', dragId === note._id && 'opacity-50')}
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setEditor({ note })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setEditor({ note });
                    }
                  }}
                  aria-label={`Edit note ${note.title || 'untitled'}`}
                  className={clsx(
                    'flex h-full min-h-[150px] cursor-pointer flex-col rounded-xl border p-3 shadow-sm transition-transform hover:-translate-y-0.5',
                    meta.card
                  )}
                >
                  <div className="flex items-start justify-between gap-1.5">
                    <h3 className="line-clamp-2 text-xs font-semibold">
                      {note.title || 'Untitled note'}
                    </h3>
                    <span
                      className="mt-0.5 shrink-0 opacity-40"
                      aria-hidden="true"
                    >
                      <GripVertical className="h-3.5 w-3.5" />
                    </span>
                  </div>

                  <p className="mt-1.5 line-clamp-5 whitespace-pre-wrap text-[11px] leading-relaxed opacity-80">
                    {note.content || 'Empty note'}
                  </p>

                  <div className="mt-auto flex items-center justify-between gap-1.5 pt-2.5">
                    <span className="text-[9px] uppercase tracking-wide opacity-60">
                      {new Date(note.updatedAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                    {draggable && (
                      <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            move(note._id, -1);
                          }}
                          aria-label={`Move ${note.title || 'note'} earlier`}
                          className="rounded-md p-1 transition-colors hover:bg-black/10"
                        >
                          <ChevronLeft className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            move(note._id, 1);
                          }}
                          aria-label={`Move ${note.title || 'note'} later`}
                          className="rounded-md p-1 transition-colors hover:bg-black/10"
                        >
                          <ChevronRight className="h-3 w-3" />
                        </button>
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editor && (
        <NoteEditorWindow
          note={editor.note}
          onClose={() => setEditor(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['productivity'] });
            setEditor(null);
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

interface NoteEditorWindowProps {
  note: StickyNoteItem | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}

function NoteEditorWindow({ note, onClose, onSaved, onError }: NoteEditorWindowProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [color, setColor] = useState<NoteColor>('yellow');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setTitle(note?.title || '');
    setContent(note?.content || '');
    setColor(note?.color || 'yellow');
    setConfirmDelete(false);
    setError('');
  }, [note?._id]);

  const save = useMutation({
    mutationFn: () => {
      const payload = { title: title.trim(), content, color };
      return note
        ? api.patch<StickyNoteItem>(`/notes/${note._id}`, payload)
        : api.post<StickyNoteItem>('/notes', payload);
    },
    onSuccess: () => {
      onError('');
      onSaved();
    },
    onError: (err: Error) => {
      setError(err.message);
      onError(err.message);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete<{ id: string }>(`/notes/${note!._id}`),
    onSuccess: () => {
      onError('');
      onSaved();
    },
    onError: (err: Error) => setError(err.message),
  });

  const submit = () => {
    if (!title.trim() && !content.trim()) {
      setError('Add a title or some content first.');
      return;
    }
    save.mutate();
  };

  const meta = NOTE_COLOR_META[color] || NOTE_COLOR_META.yellow;

  return (
    <FloatingWindow
      open
      onClose={onClose}
      size="panel"
      modal
      icon={NotebookPen}
      title={note ? 'Edit note' : 'New note'}
      subtitle="Sticky notes stay personal to you."
      footer={
        <div className="flex items-center justify-between gap-2">
          {note ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-danger transition-colors hover:bg-danger/10"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="ios-btn-secondary px-4 py-2 text-xs font-semibold"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={save.isPending || (!title.trim() && !content.trim())}
              className="ios-btn-primary px-4 py-2 text-xs font-semibold disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : note ? 'Save note' : 'Add note'}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4 px-4 py-4 sm:px-5">
        {error && (
          <p className="rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-[11px] text-danger">
            {error}
          </p>
        )}

        {confirmDelete && (
          <div className="rounded-xl border border-danger/25 bg-danger/5 p-3">
            <p className="text-[11px] text-ink">Delete this note permanently?</p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
                className="rounded-lg bg-danger px-3 py-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {remove.isPending ? 'Deleting…' : 'Delete note'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold"
              >
                Keep it
              </button>
            </div>
          </div>
        )}

        <div>
          <label htmlFor="note-title" className="mb-1.5 block text-[11px] font-semibold text-ink-muted">
            Title
          </label>
          <input
            id="note-title"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            placeholder="Note title"
            className="input px-3 py-2.5 text-xs"
            autoFocus
          />
        </div>

        <div>
          <label htmlFor="note-content" className="mb-1.5 block text-[11px] font-semibold text-ink-muted">
            Note
          </label>
          <textarea
            id="note-content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={7}
            maxLength={8000}
            placeholder="Write anything worth keeping…"
            className={clsx('input resize-none px-3 py-2.5 text-xs leading-relaxed', meta.card)}
          />
        </div>

        <div>
          <span className="mb-1.5 block text-[11px] font-semibold text-ink-muted">Colour</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {NOTE_COLOR_OPTIONS.map((option) => {
              const optionMeta = NOTE_COLOR_META[option];
              const active = color === option;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => setColor(option)}
                  aria-pressed={active}
                  aria-label={optionMeta.label}
                  title={optionMeta.label}
                  className={clsx(
                    'h-7 w-7 rounded-full ring-offset-2 ring-offset-surface transition-shadow',
                    optionMeta.swatch,
                    active && 'ring-2 ring-ink/40'
                  )}
                />
              );
            })}
          </div>
        </div>
      </div>
    </FloatingWindow>
  );
}
