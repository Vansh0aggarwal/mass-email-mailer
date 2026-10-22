/*
 * Email HTML handling.
 *
 * Email HTML is untrusted. Two layers of defence are used:
 *   1. `sanitizeEmailHtml` scrubs dangerous markup (scripts, event handlers,
 *      javascript:/vbscript: URLs, active/foreign elements) as a pure function.
 *  2. The renderer puts the result inside a sandboxed <iframe> WITHOUT
 *      `allow-scripts`, so even a sanitizer bypass cannot execute code.
 *
 * These helpers are intentionally dependency-free and DOM-light so they can be
 * unit tested in the node test environment.
 */

export interface EmailHtmlOptions {
  /** When false (default) remote http(s) images are blocked, Gmail-style. */
  showImages?: boolean;
  /** Maps a Content-ID to a safe (data:) URL for inline `cid:` images. */
  cidMap?: Record<string, string>;
}

/** 1x1 transparent GIF used for blocked / unavailable images. */
export const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const BLOCKED_BLOCK_TAGS = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'template', 'noscript'];
const BLOCKED_VOID_TAGS = ['base', 'meta', 'link', 'title', 'input', 'button', 'textarea', 'select', 'form', 'option'];

function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Decodes a URI component, returning the input unchanged if it is malformed. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Strips active content from an embedded stylesheet. */
export function sanitizeCss(css: string): string {
  return String(css || '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/vbscript:/gi, '')
    .replace(/-moz-binding/gi, '');
}

/** True for URLs that must never be used in href/src. */
export function isUnsafeUrl(url: string): boolean {
  const value = String(url || '').trim().toLowerCase();
  if (!value) return false;
  if (value.startsWith('#')) return false;
  return (
    value.startsWith('javascript:') ||
    value.startsWith('vbscript:') ||
    value.startsWith('data:text/html') ||
    value.startsWith('data:application/xhtml')
  );
}

function getAttr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? '';
}

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  if (re.test(tag)) return tag.replace(re, `${name}="${escapeAttr(value)}"`);
  return tag.replace(/\s*(\/?)>$/, (_m, slash) => ` ${name}="${escapeAttr(value)}"${slash ? ' /' : ''}>`);
}

/** Converts a base64url-encoded chunk into a `data:` URL. */
export function base64UrlToDataUrl(data: string, mimeType = 'image/png'): string {
  if (!data) return '';
  let b64 = String(data).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  b64 += pad;
  return `data:${mimeType || 'image/png'};base64,${b64}`;
}

const TRANSPARENT_PIXEL_URI =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export interface EmailHtmlOptionsInternal extends EmailHtmlOptions {
  _transparentPixel?: string;
}

/**
 * Sanitizes untrusted email HTML and resolves inline/remote images.
 *
 * - Removes scripts, frames, embedded objects, forms and meta/link/base tags.
 * - Strips `on*` event handlers and neutralizes unsafe URLs.
 * - Scrubs active content from `<style>` blocks.
 * - Rewrites `cid:` image references using `cidMap`.
 * - Blocks remote (`http(s)`) images unless `showImages` is true.
 * - Forces links to open in a new tab with a safe `rel`.
 *
 * NOTE: this is a string-level sanitizer and is intentionally paired with a
 * script-less sandboxed iframe; it is not a substitute for a full HTML parser
 * when rendering into the main document.
 */
export function sanitizeEmailHtml(raw: string, options: EmailHtmlOptions = {}): string {
  if (!raw) return '';
  let html = String(raw);

  // Drop comments (including conditional comments).
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // Remove dangerous elements together with their contents.
  for (const tag of BLOCKED_BLOCK_TAGS) {
    html = html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
  }
  // Remove any leftover standalone / void occurrences of dangerous tags.
  for (const tag of [...BLOCKED_BLOCK_TAGS, ...BLOCKED_VOID_TAGS]) {
    html = html.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }

  // Keep <style> for formatting but strip active content.
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, css) => `<style>${sanitizeCss(css)}</style>`);

  // Strip inline event handlers.
  html = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Neutralize unsafe URLs.
  html = html.replace(
    /\b(href|src|xlink:href|action|formaction|background|poster|dynsrc|lowsrc)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (match, attr, _q, dq, sq, uq) => {
      const value = dq ?? sq ?? uq ?? '';
      return isUnsafeUrl(value) ? `${attr}="#"` : match;
    }
  );

  const cidMap = options.cidMap || {};
  const showImages = options.showImages ?? false;
  const pixel = TRANSPARENT_PIXEL_URI;

  // Resolve cid: images and apply the remote-image policy.
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = getAttr(tag, 'src') || '';
    if (!src) return tag;

    if (/^cid:/i.test(src)) {
      const cid = src.slice(4).replace(/^<|>$/g, '').trim();
      const resolved = cidMap[cid] || cidMap[safeDecode(cid)] || cidMap[encodeURIComponent(cid)];
      if (resolved) return setAttr(tag, 'src', resolved);
      // Missing inline image: show the alt text instead of a broken icon.
      let out = setAttr(tag, 'src', pixel);
      out = setAttr(out, 'data-cid-missing', cid);
      return out;
    }

    if (/^https?:/i.test(src) && !showImages) {
      let out = setAttr(tag, 'data-blocked-src', src);
      out = setAttr(out, 'src', pixel);
      return out;
    }

    return tag;
  });

  // Force links to open safely in a new tab.
  html = html.replace(/<a\b[^>]*>/gi, (tag) => {
    const href = getAttr(tag, 'href') || '';
    if (!href || href.startsWith('#')) return tag;
    let out = tag;
    if (getAttr(out, 'target') === null) out = setAttr(out, 'target', '_blank');
    if (getAttr(out, 'rel') === null) out = setAttr(out, 'rel', 'noopener noreferrer nofollow');
    return out;
  });

  return html;
}

/** True when the HTML references at least one remote (http/https) image. */
export function hasRemoteImages(html?: string): boolean {
  if (!html) return false;
  return /<img\b[^>]*\bsrc\s*=\s*("|')?https?:\/\//i.test(html);
}

/**
 * Wraps a sanitized body fragment in a minimal, theme-aware HTML document
 * suitable for an iframe `srcdoc`.
 */
export function buildEmailDocument(bodyHtml: string, opts: { dark?: boolean } = {}): string {
  const dark = opts.dark === true;
  const bg = dark ? '#0b0c0f' : '#ffffff';
  const fg = dark ? '#edeff2' : '#11141a';
  const link = dark ? '#a5b4fc' : '#4f46e5';
  const quote = dark ? '#9aa0a6' : '#5f6570';
  const style = `
    html,body{margin:0;padding:0;background:${bg};color:${fg};}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;padding:2px 2px 8px;}
    img{max-width:100%;height:auto;}
    a{color:${link};}
    table{max-width:100%;border-collapse:collapse;}
    blockquote{margin:0;padding-left:12px;border-left:2px solid ${quote}55;color:${quote};}
    pre,code{white-space:pre-wrap;word-wrap:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
    *{max-width:100%;}
  `;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="color-scheme" content="${
    dark ? 'dark' : 'light'
  }"><base target="_blank"><style>${style}</style></head><body>${bodyHtml}</body></html>`;
}
