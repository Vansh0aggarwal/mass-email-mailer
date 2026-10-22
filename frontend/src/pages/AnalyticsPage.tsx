import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  TrendingUp,
  Send,
  CheckCircle2,
  MessageSquare,
  AlertTriangle,
  Slash,
  Clock,
  RefreshCw,
  Download,
  Filter,
  Calendar,
  ExternalLink,
  ChevronDown,
  BarChart2,
  PieChart as PieIcon,
  Layers,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { api } from '../lib/api';

interface SummaryData {
  campaignsCount: number;
  recipientsCount: number;
  emailsSent: number;
  emailsDelivered: number;
  repliesReceived: number;
  bouncesCount: number;
  unsubscribesCount: number;
  failedSends: number;
  pendingFollowUps: number;
  replyRatePercent: number;
  bounceRatePercent: number;
  deliveryRatePercent: number;
  comparison: {
    hasHistoricalData: boolean;
    sentDelta: number;
    repliesDelta: number;
    replyRateDelta: number;
    prevSent: number;
    prevReplies: number;
    prevReplyRate: number;
  };
}

interface ActivityPoint {
  date: string;
  displayDate: string;
  sent: number;
  replies: number;
  bounces: number;
  failures: number;
  replyRate: number;
}

interface CampaignRow {
  _id: string;
  name: string;
  status: string;
  totalRecipients: number;
  sent: number;
  replied: number;
  failed: number;
  skipped: number;
  replyRatePercent: number;
  createdAt?: string;
}

interface FunnelStage {
  stage: string;
  count: number;
  percent: number;
  description: string;
}

interface StepItem {
  stepIndex: number;
  stepName: string;
  sent: number;
  replied: number;
  pending: number;
  failed: number;
  replyRatePercent: number;
}

interface DeliveryBreakdown {
  accepted: number;
  deliveredEstimated: number;
  bounced: number;
  failed: number;
  unsubscribed: number;
}

interface AnalyticsPayload {
  summary: SummaryData;
  activityTimeSeries: ActivityPoint[];
  campaignComparison: CampaignRow[];
  outreachFunnel: FunnelStage[];
  stepPerformance: StepItem[];
  deliveryBreakdown: DeliveryBreakdown;
  topCampaigns: CampaignRow[];
  campaigns?: {
    total: number;
    active: number;
  };
  filtersApplied: {
    range: string;
    startDate: string;
    endDate: string;
    campaignId: string;
    step: string;
    status: string;
  };
  metricDefinitions: Record<string, string>;
  lastUpdated: string;
}

interface CampaignOption {
  _id: string;
  name: string;
}

