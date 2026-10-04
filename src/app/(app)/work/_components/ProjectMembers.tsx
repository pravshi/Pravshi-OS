'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ProjectMember } from '@/lib/work/schema';
import type { PersonOption } from '../_types';

/**
 * ProjectMembers — the members section for a project detail page (Phase 4).
 * Apple-minimal: quiet rows with name + email + role, a restrained add row.
 *
 * Talks to the existing API directly:
 *   GET/POST  /api/work/projects/[id]/members
 *   DELETE    /api/work/projects/[id]/members/[personId]
 * Add/remove controls only render when canManage (projects.manage_members);
 * the server re-checks the permission on every write.
 *
 * The person picker is a plain select over candidatePeople — the server page
 * passes the people visible on this project's tasks (denormalized assignees).
 * Candidates already on the project are filtered out of the select.
 */
export function ProjectMembers({
  projectId,
  candidatePeople,
  canManage,
}: {
  projectId: string;
  candidatePeople: PersonOption[];
  canManage: boolean;
}) {
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPersonId, setSelectedPersonId] = useState('');
  const [role, setRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/work/projects/${projectId}/members`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('Could not load members');
      setMembers((await res.json()) as ProjectMember[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load members');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const memberIds = new Set(members.map((m) => m.personId));
  const options = candidatePeople.filter((p) => !memberIds.has(p.id));

  async function addMember() {
    if (!selectedPersonId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/work/projects/${projectId}/members`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personId: selectedPersonId,
          ...(role.trim() ? { roleInProject: role.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(body.message ?? 'Could not add member');
      setMembers(body as unknown as ProjectMember[]);
      setSelectedPersonId('');
      setRole('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add member');
    } finally {
      setSaving(false);
    }
  }

  async function removeMember(personId: string) {
    if (removingId) return;
    setRemovingId(personId);
    setError(null);
    try {
      const res = await fetch(`/api/work/projects/${projectId}/members/${personId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(body.message ?? 'Could not remove member');
      setMembers((prev) => prev.filter((m) => m.personId !== personId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove member');
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {loading ? (
          <div className="space-y-2" aria-label="Loading members">
            <div className="h-4 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
          </div>
        ) : members.length === 0 ? (
          <p className="text-sm text-ink-muted">No members yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {members.map((m) => (
              <li key={m.personId} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{m.name ?? '—'}</p>
                  <p className="truncate text-xs text-ink-muted">
                    {[m.roleInProject, m.workEmail].filter(Boolean).join(' · ') || ' '}
                  </p>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-ink-muted hover:text-destructive"
                    onClick={() => removeMember(m.personId)}
                    disabled={removingId === m.personId}
                    aria-label={`Remove ${m.name ?? 'member'} from project`}
                  >
                    {removingId === m.personId ? 'Removing…' : 'Remove'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
            <div className="min-w-44 flex-1">
              <label htmlFor="add-member-person" className="sr-only">
                Person to add
              </label>
              <select
                id="add-member-person"
                value={selectedPersonId}
                onChange={(e) => setSelectedPersonId(e.target.value)}
                disabled={saving}
                className="h-9 w-full rounded-xl border border-input bg-background px-3 text-sm"
              >
                <option value="">Select a person…</option>
                {options.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-32 flex-1">
              <label htmlFor="add-member-role" className="sr-only">
                Role in project (optional)
              </label>
              <Input
                id="add-member-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="Role (optional)"
                maxLength={80}
                disabled={saving}
                className="h-9"
              />
            </div>
            <Button size="sm" onClick={addMember} disabled={!selectedPersonId || saving}>
              {saving ? 'Adding…' : 'Add member'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
