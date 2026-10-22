import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Avatar, getInitials, shouldShowImage } from './Avatar';

const baseUser = {
  id: 'u1',
  email: 'ada.lovelace@swaniki.dev',
  fullName: 'Ada Lovelace',
};

describe('Avatar initials + image fallback', () => {
  it('renders the Google profile photo when a valid avatarUrl is present', () => {
    const html = renderToStaticMarkup(
      React.createElement(Avatar, {
        user: { ...baseUser, avatarUrl: 'https://lh3.googleusercontent.com/a/photo=s96-c' },
      })
    );
    expect(html).toContain('<img');
    expect(html).toContain('https://lh3.googleusercontent.com/a/photo=s96-c');
    expect(html).not.toContain('>AL<');
  });

  it('renders initials when the photo is missing', () => {
    const html = renderToStaticMarkup(React.createElement(Avatar, { user: { ...baseUser } }));
    expect(html).not.toContain('<img');
    expect(html).toContain('AL');
  });

  it('treats an empty / whitespace avatarUrl as missing', () => {
    expect(shouldShowImage('', false)).toBe(false);
    expect(shouldShowImage('   ', false)).toBe(false);
    expect(shouldShowImage(null, false)).toBe(false);
    expect(shouldShowImage(undefined, false)).toBe(false);
  });

  it('falls back to initials after the image fails to load', () => {
    // When the img onError fires, hasError becomes true and the image is hidden.
    expect(shouldShowImage('https://broken.example/404.png', false)).toBe(true);
    expect(shouldShowImage('https://broken.example/404.png', true)).toBe(false);

    const html = renderToStaticMarkup(
      React.createElement(Avatar, { user: { ...baseUser, avatarUrl: 'https://broken.example/404.png' } })
    );
    // Server render shows the <img>; on the client, onError flips `hasError`
    // (covered by shouldShowImage above) so the component re-renders initials.
    expect(html).toContain('<img');
    expect(html).toContain('https://broken.example/404.png');

    const fallbackHtml = renderToStaticMarkup(
      React.createElement(Avatar, { user: { ...baseUser, avatarUrl: '' } })
    );
    expect(fallbackHtml).not.toContain('<img');
    expect(fallbackHtml).toContain('AL');
  });

  it('derives initials from name, then email, then a safe default', () => {
    expect(getInitials('Ada Lovelace', 'ada@x.com')).toBe('AL');
    expect(getInitials(undefined, 'jane.doe@x.com')).toBe('JD');
    expect(getInitials('  ', 'solo@x.com')).toBe('SO');
    expect(getInitials('', '')).toBe('U');
    expect(getInitials(null, 'x@y.com')).toBe('X');
  });

  it('renders initials for a dev-mock user with no avatar', () => {
    const html = renderToStaticMarkup(
      React.createElement(Avatar, {
        user: { id: 'd1', email: 'developer@swaniki.dev', fullName: 'Lead Engineer', isDevMock: true },
      })
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('LE');
  });
});
