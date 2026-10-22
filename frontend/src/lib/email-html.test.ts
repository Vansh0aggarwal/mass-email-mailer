import { describe, it, expect } from 'vitest';
import {
  buildEmailDocument,
  base64UrlToDataUrl,
  hasRemoteImages,
  isUnsafeUrl,
  sanitizeCss,
  sanitizeEmailHtml,
  TRANSPARENT_PIXEL,
} from './email-html';

describe('sanitizeEmailHtml', () => {
  it('removes script elements and their contents', () => {
    const out = sanitizeEmailHtml('<p>Hi</p><script>alert(1)</script>');
    expect(out).toContain('<p>Hi</p>');
    expect(out).not.toMatch(/script/i);
    expect(out).not.toContain('alert(1)');
  });

  it('removes iframes, objects and embeds', () => {
    const html = '<iframe src="https://evil.test"></iframe><object data="x"></object><embed src="y">';
    const out = sanitizeEmailHtml(html);
    expect(out).not.toMatch(/<(iframe|object|embed)/i);
  });

  it('strips inline event handlers', () => {
    const out = sanitizeEmailHtml('<img src="https://x.test/a.png" onerror="alert(1)" onClick="x()">');
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toContain('alert(1)');
  });

  it('neutralizes javascript: URLs in links', () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain('href="#"');
  });

  it('strips active content from embedded styles', () => {
    const out = sanitizeEmailHtml('<style>@import url(evil.css); p{color:red} .x{background:url(javascript:alert(1))}</style>');
    expect(out).not.toContain('@import');
    expect(out).toContain('color:red');
  });

  it('keeps an embedded <style> for formatting', () => {
    const out = sanitizeEmailHtml('<style>.a{color:red}</style><p class="a">hi</p>');
    expect(out).toContain('<style>');
    expect(out).toContain('color:red');
  });

  it('blocks remote images by default and preserves the source', () => {
    const out = sanitizeEmailHtml('<img src="https://tracker.example/pixel.png" alt="x">');
    expect(out).toContain(`src="${TRANSPARENT_PIXEL}"`);
    expect(out).toContain('data-blocked-src="https://tracker.example/pixel.png"');
  });

  it('shows remote images when explicitly allowed', () => {
    const html = '<img src="https://example.com/a.png">';
    const out = sanitizeEmailHtml(html, { showImages: true });
    expect(out).toContain('src="https://example.com/a.png"');
    expect(out).not.toContain('data-blocked-src');
  });

  it('resolves inline cid: images from the map', () => {
    const out = sanitizeEmailHtml('<img src="cid:logo@swaniki">', {
      cidMap: { 'logo@swaniki': 'data:image/png;base64,AAAA' },
    });
    expect(out).toContain('src="data:image/png;base64,AAAA"');
  });

  it('replaces unresolved cid: images with a placeholder', () => {
    const out = sanitizeEmailHtml('<img src="cid:missing">');
    expect(out).toContain(`src="${TRANSPARENT_PIXEL}"`);
    expect(out).toContain('data-cid-missing="missing"');
  });

  it('strips script/object/form elements entirely', () => {
    const html = '<form action="https://evil.test"><input name="x"></form><script>evil()</script>ok';
    const out = sanitizeEmailHtml(html);
    expect(out).not.toMatch(/<form|<input|<script/i);
    expect(out).toContain('ok');
  });

  it('neutralizes javascript: URLs in src', () => {
    const out = sanitizeEmailHtml('<img src="javascript:alert(1)">');
    expect(out).not.toContain('javascript:');
  });

  it('forces links to open in a new tab safely', () => {
    const out = sanitizeEmailHtml('<a href="https://example.com">link</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it('removes HTML comments (including conditional comments)', () => {
    const out = sanitizeEmailHtml('<!--[if IE]><script>evil()</script><![endif]-->safe');
    expect(out).not.toContain('script');
    expect(out).toContain('safe');
  });

  it('handles nullish / empty input', () => {
    expect(sanitizeEmailHtml('')).toBe('');
    expect(sanitizeEmailHtml(undefined as unknown as string)).toBe('');
  });
});

describe('isUnsafeUrl', () => {
  it('flags javascript/vbscript/data:text-html and allows normal URLs', () => {
    expect(isUnsafeUrl('javascript:alert(1)')).toBe(true);
    expect(isUnsafeUrl('  JavaScript:alert(1)')).toBe(true);
    expect(isUnsafeUrl('vbscript:msgbox')).toBe(true);
    expect(isUnsafeUrl('data:text/html;base64,AAAA')).toBe(true);
    expect(isUnsafeUrl('https://example.com')).toBe(false);
    expect(isUnsafeUrl('#anchor')).toBe(false);
    expect(isUnsafeUrl('mailto:a@b.com')).toBe(false);
  });
});

describe('sanitizeCss', () => {
  it('removes @import, expression() and javascript:', () => {
    const out = sanitizeCss('@import url(x);a{width:expression(alert(1));background:url(javascript:x)}');
    expect(out).not.toContain('@import');
    expect(out).not.toContain('expression(');
    expect(out).not.toContain('javascript:');
  });
});

describe('base64UrlToDataUrl', () => {
  it('converts base64url to a data URL with padding', () => {
    expect(base64UrlToDataUrl('AAAA', 'image/png')).toBe('data:image/png;base64,AAAA');
    expect(base64UrlToDataUrl('AA-_', 'image/jpeg').startsWith('data:image/jpeg;base64,')).toBe(true);
  });
  it('returns empty string for empty input', () => {
    expect(base64UrlToDataUrl('')).toBe('');
  });
});

describe('hasRemoteImages', () => {
  it('detects remote image references', () => {
    expect(hasRemoteImages('<img src="https://x/y.png">')).toBe(true);
    expect(hasRemoteImages("<img src='http://x/y.png'>")).toBe(true);
    expect(hasRemoteImages('<img src="cid:x">')).toBe(false);
    expect(hasRemoteImages(undefined)).toBe(false);
  });
});

describe('buildEmailDocument', () => {
  it('wraps the body and sets a dark color-scheme', () => {
    const doc = buildEmailDocument('<p>hi</p>', { dark: true });
    expect(doc).toContain('<p>hi</p>');
    expect(doc).toContain('color-scheme" content="dark"');
  });
});
