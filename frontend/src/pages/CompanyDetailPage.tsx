import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Building2,
  Globe,
  MapPin,
  Mail,
  Phone,
  User,
  AlertTriangle,
  RefreshCw,
  Star,
} from 'lucide-react';
import { api } from '../lib/api';
import type { Company } from '../types';

interface CompanyDetail extends Company {
  contacts?: {
    _id: string;
    fullName?: string;
    firstName?: string;
    lastName?: string;
    email: string;
    phone?: string;
    role?: string;
    isPrimary?: boolean;
    isSuppressed?: boolean;
  }[];
  assessments?: {
    _id: string;
    assessmentDate?: string;
    overallRating?: string;
    notes?: string;
  }[];
}

export function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: company, isLoading, isError, error, refetch, isFetching } = useQuery<CompanyDetail>({
    queryKey: ['company', id],
    queryFn: () => api.get<CompanyDetail>(`/companies/${id}`),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center text-sm text-ink-muted">
        <RefreshCw className="w-4 h-4 animate-spin mr-2" />
        Loading company...
      </div>
    );
  }

  if (isError || !company) {
    return (
      <div className="p-8 text-center space-y-3">
        <AlertTriangle className="w-8 h-8 text-danger mx-auto" />
        <p className="text-sm font-semibold text-ink">Couldn't load this company</p>
        <p className="text-xs text-ink-muted">{(error as Error)?.message || 'The company may have been removed.'}</p>
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => refetch()}
            className="ios-btn-primary px-4 py-2 text-xs font-semibold"
          >
            Retry
          </button>
          <Link
            to="/companies"
            className="ios-btn-secondary px-4 py-2 text-xs font-medium"
          >
            Back to companies
          </Link>
        </div>
      </div>
    );
  }

  const address = [company.city, company.country].filter(Boolean).join(', ');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-3 transition-colors"
          aria-label="Go back"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-ink truncate">{company.name}</h1>
          <p className="text-xs text-ink-subtle">{company.industry || 'Company profile'}</p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-3 disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <div className="ios-card p-5 border border-line space-y-3">
            <div className="flex items-center gap-2 text-ink font-semibold text-sm">
              <Building2 className="w-4 h-4 text-accent" />
              Overview
            </div>
            <p className="text-xs text-ink-muted whitespace-pre-wrap leading-relaxed">
              {company.notes || 'No notes captured for this company yet.'}
            </p>
            {company.services && company.services.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {company.services.map((s) => (
                  <span key={s} className="ios-pill">
                    {s}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="ios-card p-5 border border-line space-y-3">
            <div className="flex items-center gap-2 text-ink font-semibold text-sm">
              <User className="w-4 h-4 text-accent" />
              Contacts
              <span className="text-ink-subtle font-normal">({company.contacts?.length || 0})</span>
            </div>
            {!company.contacts || company.contacts.length === 0 ? (
              <p className="text-xs text-ink-subtle">No contacts linked to this company.</p>
            ) : (
              <div className="divide-y divide-line">
                {company.contacts.map((c) => (
                  <div key={c._id} className="py-2.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-ink truncate">
                        {c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email}
                        {c.isPrimary && (
                          <span className="ml-2 badge badge-info">
                            Primary
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-ink-subtle truncate">
                        {c.role || 'Contact'}
                        {c.isSuppressed ? ' · suppressed' : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-ink-muted shrink-0">
                      <a href={`mailto:${c.email}`} className="flex items-center gap-1 hover:text-accent">
                        <Mail className="w-3 h-3" />
                        <span className="hidden sm:inline">{c.email}</span>
                      </a>
                      {c.phone && (
                        <span className="flex items-center gap-1">
                          <Phone className="w-3 h-3" />
                          {c.phone}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="ios-card p-5 border border-line space-y-3">
            <div className="flex items-center gap-2 text-ink font-semibold text-sm">
              <Star className="w-4 h-4 text-accent" />
              Assessments
              <span className="text-ink-subtle font-normal">({company.assessments?.length || 0})</span>
            </div>
            {!company.assessments || company.assessments.length === 0 ? (
              <p className="text-xs text-ink-subtle">No assessments recorded.</p>
            ) : (
              <div className="divide-y divide-line">
                {company.assessments.map((a) => (
                  <div key={a._id} className="py-2.5 flex items-center justify-between gap-3">
                    <span className="text-xs text-ink-muted">
                      {a.assessmentDate ? new Date(a.assessmentDate).toLocaleDateString() : 'Assessment'}
                    </span>
                    <span className="text-xs font-semibold text-ink tabular-nums">{a.overallRating || '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="ios-card p-5 border border-line space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-ink-subtle">Rating</span>
              <span className="font-bold text-ink tabular-nums">{company.overallRating || 'unrated'}</span>
            </div>
            {company.domain && (
              <div className="flex items-center gap-2 text-ink-muted">
                <Globe className="w-3.5 h-3.5 text-ink-subtle" />
                <span className="truncate">{company.domain}</span>
              </div>
            )}
            {company.websiteUrl && (
              <a
                href={company.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-accent hover:underline"
              >
                <Globe className="w-3.5 h-3.5" />
                <span className="truncate">{company.websiteUrl}</span>
              </a>
            )}
            {address && (
              <div className="flex items-center gap-2 text-ink-muted">
                <MapPin className="w-3.5 h-3.5 text-ink-subtle" />
                <span>{address}</span>
              </div>
            )}
            <Link
              to="/email"
              className="mt-1 block text-center px-3 py-2 rounded-xl border border-line hover:border-accent hover:text-accent text-ink-muted font-medium transition-colors"
            >
              Open email workspace
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
