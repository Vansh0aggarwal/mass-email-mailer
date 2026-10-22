import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Building2,
  Sparkles,
  Mail,
  FileSpreadsheet,
  CheckCircle2,
  ArrowRight,
  ShieldCheck,
  Zap,
  TrendingUp,
} from 'lucide-react';
import { Link } from 'react-router-dom';

export function DashboardPage() {
  const { data: healthData, isLoading: isLoadingHealth } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<any>('/health'),
  });

  const { data: companies = [], isLoading: isLoadingCompanies } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<any[]>('/companies').catch(() => []),
  });

  const { data: drafts = [], isLoading: isLoadingDrafts } = useQuery({
    queryKey: ['drafts'],
    queryFn: () => api.get<any[]>('/drafts').catch(() => []),
  });

  const { data: opportunities = [], isLoading: isLoadingOpportunities } = useQuery<any[]>({
    queryKey: ['opportunities'],
    queryFn: () => api.get<any[]>('/opportunities').catch(() => []),
  });

  const qualifiedOpportunities = Array.isArray(opportunities)
    ? opportunities.filter((o) => o.isQualified)
    : [];
  const avgConfidence = Array.isArray(opportunities) && opportunities.length > 0
    ? Math.round(
        (opportunities.reduce((acc, o) => acc + (typeof o.confidence === 'number' ? o.confidence : 0.8), 0) /
          opportunities.length) *
          100
      )
    : 0;

  return (
    <div className="space-y-6 max-w-7xl select-none">
      {/* Hero Card */}
      <div className="ios-card relative overflow-hidden p-7 md:p-8">
        <div className="relative z-10 max-w-3xl space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface-3 border border-line text-xs font-medium text-ink">
            <span className="w-2 h-2 rounded-full bg-success" />
            <span className="text-[11px] tracking-wide uppercase text-ink-muted">Overview</span>
            <span className="text-ink-subtle">•</span>
            <span>Swaniki New Business Radar</span>
          </div>

          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-ink leading-tight">
            New business radar
          </h1>

          <p className="text-sm md:text-base text-ink-muted leading-relaxed max-w-2xl">
            Track target accounts, surface service opportunities with transparent rule scoring, and
            draft grounded outreach for human review.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Link
              to="/csv-imports"
              className="ios-btn-primary px-5 py-2.5 text-xs inline-flex items-center gap-2"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>Import Company CSV</span>
            </Link>

            <Link
              to="/email"
              className="ios-btn-secondary px-5 py-2.5 text-xs inline-flex items-center gap-2"
            >
              <Mail className="w-4 h-4 text-accent" />
              <span>Open Email Workspace</span>
            </Link>

            <Link
              to="/ai-studio"
              className="ios-btn-secondary px-5 py-2.5 text-xs inline-flex items-center gap-2"
            >
              <Sparkles className="w-4 h-4 text-accent" />
              <span>AI Email Studio</span>
            </Link>
          </div>
        </div>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Widget 1: Companies */}
        <div className="ios-card p-5 relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wider text-ink-subtle uppercase">
              Accounts Tracked
            </span>
            <div className="w-8 h-8 rounded-[10px] bg-accent/10 border border-accent/20 flex items-center justify-center text-accent">
              <Building2 className="w-4 h-4" />
            </div>
          </div>
          <div className="text-3xl font-bold tracking-tight text-ink mt-3 tabular-nums">
            {isLoadingCompanies ? (
              <div className="skeleton h-9 w-16" />
            ) : Array.isArray(companies) ? (
              companies.length
            ) : (
              0
            )}
          </div>
          <div className="text-[11px] text-ink-muted mt-1.5 flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5 text-success" />
            <span>Multi-tenant MongoDB data store</span>
          </div>
        </div>

        {/* Widget 2: Qualified Needs */}
        <div className="ios-card p-5 relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wider text-ink-subtle uppercase">
              Opportunity Engine
            </span>
            <div className="w-8 h-8 rounded-[10px] bg-accent/10 border border-accent/20 flex items-center justify-center text-accent">
              <Sparkles className="w-4 h-4" />
            </div>
          </div>
          <div className="text-3xl font-bold tracking-tight text-ink mt-3 tabular-nums">
            {isLoadingOpportunities ? (
              <div className="skeleton h-9 w-16" />
            ) : opportunities.length > 0 ? (
              `${avgConfidence}%`
            ) : (
              '0%'
            )}
          </div>
          <div className="text-[11px] text-ink-muted mt-1.5 flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-warning" />
            <span>
              {opportunities.length > 0
                ? `${qualifiedOpportunities.length} qualified of ${opportunities.length} accounts`
                : 'Transparent scoring matrix'}
            </span>
          </div>
        </div>

        {/* Widget 3: Pending Review */}
        <div className="ios-card p-5 relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wider text-ink-subtle uppercase">
              Outreach Drafts
            </span>
            <div className="w-8 h-8 rounded-[10px] bg-warning/10 border border-warning/20 flex items-center justify-center text-warning">
              <Mail className="w-4 h-4" />
            </div>
          </div>
          <div className="text-3xl font-bold tracking-tight text-ink mt-3 tabular-nums">
            {isLoadingDrafts ? (
              <div className="skeleton h-9 w-16" />
            ) : Array.isArray(drafts) ? (
              drafts.length
            ) : (
              0
            )}
          </div>
          <div className="text-[11px] text-ink-muted mt-1.5 flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-success" />
            <span>Strict human review required</span>
          </div>
        </div>

        {/* Widget 4: Backend Status */}
        <div className="ios-card p-5 relative overflow-hidden group">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wider text-ink-subtle uppercase">
              Engine Health
            </span>
            <div className="w-8 h-8 rounded-[10px] bg-success/10 border border-success/20 flex items-center justify-center text-success">
              <CheckCircle2 className="w-4 h-4" />
            </div>
          </div>
          <div className="text-3xl font-bold tracking-tight text-success mt-3 capitalize tabular-nums">
            {isLoadingHealth ? (
              <div className="skeleton h-9 w-20" />
            ) : healthData?.status === 'ok' ? (
              'Online'
            ) : (
              healthData?.status || 'Active'
            )}
          </div>
          <div className="text-[11px] text-ink-muted mt-1.5 flex items-center gap-1">
            <span>DB: {healthData?.database?.status === 'connected' ? 'Connected' : healthData?.database?.status || 'Connected'}</span>
            <span>•</span>
            <span className="text-accent">OAuth Ready</span>
          </div>
        </div>
      </div>

      {/* Quick access workflow */}
      <div className="ios-card p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div>
            <h2 className="text-base font-semibold text-ink tracking-tight">
              Outreach workflow
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              From prospect CSV discovery to Gmail delivery
            </p>
          </div>
          <span className="text-[10px] uppercase px-2.5 py-1 rounded-full bg-surface-3 border border-line text-ink-muted">
            Guided pipeline
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 pt-1">
          {[
            {
              step: '01',
              title: 'CSV Ingestion',
              desc: 'Formula injection defense and rating normalization',
              to: '/csv-imports',
              color: 'text-accent',
            },
            {
              step: '02',
              title: 'Opportunity Scoring',
              desc: 'Rule-based matching against your service catalog',
              to: '/opportunities',
              color: 'text-accent',
            },
            {
              step: '03',
              title: 'AI Email Studio',
              desc: 'Grounded composition with explicit fact checks',
              to: '/ai-studio',
              color: 'text-accent',
            },
            {
              step: '04',
              title: 'Gmail API Send',
              desc: 'Encrypted token dispatch with quota enforcement',
              to: '/email',
              color: 'text-success',
            },
          ].map((item) => (
            <Link
              key={item.step}
              to={item.to}
              className="p-4 rounded-xl bg-surface-2 hover:bg-surface-3 border border-line hover:border-line-strong transition-all group block active:scale-[0.98]"
            >
              <div className="flex items-center justify-between mb-2">
                <span className={`text-[10px] font-bold ${item.color}`}>
                  STEP {item.step}
                </span>
                <ArrowRight className="w-3.5 h-3.5 text-ink-subtle group-hover:text-ink group-hover:translate-x-0.5 transition-all" />
              </div>
              <h3 className="text-xs font-semibold text-ink group-hover:text-ink transition-colors">
                {item.title}
              </h3>
              <p className="text-[11px] text-ink-muted mt-1 leading-relaxed">
                {item.desc}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
