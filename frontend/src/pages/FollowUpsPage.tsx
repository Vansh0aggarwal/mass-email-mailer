import { Clock } from 'lucide-react';

export function FollowUpsPage() {
  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-lg bg-warning/15 border border-warning/25 text-warning flex items-center justify-center">
            <Clock className="w-4 h-4" />
          </span>
          <span>Follow-ups</span>
        </h1>
        <p className="text-xs text-ink-muted mt-1">
          Track pending touchpoints, due dates, and follow-up reminders.
        </p>
      </div>

      <div className="ios-card empty-state p-10 space-y-4">
        <div className="w-14 h-14 rounded-xl bg-warning/10 border border-warning/30 text-warning flex items-center justify-center mx-auto">
          <Clock className="w-7 h-7" />
        </div>
        <h3 className="text-base font-semibold text-ink tracking-tight">No follow-ups yet</h3>
        <p className="text-xs text-ink-muted max-w-md mx-auto leading-relaxed">
          Follow-up tasks are automatically generated when outreach emails await replies, or you can schedule one from any company profile.
        </p>
      </div>
    </div>
  );
}
