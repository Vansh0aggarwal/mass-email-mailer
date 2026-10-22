import { ApiError } from './api';
import type { EmailAccount } from '../types';

export type MailFolder =
  | 'inbox'
  | 'starred'
  | 'snoozed'
  | 'sent'
  | 'drafts'
  | 'spam'
  | 'trash'
  | 'all';

export interface MailAddress {
  name: string;
  email: string;
}

export interface MailAttachment {
  filename: string;
  mimeType?: string;
  size?: number;
  /** Gmail attachment id, required to fetch the bytes (absent for embedded inline parts). */
  attachmentId?: string;
  /** Content-ID used to resolve inline `cid:` references. */
  contentId?: string;
  partId?: string;
  /** True when the part is shown inline in the HTML body instead of as a download. */
  isInline?: boolean;
  /** Base64url bytes Gmail embedded directly (small inline images). */
  inlineData?: string;
}

export interface MailMessage {
  id: string;
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  replyTo?: MailAddress;
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  snippet: string;
  date: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  attachments?: MailAttachment[];
  messageIdHeader?: string;
  references?: string;
}

export interface MailThread {
  _id: string;
  threadId: string;
  mailboxEmail: string;
  subject: string;
  snippet: string;
  lastMessageDate: string;
  messageCount: number;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isSpam: boolean;
  isTrash: boolean;
  isSnoozed: boolean;
  inInbox: boolean;
  hasAttachments: boolean;
  unreadCount: number;
  labels: string[];
  category?: string;
  lastFromName?: string;
  lastFromEmail?: string;
  participants: string[];
  companyId?: string;
  companyName?: string;
  messages: MailMessage[];
}

export interface MailCounts {
  inbox: number;
  inboxUnread: number;
  starred: number;
  snoozed: number;
  sent: number;
  drafts: number;
  spam: number;
  trash: number;
}

export interface ThreadListMeta {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  folder: string;
}

const BASE_URL = '/api/v1';

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/**
 * Neutralises untrusted email content before it reaches the DOM.
 * The backend stores plain text bodies, but any HTML-ish markup that slips
 * through (or arrives from an HTML-only MIME part) is stripped of tags,
 * scripts and event handlers and returned as safe plain text.
 */
export function sanitizeEmailBody(raw?: string): string {
  if (!raw) return '';
  let text = String(raw);
  // Drop dangerous blocks entirely
  text = text.replace(
    /<\s*(script|style|iframe|object|embed|link|meta|form|svg)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    ''
  );
  text = text.replace(/<\s*(script|style|iframe|object|embed|link|meta|form|svg)[^>]*\/?>/gi, '');
  // Turn structural boundaries into newlines
  text = text.replace(/<\s*br\s*\/?>/gi, '\n');
  text = text.replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|blockquote)\s*>/gi, '\n');
  // Strip every remaining tag (removes onerror/onclick attrs and javascript: URLs)
  text = text.replace(/<[^>]*>/g, '');
  // Decode a small set of common entities
  text = text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITY_MAP[m] ?? m);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** Builds auth headers, forwarding only a real bearer token. */
