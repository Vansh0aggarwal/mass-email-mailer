import { useEffect, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import {
  base64UrlToDataUrl,
  buildEmailDocument,
  hasRemoteImages,
  sanitizeEmailHtml,
} from '../../lib/email-html';
import { fetchAttachmentDataUrl, type MailAttachment } from '../../lib/mail';

interface EmailBodyRendererProps {
  html?: string;
  text?: string;
  mailbox: string;
  threadId: string;
  messageId: string;
  attachments?: MailAttachment[];
}

/**
 * Renders an email body safely.
 *
 * - HTML is sanitized and injected into a sandboxed iframe (no `allow-scripts`),
 *   so a sanitizer bypass still cannot execute code.
 * - Inline `cid:` images are resolved to authenticated `data:` URLs.
 * - Remote images are blocked until the user opts in ("Display images").
 * - Falls back to the plain-text body when no HTML is available.
 */
export function EmailBodyRenderer({
  html,
  text,
  mailbox,
  threadId,
  messageId,
  attachments,
}: EmailBodyRendererProps) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === 'dark';

  const [showImages, setShowImages] = useState(false);
  const [cidMap, setCidMap] = useState<Record<string, string>>({});
  const [height, setHeight] = useState(200);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const inlineAttachments = useMemo(
    () => (attachments || []).filter((att) => att.isInline && (att.contentId || att.attachmentId)),
    [attachments]
  );

  // Resolve inline images to data URLs (embedded bytes first, then fetch).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const map: Record<string, string> = {};
      for (const att of inlineAttachments) {
        const key = att.contentId || att.filename;
        if (!key) continue;
        try {
          if (att.inlineData) {
            map[key] = base64UrlToDataUrl(att.inlineData, att.mimeType || 'image/png');
          } else if (att.attachmentId && att.contentId) {
            map[att.contentId] = await fetchAttachmentDataUrl(mailbox, threadId, messageId, att.attachmentId, {
              inline: true,
            });
          }
        } catch {
          /* individual inline image failed — leave it unresolved */
        }
      }
      if (!cancelled) setCidMap(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [inlineAttachments, mailbox, threadId, messageId]);

  const srcDoc = useMemo(() => {
    if (!html) return '';
    const sanitized = sanitizeEmailHtml(html, { showImages, cidMap });
    return buildEmailDocument(sanitized, { dark });
  }, [html, showImages, cidMap, dark]);

  // Auto-size the iframe to its content.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !srcDoc) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const doc = iframe.contentDocument;
      if (doc?.documentElement) {
        setHeight(Math.max(doc.documentElement.scrollHeight + 4, 80));
      }
    };
    const onLoad = () => {
      measure();
      try {
        const doc = iframe.contentDocument;
        if (doc?.documentElement && typeof ResizeObserver !== 'undefined') {
          observer?.disconnect();
          observer = new ResizeObserver(measure);
          observer.observe(doc.documentElement);
        }
      } catch {
        /* measuring is best-effort only */
      }
    };
    iframe.addEventListener('load', onLoad);
    const timer = setTimeout(measure, 250);
    return () => {
      iframe.removeEventListener('load', onLoad);
      observer?.disconnect();
      clearTimeout(timer);
    };
  }, [srcDoc]);

  const showBanner = !!html && hasRemoteImages(html) && !showImages;

  if (!html) {
    return (
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink">
        {text || 'This message has no content.'}
      </pre>
    );
  }

  return (
    <div className="space-y-2">
      {showBanner && (
        <button
          type="button"
          onClick={() => setShowImages(true)}
          className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-[11px] font-medium text-ink-muted hover:text-accent hover:border-accent transition-colors"
        >
          <ImageIcon className="w-3.5 h-3.5" />
          Images are blocked. Display images
        </button>
      )}
      <iframe
        ref={iframeRef}
        title="Email message body"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        className="w-full rounded-lg border-0 bg-transparent"
        style={{ height: `${height}px` }}
      />
    </div>
  );
}
