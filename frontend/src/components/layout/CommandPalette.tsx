import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Building2,
  Users,
  Send,
  Mail,
  X,
  ArrowRight,
  CornerDownLeft,
  ListChecks,
  FolderKanban,
  StickyNote,
} from 'lucide-react';
import { api } from '../../lib/api';
import type {
  NoteColor,
  ProductivitySearchResponse,
  ProjectColor,
  TaskViewTarget,
  TodoPriority,
} from '../../types';
import {
  NOTE_COLOR_META,
  PRIORITY_META,
  PROJECT_COLOR_META,
} from '../../lib/productivity';
import { useProductivity } from '../../context/ProductivityContext';

/** Productivity search returns raw enum values; show the same labels as the windows. */
function displayBadge(badge?: string): string | undefined {
  if (!badge) return undefined;
  if (badge in PRIORITY_META) return PRIORITY_META[badge as TodoPriority].label;
  if (badge in PROJECT_COLOR_META) return PROJECT_COLOR_META[badge as ProjectColor].label;
  if (badge in NOTE_COLOR_META) return NOTE_COLOR_META[badge as NoteColor].label;
  return badge;
}

interface SearchResultItem {
  id: string;
  type: 'company' | 'contact' | 'campaign' | 'thread' | 'task' | 'project' | 'note';
  title: string;
  subtitle: string;
  badge?: string;
  url: string;
  /** Set for productivity results so selection can open the matching window. */
  taskId?: string;
  target?: TaskViewTarget;
}

interface SearchResponse {
  query: string;
  total: number;
  companies: SearchResultItem[];
  contacts: SearchResultItem[];
  campaigns: SearchResultItem[];
  threads: SearchResultItem[];
}

