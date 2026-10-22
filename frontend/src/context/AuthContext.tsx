import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AuthUser, Organization } from '../types';

export interface LogoutOptions {
  /** Also disconnect Gmail mailboxes and delete locally synced mail data. */
  clearMailData?: boolean;
}

export interface LogoutResult {
  mode: 'session' | 'clear-mail-data';
  mailData?: {
    mailboxesProcessed?: number;
    gmailAccountsRemoved?: number;
    threadsDeleted?: number;
    messagesDeleted?: number;
    sendAttemptsDeleted?: number;
    followUpsDeleted?: number;
    revocationWarnings?: { emailAddress: string; warning: string }[];
  };
}

interface AuthContextType {
  user: AuthUser | null;
  organizations: Organization[];
  currentOrgId: string;
  userRole: string;
  isLoading: boolean;
  isAuthenticated: boolean;
  loginWithGoogle: (returnTo?: string) => void;
  devLogin: () => Promise<void>;
  logout: (options?: LogoutOptions) => Promise<LogoutResult>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const AUTH_STORAGE_KEYS = [
  'radar_user',
  'radar_user_id',
  'radar_org_id',
  'radar_user_role',
  'radar_token',
] as const;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const isLoggingOutRef = useRef(false);
  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      const saved = localStorage.getItem('radar_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [currentOrgId, setCurrentOrgId] = useState<string>(() => localStorage.getItem('radar_org_id') || '');
  const [userRole, setUserRole] = useState<string>(() => localStorage.getItem('radar_user_role') || 'owner');
  const [isLoading, setIsLoading] = useState<boolean>(() => !localStorage.getItem('radar_user') && !localStorage.getItem('radar_token'));

  const clearLocalAuthState = () => {
    AUTH_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    setUser(null);
    setOrganizations([]);
    setCurrentOrgId('');
    setUserRole('owner');
  };

  const refreshSession = async () => {
    try {
      const token = localStorage.getItem('radar_token');
      const orgId = localStorage.getItem('radar_org_id');
      const role = localStorage.getItem('radar_user_role');

      // The HttpOnly session cookie is the source of truth. Do NOT forward
      // localStorage ids as x-user-id / x-organization-id identity headers:
      // stale or dev-mock values are not valid ObjectIds and the server would
      // reject them (400). Only a real bearer token is forwarded, if present.
      const res = await fetch('/api/v1/auth/me', {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.data && json.data.user) {
          setUser(json.data.user);
          setOrganizations(json.data.organizations || []);
          const activeOrg = json.data.organizationId || orgId || '';
          const activeRole = json.data.userRole || role || 'owner';
          setCurrentOrgId(activeOrg);
          setUserRole(activeRole);
          localStorage.setItem('radar_user', JSON.stringify(json.data.user));
          if (json.data.user.id || json.data.user._id) {
            localStorage.setItem('radar_user_id', json.data.user.id || json.data.user._id);
          }
          if (activeOrg) localStorage.setItem('radar_org_id', activeOrg);
          if (activeRole) localStorage.setItem('radar_user_role', activeRole);
        } else {
          // Server confirms there is no active session: drop stale identity.
          clearLocalAuthState();
        }
      } else if (res.status === 401 || res.status === 403) {
        // The session token/cookie is genuinely invalid, expired or revoked.
        clearLocalAuthState();
      } else {
        // A 400/5xx or proxy error is not proof that the session is invalid.
        // Keep whatever identity we already have rather than logging the user
        // out of a valid session because of a transient server problem.
        console.warn(`Session probe returned ${res.status}; keeping cached identity.`);
      }
    } catch (err) {
      console.error('Auth session refresh failed:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    try {
      const searchParams = new URLSearchParams(window.location.search);
      const urlToken = searchParams.get('token');
      const urlUid = searchParams.get('uid');
      const urlOid = searchParams.get('oid');
      const urlRole = searchParams.get('role');

      if (urlToken) {
        localStorage.setItem('radar_token', urlToken);
        if (urlUid) localStorage.setItem('radar_user_id', urlUid);
        if (urlOid) {
          localStorage.setItem('radar_org_id', urlOid);
          setCurrentOrgId(urlOid);
        }
        if (urlRole) {
          localStorage.setItem('radar_user_role', urlRole);
          setUserRole(urlRole);
        }

        // Clean query parameters from URL without page reload
        searchParams.delete('token');
        searchParams.delete('uid');
        searchParams.delete('oid');
        searchParams.delete('role');
        const newSearch = searchParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
        window.history.replaceState({}, '', newUrl);
      }
    } catch (e) {
      console.warn('Failed to parse URL auth parameters:', e);
    }

    refreshSession();
  }, []);

  // If the browser restores this page from the back/forward cache after sign-out,
  // force a fresh load so protected routes re-evaluate authentication.
  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        window.location.reload();
      }
    };
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, []);

  const loginWithGoogle = (returnTo = '/dashboard') => {
    // Initiate top-level OAuth redirect to backend Google auth endpoint
    window.location.href = `/api/v1/auth/google?returnTo=${encodeURIComponent(returnTo)}`;
  };

  const devLogin = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/v1/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success && data.data) {
        if (data.data.token) {
          localStorage.setItem('radar_token', data.data.token);
        }
        if (data.data.user) {
          setUser(data.data.user);
          localStorage.setItem('radar_user', JSON.stringify(data.data.user));
          localStorage.setItem('radar_user_id', data.data.user.id || data.data.user._id);
        }
        if (data.data.organizationId) {
          setCurrentOrgId(data.data.organizationId);
          localStorage.setItem('radar_org_id', data.data.organizationId);
        }
        if (data.data.userRole) {
          setUserRole(data.data.userRole);
          localStorage.setItem('radar_user_role', data.data.userRole);
        }
        setIsLoading(false);
        window.location.href = '/dashboard';
      }
    } catch (err) {
      console.error('Dev login failed:', err);
      setIsLoading(false);
    }
  };

  const logout = async (options?: LogoutOptions): Promise<LogoutResult> => {
    const clearMailData = options?.clearMailData === true;
    const mode: LogoutResult['mode'] = clearMailData ? 'clear-mail-data' : 'session';

    if (isLoggingOutRef.current) {
      throw new Error('A sign-out is already in progress.');
    }
    isLoggingOutRef.current = true;

    const finalizeClientSide = () => {
      // Drop every private API cache before unmounting the authenticated tree.
      queryClient.clear();
      clearLocalAuthState();
      // Replace (not push) the history entry so the Back button cannot return to
      // a now-unauthenticated protected workspace.
      window.location.replace('/login?reason=signed_out');
    };

    try {
      const token = localStorage.getItem('radar_token');
      const res = await fetch('/api/v1/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ mode }),
      });

      if (!res.ok) {
        let message = 'Sign out failed. Please try again.';
        try {
          const err = await res.json();
          message = err?.error?.message || message;
        } catch {
          /* ignore non-JSON error bodies */
        }
        // For "clear mail data" we must not pretend the data was deleted, and
        // we keep the user signed in so they can retry safely.
        if (clearMailData) {
          throw new Error(message);
        }
        // Plain sign-out: still clear the local session on the client.
        finalizeClientSide();
        return { mode };
      }

      const json = await res.json().catch(() => ({}));
      finalizeClientSide();
      return { mode, mailData: json?.data };
    } catch (err) {
      if (clearMailData) {
        throw err;
      }
      // Network failure during a plain sign-out: best-effort client sign-out.
      finalizeClientSide();
      return { mode };
    } finally {
      isLoggingOutRef.current = false;
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        organizations,
        currentOrgId,
        userRole,
        isLoading,
        isAuthenticated: !!user,
        loginWithGoogle,
        devLogin,
        logout,
        refreshSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
