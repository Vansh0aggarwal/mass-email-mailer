import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  Check,
  FolderKanban,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../../../lib/api';
import type { ProjectColor, ProjectIcon, ProductivityProject } from '../../../types';
import {
  PROJECT_COLOR_META,
  PROJECT_ICON_OPTIONS,
  productivityKeys,
} from '../../../lib/productivity';
import { FloatingWindow } from '../FloatingWindow';
import { ProjectGlyph } from '../ProjectGlyph';

const COLOR_OPTIONS = Object.keys(PROJECT_COLOR_META) as ProjectColor[];

interface ProjectsTabProps {
  onError: (message: string) => void;
}

export function ProjectsTab({ onError }: ProjectsTabProps) {
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [editor, setEditor] = useState<{ project: ProductivityProject | null } | null>(null);

  const projectsQuery = useQuery({
    queryKey: productivityKeys.projects(showArchived),
    queryFn: () =>
      api.get<ProductivityProject[]>(
        `/projects${showArchived ? '?includeArchived=1' : ''}`
      ),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['productivity'] });
  };

  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api.patch<ProductivityProject>(`/projects/${id}`, { archived }),
    onSuccess: () => {
      onError('');
      invalidate();
    },
    onError: (err: Error) => onError(err.message),
  });

  const projects = projectsQuery.data || [];
  const activeProjects = projects.filter((project) => !project.archived);

  return (
    <div className="space-y-3 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-ink">Projects</h3>
          <span className="rounded-full border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-ink-muted">
            {activeProjects.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10px] text-ink-muted">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-line accent-accent"
            />
            Show archived
          </label>
          <button
            type="button"
            onClick={() => setEditor({ project: null })}
            className="ios-btn-primary inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold"
          >
            <Plus className="h-3.5 w-3.5" /> New project
          </button>
        </div>
      </div>

      {projectsQuery.isLoading ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[0, 1, 2, 3].map((row) => (
            <div
              key={row}
              className="h-[92px] animate-pulse rounded-xl border border-line bg-surface-2"
            />
          ))}
        </div>
      ) : projectsQuery.isError ? (
        <div className="empty-state gap-3 px-4 py-10">
          <p className="text-xs">Could not load projects right now.</p>
          <button
            type="button"
            onClick={() => projectsQuery.refetch()}
            className="ios-btn-secondary px-3 py-1.5 text-[11px] font-semibold"
          >
            Try again
          </button>
        </div>
      ) : projects.length === 0 ? (
        <div className="empty-state gap-3 px-4 py-10">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface-2 text-ink-subtle">
            <FolderKanban className="h-5 w-5" />
          </span>
          <p className="text-xs font-medium">No projects yet.</p>
          <p className="max-w-xs text-[11px] text-ink-subtle">
            Group related tasks to track progress at a glance.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {projects.map((project) => {
            const meta = PROJECT_COLOR_META[project.color] || PROJECT_COLOR_META.slate;
            return (
              <li
                key={project._id}
                className={clsx(
                  'rounded-xl border border-line bg-surface-2 p-3 transition-colors hover:border-line-strong',
                  project.archived && 'opacity-70'
                )}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className={clsx(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
                      meta.soft,
                      meta.text
                    )}
                  >
                    <ProjectGlyph icon={project.icon} className="h-4 w-4" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-xs font-semibold text-ink">
                      {project.name}
                      {project.archived && (
                        <span className="rounded-full border border-line bg-surface px-1.5 py-0.5 text-[9px] font-semibold text-ink-subtle">
                          Archived
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 line-clamp-1 text-[10px] text-ink-muted">
                      {project.description || 'No description'}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => setEditor({ project })}
                      aria-label={`Edit ${project.name}`}
                      className="rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={archive.isPending}
                      onClick={() => archive.mutate({ id: project._id, archived: !project.archived })}
                      aria-label={project.archived ? `Restore ${project.name}` : `Archive ${project.name}`}
                      className="rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-50"
                    >
                      {project.archived ? (
                        <ArchiveRestore className="h-3.5 w-3.5" />
                      ) : (
                        <Archive className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="mt-2.5">
                  <div className="flex items-center justify-between text-[10px] text-ink-muted">
                    <span>
                      {project.openCount} open · {project.completedCount} done
                    </span>
                    <span className="font-semibold tabular-nums text-ink">
                      {project.progress}%
                    </span>
                  </div>
                  <div
                    className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={project.progress}
                    aria-label={`${project.name} progress`}
                  >
                    <div
                      className={clsx('h-full rounded-full transition-[width] duration-300', meta.swatch)}
                      style={{ width: `${project.progress}%` }}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editor && (
        <ProjectEditorWindow
          project={editor.project}
          onClose={() => setEditor(null)}
          onSaved={() => {
            invalidate();
            setEditor(null);
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

interface ProjectEditorWindowProps {
  project: ProductivityProject | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}

function ProjectEditorWindow({ project, onClose, onSaved, onError }: ProjectEditorWindowProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState<ProjectColor>('slate');
  const [icon, setIcon] = useState<ProjectIcon>('folder');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setName(project?.name || '');
    setDescription(project?.description || '');
    setColor(project?.color || 'slate');
    setIcon(project?.icon || 'folder');
    setConfirmDelete(false);
    setError('');
  }, [project?._id]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        color,
        icon,
      };
      return project
        ? api.patch<ProductivityProject>(`/projects/${project._id}`, payload)
        : api.post<ProductivityProject>('/projects', payload);
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
    mutationFn: () => api.delete<{ id: string }>(`/projects/${project!._id}`),
    onSuccess: () => {
      onError('');
      onSaved();
    },
    onError: (err: Error) => setError(err.message),
  });

  const submit = () => {
    if (!name.trim()) {
      setError('Give the project a name first.');
      return;
    }
    save.mutate();
  };

  return (
    <FloatingWindow
      open
      onClose={onClose}
      size="panel"
      modal
      icon={FolderKanban}
      title={project ? 'Edit project' : 'New project'}
      subtitle={project ? project.name : 'Group tasks and track their progress.'}
      footer={
        <div className="flex items-center justify-between gap-2">
          {project ? (
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
              disabled={save.isPending || !name.trim()}
              className="ios-btn-primary px-4 py-2 text-xs font-semibold disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : project ? 'Save changes' : 'Create project'}
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
            <p className="text-[11px] text-ink">
              Delete <span className="font-semibold">{project?.name}</span>? Its {project?.taskCount}{' '}
              task{project?.taskCount === 1 ? '' : 's'} stay, but lose the project assignment.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
                className="rounded-lg bg-danger px-3 py-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {remove.isPending ? 'Deleting…' : 'Delete project'}
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
          <label htmlFor="project-name" className="mb-1.5 block text-[11px] font-semibold text-ink-muted">
            Project name <span className="text-danger">*</span>
          </label>
          <input
            id="project-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="e.g. Q4 outreach"
            className="input px-3 py-2.5 text-xs"
            autoFocus
          />
        </div>

        <div>
          <label htmlFor="project-description" className="mb-1.5 block text-[11px] font-semibold text-ink-muted">
            Description
          </label>
          <textarea
            id="project-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="What is this project about?"
            className="input resize-none px-3 py-2.5 text-xs"
          />
        </div>

        <div>
          <span className="mb-1.5 block text-[11px] font-semibold text-ink-muted">Colour</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {COLOR_OPTIONS.map((option) => {
              const meta = PROJECT_COLOR_META[option];
              const active = color === option;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => setColor(option)}
                  aria-pressed={active}
                  aria-label={meta.label}
                  title={meta.label}
                  className={clsx(
                    'flex h-7 w-7 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition-shadow',
                    meta.swatch,
                    active && 'ring-2 ring-ink/40'
                  )}
                >
                  {active && <Check className="h-3.5 w-3.5 text-white" />}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <span className="mb-1.5 block text-[11px] font-semibold text-ink-muted">Icon</span>
          <div className="grid grid-cols-6 gap-1.5">
            {PROJECT_ICON_OPTIONS.map((option) => {
              const active = icon === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setIcon(option.value)}
                  aria-pressed={active}
                  aria-label={option.label}
                  title={option.label}
                  className={clsx(
                    'flex h-9 items-center justify-center rounded-xl border transition-colors',
                    active
                      ? 'border-accent/50 bg-accent/10 text-accent'
                      : 'border-line bg-surface-2 text-ink-muted hover:text-ink'
                  )}
                >
                  <ProjectGlyph icon={option.value} className="h-4 w-4" />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </FloatingWindow>
  );
}