export function CommandPalette({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [productivityResults, setProductivityResults] = useState<ProductivitySearchResponse | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const navigate = useNavigate();
  const { openTask, openWindow } = useProductivity();
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery('');
      setResults(null);
      setProductivityResults(null);
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Debounced search
  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) {
      setResults(null);
      setProductivityResults(null);
      setIsLoading(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsLoading(true);
      const q = encodeURIComponent(query.trim());
      const [business, productivity] = await Promise.all([
        api.get<SearchResponse>(`/search?q=${q}`).catch(() => null),
        api.get<ProductivitySearchResponse>(`/productivity/search?q=${q}`).catch(() => null),
      ]);
      setResults(business);
      setProductivityResults(productivity);
      setSelectedIndex(0);
      setIsLoading(false);
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  const productivityItems: SearchResultItem[] = productivityResults
    ? [
        ...productivityResults.tasks.map((task) => ({
          id: `task-${task.id}`,
          type: 'task' as const,
          title: task.title,
          subtitle: task.subtitle,
          badge: displayBadge(task.badge),
          url: '',
          taskId: task.id,
          target: task.target,
        })),
        ...productivityResults.projects.map((project) => ({
          id: `project-${project.id}`,
          type: 'project' as const,
          title: project.title,
          subtitle: project.subtitle,
          badge: displayBadge(project.badge),
          url: '',
        })),
        ...productivityResults.notes.map((note) => ({
          id: `note-${note.id}`,
          type: 'note' as const,
          title: note.title,
          subtitle: note.subtitle,
          badge: displayBadge(note.badge),
          url: '',
        })),
      ]
    : [];

  // Flatten items for keyboard navigation
  const allItems: SearchResultItem[] = results
    ? [
        ...results.companies,
        ...results.contacts,
        ...results.campaigns,
        ...results.threads,
        ...productivityItems,
      ]
    : productivityItems;

  const handleSelect = (item: SearchResultItem) => {
    onClose();
    if (item.type === 'task' && item.taskId) {
      openTask(item.taskId, item.target);
      return;
    }
    if (item.type === 'project') {
      openWindow('daily', { tab: 'projects' });
      return;
    }
    if (item.type === 'note') {
      openWindow('daily', { tab: 'notes' });
      return;
    }
    navigate(item.url);
  };

  const trimmedQuery = query.trim();
  const hasSearched = results !== null || productivityResults !== null;
  const showEmpty =
    !isLoading &&
    trimmedQuery.length >= 2 &&
    hasSearched &&
    (results?.total ?? 0) === 0 &&
    productivityItems.length === 0;
  const showError =
    !isLoading && trimmedQuery.length >= 2 && !hasSearched;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (allItems.length > 0 ? (prev + 1) % allItems.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (allItems.length > 0 ? (prev - 1 + allItems.length) % allItems.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (allItems[selectedIndex]) {
        handleSelect(allItems[selectedIndex]);
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity" onClick={onClose} />

      <div className="relative w-full max-w-2xl bg-surface border border-line rounded-2xl shadow-2xl overflow-hidden flex flex-col z-10 animate-in fade-in-0 zoom-in-95 duration-150">
        <div className="flex items-center px-4 py-3.5 border-b border-line gap-3">
          <Search className="w-5 h-5 text-ink-subtle shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search companies, contacts, tasks, projects, notes..."
            className="w-full bg-transparent text-ink placeholder:text-ink-subtle text-sm outline-none"
          />
          {isLoading && <span className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />}
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-ink-subtle hover:text-ink hover:bg-surface-2 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2 divide-y divide-line/40">
          {trimmedQuery.length < 2 && !isLoading && (
            <div className="py-12 text-center text-xs text-ink-subtle space-y-2">
              <p className="font-medium text-ink-muted">Swaniki Global Workspace Search</p>
              <p>
                Type at least 2 characters to search companies, prospects, campaigns, inbox threads,
                tasks, projects, and notes.
              </p>
            </div>
          )}

          {showEmpty && (
            <div className="py-10 text-center text-xs text-ink-subtle">
              No matching records found for "{query}".
            </div>
          )}

          {showError && (
            <div className="py-10 text-center text-xs text-ink-subtle">
              Search is unavailable right now. Try again in a moment.
            </div>
          )}

          {results && results.companies.length > 0 && (
            <div className="py-2">
              <div className="px-3 py-1 text-[10px] font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-1.5">
                <Building2 className="w-3 h-3 text-accent" />
                Companies
              </div>
              <div className="space-y-1 mt-1">
                {results.companies.map((c) => {
                  const globalIdx = allItems.findIndex((it) => it.id === c.id);
                  const isSelected = globalIdx === selectedIndex;
                  return (
                    <div
                      key={c.id}
                      onClick={() => handleSelect(c)}
                      onMouseEnter={() => setSelectedIndex(globalIdx)}
                      className={`px-3 py-2 rounded-xl cursor-pointer flex items-center justify-between text-xs transition-colors ${
                        isSelected ? 'bg-accent/10 text-accent-fg' : 'hover:bg-surface-2 text-ink'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-ink truncate">{c.title}</div>
                        <div className="text-[11px] text-ink-subtle truncate">{c.subtitle}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {c.badge && (
                          <span className="px-2 py-0.5 rounded-full bg-surface-3 text-[10px] text-ink-muted">
                            {c.badge}
                          </span>
                        )}
                        <ArrowRight className="w-3.5 h-3.5 text-ink-subtle" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {results && results.contacts.length > 0 && (
            <div className="py-2">
              <div className="px-3 py-1 text-[10px] font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-1.5">
                <Users className="w-3 h-3 text-info" />
                Contacts
              </div>
              <div className="space-y-1 mt-1">
                {results.contacts.map((ct) => {
                  const globalIdx = allItems.findIndex((it) => it.id === ct.id);
                  const isSelected = globalIdx === selectedIndex;
                  return (
                    <div
                      key={ct.id}
                      onClick={() => handleSelect(ct)}
                      onMouseEnter={() => setSelectedIndex(globalIdx)}
                      className={`px-3 py-2 rounded-xl cursor-pointer flex items-center justify-between text-xs transition-colors ${
                        isSelected ? 'bg-accent/10 text-accent-fg' : 'hover:bg-surface-2 text-ink'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-ink truncate">{ct.title}</div>
                        <div className="text-[11px] text-ink-subtle truncate">{ct.subtitle}</div>
                      </div>
                      {ct.badge && (
                        <span className="px-2 py-0.5 rounded-full bg-surface-3 text-[10px] text-ink-muted shrink-0">
                          {ct.badge}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {results && results.campaigns.length > 0 && (
            <div className="py-2">
              <div className="px-3 py-1 text-[10px] font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-1.5">
                <Send className="w-3 h-3 text-success" />
                Campaigns
              </div>
              <div className="space-y-1 mt-1">
                {results.campaigns.map((cmp) => {
                  const globalIdx = allItems.findIndex((it) => it.id === cmp.id);
                  const isSelected = globalIdx === selectedIndex;
                  return (
                    <div
                      key={cmp.id}
                      onClick={() => handleSelect(cmp)}
                      onMouseEnter={() => setSelectedIndex(globalIdx)}
                      className={`px-3 py-2 rounded-xl cursor-pointer flex items-center justify-between text-xs transition-colors ${
                        isSelected ? 'bg-accent/10 text-accent-fg' : 'hover:bg-surface-2 text-ink'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-ink truncate">{cmp.title}</div>
                        <div className="text-[11px] text-ink-subtle truncate">{cmp.subtitle}</div>
                      </div>
                      {cmp.badge && (
                        <span className="px-2 py-0.5 rounded-full bg-success/10 text-success text-[10px] font-medium shrink-0">
                          {cmp.badge}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {results && results.threads.length > 0 && (
            <div className="py-2">
              <div className="px-3 py-1 text-[10px] font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-1.5">
                <Mail className="w-3 h-3 text-warning" />
                Inbox Threads
              </div>
              <div className="space-y-1 mt-1">
                {results.threads.map((th) => {
                  const globalIdx = allItems.findIndex((it) => it.id === th.id);
                  const isSelected = globalIdx === selectedIndex;
                  return (
                    <div
                      key={th.id}
                      onClick={() => handleSelect(th)}
                      onMouseEnter={() => setSelectedIndex(globalIdx)}
                      className={`px-3 py-2 rounded-xl cursor-pointer flex items-center justify-between text-xs transition-colors ${
                        isSelected ? 'bg-accent/10 text-accent-fg' : 'hover:bg-surface-2 text-ink'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-ink truncate">{th.title}</div>
                        <div className="text-[11px] text-ink-subtle truncate">{th.subtitle}</div>
                      </div>
                      {th.badge && (
                        <span className="px-2 py-0.5 rounded-full bg-surface-3 text-[10px] text-ink-muted shrink-0">
                          {th.badge}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {productivityResults && productivityResults.tasks.length > 0 && (
            <div className="py-2">
              <div className="px-3 py-1 text-[10px] font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-1.5">
                <ListChecks className="w-3 h-3 text-accent" />
                Tasks
              </div>
              <div className="space-y-1 mt-1">
                {productivityResults.tasks.map((task) => {
                  const itemId = `task-${task.id}`;
                  const globalIdx = allItems.findIndex((it) => it.id === itemId);
                  const isSelected = globalIdx === selectedIndex;
                  return (
                    <div
                      key={itemId}
                      onClick={() => handleSelect(allItems[globalIdx])}
                      onMouseEnter={() => setSelectedIndex(globalIdx)}
                      className={`px-3 py-2 rounded-xl cursor-pointer flex items-center justify-between text-xs transition-colors ${
                        isSelected ? 'bg-accent/10 text-accent-fg' : 'hover:bg-surface-2 text-ink'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-ink truncate">{task.title}</div>
                        <div className="text-[11px] text-ink-subtle truncate">{task.subtitle}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {task.badge && (
                          <span className="px-2 py-0.5 rounded-full bg-surface-3 text-[10px] text-ink-muted">
                            {displayBadge(task.badge)}
                          </span>
                        )}
                        <ArrowRight className="w-3.5 h-3.5 text-ink-subtle" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {productivityResults && productivityResults.projects.length > 0 && (
            <div className="py-2">
              <div className="px-3 py-1 text-[10px] font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-1.5">
                <FolderKanban className="w-3 h-3 text-info" />
                Projects
              </div>
              <div className="space-y-1 mt-1">
                {productivityResults.projects.map((project) => {
                  const itemId = `project-${project.id}`;
                  const globalIdx = allItems.findIndex((it) => it.id === itemId);
                  const isSelected = globalIdx === selectedIndex;
                  return (
                    <div
                      key={itemId}
                      onClick={() => handleSelect(allItems[globalIdx])}
                      onMouseEnter={() => setSelectedIndex(globalIdx)}
                      className={`px-3 py-2 rounded-xl cursor-pointer flex items-center justify-between text-xs transition-colors ${
                        isSelected ? 'bg-accent/10 text-accent-fg' : 'hover:bg-surface-2 text-ink'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-ink truncate">{project.title}</div>
                        <div className="text-[11px] text-ink-subtle truncate">{project.subtitle}</div>
                      </div>
                      {project.badge && (
                        <span className="px-2 py-0.5 rounded-full bg-surface-3 text-[10px] text-ink-muted shrink-0">
                          {displayBadge(project.badge)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {productivityResults && productivityResults.notes.length > 0 && (
            <div className="py-2">
              <div className="px-3 py-1 text-[10px] font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-1.5">
                <StickyNote className="w-3 h-3 text-warning" />
                Notes
              </div>
              <div className="space-y-1 mt-1">
                {productivityResults.notes.map((note) => {
                  const itemId = `note-${note.id}`;
                  const globalIdx = allItems.findIndex((it) => it.id === itemId);
                  const isSelected = globalIdx === selectedIndex;
                  return (
                    <div
                      key={itemId}
                      onClick={() => handleSelect(allItems[globalIdx])}
                      onMouseEnter={() => setSelectedIndex(globalIdx)}
                      className={`px-3 py-2 rounded-xl cursor-pointer flex items-center justify-between text-xs transition-colors ${
                        isSelected ? 'bg-accent/10 text-accent-fg' : 'hover:bg-surface-2 text-ink'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-ink truncate">{note.title}</div>
                        <div className="text-[11px] text-ink-subtle truncate">{note.subtitle}</div>
                      </div>
                      {note.badge && (
                        <span className="px-2 py-0.5 rounded-full bg-surface-3 text-[10px] text-ink-muted shrink-0">
                          {displayBadge(note.badge)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="px-4 py-2.5 bg-surface-2 border-t border-line flex items-center justify-between text-[11px] text-ink-subtle">
          <div className="flex items-center gap-3">
            <span>
              Use <kbd className="px-1.5 py-0.5 rounded bg-surface border border-line text-[10px]">↑</kbd> <kbd className="px-1.5 py-0.5 rounded bg-surface border border-line text-[10px]">↓</kbd> to navigate
            </span>
            <span className="flex items-center gap-1">
              <CornerDownLeft className="w-3 h-3" /> to select
            </span>
          </div>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}
