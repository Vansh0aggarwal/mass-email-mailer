import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../context/ThemeContext';
import { CustomCursor } from './CustomCursor';

/**
 * The cursor is drawn with plain elements and CSS, so the markup *is* the
 * contract between JavaScript and the stylesheet. These assertions lock the
 * structure the stylesheet depends on.
 */
function render(): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(CustomCursor, null),
      ),
    ),
  );
}

describe('CustomCursor markup', () => {
  it('renders a decorative layer that starts hidden', () => {
    const html = render();
    expect(html).toContain('class="cursor-layer"');
    expect(html).toContain('data-mode="default"');
    expect(html).toContain('data-pressed="false"');
    expect(html).toContain('data-visible="false"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('separates the position from the scale', () => {
    const html = render();
    // One anchor per layer of the cursor: the anchor carries the position
    // that JavaScript writes every frame, the child carries the scale that
    // the stylesheet animates. Mixing them would move the point the cursor
    // points at while it grows.
    expect((html.match(/class="cursor-anchor"/g) ?? []).length).toBe(2);
    expect(html).toContain('class="cursor-dot"');
    expect(html).toContain('class="cursor-ring"');
    expect(html).toContain('class="cursor-caret"');
    expect(html).toContain('class="cursor-pulse"');
    expect(html).toContain('class="cursor-label"');
  });

  it('takes the theme from the theme provider', () => {
    expect(render()).toContain('data-theme="light"');
  });

  it('renders nothing that could swallow a click', () => {
    const html = render();
    // Every visual part is a plain element without a role, a tabindex or a
    // link — the cursor is decoration only.
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<button');
  });
});
