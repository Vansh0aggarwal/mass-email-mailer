import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { BottomNavigation } from './BottomNavigation';

function render(): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(BottomNavigation, { onOpenSearch: () => {} }),
    ),
  );
}

describe('BottomNavigation', () => {
  it('opens Analytics from Home', () => {
    const html = render();
    expect(html).toContain('href="/analytics"');
    expect(html).toContain('title="Analytics Home"');
  });

  it('keeps Dashboard on its own route', () => {
    expect(render()).toContain('href="/dashboard"');
  });
});
