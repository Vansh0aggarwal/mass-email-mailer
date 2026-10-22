import React from 'react';
import { Navigate, useLocation, Outlet } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Radar } from 'lucide-react';

export function ProtectedRoute({ children }: { children?: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="min-h-screen bg-app flex flex-col items-center justify-center gap-4"
      >
        <div className="w-12 h-12 rounded-xl bg-accent text-accent-fg flex items-center justify-center">
          <Radar className="w-6 h-6" />
        </div>
        <p className="text-xs text-ink-muted font-medium">Loading your workspace…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return children ? <>{children}</> : <Outlet />;
}
