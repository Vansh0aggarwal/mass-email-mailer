import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Company } from '../types';
import { Building2, Plus, Search, Globe } from 'lucide-react';
import { Link } from 'react-router-dom';

export function CompaniesPage() {
  const [search, setSearch] = useState('');
  const [industryFilter, setIndustryFilter] = useState('');

  const { data: companies = [], isLoading } = useQuery<Company[]>({
    queryKey: ['companies', search, industryFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.append('q', search);
      if (industryFilter) params.append('industry', industryFilter);
      return api.get<Company[]>(`/companies?${params.toString()}`);
    },
  });

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center text-accent-fg">
              <Building2 className="w-4 h-4" />
            </span>
            <span>Company Directory</span>
          </h1>
          <p className="text-xs text-ink-muted mt-1">
            Manage target accounts, website health ratings, industry tags, and opportunity leads.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Link
            to="/csv-imports"
            className="ios-btn-secondary px-3.5 py-2 text-xs"
          >
            Import CSV
          </Link>
          <button
            type="button"
            onClick={() => alert('Use CSV Import or the Add Company modal')}
            className="ios-btn-primary px-4 py-2 text-xs flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> Add Company
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-col sm:flex-row items-center gap-3 ios-card p-3">
        <div className="relative flex-1 w-full">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <input
            type="text"
            placeholder="Search by company name, domain, city..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-9 pr-3 py-2 text-xs"
          />
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <select
            value={industryFilter}
            onChange={(e) => setIndustryFilter(e.target.value)}
            className="input px-3 py-2 text-xs cursor-pointer"
          >
            <option value="" className="bg-surface text-ink">All Industries</option>
            <option value="Technology" className="bg-surface text-ink">Technology</option>
            <option value="Healthcare" className="bg-surface text-ink">Healthcare</option>
            <option value="E-Commerce" className="bg-surface text-ink">E-Commerce</option>
            <option value="Professional Services" className="bg-surface text-ink">Professional Services</option>
          </select>
        </div>
      </div>

      {/* Companies Table / List */}
      <div className="ios-card rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-5 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton h-9 w-full" />
            ))}
          </div>
        ) : companies.length === 0 ? (
          <div className="empty-state p-12 space-y-3">
            <Building2 className="w-10 h-10 text-ink-subtle mx-auto" />
            <h3 className="text-sm font-semibold text-ink">No Companies Found</h3>
            <p className="text-xs text-ink-muted max-w-sm mx-auto">
              Get started by uploading a CSV spreadsheet with your prospect list or adding a company manually.
            </p>
            <Link
              to="/csv-imports"
              className="inline-flex ios-btn-primary px-4 py-2 text-xs font-semibold"
            >
              Start CSV Import
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="bg-surface-2 border-b border-line text-ink-subtle font-semibold uppercase tracking-wider text-[10px]">
              <tr>
                <th className="px-5 py-3.5">Company Name</th>
                <th className="px-5 py-3.5">Domain / Website</th>
                <th className="px-5 py-3.5">Industry</th>
                <th className="px-5 py-3.5">Rating</th>
                <th className="px-5 py-3.5">Location</th>
                <th className="px-5 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line text-ink">
              {companies.map((c) => (
                <tr key={c._id} className="hover:bg-surface-3 transition-colors">
                  <td className="px-5 py-3.5 font-medium text-ink">
                    <Link to={`/companies/${c._id}`} className="hover:text-accent transition-colors">
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-5 py-3.5 text-ink-muted">
                    {c.websiteUrl ? (
                      <a
                        href={c.websiteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 hover:text-accent text-ink transition-colors"
                      >
                        <Globe className="w-3.5 h-3.5 text-accent" />
                        {c.domain || c.websiteUrl}
                      </a>
                    ) : (
                      '--'
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-ink-muted">{c.industry || '—'}</td>
                  <td className="px-5 py-3.5">
                    <span
                      className={`badge font-semibold tabular-nums ${
                        c.overallRating === 'A'
                          ? 'badge-success'
                          : c.overallRating === 'B'
                          ? 'badge-info'
                          : c.overallRating === 'C'
                          ? 'badge-warning'
                          : c.overallRating === 'D' || c.overallRating === 'F'
                          ? 'badge-danger'
                          : 'badge-neutral'
                      }`}
                    >
                      {c.overallRating || 'unrated'}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-ink-muted">
                    {[c.city, c.country].filter(Boolean).join(', ') || '--'}
                  </td>
                  <td className="px-5 py-3.5 text-right space-x-2">
                    <Link
                      to={`/opportunities?companyId=${c._id}`}
                      className="text-accent hover:underline text-[11px] font-semibold"
                    >
                      View Needs
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
