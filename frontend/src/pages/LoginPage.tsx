import { useSearchParams, Navigate } from 'react-router-dom';
import { ShieldCheck, Radar, AlertCircle, CheckCircle2, Sparkles, Terminal } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const error = searchParams.get('error');
  const { loginWithGoogle, devLogin, isLoading, isAuthenticated } = useAuth();

  if (isAuthenticated && !isLoading) {
    return <Navigate to="/dashboard" replace />;
  }

  const signedOut = searchParams.get('reason') === 'signed_out';

  return (
    <div className="min-h-screen bg-app flex flex-col justify-center items-center px-4 relative overflow-hidden">
      <div className="max-w-md w-full space-y-8 relative z-10">
        {/* Brand Header */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-accent text-accent-fg">
            <Radar className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Swaniki New Business Radar</h1>
          <p className="text-xs text-ink-subtle max-w-sm mx-auto">
            Opportunity discovery, grounded outreach, and an integrated email workspace
          </p>
        </div>

        {/* Error notification if redirected back from OAuth failure */}
        {error && (
          <div className="p-4 rounded-xl bg-danger/10 border border-danger/25 flex items-start gap-3 text-danger text-xs">
            <AlertCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-ink">Sign-In Failed</p>
              <p className="text-[11px] text-ink-muted mt-0.5">{decodeURIComponent(error)}</p>
            </div>
          </div>
        )}

        {/* Signed-out confirmation */}
        {signedOut && !error && (
          <div className="p-4 rounded-xl bg-success/10 border border-success/25 flex items-start gap-3 text-success text-xs">
            <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-ink">You have been signed out</p>
              <p className="text-[11px] text-ink-muted mt-0.5">
                Sign in again to reconnect your mailboxes and continue.
              </p>
            </div>
          </div>
        )}

        {/* Login Card */}
        <div className="ios-card rounded-xl p-7 sm:p-8 bg-surface-2 space-y-6">
          <div className="space-y-1 text-center">
            <h2 className="text-base font-semibold text-ink tracking-tight">Welcome Back</h2>
            <p className="text-xs text-ink-subtle">Sign in to continue to your workspace</p>
          </div>

          <div className="space-y-3">
            {/* Real Google Sign-In Button */}
            <button
              type="button"
              onClick={() => loginWithGoogle()}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl bg-white hover:bg-white/90 text-black font-semibold text-xs border border-line transition-all active:scale-[0.98] disabled:opacity-50"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
              <span>Continue with Google</span>
            </button>

            {/* Privacy & Scope Disclaimer */}
            <div className="flex items-center gap-2.5 p-3 rounded-xl bg-surface-2 border border-line text-[11px] text-ink-subtle">
              <ShieldCheck className="w-4 h-4 text-accent shrink-0" />
              <span>
                Standard OpenID Connect authentication. Gmail access is not requested during login.
              </span>
            </div>
          </div>

          <div className="relative flex py-1 items-center">
            <div className="flex-grow border-t border-line"></div>
            <span className="flex-shrink mx-3 text-[10px] uppercase text-ink-subtle">
              Or Local Sandbox
            </span>
            <div className="flex-grow border-t border-line"></div>
          </div>

          {/* Dev Mode One-Click Login */}
          <div className="space-y-2.5">
            <button
              type="button"
              onClick={() => devLogin()}
              disabled={isLoading}
              className="ios-btn-secondary w-full py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.98]"
            >
              <Terminal className="w-4 h-4 text-success" />
              <span>Continue as Dev User (Local Sandbox)</span>
            </button>
            <p className="text-[10px] text-ink-subtle text-center">
              Instant login for local evaluation without needing Google Cloud credentials.
            </p>
          </div>
        </div>

        {/* Footer info */}
        <div className="text-center text-[11px] text-ink-subtle flex items-center justify-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-accent" />
          <span>Secure, decoupled Gmail architecture</span>
        </div>
      </div>
    </div>
  );
}