export function mailAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = localStorage.getItem('radar_token');
  // The HttpOnly session cookie is the source of truth. Stale localStorage ids
  // (e.g. non-ObjectId dev-mock values) must not be forwarded as identity
  // headers, which produced spurious 400 responses and phantom sessions.
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function requestFull<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ data: T; meta?: any }> {
  const url = `${BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  const headers = mailAuthHeaders({
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  });

  const response = await fetch(url, { ...options, credentials: 'include', headers });
  const contentType = response.headers.get('content-type');
  let body: any = null;
  if (contentType && contentType.includes('application/json')) {
    body = await response.json();
  }

  if (!response.ok) {
    throw new ApiError(
      body?.error?.message || `HTTP ${response.status}: ${response.statusText}`,
      body?.error?.code || 'SERVER_ERROR',
      response.status,
      body?.error?.details
    );
  }

  return { data: body?.data as T, meta: body?.meta };
}

/** Builds the authenticated URL for an attachment / inline image. */
export function attachmentUrl(
  mailbox: string,
  threadId: string,
  messageId: string,
  attachmentId: string,
  opts: { inline?: boolean } = {}
): string {
  const qs = opts.inline ? '?inline=1' : '';
  return `${BASE_URL}/mailboxes/${encodeURIComponent(mailbox.toLowerCase())}/threads/${encodeURIComponent(
    threadId
  )}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}${qs}`;
}

/**
 * Fetches attachment bytes through the authenticated backend (never exposing
 * Google tokens). Returns a blob URL for previews/downloads.
 */
export async function fetchAttachmentObjectUrl(
  mailbox: string,
  threadId: string,
  messageId: string,
  attachmentId: string,
  opts: { inline?: boolean } = {}
): Promise<string> {
  const url = attachmentUrl(mailbox, threadId, messageId, attachmentId, opts);
  const response = await fetch(url, { credentials: 'include', headers: mailAuthHeaders() });
  if (!response.ok) {
    throw new ApiError(`Attachment request failed (HTTP ${response.status})`, 'ATTACHMENT_ERROR', response.status);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

/**
 * Fetches attachment bytes and returns them as a `data:` URL. Used for inline
 * (`cid:`) images so they render inside a sandboxed iframe regardless of origin.
 */
export async function fetchAttachmentDataUrl(
  mailbox: string,
  threadId: string,
  messageId: string,
  attachmentId: string,
  opts: { inline?: boolean } = {}
): Promise<string> {
  const url = attachmentUrl(mailbox, threadId, messageId, attachmentId, opts);
  const response = await fetch(url, { credentials: 'include', headers: mailAuthHeaders() });
  if (!response.ok) {
    throw new ApiError(`Attachment request failed (HTTP ${response.status})`, 'ATTACHMENT_ERROR', response.status);
  }
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new ApiError('Unable to read attachment', 'ATTACHMENT_ERROR', 0));
    reader.readAsDataURL(blob);
  });
}

/** Triggers an authenticated attachment download in the browser. */
export async function downloadAttachment(
  mailbox: string,
  threadId: string,
  messageId: string,
  attachment: { attachmentId?: string; filename?: string }
): Promise<void> {
  if (!attachment.attachmentId) throw new ApiError('Attachment is not downloadable', 'ATTACHMENT_ERROR', 0);
  const objectUrl = await fetchAttachmentObjectUrl(mailbox, threadId, messageId, attachment.attachmentId);
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = attachment.filename || 'attachment';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
}

const mailboxSegment = (mailbox: string) => encodeURIComponent(mailbox.toLowerCase());

export interface ThreadQuery {
  folder?: MailFolder;
  q?: string;
  page?: number;
  limit?: number;
  companyId?: string;
}

export const mailApi = {
  listMailboxes: async (): Promise<EmailAccount[]> => {
    const { data } = await requestFull<EmailAccount[]>('/mailboxes');
    return data || [];
  },

  listThreads: async (mailbox: string, query: ThreadQuery = {}) => {
    const params = new URLSearchParams();
    if (query.folder) params.set('folder', query.folder);
    if (query.q) params.set('q', query.q);
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));
    if (query.companyId) params.set('companyId', query.companyId);
    const qs = params.toString();
    return requestFull<MailThread[]>(
      `/mailboxes/${mailboxSegment(mailbox)}/threads${qs ? `?${qs}` : ''}`
    );
  },

  getThread: async (mailbox: string, threadId: string): Promise<MailThread> => {
    const { data } = await requestFull<MailThread>(
      `/mailboxes/${mailboxSegment(mailbox)}/threads/${encodeURIComponent(threadId)}`
    );
    return data;
  },

  getCounts: async (mailbox: string): Promise<MailCounts> => {
    const { data } = await requestFull<MailCounts>(`/mailboxes/${mailboxSegment(mailbox)}/counts`);
    return data;
  },

  patchThread: async (
    mailbox: string,
    threadId: string,
    changes: Record<string, any>
  ): Promise<MailThread> => {
    const { data } = await requestFull<MailThread>(
      `/mailboxes/${mailboxSegment(mailbox)}/threads/${encodeURIComponent(threadId)}`,
      { method: 'PATCH', body: JSON.stringify(changes) }
    );
    return data;
  },

  bulkAction: async (
    mailbox: string,
    threadIds: string[],
    action: string
  ): Promise<{ updatedCount: number; action: string }> => {
    const { data } = await requestFull<{ updatedCount: number; action: string }>(
      `/mailboxes/${mailboxSegment(mailbox)}/threads/bulk`,
      { method: 'POST', body: JSON.stringify({ threadIds, action }) }
    );
    return data;
  },

  deleteThread: async (mailbox: string, threadId: string) => {
    await requestFull(`/mailboxes/${mailboxSegment(mailbox)}/threads/${encodeURIComponent(threadId)}`, {
      method: 'DELETE',
    });
  },

  reply: async (
    mailbox: string,
    threadId: string,
    payload: { bodyText: string; to?: string; cc?: string; bcc?: string }
  ): Promise<MailThread> => {
    const { data } = await requestFull<MailThread>(
      `/mailboxes/${mailboxSegment(mailbox)}/threads/${encodeURIComponent(threadId)}/reply`,
      { method: 'POST', body: JSON.stringify(payload) }
    );
    return data;
  },

  compose: async (
    mailbox: string,
    payload: { to: string; cc?: string; bcc?: string; subject: string; body: string }
  ): Promise<{ threadId: string; messageId: string; isSimulated: boolean }> => {
    const { data } = await requestFull<{ threadId: string; messageId: string; isSimulated: boolean }>(
      `/mailboxes/${mailboxSegment(mailbox)}/messages`,
      { method: 'POST', body: JSON.stringify(payload) }
    );
    return data;
  },

  sync: async (mailbox: string): Promise<{ syncedCount: number; lastSyncedAt: string }> => {
    const { data } = await requestFull<{ syncedCount: number; lastSyncedAt: string }>(
      `/mailboxes/${mailboxSegment(mailbox)}/sync`,
      { method: 'POST' }
    );
    return data;
  },

  disconnectGmail: async (email: string) => {
    const { data } = await requestFull(`/integrations/google/gmail/${encodeURIComponent(email)}/disconnect`, {
      method: 'POST',
    });
    return data;
  },
};

export const mailKeys = {
  mailboxes: ['mailboxes'] as const,
  threads: (mailbox: string, folder: MailFolder, q: string, page = 1) =>
    ['threads', mailbox.toLowerCase(), folder, q, page] as const,
  counts: (mailbox: string) => ['mail-counts', mailbox.toLowerCase()] as const,
  thread: (mailbox: string, threadId: string) =>
    ['thread', mailbox.toLowerCase(), threadId] as const,
};

const DAY = 24 * 60 * 60 * 1000;

export function formatListDate(input?: string): string {
  if (!input) return '';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ts = date.getTime();
  if (ts >= startOfToday) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (ts >= startOfToday - DAY) {
    return 'Yesterday';
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatFullDate(input?: string): string {
  if (!input) return '';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function parseEmailList(raw?: string): MailAddress[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const match = chunk.match(/^(.*?)<([^>]+)>$/);
      if (match) {
        return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim().toLowerCase() };
      }
      return { name: '', email: chunk.toLowerCase() };
    });
}

export function formatAddressList(list?: MailAddress[]): string {
  if (!list || list.length === 0) return '';
  return list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
}

export function initialsOf(address?: MailAddress): string {
  const source = address?.name?.trim() || address?.email?.trim() || '';
  if (!source) return '?';
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}
