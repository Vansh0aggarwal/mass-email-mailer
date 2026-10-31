import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { AuthProvider } from './context/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { CustomCursor } from './components/common/CustomCursor';

// ---------------------------------------------------------------------------
// Lazy-load every page so Vite produces per-route chunks instead of one
// monolithic 1.1 MB bundle. Each page only downloads when first navigated to.
// Heavy deps (Recharts, react-hook-form, campaign service wrappers) are
// automatically excluded from the initial JS payload.
// ---------------------------------------------------------------------------
const DashboardPage      = lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
const EmailWorkspacePage = lazy(() => import('./pages/EmailWorkspacePage').then(m => ({ default: m.EmailWorkspacePage })));
const AiStudioPage       = lazy(() => import('./pages/AiStudioPage').then(m => ({ default: m.AiStudioPage })));
const EmailDesignStudioPage = lazy(() => import('./pages/EmailDesignStudioPage').then(m => ({ default: m.EmailDesignStudioPage })));
const CompaniesPage      = lazy(() => import('./pages/CompaniesPage').then(m => ({ default: m.CompaniesPage })));
const CompanyDetailPage  = lazy(() => import('./pages/CompanyDetailPage').then(m => ({ default: m.CompanyDetailPage })));
const ContactsPage       = lazy(() => import('./pages/ContactsPage').then(m => ({ default: m.ContactsPage })));
const OpportunitiesPage  = lazy(() => import('./pages/OpportunitiesPage').then(m => ({ default: m.OpportunitiesPage })));
const CsvImportsPage     = lazy(() => import('./pages/CsvImportsPage').then(m => ({ default: m.CsvImportsPage })));
const TemplatesPage      = lazy(() => import('./pages/TemplatesPage').then(m => ({ default: m.TemplatesPage })));
const DraftsPage         = lazy(() => import('./pages/DraftsPage').then(m => ({ default: m.DraftsPage })));
const FollowUpsPage      = lazy(() => import('./pages/FollowUpsPage').then(m => ({ default: m.FollowUpsPage })));
const CampaignsPage      = lazy(() => import('./pages/CampaignsPage').then(m => ({ default: m.CampaignsPage })));
const CampaignNewPage    = lazy(() => import('./pages/CampaignNewPage').then(m => ({ default: m.CampaignNewPage })));
const CampaignDetailPage = lazy(() => import('./pages/CampaignDetailPage').then(m => ({ default: m.CampaignDetailPage })));
const CampaignSplitsPage = lazy(() => import('./pages/CampaignSplitsPage').then(m => ({ default: m.CampaignSplitsPage })));
const CampaignSplitNewPage = lazy(() => import('./pages/CampaignSplitNewPage').then(m => ({ default: m.CampaignSplitNewPage })));
const CampaignSplitDetailPage = lazy(() => import('./pages/CampaignSplitDetailPage').then(m => ({ default: m.CampaignSplitDetailPage })));
const AnalyticsPage      = lazy(() => import('./pages/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })));
const ServicesPage       = lazy(() => import('./pages/ServicesPage').then(m => ({ default: m.ServicesPage })));
const IntegrationsPage   = lazy(() => import('./pages/IntegrationsPage').then(m => ({ default: m.IntegrationsPage })));
const SettingsPage       = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const DeliverabilityPage = lazy(() => import('./pages/DeliverabilityPage').then(m => ({ default: m.DeliverabilityPage })));
const TeamPage           = lazy(() => import('./pages/TeamPage').then(m => ({ default: m.TeamPage })));

// Lightweight fallback shown while a page chunk loads.
function PageLoader() {
  return (
    <div className="flex items-center justify-center w-full h-full min-h-[60vh]">
      <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2, // 2 minutes
      // Only retry on server errors (5xx), not auth failures (401/403).
      // Without this, a 401 would be retried once — a guaranteed wasted request.
      retry: (failureCount, error: any) =>
        failureCount < 1 && (error?.status ?? 0) >= 500,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<AppLayout />}>
                {/* All page routes are wrapped in Suspense so the per-route
                    chunk can be fetched lazily without a blank screen. */}
                <Route index element={<Suspense fallback={<PageLoader />}><DashboardPage /></Suspense>} />
                <Route path="dashboard" element={<Suspense fallback={<PageLoader />}><DashboardPage /></Suspense>} />
                <Route path="email" element={<Suspense fallback={<PageLoader />}><EmailWorkspacePage /></Suspense>} />
                <Route path="ai-studio" element={<Suspense fallback={<PageLoader />}><AiStudioPage /></Suspense>} />
                <Route path="email-studio" element={<Suspense fallback={<PageLoader />}><EmailDesignStudioPage /></Suspense>} />
                <Route path="companies" element={<Suspense fallback={<PageLoader />}><CompaniesPage /></Suspense>} />
                <Route path="companies/:id" element={<Suspense fallback={<PageLoader />}><CompanyDetailPage /></Suspense>} />
                <Route path="contacts" element={<Suspense fallback={<PageLoader />}><ContactsPage /></Suspense>} />
                <Route path="opportunities" element={<Suspense fallback={<PageLoader />}><OpportunitiesPage /></Suspense>} />
                <Route path="csv-imports" element={<Suspense fallback={<PageLoader />}><CsvImportsPage /></Suspense>} />
                <Route path="templates" element={<Suspense fallback={<PageLoader />}><TemplatesPage /></Suspense>} />
                <Route path="drafts" element={<Suspense fallback={<PageLoader />}><DraftsPage /></Suspense>} />
                <Route path="follow-ups" element={<Suspense fallback={<PageLoader />}><FollowUpsPage /></Suspense>} />
                <Route path="campaigns" element={<Suspense fallback={<PageLoader />}><CampaignsPage /></Suspense>} />
                <Route path="campaigns/new" element={<Suspense fallback={<PageLoader />}><CampaignNewPage /></Suspense>} />
                <Route path="campaigns/splits" element={<Suspense fallback={<PageLoader />}><CampaignSplitsPage /></Suspense>} />
                <Route path="campaigns/splits/new" element={<Suspense fallback={<PageLoader />}><CampaignSplitNewPage /></Suspense>} />
                <Route path="campaigns/splits/:id" element={<Suspense fallback={<PageLoader />}><CampaignSplitDetailPage /></Suspense>} />
                <Route path="campaigns/:id" element={<Suspense fallback={<PageLoader />}><CampaignDetailPage /></Suspense>} />
                <Route path="analytics" element={<Suspense fallback={<PageLoader />}><AnalyticsPage /></Suspense>} />
                <Route path="deliverability" element={<Suspense fallback={<PageLoader />}><DeliverabilityPage /></Suspense>} />
                <Route path="team" element={<Suspense fallback={<PageLoader />}><TeamPage /></Suspense>} />
                <Route path="services" element={<Suspense fallback={<PageLoader />}><ServicesPage /></Suspense>} />
                <Route path="integrations" element={<Suspense fallback={<PageLoader />}><IntegrationsPage /></Suspense>} />
                <Route path="settings" element={<Suspense fallback={<PageLoader />}><SettingsPage /></Suspense>} />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Route>
            </Route>
          </Routes>
          <CustomCursor />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