export function AnalyticsPage() {
  // Filter States
  const [timeRange, setTimeRange] = useState<'7d' | '14d' | '30d' | '90d' | 'all' | 'custom'>('30d');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>('all');
  const [selectedStep, setSelectedStep] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [activityChartType, setActivityChartType] = useState<'area' | 'bar'>('area');
  const [isExporting, setIsExporting] = useState(false);
  const [showDefinitions, setShowDefinitions] = useState(false);

  // Fetch campaigns for dropdown filter
  const { data: campaignsList = [] } = useQuery<CampaignOption[]>({
    queryKey: ['campaigns-filter-list'],
    queryFn: async () => {
      const res = await api.get<any>('/campaigns');
      return Array.isArray(res) ? res : res?.campaigns || [];
    },
    staleTime: 1000 * 60 * 5,
  });

  // Fetch analytics overview
  const {
    data: rawData,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery<any>({
    queryKey: [
      'analytics-overview',
      timeRange,
      customStartDate,
      customEndDate,
      selectedCampaignId,
      selectedStep,
      selectedStatus,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('range', timeRange);
      if (timeRange === 'custom') {
        if (customStartDate) params.set('startDate', customStartDate);
        if (customEndDate) params.set('endDate', customEndDate);
      }
      if (selectedCampaignId !== 'all') params.set('campaignId', selectedCampaignId);
      if (selectedStep !== 'all') params.set('step', selectedStep);
      if (selectedStatus !== 'all') params.set('status', selectedStatus);

      return api.get(`/analytics/overview?${params.toString()}`);
    },
    refetchOnMount: 'always',
  });

  // Defensive unwrapping to support both direct and nested data returns
  const analytics: AnalyticsPayload | null =
    rawData?.summary
      ? (rawData as AnalyticsPayload)
      : rawData?.data?.summary
      ? (rawData.data as AnalyticsPayload)
      : null;

  // Active filter count (excluding defaults)
  const activeFilterCount =
    (timeRange !== '30d' ? 1 : 0) +
    (selectedCampaignId !== 'all' ? 1 : 0) +
    (selectedStep !== 'all' ? 1 : 0) +
    (selectedStatus !== 'all' ? 1 : 0);

  const handleResetFilters = () => {
    setTimeRange('30d');
    setCustomStartDate('');
    setCustomEndDate('');
    setSelectedCampaignId('all');
    setSelectedStep('all');
    setSelectedStatus('all');
  };

  const handleExportCsv = async () => {
    setIsExporting(true);
    try {
      const params = new URLSearchParams();
      params.set('range', timeRange);
      if (timeRange === 'custom') {
        if (customStartDate) params.set('startDate', customStartDate);
        if (customEndDate) params.set('endDate', customEndDate);
      }
      if (selectedCampaignId !== 'all') params.set('campaignId', selectedCampaignId);
      if (selectedStep !== 'all') params.set('step', selectedStep);
      if (selectedStatus !== 'all') params.set('status', selectedStatus);

      const token = localStorage.getItem('radar_token');
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(`/api/v1/analytics/export?${params.toString()}`, {
        credentials: 'include',
        headers,
      });

      if (!res.ok) throw new Error('Failed to generate CSV export');

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `swaniki-analytics-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-16 px-4 sm:px-6">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pt-2">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-ink tracking-tight">
                Outreach & Conversion Analytics
              </h1>
              <p className="text-xs text-ink-muted mt-0.5">
                Database-grounded metrics across campaigns, Gmail dispatches, replies, and follow-up sequences.
              </p>
            </div>
          </div>
        </div>

        {/* Global Actions */}
        <div className="flex flex-wrap items-center gap-2.5 self-start md:self-auto">
          {analytics?.lastUpdated && (
            <span className="text-[11px] text-ink-subtle hidden lg:inline-block">
              Updated: {new Date(analytics.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}

          <button
            onClick={handleExportCsv}
            disabled={isExporting || isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-2 hover:bg-surface-3 border border-line text-xs font-semibold text-ink transition-colors disabled:opacity-50"
            title="Download full analytics report in CSV format"
          >
            <Download className={`w-3.5 h-3.5 ${isExporting ? 'animate-bounce' : ''}`} />
            {isExporting ? 'Exporting...' : 'Export CSV'}
          </button>

          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-2 hover:bg-surface-3 border border-line text-xs font-semibold text-ink transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin text-accent' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Time Range Pills */}
          <div className="flex items-center gap-1 p-1 bg-surface-2 rounded-xl border border-line text-xs overflow-x-auto">
            <span className="text-ink-subtle px-2 font-medium flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" /> Range:
            </span>
            {(['7d', '14d', '30d', '90d', 'all', 'custom'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setTimeRange(r)}
                className={`px-3 py-1 rounded-lg font-medium transition-all ${
                  timeRange === r
                    ? 'bg-accent text-accent-fg shadow-sm'
                    : 'text-ink-muted hover:text-ink hover:bg-surface-3'
                }`}
              >
                {r === '7d'
                  ? '7D'
                  : r === '14d'
                  ? '14D'
                  : r === '30d'
                  ? '30D'
                  : r === '90d'
                  ? '90D'
                  : r === 'all'
                  ? 'All Time'
                  : 'Custom'}
              </button>
            ))}
          </div>

          {/* Reset Filters Button */}
          {activeFilterCount > 0 && (
            <button
              onClick={handleResetFilters}
              className="text-xs text-accent hover:underline flex items-center gap-1 font-semibold"
            >
              <Filter className="w-3 h-3" />
              Reset Filters ({activeFilterCount})
            </button>
          )}
        </div>

        {/* Dropdowns & Custom Date Selectors */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
          {timeRange === 'custom' && (
            <div className="flex items-center gap-2 col-span-1 sm:col-span-2">
              <div className="flex-1">
                <label className="text-[10px] uppercase font-bold text-ink-subtle block mb-1">
                  Start Date
                </label>
                <input
                  type="date"
                  value={customStartDate}
                  onChange={(e) => setCustomStartDate(e.target.value)}
                  className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-line bg-surface text-ink focus:outline-none focus:border-accent"
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] uppercase font-bold text-ink-subtle block mb-1">
                  End Date
                </label>
                <input
                  type="date"
                  value={customEndDate}
                  onChange={(e) => setCustomEndDate(e.target.value)}
                  className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-line bg-surface text-ink focus:outline-none focus:border-accent"
                />
              </div>
            </div>
          )}

          <div>
            <label className="text-[10px] uppercase font-bold text-ink-subtle block mb-1">
              Campaign
            </label>
            <select
              value={selectedCampaignId}
              onChange={(e) => setSelectedCampaignId(e.target.value)}
              className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-line bg-surface text-ink focus:outline-none focus:border-accent"
            >
              <option value="all">All Campaigns</option>
              {campaignsList.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] uppercase font-bold text-ink-subtle block mb-1">
              Sequence Step
            </label>
            <select
              value={selectedStep}
              onChange={(e) => setSelectedStep(e.target.value)}
              className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-line bg-surface text-ink focus:outline-none focus:border-accent"
            >
              <option value="all">All Sequence Steps</option>
              <option value="0">Step 1: Initial Outreach</option>
              <option value="1">Step 2: Value Follow-up</option>
              <option value="2">Step 3: Closing Check-in</option>
            </select>
          </div>

          <div>
            <label className="text-[10px] uppercase font-bold text-ink-subtle block mb-1">
              Campaign Status
            </label>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-line bg-surface text-ink focus:outline-none focus:border-accent"
            >
              <option value="all">All Statuses</option>
              <option value="sending">Sending (Active)</option>
              <option value="scheduled">Scheduled</option>
              <option value="completed">Completed</option>
              <option value="paused">Paused</option>
              <option value="draft">Draft</option>
            </select>
          </div>
        </div>
      </div>

      {/* Loading Skeleton */}
      {isLoading ? (
        <div className="space-y-6 animate-pulse">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-28 rounded-2xl bg-surface-2 border border-line" />
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="h-80 rounded-2xl bg-surface-2 border border-line lg:col-span-2" />
            <div className="h-80 rounded-2xl bg-surface-2 border border-line" />
          </div>
        </div>
      ) : isError ? (
        /* Error State */
        <div className="rounded-2xl border border-danger/30 bg-danger/5 p-8 text-center space-y-3">
          <AlertTriangle className="w-10 h-10 text-danger mx-auto" />
          <h3 className="text-base font-bold text-ink">Failed to load analytics</h3>
          <p className="text-xs text-ink-muted max-w-md mx-auto">
            {error instanceof Error ? error.message : 'An error occurred while aggregating workspace metrics.'}
          </p>
          <button
            onClick={() => refetch()}
            className="px-4 py-2 rounded-xl bg-accent text-accent-fg text-xs font-semibold hover:bg-accent-strong transition-colors"
          >
            Retry Aggregation
          </button>
        </div>
      ) : !analytics ? (
        /* Empty State */
        <div className="rounded-2xl border border-line bg-surface p-12 text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-surface-2 border border-line flex items-center justify-center text-ink-subtle mx-auto">
            <BarChart2 className="w-6 h-6" />
          </div>
          <h3 className="text-lg font-bold text-ink">No outreach data available</h3>
          <p className="text-xs text-ink-muted max-w-md mx-auto">
            Upload prospects and launch your first email outreach campaign to populate performance metrics and time series.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <Link
              to="/campaigns/new"
              className="px-4 py-2 rounded-xl bg-accent text-accent-fg text-xs font-semibold hover:bg-accent-strong transition-colors"
            >
              Create Campaign
            </Link>
            <Link
              to="/csv-imports"
              className="px-4 py-2 rounded-xl bg-surface-2 border border-line text-xs font-semibold text-ink hover:bg-surface-3 transition-colors"
            >
              Import Prospects
            </Link>
          </div>
        </div>
      ) : (
        /* Populated Dashboard */
        <>
          {/* Summary KPI Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* 1. Total Campaigns */}
            <div className="rounded-2xl border border-line bg-surface p-5 space-y-2 relative overflow-hidden">
              <div className="flex items-center justify-between text-xs font-semibold text-ink-subtle uppercase tracking-wider">
                <span>Campaigns</span>
                <Layers className="w-4 h-4 text-accent" />
              </div>
              <div className="text-3xl font-extrabold text-ink tabular-nums">
                {analytics.summary.campaignsCount.toLocaleString()}
              </div>
              <div className="text-[11px] text-ink-muted flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-success inline-block" />
                <span>Active: {analytics.campaigns?.active || 0}</span>
                <span className="text-ink-subtle">·</span>
                <span>{analytics.summary.recipientsCount.toLocaleString()} prospects</span>
              </div>
            </div>

            {/* 2. Emails Sent (Accepted by Provider) */}
            <div className="rounded-2xl border border-line bg-surface p-5 space-y-2 relative overflow-hidden">
              <div className="flex items-center justify-between text-xs font-semibold text-ink-subtle uppercase tracking-wider">
                <span>Emails Sent</span>
                <Send className="w-4 h-4 text-info" />
              </div>
              <div className="text-3xl font-extrabold text-ink tabular-nums">
                {analytics.summary.emailsSent.toLocaleString()}
              </div>
              <div className="text-[11px] text-ink-muted flex items-center justify-between">
                <span>Provider verified dispatches</span>
                {analytics.summary.comparison?.hasHistoricalData && (
                  <span
                    className={`inline-flex items-center gap-0.5 font-bold text-[10px] px-1.5 py-0.5 rounded-full ${
                      analytics.summary.comparison.sentDelta >= 0
                        ? 'text-success bg-success/10'
                        : 'text-danger bg-danger/10'
                    }`}
                  >
                    {analytics.summary.comparison.sentDelta >= 0 ? '+' : ''}
                    {analytics.summary.comparison.sentDelta}%
                  </span>
                )}
              </div>
            </div>

            {/* 3. Inbound Replies */}
            <div className="rounded-2xl border border-line bg-surface p-5 space-y-2 relative overflow-hidden">
              <div className="flex items-center justify-between text-xs font-semibold text-ink-subtle uppercase tracking-wider">
                <span>Inbound Replies</span>
                <MessageSquare className="w-4 h-4 text-success" />
              </div>
              <div className="text-3xl font-extrabold text-success tabular-nums">
                {analytics.summary.repliesReceived.toLocaleString()}
              </div>
              <div className="text-[11px] text-ink-muted flex items-center justify-between">
                <span>Prospect responses</span>
                {analytics.summary.comparison?.hasHistoricalData && (
                  <span
                    className={`inline-flex items-center gap-0.5 font-bold text-[10px] px-1.5 py-0.5 rounded-full ${
                      analytics.summary.comparison.repliesDelta >= 0
                        ? 'text-success bg-success/10'
                        : 'text-danger bg-danger/10'
                    }`}
                  >
                    {analytics.summary.comparison.repliesDelta >= 0 ? '+' : ''}
                    {analytics.summary.comparison.repliesDelta}%
                  </span>
                )}
              </div>
            </div>

            {/* 4. Reply Rate */}
            <div className="rounded-2xl border border-line bg-surface p-5 space-y-2 relative overflow-hidden">
              <div className="flex items-center justify-between text-xs font-semibold text-ink-subtle uppercase tracking-wider">
                <span>Reply Rate</span>
                <TrendingUp className="w-4 h-4 text-accent" />
              </div>
              <div className="text-3xl font-extrabold text-ink tabular-nums">
                {analytics.summary.replyRatePercent}%
              </div>
              <div className="text-[11px] text-ink-muted flex items-center justify-between">
                <span>Replies / Emails Sent</span>
                {analytics.summary.comparison?.hasHistoricalData && (
                  <span
                    className={`inline-flex items-center gap-0.5 font-bold text-[10px] px-1.5 py-0.5 rounded-full ${
                      analytics.summary.comparison.replyRateDelta >= 0
                        ? 'text-success bg-success/10'
                        : 'text-danger bg-danger/10'
                    }`}
                  >
                    {analytics.summary.comparison.replyRateDelta >= 0 ? '+' : ''}
                    {analytics.summary.comparison.replyRateDelta}%
                  </span>
                )}
              </div>
            </div>

            {/* 5. Delivered (Estimated) */}
            <div className="rounded-2xl border border-line bg-surface p-5 space-y-2 relative overflow-hidden">
              <div className="flex items-center justify-between text-xs font-semibold text-ink-subtle uppercase tracking-wider">
                <span>Delivered (Est.)</span>
                <CheckCircle2 className="w-4 h-4 text-success" />
              </div>
              <div className="text-3xl font-extrabold text-ink tabular-nums">
                {analytics.summary.emailsDelivered.toLocaleString()}
              </div>
              <div className="text-[11px] text-ink-muted flex items-center justify-between">
                <span>{analytics.summary.deliveryRatePercent}% delivery rate</span>
                <span className="text-[10px] text-ink-subtle">Minus bounces</span>
              </div>
            </div>

            {/* 6. Bounces */}
            <div className="rounded-2xl border border-line bg-surface p-5 space-y-2 relative overflow-hidden">
              <div className="flex items-center justify-between text-xs font-semibold text-ink-subtle uppercase tracking-wider">
                <span>Bounces</span>
                <AlertTriangle className="w-4 h-4 text-warning" />
              </div>
              <div className="text-3xl font-extrabold text-ink tabular-nums">
                {analytics.summary.bouncesCount.toLocaleString()}
              </div>
              <div className="text-[11px] text-ink-muted flex items-center justify-between">
                <span>{analytics.summary.bounceRatePercent}% bounce rate</span>
                <span className="text-[10px] text-ink-subtle">Suppressed</span>
              </div>
            </div>

            {/* 7. Unsubscribes / Suppressed */}
            <div className="rounded-2xl border border-line bg-surface p-5 space-y-2 relative overflow-hidden">
              <div className="flex items-center justify-between text-xs font-semibold text-ink-subtle uppercase tracking-wider">
                <span>Unsubscribes</span>
                <Slash className="w-4 h-4 text-danger" />
              </div>
              <div className="text-3xl font-extrabold text-ink tabular-nums">
                {analytics.summary.unsubscribesCount.toLocaleString()}
              </div>
              <div className="text-[11px] text-ink-muted">
                Opt-outs & suppression blocks
              </div>
            </div>

            {/* 8. Pending Follow-ups */}
            <div className="rounded-2xl border border-line bg-surface p-5 space-y-2 relative overflow-hidden">
              <div className="flex items-center justify-between text-xs font-semibold text-ink-subtle uppercase tracking-wider">
                <span>Pending Follow-ups</span>
                <Clock className="w-4 h-4 text-accent" />
              </div>
              <div className="text-3xl font-extrabold text-ink tabular-nums">
                {analytics.summary.pendingFollowUps.toLocaleString()}
              </div>
              <div className="text-[11px] text-ink-muted">
                Scheduled sequence steps due
              </div>
            </div>
          </div>

          {/* Primary Visualizations: Activity Over Time & Delivery Breakdown */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Chart 1: Email Activity Over Time */}
            <div className="rounded-2xl border border-line bg-surface p-5 space-y-4 lg:col-span-2 shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h3 className="text-xs font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-2">
                    <BarChart2 className="w-4 h-4 text-accent" />
                    Email Activity Over Time
                  </h3>
                  <p className="text-[11px] text-ink-muted mt-0.5">
                    Daily trajectory of sent messages, replies, bounces, and transmission failures.
                  </p>
                </div>

                {/* Area vs Bar Toggle */}
                <div className="flex items-center gap-1 p-0.5 bg-surface-2 rounded-lg border border-line text-[11px] self-start">
                  <button
                    onClick={() => setActivityChartType('area')}
                    className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                      activityChartType === 'area'
                        ? 'bg-surface text-ink font-semibold shadow-xs'
                        : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    Smooth Area
                  </button>
                  <button
                    onClick={() => setActivityChartType('bar')}
                    className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                      activityChartType === 'bar'
                        ? 'bg-surface text-ink font-semibold shadow-xs'
                        : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    Grouped Bar
                  </button>
                </div>
              </div>

              <div className="h-72 w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  {activityChartType === 'area' ? (
                    <AreaChart data={analytics.activityTimeSeries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorSent" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#6366f1" stopOpacity={0.0} />
                        </linearGradient>
                        <linearGradient id="colorReplies" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(150, 150, 150, 0.15)" vertical={false} />
                      <XAxis dataKey="displayDate" tick={{ fontSize: 11, fill: '#828894' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: '#828894' }} axisLine={false} tickLine={false} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#15171c',
                          borderColor: '#2b2f38',
                          borderRadius: '12px',
                          color: '#f3f4f6',
                          fontSize: '12px',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                      <Area type="monotone" dataKey="sent" name="Emails Sent" stroke="#6366f1" strokeWidth={2} fillOpacity={1} fill="url(#colorSent)" />
                      <Area type="monotone" dataKey="replies" name="Replies Received" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorReplies)" />
                      <Area type="monotone" dataKey="bounces" name="Bounces" stroke="#f59e0b" strokeWidth={1.5} fill="transparent" />
                      <Area type="monotone" dataKey="failures" name="Failures" stroke="#ef4444" strokeWidth={1.5} fill="transparent" />
                    </AreaChart>
                  ) : (
                    <BarChart data={analytics.activityTimeSeries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(150, 150, 150, 0.15)" vertical={false} />
                      <XAxis dataKey="displayDate" tick={{ fontSize: 11, fill: '#828894' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: '#828894' }} axisLine={false} tickLine={false} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#15171c',
                          borderColor: '#2b2f38',
                          borderRadius: '12px',
                          color: '#f3f4f6',
                          fontSize: '12px',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                      <Bar dataKey="sent" name="Emails Sent" fill="#6366f1" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="replies" name="Replies Received" fill="#10b981" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="bounces" name="Bounces" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="failures" name="Failures" fill="#ef4444" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  )}
                </ResponsiveContainer>
              </div>
            </div>

            {/* Chart 2: Delivery & Failure Breakdown Donut */}
            <div className="rounded-2xl border border-line bg-surface p-5 space-y-4 shadow-sm flex flex-col justify-between">
              <div>
                <h3 className="text-xs font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-2">
                  <PieIcon className="w-4 h-4 text-accent" />
                  Delivery & Failure Breakdown
                </h3>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  Proportion of delivered vs bounced, failed, and unsubscribed recipients.
                </p>
              </div>

              <div className="h-56 w-full relative">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={[
                        { name: 'Delivered (Est.)', value: analytics.deliveryBreakdown.deliveredEstimated || 1 },
                        { name: 'Bounced', value: analytics.deliveryBreakdown.bounced },
                        { name: 'Failed Sends', value: analytics.deliveryBreakdown.failed },
                        { name: 'Unsubscribed', value: analytics.deliveryBreakdown.unsubscribed },
                      ]}
                      innerRadius={55}
                      outerRadius={80}
                      paddingAngle={4}
                      dataKey="value"
                    >
                      <Cell fill="#10b981" />
                      <Cell fill="#f59e0b" />
                      <Cell fill="#ef4444" />
                      <Cell fill="#64748b" />
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#15171c',
                        borderColor: '#2b2f38',
                        borderRadius: '12px',
                        color: '#f3f4f6',
                        fontSize: '12px',
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>

                {/* Center Badge */}
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-2xl font-extrabold text-ink tabular-nums">
                    {analytics.summary.deliveryRatePercent}%
                  </span>
                  <span className="text-[10px] text-ink-muted font-medium">Delivered</span>
                </div>
              </div>

              {/* Legend Summary */}
              <div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-line/60">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#10b981]" />
                  <span className="text-ink-muted text-[11px]">Delivered:</span>
                  <span className="font-bold text-ink">{analytics.deliveryBreakdown.deliveredEstimated}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#f59e0b]" />
                  <span className="text-ink-muted text-[11px]">Bounced:</span>
                  <span className="font-bold text-ink">{analytics.deliveryBreakdown.bounced}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#ef4444]" />
                  <span className="text-ink-muted text-[11px]">Failed:</span>
                  <span className="font-bold text-ink">{analytics.deliveryBreakdown.failed}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#64748b]" />
                  <span className="text-ink-muted text-[11px]">Opt-outs:</span>
                  <span className="font-bold text-ink">{analytics.deliveryBreakdown.unsubscribed}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Secondary Visualizations: Outreach Funnel & Follow-up Sequence Performance */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Outreach Conversion Funnel */}
            <div className="rounded-2xl border border-line bg-surface p-5 space-y-4 shadow-sm">
              <div>
                <h3 className="text-xs font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-accent" />
                  Outreach Conversion Funnel
                </h3>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  End-to-end conversion progression from imported target prospects to qualified replies.
                </p>
              </div>

              <div className="space-y-3.5 pt-2">
                {analytics.outreachFunnel.map((stage, idx) => (
                  <div key={stage.stage} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-surface-2 border border-line flex items-center justify-center text-[10px] font-bold text-ink">
                          {idx + 1}
                        </span>
                        <span className="font-semibold text-ink">{stage.stage}</span>
                      </div>
                      <div className="flex items-center gap-2 tabular-nums">
                        <span className="font-bold text-ink">{stage.count.toLocaleString()}</span>
                        <span className="text-[11px] text-ink-subtle">({stage.percent}%)</span>
                      </div>
                    </div>
                    {/* Visual Progress Bar */}
                    <div className="h-2.5 w-full bg-surface-2 rounded-full overflow-hidden border border-line/60">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.max(2, Math.min(100, stage.percent))}%`,
                          backgroundColor:
                            idx === 0
                              ? '#6366f1'
                              : idx === 1
                              ? '#818cf8'
                              : idx === 2
                              ? '#3b82f6'
                              : idx === 3
                              ? '#10b981'
                              : '#059669',
                        }}
                      />
                    </div>
                    <p className="text-[10px] text-ink-subtle pl-7">{stage.description}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Follow-up Sequence Performance */}
            <div className="rounded-2xl border border-line bg-surface p-5 space-y-4 shadow-sm flex flex-col justify-between">
              <div>
                <h3 className="text-xs font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-2">
                  <Layers className="w-4 h-4 text-accent" />
                  Follow-Up Sequence Performance (Steps 1–3)
                </h3>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  Comparative performance and response rates by campaign sequence step.
                </p>
              </div>

              <div className="h-56 w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics.stepPerformance} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(150, 150, 150, 0.15)" vertical={false} />
                    <XAxis dataKey="stepName" tick={{ fontSize: 10, fill: '#828894' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: '#828894' }} axisLine={false} tickLine={false} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#15171c',
                        borderColor: '#2b2f38',
                        borderRadius: '12px',
                        color: '#f3f4f6',
                        fontSize: '12px',
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                    <Bar dataKey="sent" name="Sent" fill="#6366f1" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="replied" name="Replies" fill="#10b981" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="pending" name="Pending Next" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Step Key Highlights */}
              <div className="grid grid-cols-3 gap-2 text-center pt-2 border-t border-line/60">
                {analytics.stepPerformance.map((step) => (
                  <div key={step.stepIndex} className="p-2 rounded-xl bg-surface-2 border border-line">
                    <span className="text-[10px] text-ink-subtle block font-semibold">
                      Step {step.stepIndex + 1}
                    </span>
                    <span className="text-base font-extrabold text-ink tabular-nums block mt-0.5">
                      {step.replyRatePercent}%
                    </span>
                    <span className="text-[10px] text-success block">Reply Rate</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Top Performing Campaigns Table & Drill-Down */}
          <div className="rounded-2xl border border-line bg-surface overflow-hidden shadow-sm">
            <div className="px-5 py-4 border-b border-line flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h3 className="text-xs font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-accent" />
                  Top-Performing Campaign Rankings
                </h3>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  Ranked by verified prospect response rate and send volume. Click any campaign to view full recipient history.
                </p>
              </div>
              <span className="text-xs text-ink-subtle self-start sm:self-auto font-medium">
                {analytics.topCampaigns.length} Campaign{analytics.topCampaigns.length === 1 ? '' : 's'} Evaluated
              </span>
            </div>

            {analytics.topCampaigns.length === 0 ? (
              <div className="p-8 text-center text-xs text-ink-subtle">
                No campaigns match the selected filters.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface-2 border-b border-line text-ink-subtle font-semibold uppercase tracking-wider text-[10px]">
                    <tr>
                      <th className="px-5 py-3">Campaign Name</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3 text-right">Recipients</th>
                      <th className="px-5 py-3 text-right">Sent</th>
                      <th className="px-5 py-3 text-right">Replies</th>
                      <th className="px-5 py-3 text-right">Failed</th>
                      <th className="px-5 py-3">Response Rate</th>
                      <th className="px-5 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60 text-ink">
                    {analytics.topCampaigns.map((cmp) => (
                      <tr key={cmp._id} className="hover:bg-surface-2/60 transition-colors">
                        <td className="px-5 py-3.5 font-semibold text-ink">
                          <Link
                            to={`/campaigns/${cmp._id}`}
                            className="hover:text-accent flex items-center gap-1.5 transition-colors"
                          >
                            <span>{cmp.name}</span>
                            <ExternalLink className="w-3 h-3 text-ink-subtle opacity-0 hover:opacity-100 transition-opacity" />
                          </Link>
                        </td>
                        <td className="px-5 py-3.5">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-bold ${
                              cmp.status === 'sending'
                                ? 'bg-info/10 text-info'
                                : cmp.status === 'completed'
                                ? 'bg-success/10 text-success'
                                : cmp.status === 'scheduled'
                                ? 'bg-warning/10 text-warning'
                                : 'bg-surface-3 text-ink-muted'
                            }`}
                          >
                            {cmp.status}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-right tabular-nums">{cmp.totalRecipients.toLocaleString()}</td>
                        <td className="px-5 py-3.5 text-right tabular-nums font-medium">{cmp.sent.toLocaleString()}</td>
                        <td className="px-5 py-3.5 text-right font-bold text-success tabular-nums">
                          {cmp.replied.toLocaleString()}
                        </td>
                        <td className="px-5 py-3.5 text-right text-ink-subtle tabular-nums">{cmp.failed}</td>
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-2 bg-surface-2 rounded-full overflow-hidden border border-line">
                              <div
                                className="h-full bg-accent rounded-full"
                                style={{ width: `${Math.min(100, cmp.replyRatePercent * 3)}%` }}
                              />
                            </div>
                            <span className="font-bold text-ink tabular-nums text-xs">
                              {cmp.replyRatePercent}%
                            </span>
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <Link
                            to={`/campaigns/${cmp._id}`}
                            className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:text-accent-strong transition-colors"
                          >
                            View
                            <ArrowRight className="w-3 h-3" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Metric Definitions & Data Transparency Section */}
          <div className="rounded-2xl border border-line bg-surface p-5 space-y-3 shadow-sm">
            <button
              onClick={() => setShowDefinitions(!showDefinitions)}
              className="w-full flex items-center justify-between text-left"
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-ink-subtle uppercase tracking-wider">
                <ShieldCheck className="w-4 h-4 text-accent" />
                <span>Metric Definitions & Data Transparency Standards</span>
              </div>
              <ChevronDown
                className={`w-4 h-4 text-ink-subtle transition-transform duration-200 ${
                  showDefinitions ? 'rotate-180' : ''
                }`}
              />
            </button>

            {showDefinitions && (
              <div className="pt-2 text-xs text-ink-muted grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 border-t border-line/60">
                <div className="space-y-1">
                  <span className="font-bold text-ink block">Emails Sent</span>
                  <p className="text-[11px] leading-relaxed">
                    Count of successful provider transmissions confirmed via Gmail API or outbound SMTP. Excludes drafts and rejected dispatches.
                  </p>
                </div>
                <div className="space-y-1">
                  <span className="font-bold text-ink block">Emails Delivered (Estimated)</span>
                  <p className="text-[11px] leading-relaxed">
                    Provider-accepted dispatches minus confirmed bounce and rejection notices. Destination MX inbox placement is governed by recipient policies.
                  </p>
                </div>
                <div className="space-y-1">
                  <span className="font-bold text-ink block">Inbound Replies & Reply Rate</span>
                  <p className="text-[11px] leading-relaxed">
                    Verified incoming email responses linked to recipient conversation threads. Reply rate is calculated as (Total Replies / Total Emails Sent) × 100%.
                  </p>
                </div>
                <div className="space-y-1">
                  <span className="font-bold text-ink block">Bounces & Suppressions</span>
                  <p className="text-[11px] leading-relaxed">
                    Hard bounces and delivery failure notices captured in suppression tables, automatically removing invalid addresses from future outreach.
                  </p>
                </div>
                <div className="space-y-1">
                  <span className="font-bold text-ink block">Failed Sends</span>
                  <p className="text-[11px] leading-relaxed">
                    Count of outbound dispatch attempts that failed pre-flight verification or returned transient SMTP errors. Deduplicated across retries.
                  </p>
                </div>
                <div className="space-y-1">
                  <span className="font-bold text-ink block">Pending Follow-Ups</span>
                  <p className="text-[11px] leading-relaxed">
                    Unexecuted sequence follow-ups and active follow-up tasks currently awaiting scheduled send time or manual approval.
                  </p>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default AnalyticsPage;
