import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Users,
  UserPlus,
  Activity,
  Clock,
  Trash2,
  RefreshCw,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';

interface TeamMember {
  _id: string;
  email: string;
  fullName: string;
  avatarUrl?: string;
  status: 'active' | 'invited' | 'disabled';
  role: 'owner' | 'admin' | 'manager' | 'sales_rep' | 'viewer';
  createdAt: string;
  updatedAt: string;
}

interface ActivityLogItem {
  _id: string;
  userId?: string;
  userEmail?: string;
  action: string;
  targetType: string;
  targetName?: string;
  details?: Record<string, any>;
  createdAt: string;
}

export function TeamPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'manager' | 'sales_rep' | 'viewer'>('sales_rep');
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'members' | 'activity'>('members');

  const { data: members = [], isLoading: membersLoading, refetch: refetchMembers } = useQuery<TeamMember[]>({
    queryKey: ['team-members'],
    queryFn: () => api.get<TeamMember[]>('/team/members'),
  });

  const { data: activityResponse, isLoading: activityLoading, refetch: refetchActivity } = useQuery<{
    success: boolean;
    data: ActivityLogItem[];
  }>({
    queryKey: ['team-activity'],
    queryFn: () => api.get<any>('/team/activity?limit=40'),
    enabled: activeTab === 'activity',
  });

  const inviteMutation = useMutation({
    mutationFn: (data: { email: string; fullName: string; role: string }) =>
      api.post('/team/invite', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-members'] });
      queryClient.invalidateQueries({ queryKey: ['team-activity'] });
      setInviteModalOpen(false);
      setInviteEmail('');
      setInviteName('');
      setInviteError(null);
    },
    onError: (err: any) => {
      setInviteError(err?.message || 'Failed to invite team member');
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: string }) =>
      api.patch(`/team/members/${memberId}`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-members'] });
      queryClient.invalidateQueries({ queryKey: ['team-activity'] });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (memberId: string) => api.delete(`/team/members/${memberId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-members'] });
      queryClient.invalidateQueries({ queryKey: ['team-activity'] });
    },
  });

  const handleInviteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim() || !inviteName.trim()) {
      setInviteError('Name and email are required');
      return;
    }
    inviteMutation.mutate({
      email: inviteEmail.trim(),
      fullName: inviteName.trim(),
      role: inviteRole,
    });
  };

  const roleBadges: Record<string, string> = {
    owner: 'bg-accent/15 text-accent border-accent/30',
    admin: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30',
    manager: 'bg-info/15 text-info border-info/30',
    sales_rep: 'bg-success/15 text-success border-success/30',
    viewer: 'bg-surface-3 text-ink-muted border-line',
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink tracking-tight flex items-center gap-2">
            <Users className="w-6 h-6 text-accent" />
            Team Collaboration & Access Control
          </h1>
          <p className="text-sm text-ink-muted mt-1">
            Manage organization members, assign role-based permissions, and audit workspace activity.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              refetchMembers();
              refetchActivity();
            }}
            className="p-2 rounded-xl bg-surface-2 hover:bg-surface-3 border border-line text-ink transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setInviteModalOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-accent hover:bg-accent-strong text-accent-fg text-xs font-semibold transition-colors"
          >
            <UserPlus className="w-4 h-4" />
            Invite Member
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-line pb-px text-xs font-semibold">
        <button
          onClick={() => setActiveTab('members')}
          className={`px-4 py-2 border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === 'members'
              ? 'border-accent text-accent'
              : 'border-transparent text-ink-muted hover:text-ink'
          }`}
        >
          <Users className="w-4 h-4" />
          Team Members ({members.length})
        </button>
        <button
          onClick={() => setActiveTab('activity')}
          className={`px-4 py-2 border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === 'activity'
              ? 'border-accent text-accent'
              : 'border-transparent text-ink-muted hover:text-ink'
          }`}
        >
          <Activity className="w-4 h-4" />
          Audit & Activity History
        </button>
      </div>

      {/* Members Tab */}
      {activeTab === 'members' && (
        <div className="rounded-2xl border border-line bg-surface overflow-hidden">
          {membersLoading ? (
            <div className="p-12 text-center text-xs text-ink-muted">Loading team members...</div>
          ) : members.length === 0 ? (
            <div className="p-12 text-center text-xs text-ink-subtle">No team members found.</div>
          ) : (
            <div className="divide-y divide-line/60">
              {members.map((m) => (
                <div key={m._id} className="p-4 sm:px-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div className="w-10 h-10 rounded-full bg-accent/15 text-accent font-bold flex items-center justify-center shrink-0 uppercase text-sm border border-accent/20">
                      {m.fullName?.slice(0, 2) || m.email.slice(0, 2)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-ink text-sm truncate">{m.fullName}</span>
                        {m.email === user?.email && (
                          <span className="px-1.5 py-0.2 rounded bg-surface-3 text-[10px] text-ink-subtle">
                            You
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink-muted truncate">{m.email}</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 self-end sm:self-center">
                    <span className="px-2 py-0.5 rounded-full bg-surface-2 text-[11px] text-ink-muted capitalize">
                      {m.status}
                    </span>

                    <select
                      value={m.role}
                      disabled={m.role === 'owner'}
                      onChange={(e) => updateRoleMutation.mutate({ memberId: m._id, role: e.target.value })}
                      className={`px-2.5 py-1 rounded-xl text-xs font-semibold border outline-none capitalize ${
                        roleBadges[m.role] || roleBadges.viewer
                      } ${m.role === 'owner' ? 'cursor-not-allowed opacity-90' : 'cursor-pointer hover:opacity-80'}`}
                    >
                      <option value="owner" disabled>
                        Owner
                      </option>
                      <option value="admin">Admin</option>
                      <option value="manager">Manager</option>
                      <option value="sales_rep">Sales Rep</option>
                      <option value="viewer">Viewer</option>
                    </select>

                    {m.role !== 'owner' && m.email !== user?.email && (
                      <button
                        onClick={() => {
                          if (confirm(`Remove ${m.fullName || m.email} from organization?`)) {
                            removeMemberMutation.mutate(m._id);
                          }
                        }}
                        className="p-1.5 rounded-lg text-ink-subtle hover:text-danger hover:bg-danger/10 transition-colors"
                        title="Remove member"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Activity Log Tab */}
      {activeTab === 'activity' && (
        <div className="rounded-2xl border border-line bg-surface overflow-hidden">
          <div className="px-5 py-4 border-b border-line flex items-center justify-between">
            <h3 className="text-xs font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-accent" />
              Recent Organization Events & Actions
            </h3>
            <span className="text-[11px] text-ink-subtle">Audit trail</span>
          </div>

          {activityLoading ? (
            <div className="p-12 text-center text-xs text-ink-muted">Loading audit records...</div>
          ) : !activityResponse?.data || activityResponse.data.length === 0 ? (
            <div className="p-12 text-center text-xs text-ink-subtle">No activity records logged yet.</div>
          ) : (
            <div className="divide-y divide-line/60">
              {activityResponse.data.map((act) => (
                <div key={act._id} className="px-5 py-3.5 flex items-start justify-between gap-4 text-xs">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">
                        {act.action.replace('.', ' → ').toUpperCase()}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-surface-3 text-[10px] text-ink-muted uppercase">
                        {act.targetType}
                      </span>
                    </div>
                    {act.targetName && (
                      <div className="text-ink-muted">
                        Target: <span className="font-medium text-ink">{act.targetName}</span>
                      </div>
                    )}
                    {act.userEmail && (
                      <div className="text-[11px] text-ink-subtle">Initiated by {act.userEmail}</div>
                    )}
                  </div>

                  <span className="text-[11px] text-ink-subtle shrink-0">
                    {new Date(act.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Invite Modal */}
      {inviteModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setInviteModalOpen(false)} />
          <div className="relative w-full max-w-md bg-surface border border-line rounded-2xl shadow-2xl p-5 z-10 space-y-4">
            <h3 className="text-base font-semibold text-ink">Invite New Team Member</h3>
            <p className="text-xs text-ink-muted">
              Add a colleague to your organization workspace with scoped permissions.
            </p>

            {inviteError && <div className="p-2.5 rounded-xl bg-danger/10 text-danger text-xs">{inviteError}</div>}

            <form onSubmit={handleInviteSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-ink-muted mb-1">Full Name</label>
                <input
                  type="text"
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  placeholder="e.g. Alex Vance"
                  className="w-full px-3 py-2 rounded-xl bg-surface-2 border border-line text-xs text-ink outline-none focus:border-accent"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-muted mb-1">Email Address</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="alex.vance@company.example.com"
                  className="w-full px-3 py-2 rounded-xl bg-surface-2 border border-line text-xs text-ink outline-none focus:border-accent"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-muted mb-1">Workspace Role</label>
                <select
                  value={inviteRole}
                  onChange={(e: any) => setInviteRole(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-surface-2 border border-line text-xs text-ink outline-none focus:border-accent"
                >
                  <option value="admin">Admin (Full campaign, mailbox, & user control)</option>
                  <option value="manager">Manager (Approve drafts, monitor replies)</option>
                  <option value="sales_rep">Sales Rep (Import leads, manage contacts, send outreach)</option>
                  <option value="viewer">Viewer (Read-only access)</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setInviteModalOpen(false)}
                  className="px-3 py-1.5 rounded-xl border border-line text-xs font-medium text-ink-muted hover:text-ink"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={inviteMutation.isPending}
                  className="px-4 py-1.5 rounded-xl bg-accent hover:bg-accent-strong text-accent-fg text-xs font-semibold transition-colors disabled:opacity-50"
                >
                  {inviteMutation.isPending ? 'Inviting...' : 'Send Invitation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
