import { useState } from 'react';
import { clsx } from 'clsx';
import type { AuthUser } from '../../types';

export interface AvatarProps {
  user: AuthUser | null;
  size?: number;
  className?: string;
}

export function getInitials(name?: string | null, email?: string | null): string {
  const trimmedName = (name || '').trim();
  const source = trimmedName || (email || '').split('@')[0].trim();
  if (!source) return 'U';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

/**
 * Pure decision helper: an image should be shown only when a non-empty URL
 * exists and it has not already failed to load.
 */
export function shouldShowImage(avatarUrl?: string | null, hasError = false): boolean {
  return Boolean(avatarUrl && avatarUrl.trim()) && !hasError;
}

export function Avatar({ user, size = 32, className }: AvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const hasImage = shouldShowImage(
    user?.avatarUrl,
    failedUrl !== null && failedUrl === user?.avatarUrl
  );
  const initials = getInitials(user?.fullName, user?.email);
  const style = {
    width: size,
    height: size,
    fontSize: Math.max(10, size / 2.5),
  };

  if (hasImage) {
    return (
      <img
        src={user?.avatarUrl as string}
        alt={user?.fullName || user?.email || 'User avatar'}
        className={clsx('rounded-full object-cover ring-1 ring-black/5 dark:ring-white/10', className)}
        style={style}
        onError={() => setFailedUrl(user?.avatarUrl ?? null)}
      />
    );
  }

  return (
    <div
      className={clsx(
        'rounded-full bg-accent flex items-center justify-center text-accent-fg font-semibold',
        className
      )}
      style={style}
      title={user?.fullName || user?.email}
    >
      {initials}
    </div>
  );
}
