import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { OpportunityRecommendation } from '../types';
import { Compass, Sparkles, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';

export function OpportunitiesPage() {
  const { data: opportunities = [], isLoading } = useQuery<OpportunityRecommendation[]>({
    queryKey: ['opportunities'],
    queryFn: () => api.get<OpportunityRecommendation[]>('/opportunities'),
  });

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center text-accent-fg">
            <Compass className="w-4 h-4" />
          </span>
          <span>Business Opportunity Recommendations</span>
        </h1>
        <p className="text-xs text-ink-muted mt-1">
          Algorithmic, evidence-grounded service recommendations. Prioritizes explicit CSV requirements over ratings and avoids fabricating facts.
        </p>
      </div>

      <div className="space-y-4">
        {isLoading ? (
          <div className="p-8 text-center text-xs text-ink/40">Evaluating opportunities...</div>
        ) : opportunities.length === 0 ? (
          <div className="ios-card p-12 empty-state space-y-3">
            <Compass className="w-10 h-10 text-ink-subtle mx-auto" />
            <h3 className="text-sm font-semibold text-ink">No Opportunities Evaluated Yet</h3>
            <p className="text-xs text-ink-muted max-w-md mx-auto">
              Import company records with requirements or website assessments to trigger automatic opportunity scoring and service matching.
            </p>
            <Link
              to="/csv-imports"
              className="inline-flex ios-btn-primary px-4 py-2 text-xs font-semibold"
            >
              Import Leads Now
            </Link>
          </div>
        ) : (
          opportunities.map((opp) => (
            <div
              key={opp.companyId}
              className="ios-card p-5 space-y-4"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-bold text-ink flex items-center gap-2 tracking-tight">
                    {opp.companyName}
                    <span className="text-xs text-ink-muted bg-surface-3 px-2 py-0.5 rounded-full tabular-nums">Score: {opp.score}/100</span>
                  </h3>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="badge badge-info">
                      Confidence: {Math.round(opp.confidence * 100)}%
                    </span>
                    {opp.isQualified && (
                      <span className="badge badge-success">
                        Qualified Outreach Target
                      </span>
                    )}
                  </div>
                </div>

                <Link
                  to={`/ai-studio?companyId=${opp.companyId}`}
                  className="ios-btn-primary px-4 py-2 text-xs font-semibold inline-flex items-center gap-1.5 shrink-0"
                >
                  <Sparkles className="w-3.5 h-3.5" /> Generate AI Draft
                </Link>
              </div>

              {/* Recommended Services & Explanations */}
              <div className="bg-surface-2 rounded-xl p-3.5 space-y-2 border border-line">
                <div className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider">
                  Recommended Services & Supporting Evidence
                </div>
                {opp.recommendedServices.map((svc) => (
                  <div key={svc.serviceId} className="text-xs text-ink flex items-start gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-success mt-0.5 shrink-0" />
                    <div>
                      <strong className="text-ink font-semibold">{svc.serviceName}:</strong> {svc.reason}
                    </div>
                  </div>
                ))}
              </div>

              {/* Warnings / Missing Data */}
              {opp.missingDataWarnings.length > 0 && (
                <div className="text-[11px] text-warning flex items-center gap-2 bg-warning/10 border border-warning/20 p-2.5 rounded-xl">
                  <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
                  <span>{opp.missingDataWarnings.join(' • ')}</span>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
