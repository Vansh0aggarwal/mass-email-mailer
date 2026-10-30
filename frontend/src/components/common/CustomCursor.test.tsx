import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { CustomCursor } from './CustomCursor';

/**
 * The cursor is drawn with plain elements and CSS, so the markup is the
 * contract between JavaScript and the stylesheet.
 */
function render(): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(CustomCursor, null),
    ),
  );
}

describe('CustomCursor markup', () => {
  it('renders one decorative layer that starts hidden', () => {
    const html = render();
    expect(html).toContain('class="custom-cursor"');
    expect(html).toContain('data-state="default"');
    expect(html).toContain('data-pressed="false"');
    expect(html).toContain('data-visible="false"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('renders exactly one anchor and one dot', () => {
    const html = render();
    // The anchor carries the smoothed pointer position and the dot carries the
    // spring-driven scale. Separating them keeps the dot centred on the pointer
    // while it grows.
    expect((html.match(/class="custom-cursor__anchor"/g) ?? []).length).toBe(1);
    expect((html.match(/class="custom-cursor__dot"/g) ?? []).length).toBe(1);
  });

  it('adds no ring, caret, label, pulse or second cursor layer', () => {
    const html = render();
    for (const removed of ['custom-cursor__ring', 'custom-cursor__caret', 'custom-cursor__label', 'custom-cursor__pulse']) {
      expect(html).not.toContain(removed);
    }
    expect((html.match(/class="custom-cursor"/g) ?? []).length).toBe(1);
  });

  it('renders nothing that could swallow a click', () => {
    const html = render();
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<button');
  });
});
