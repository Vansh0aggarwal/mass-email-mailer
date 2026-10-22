import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Contact } from '../types';
import { Users, Search, Mail, ShieldAlert } from 'lucide-react';

export function ContactsPage() {
  const [search, setSearch] = useState('');

  const { data: contacts = [], isLoading } = useQuery<Contact[]>({
    queryKey: ['contacts', search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.append('q', search);
      return api.get<Contact[]>(`/contacts?${params.toString()}`);
    },
  });

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center text-accent-fg">
            <Users className="w-4 h-4" />
          </span>
          <span>Contact Management</span>
        </h1>
        <p className="text-xs text-ink-muted mt-1">
          Verified prospect contacts, suppression flags, and email outreach targets.
        </p>
      </div>

      <div className="flex items-center gap-3 ios-card p-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <input
            type="text"
            placeholder="Search contacts by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-9 pr-3 py-2"
            aria-label="Search contacts"
          />
        </div>
      </div>

      <div className="ios-card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-xs text-ink-muted">Loading contacts...</div>
        ) : contacts.length === 0 ? (
          <div className="p-12 empty-state space-y-3">
            <Users className="w-10 h-10 text-ink-subtle mx-auto" />
            <h3 className="text-sm font-semibold text-ink">No Contacts Found</h3>
            <p className="text-xs text-ink-muted max-w-sm mx-auto">
              Contacts are created automatically when importing CSV company spreadsheets or added manually.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="bg-surface-2 border-b border-line text-ink-muted font-semibold uppercase tracking-wider text-[10px]">
              <tr>
                <th className="px-5 py-3.5">Name</th>
                <th className="px-5 py-3.5">Email Address</th>
                <th className="px-5 py-3.5">Role</th>
                <th className="px-5 py-3.5">Status</th>
                <th className="px-5 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line text-ink">
              {contacts.map((c) => (
                <tr key={c._id} className="hover:bg-surface-3 transition-colors">
                  <td className="px-5 py-3.5 font-medium text-ink">{c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unnamed'}</td>
                  <td className="px-5 py-3.5 text-accent">{c.email}</td>
                  <td className="px-5 py-3.5 text-ink-muted">{c.role || 'Executive'}</td>
                  <td className="px-5 py-3.5">
                    {c.isSuppressed ? (
                      <span className="badge badge-danger inline-flex items-center gap-1">
                        <ShieldAlert className="w-3 h-3" /> Suppressed
                      </span>
                    ) : (
                      <span className="badge badge-success">Eligible</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <button
                      type="button"
                      onClick={() => alert(`Compose outreach to ${c.email}`)}
                      className="text-xs text-accent hover:underline font-semibold inline-flex items-center gap-1.5"
                      aria-label={`Compose outreach to ${c.email}`}
                    >
                      <Mail className="w-3.5 h-3.5" /> Write Email
                    </button>
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
