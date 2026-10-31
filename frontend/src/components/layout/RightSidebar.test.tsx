import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../../context/ThemeContext';
import { ProductivityProvider } from '../../context/ProductivityContext';
import { RightSidebar } from './RightSidebar';

function render(): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            ProductivityProvider,
            null,
            React.createElement(RightSidebar, null),
          ),
        ),
      ),
    ),
  );
}

describe('RightSidebar layout', () => {
  it('renders the utilities in the specified order', () => {
    const labels = [...render().matchAll(/role="tooltip">([^<]+)</g)].map((match) => match[1]);
    expect(labels).toEqual([
      'Notifications',
      'Optimize Memory',
      'Analytics Home',
      'Previous Page',
      'To-Do List',
      'Daily Tasks',
      'Google Meet',
      'Google Calendar',
      'Switch Theme',
    ]);
  });

  it('splits the groups with three dividers', () => {
    expect((render().match(/class="my-1 h-px w-8 shrink-0 bg-line"/g) ?? []).length).toBe(3);
  });

  it('keeps the back control directly after home', () => {
    const html = render();
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
    expect(labels.indexOf('Previous Page')).toBe(labels.indexOf('Analytics Home') + 1);
  });
});
