import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ServiceItem } from '../types';
import { Briefcase } from 'lucide-react';

export function ServicesPage() {
  const { data: services = [], isLoading } = useQuery<ServiceItem[]>({
    queryKey: ['services'],
    queryFn: () => api.get<ServiceItem[]>('/services'),
  });

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center text-accent-fg">
            <Briefcase className="w-4 h-4" />
          </span>
          <span>Offered Services Catalog</span>
        </h1>
        <p className="text-xs text-ink-subtle mt-1">
          Define your agency/business services. The recommendation engine matches company needs and signals against these services.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {isLoading ? (
          [0, 1, 2].map((i) => (
            <div key={i} className="ios-card rounded-xl p-5 space-y-3 bg-surface-2" aria-hidden="true">
              <div className="skeleton h-4 w-1/2" />
              <div className="skeleton h-16 w-full" />
              <div className="skeleton h-3 w-3/4" />
            </div>
          ))
        ) : services.length === 0 ? (
          <div className="col-span-3 empty-state ios-card rounded-xl p-10 space-y-3 bg-surface-2">
            <Briefcase className="w-10 h-10 text-ink-subtle" />
            <h3 className="text-sm font-semibold text-ink">No services yet</h3>
            <p className="text-xs text-ink-subtle max-w-md">
              Add the services you offer and they will appear here.
            </p>
          </div>
        ) : (
          services.map((svc) => (
            <div key={svc._id} className="ios-card rounded-xl p-5 space-y-3 bg-surface-2 transition-colors">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ink tracking-tight">{svc.name}</h3>
                <span className={`badge ${svc.isActive ? 'badge-success' : 'badge-neutral'}`}>
                  {svc.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
              <p className="text-xs text-ink-muted leading-relaxed">{svc.description}</p>
              <div className="pt-2.5 divider text-[11px] text-accent">
                <strong className="text-ink-muted">Value Proposition:</strong> {svc.valueProposition}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
