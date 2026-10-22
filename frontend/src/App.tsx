import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLayout } from './components/layout/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { EmailWorkspacePage } from './pages/EmailWorkspacePage';
import { AiStudioPage } from './pages/AiStudioPage';
import { CompaniesPage } from './pages/CompaniesPage';
import { CompanyDetailPage } from './pages/CompanyDetailPage';
import { ContactsPage } from './pages/ContactsPage';
import { OpportunitiesPage } from './pages/OpportunitiesPage';
import { CsvImportsPage } from './pages/CsvImportsPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { DraftsPage } from './pages/DraftsPage';
import { FollowUpsPage } from './pages/FollowUpsPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { CampaignNewPage } from './pages/CampaignNewPage';
import { CampaignDetailPage } from './pages/CampaignDetailPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { ServicesPage } from './pages/ServicesPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { SettingsPage } from './pages/SettingsPage';
import { DeliverabilityPage } from './pages/DeliverabilityPage';
import { TeamPage } from './pages/TeamPage';

import { AuthProvider } from './context/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { CustomCursor } from './components/common/CustomCursor';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2, // 2 minutes
      retry: 1,
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
                <Route index element={<DashboardPage />} />
                <Route path="dashboard" element={<DashboardPage />} />
                <Route path="email" element={<EmailWorkspacePage />} />
                <Route path="ai-studio" element={<AiStudioPage />} />
                <Route path="companies" element={<CompaniesPage />} />
                <Route path="companies/:id" element={<CompanyDetailPage />} />
                <Route path="contacts" element={<ContactsPage />} />
                <Route path="opportunities" element={<OpportunitiesPage />} />
                <Route path="csv-imports" element={<CsvImportsPage />} />
                <Route path="templates" element={<TemplatesPage />} />
                <Route path="drafts" element={<DraftsPage />} />
                <Route path="follow-ups" element={<FollowUpsPage />} />
                <Route path="campaigns" element={<CampaignsPage />} />
                <Route path="campaigns/new" element={<CampaignNewPage />} />
                <Route path="campaigns/:id" element={<CampaignDetailPage />} />
                <Route path="analytics" element={<AnalyticsPage />} />
                <Route path="deliverability" element={<DeliverabilityPage />} />
                <Route path="team" element={<TeamPage />} />
                <Route path="services" element={<ServicesPage />} />
                <Route path="integrations" element={<IntegrationsPage />} />
                <Route path="settings" element={<SettingsPage />} />
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

export default App;
