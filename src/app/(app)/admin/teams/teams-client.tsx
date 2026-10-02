'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  createTeamAction,
  updateTeamAction,
  archiveTeamAction,
  setTeamMembersAction,
} from './actions';

type TeamMember = { personId: string; name: string; workEmail: string | null };
type Team = {
  id: string;
  name: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  leadPersonId: string | null;
  leadName: string | null;
  memberCount: number;
  members: TeamMember[];
};
type Department = { id: string; code: string; name: string; status: string };
type Person = { id: string; name: string; workEmail: string | null };

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-popover p-6">
        <h3 className="text-lg font-medium">{title}</h3>
        <div className="mt-4">{children}</div>
        <div className="mt-4 flex justify-end">
          <Button variant="outline" type="button" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

export function TeamsClient({
  teams,
  departments,
  people,
}: {
  teams: Team[];
  departments: Department[];
  people: Person[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // create / edit form state
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Team | null>(null);
  const [name, setName] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [leadPersonId, setLeadPersonId] = useState('');

  // members dialog state
  const [managing, setManaging] = useState<Team | null>(null);
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());

  const activeDepartments = departments.filter((d) => d.status === 'ACTIVE');

  function openCreate() {
    setEditing(null);
    setName('');
    setDepartmentId(activeDepartments[0]?.id ?? '');
    setLeadPersonId('');
    setShowForm(true);
    setError(null);
  }

  function openEdit(team: Team) {
    setEditing(team);
    setName(team.name);
    setDepartmentId(team.departmentId);
    setLeadPersonId(team.leadPersonId ?? '');
    setShowForm(true);
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy('form');
    try {
      const lead = leadPersonId === '' ? null : leadPersonId;
      if (editing) {
        await updateTeamAction(editing.id, { name, leadPersonId: lead });
      } else {
        await createTeamAction({ departmentId, name, leadPersonId: lead });
      }
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the team.');
    } finally {
      setBusy(null);
    }
  }

  async function onArchive(id: string) {
    setBusy(id);
    try {
      await archiveTeamAction(id);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not archive the team.');
      setBusy(null);
    }
  }

  function openMembers(team: Team) {
    setManaging(team);
    setSelectedMembers(new Set(team.members.map((m) => m.personId)));
    setError(null);
  }

  function toggleMember(personId: string) {
    setSelectedMembers((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  }

  async function onSaveMembers() {
    if (!managing) return;
    setError(null);
    setBusy('members');
    try {
      await setTeamMembersAction(managing.id, [...selectedMembers]);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save members.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Button onClick={openCreate}>New team</Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-cream-dark/50 text-left">
              <th className="px-4 py-2 font-medium">Team</th>
              <th className="px-4 py-2 font-medium">Department</th>
              <th className="px-4 py-2 font-medium">Lead</th>
              <th className="px-4 py-2 font-medium">Members</th>
              <th className="px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-medium">{t.name}</td>
                <td className="px-4 py-2">
                  <span className="font-mono text-xs">{t.departmentCode}</span>
                  <span className="ml-2 text-ink-muted">{t.departmentName}</span>
                </td>
                <td className="px-4 py-2">{t.leadName ?? '—'}</td>
                <td className="px-4 py-2">{t.memberCount}</td>
                <td className="px-4 py-2">
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => openEdit(t)}>
                      Edit
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openMembers(t)}>
                      Members
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === t.id}
                      onClick={() => onArchive(t.id)}
                    >
                      Archive
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {teams.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-ink-muted">
                  No teams yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-popover p-6">
            <h3 className="text-lg font-medium">{editing ? 'Edit team' : 'New team'}</h3>
            <form onSubmit={onSubmit} className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="team-name">Name</Label>
                <Input
                  id="team-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Platform"
                  disabled={busy === 'form'}
                />
              </div>
              {!editing && (
                <div className="space-y-2">
                  <Label htmlFor="team-department">Department</Label>
                  <select
                    id="team-department"
                    className="w-full rounded border border-line bg-background px-2 py-2 text-sm"
                    value={departmentId}
                    onChange={(e) => setDepartmentId(e.target.value)}
                    disabled={busy === 'form'}
                    required
                  >
                    {activeDepartments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.code} — {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="team-lead">Lead (optional)</Label>
                <select
                  id="team-lead"
                  className="w-full rounded border border-line bg-background px-2 py-2 text-sm"
                  value={leadPersonId}
                  onChange={(e) => setLeadPersonId(e.target.value)}
                  disabled={busy === 'form'}
                >
                  <option value="">No lead</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.workEmail ? ` — ${p.workEmail}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={busy === 'form'}>
                  {busy === 'form' ? 'Saving…' : editing ? 'Save' : 'Create'}
                </Button>
                <Button variant="outline" type="button" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {managing && (
        <Modal title={`Members — ${managing.name}`} onClose={() => setManaging(null)}>
          <div className="max-h-96 space-y-1 overflow-y-auto">
            {people.map((p) => (
              <label
                key={p.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-cream-dark/50"
              >
                <input
                  type="checkbox"
                  checked={selectedMembers.has(p.id)}
                  onChange={() => toggleMember(p.id)}
                  disabled={busy === 'members'}
                />
                <span className="text-sm">{p.name}</span>
                {p.workEmail && <span className="text-xs text-ink-muted">{p.workEmail}</span>}
              </label>
            ))}
            {people.length === 0 && (
              <p className="text-sm text-ink-muted">No people in this organization.</p>
            )}
          </div>
          {error && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <Button onClick={onSaveMembers} disabled={busy === 'members'}>
              {busy === 'members' ? 'Saving…' : `Save members (${selectedMembers.size})`}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
