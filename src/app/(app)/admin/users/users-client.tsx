'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  inviteUserAction,
  revokeInvitationAction,
  suspendUserAction,
  unsuspendUserAction,
  setPersonRolesAction,
  getUserSessionsAction,
  revokeUserSessionAction,
  revokeAllUserSessionsAction,
  adminResetCredentialAction,
} from './actions';

interface Role {
  id: string;
  code: string;
  name: string;
  isProtected: boolean;
}

interface User {
  id: string;
  fullName: string | null;
  email: string;
  status: string;
  hasLogin: boolean;
  suspended: boolean;
  roles: string[];
}

interface Invitation {
  id: string;
  email: string;
  expiresAt: Date;
  roles: string[];
}

interface Department {
  id: string;
  code: string;
  name: string;
  status: string;
}

interface AdminSession {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

const ENGAGEMENT_TYPES = [
  'EMPLOYEE',
  'INTERN',
  'TRAINEE',
  'CONTRACTOR',
  'CONSULTANT',
  'PART_TIME',
  'TEMPORARY',
] as const;

/** Client interactivity for /admin/users: dialogs and confirmations. The Server
 *  Component above fetched the data; every mutation re-authorizes server-side. */
export function UsersClient({
  users,
  invitations,
  roles,
  departments,
}: {
  users: User[];
  invitations: Invitation[];
  roles: Role[];
  departments: Department[];
}) {
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRoles, setInviteRoles] = useState<string[]>([]);
  const [inviteEngagementType, setInviteEngagementType] = useState<string>('EMPLOYEE');
  const [inviteDepartmentId, setInviteDepartmentId] = useState('');
  const [inviteStartDate, setInviteStartDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [inviteResult, setInviteResult] = useState<{ inviteUrl: string; email: string } | null>(
    null,
  );
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [invitePending, setInvitePending] = useState(false);

  const [editingRoles, setEditingRoles] = useState<User | null>(null);
  const [editRoleIds, setEditRoleIds] = useState<string[]>([]);
  const [editError, setEditError] = useState<string | null>(null);

  const [confirmSuspend, setConfirmSuspend] = useState<User | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [sessionsUser, setSessionsUser] = useState<User | null>(null);
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);

  const [resetUser, setResetUser] = useState<User | null>(null);
  const [resetResult, setResetResult] = useState<{
    resetUrl: string;
    email: string;
    emailSent: boolean;
  } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  async function refresh() {
    window.location.reload();
  }

  async function onInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError(null);
    setInviteResult(null);
    if (inviteRoles.length === 0) {
      setInviteError('Choose at least one role.');
      return;
    }
    if (!inviteDepartmentId) {
      setInviteError('Choose the department — the invitation creates the engagement there.');
      return;
    }
    setInvitePending(true);
    try {
      const result = await inviteUserAction({
        email: inviteEmail.trim(),
        roleIds: inviteRoles,
        expiresInDays: 7,
        engagementType: inviteEngagementType as (typeof ENGAGEMENT_TYPES)[number],
        departmentId: inviteDepartmentId,
        startDate: inviteStartDate,
      });
      setInviteResult(result);
      setInviteEmail('');
      setInviteRoles([]);
      setInviteDepartmentId('');
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Could not create the invitation.');
    } finally {
      setInvitePending(false);
    }
  }

  async function onRevoke(id: string) {
    setBusy(id);
    try {
      await revokeInvitationAction(id);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function onSuspend(user: User) {
    setBusy(user.id);
    try {
      await suspendUserAction(user.id);
      setConfirmSuspend(null);
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not suspend.');
    } finally {
      setBusy(null);
    }
  }

  async function onUnsuspend(user: User) {
    setBusy(user.id);
    try {
      await unsuspendUserAction(user.id);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  function openRoleEditor(user: User) {
    const ids = roles.filter((r) => user.roles.includes(r.code)).map((r) => r.id);
    setEditRoleIds(ids);
    setEditError(null);
    setEditingRoles(user);
  }

  async function onSaveRoles() {
    if (!editingRoles) return;
    setEditError(null);
    setBusy(editingRoles.id);
    try {
      await setPersonRolesAction(editingRoles.id, editRoleIds);
      setEditingRoles(null);
      await refresh();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Could not update roles.');
    } finally {
      setBusy(null);
    }
  }

  async function loadSessions(user: User) {
    setSessionsError(null);
    try {
      const rows = await getUserSessionsAction(user.id);
      setSessions(rows);
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : 'Could not load sessions.');
      setSessions([]);
    }
  }

  function openSessions(user: User) {
    setSessionsUser(user);
    setSessions(null);
    setConfirmRevokeAll(false);
    void loadSessions(user);
  }

  async function onRevokeSession(sessionId: string) {
    if (!sessionsUser) return;
    setBusy(sessionId);
    try {
      await revokeUserSessionAction(sessionsUser.id, sessionId);
      await loadSessions(sessionsUser);
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : 'Could not revoke session.');
    } finally {
      setBusy(null);
    }
  }

  async function onRevokeAllSessions() {
    if (!sessionsUser) return;
    setBusy(sessionsUser.id);
    try {
      await revokeAllUserSessionsAction(sessionsUser.id);
      setConfirmRevokeAll(false);
      await loadSessions(sessionsUser);
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : 'Could not revoke sessions.');
    } finally {
      setBusy(null);
    }
  }

  function openResetCredential(user: User) {
    setResetUser(user);
    setResetResult(null);
    setResetError(null);
  }

  async function onResetCredential() {
    if (!resetUser) return;
    setResetError(null);
    setBusy(resetUser.id);
    try {
      const result = await adminResetCredentialAction(resetUser.id);
      setResetResult(result);
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Could not issue a credential reset.');
    } finally {
      setBusy(null);
    }
  }

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  return (
    <div className="space-y-10">
      {/* ── people ── */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">People</h2>
          <Button onClick={() => setShowInvite(true)}>Invite user</Button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-cream-dark/50 text-left">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Roles</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2">{u.fullName ?? '—'}</td>
                  <td className="px-4 py-2">{u.email}</td>
                  <td className="px-4 py-2">
                    {u.suspended ? (
                      <span className="text-destructive">Suspended</span>
                    ) : u.hasLogin ? (
                      <span className="text-ok">Active</span>
                    ) : (
                      <span className="text-ink-muted">No login</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-ink-muted">
                    {u.roles.length > 0 ? u.roles.join(', ') : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={() => openRoleEditor(u)}>
                        Roles
                      </Button>
                      {u.hasLogin && (
                        <>
                          <Button variant="outline" size="sm" onClick={() => openSessions(u)}>
                            Sessions
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openResetCredential(u)}
                          >
                            Reset credential
                          </Button>
                        </>
                      )}
                      {u.hasLogin &&
                        (u.suspended ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy === u.id}
                            onClick={() => onUnsuspend(u)}
                          >
                            Unsuspend
                          </Button>
                        ) : (
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busy === u.id}
                            onClick={() => setConfirmSuspend(u)}
                          >
                            Suspend
                          </Button>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-ink-muted">
                    Nobody here yet. Invite the first user.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── pending invitations ── */}
      <section>
        <h2 className="mb-4 text-lg font-medium">Pending invitations</h2>
        {invitations.length === 0 ? (
          <p className="text-sm text-ink-muted">No pending invitations.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-cream-dark/50 text-left">
                  <th className="px-4 py-2 font-medium">Email</th>
                  <th className="px-4 py-2 font-medium">Roles</th>
                  <th className="px-4 py-2 font-medium">Expires</th>
                  <th className="px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => (
                  <tr key={inv.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">{inv.email}</td>
                    <td className="px-4 py-2 text-ink-muted">{inv.roles.join(', ')}</td>
                    <td className="px-4 py-2 text-ink-muted">
                      {new Date(inv.expiresAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === inv.id}
                        onClick={() => onRevoke(inv.id)}
                      >
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── invite dialog ── */}
      {showInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-popover p-6">
            <h3 className="text-lg font-medium">Invite user</h3>
            {inviteResult ? (
              <div className="mt-4 space-y-3">
                <p className="text-sm">
                  Invitation created for <strong>{inviteResult.email}</strong>.
                </p>
                <p className="text-sm text-ink-muted">
                  Share this link — it is shown exactly once:
                </p>
                <p className="break-all rounded bg-cream-dark p-2 text-xs">
                  {inviteResult.inviteUrl}
                </p>
                <Button
                  onClick={() => {
                    navigator.clipboard.writeText(inviteResult.inviteUrl);
                  }}
                >
                  Copy link
                </Button>
                <div>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowInvite(false);
                      refresh();
                    }}
                  >
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={onInvite} className="mt-4 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="invite-email">Work email</Label>
                  <Input
                    id="invite-email"
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    disabled={invitePending}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Roles</Label>
                  <div className="max-h-48 space-y-1 overflow-y-auto rounded border border-line p-2">
                    {roles.map((r) => (
                      <label key={r.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={inviteRoles.includes(r.id)}
                          onChange={() => setInviteRoles(toggle(inviteRoles, r.id))}
                          disabled={invitePending}
                        />
                        <span>
                          {r.code}
                          {r.isProtected && (
                            <span className="ml-1 text-xs text-destructive">(admin)</span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invite-engagement">Engagement</Label>
                  <p className="text-xs text-ink-muted">
                    The acceptance creates this engagement — without it the new login would see no
                    data.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      id="invite-engagement"
                      className="rounded border border-line bg-background px-2 py-2 text-sm"
                      value={inviteEngagementType}
                      onChange={(e) => setInviteEngagementType(e.target.value)}
                      disabled={invitePending}
                    >
                      {ENGAGEMENT_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t.charAt(0) + t.slice(1).toLowerCase().replace('_', ' ')}
                        </option>
                      ))}
                    </select>
                    <Input
                      type="date"
                      aria-label="Start date"
                      value={inviteStartDate}
                      onChange={(e) => setInviteStartDate(e.target.value)}
                      disabled={invitePending}
                      required
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invite-department">Department</Label>
                  <select
                    id="invite-department"
                    className="w-full rounded border border-line bg-background px-2 py-2 text-sm"
                    value={inviteDepartmentId}
                    onChange={(e) => setInviteDepartmentId(e.target.value)}
                    disabled={invitePending}
                    required
                  >
                    <option value="">Choose a department…</option>
                    {departments
                      .filter((d) => d.status === 'ACTIVE')
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                  </select>
                </div>
                {inviteError && (
                  <p role="alert" className="text-sm text-destructive">
                    {inviteError}
                  </p>
                )}
                <div className="flex gap-2">
                  <Button type="submit" disabled={invitePending}>
                    {invitePending ? 'Creating…' : 'Create invitation'}
                  </Button>
                  <Button variant="outline" type="button" onClick={() => setShowInvite(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* ── role editor dialog ── */}
      {editingRoles && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-popover p-6">
            <h3 className="text-lg font-medium">
              Roles for {editingRoles.fullName ?? editingRoles.email}
            </h3>
            <div className="mt-4 max-h-64 space-y-1 overflow-y-auto rounded border border-line p-2">
              {roles.map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editRoleIds.includes(r.id)}
                    onChange={() => setEditRoleIds(toggle(editRoleIds, r.id))}
                  />
                  <span>
                    {r.code}
                    {r.isProtected && (
                      <span className="ml-1 text-xs text-destructive">(admin)</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            {editError && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {editError}
              </p>
            )}
            <div className="mt-4 flex gap-2">
              <Button onClick={onSaveRoles} disabled={busy === editingRoles.id}>
                Save roles
              </Button>
              <Button variant="outline" onClick={() => setEditingRoles(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── suspend confirmation ── */}
      {confirmSuspend && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-popover p-6">
            <h3 className="text-lg font-medium">Suspend this login?</h3>
            <p className="mt-2 text-sm text-ink-muted">
              {confirmSuspend.fullName ?? confirmSuspend.email} will be signed out everywhere
              immediately and cannot sign in again until unsuspended.
            </p>
            <div className="mt-4 flex gap-2">
              <Button
                variant="destructive"
                disabled={busy === confirmSuspend.id}
                onClick={() => onSuspend(confirmSuspend)}
              >
                Suspend
              </Button>
              <Button variant="outline" onClick={() => setConfirmSuspend(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── sessions dialog ── */}
      {sessionsUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-popover p-6">
            <h3 className="text-lg font-medium">
              Sessions for {sessionsUser.fullName ?? sessionsUser.email}
            </h3>
            {sessions === null ? (
              <p className="mt-4 text-sm text-ink-muted">Loading sessions…</p>
            ) : sessions.length === 0 ? (
              <p className="mt-4 text-sm text-ink-muted">No active sessions.</p>
            ) : (
              <ul className="mt-4 max-h-64 space-y-2 overflow-y-auto">
                {sessions.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-3 rounded border border-line p-3 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-ink-muted">
                        {s.ipAddress ?? 'unknown IP'}
                        {s.userAgent ? ` · ${s.userAgent.slice(0, 60)}` : ''}
                      </p>
                      <p className="text-xs text-ink-muted">
                        Created {new Date(s.createdAt).toLocaleString()} · expires{' '}
                        {new Date(s.expiresAt).toLocaleString()}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === s.id}
                      onClick={() => onRevokeSession(s.id)}
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {sessionsError && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {sessionsError}
              </p>
            )}
            {confirmRevokeAll ? (
              <div className="mt-4 rounded border border-destructive/40 p-3">
                <p className="text-sm">
                  Revoke <strong>all</strong> sessions for{' '}
                  {sessionsUser.fullName ?? sessionsUser.email}? They will be signed out everywhere
                  immediately.
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy === sessionsUser.id}
                    onClick={onRevokeAllSessions}
                  >
                    Revoke all sessions
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmRevokeAll(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-4 flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={sessions === null || sessions.length === 0}
                  onClick={() => setConfirmRevokeAll(true)}
                >
                  Revoke all sessions
                </Button>
                <Button variant="outline" size="sm" onClick={() => setSessionsUser(null)}>
                  Close
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── credential reset dialog ── */}
      {resetUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-popover p-6">
            <h3 className="text-lg font-medium">Reset credential</h3>
            {resetResult ? (
              <div className="mt-4 space-y-3">
                <p className="text-sm">
                  A single-use reset link was issued for <strong>{resetResult.email}</strong>, valid
                  for one hour.
                  {resetResult.emailSent
                    ? ' It was also emailed to them.'
                    : ' Email delivery is not configured, so share the link directly.'}
                </p>
                <p className="text-sm text-ink-muted">
                  Share this link — it is shown exactly once:
                </p>
                <p className="break-all rounded bg-cream-dark p-2 text-xs">
                  {resetResult.resetUrl}
                </p>
                <Button
                  onClick={() => {
                    navigator.clipboard.writeText(resetResult.resetUrl);
                  }}
                >
                  Copy link
                </Button>
                <div>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setResetUser(null);
                      refresh();
                    }}
                  >
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <p className="mt-2 text-sm text-ink-muted">
                  Issue a single-use, one-hour reset link for{' '}
                  {resetUser.fullName ?? resetUser.email}. The link is emailed when delivery is
                  configured, and shown to you exactly once either way. Their current password keeps
                  working until the link is used.
                </p>
                {resetError && (
                  <p role="alert" className="mt-3 text-sm text-destructive">
                    {resetError}
                  </p>
                )}
                <div className="mt-4 flex gap-2">
                  <Button disabled={busy === resetUser.id} onClick={onResetCredential}>
                    {busy === resetUser.id ? 'Issuing…' : 'Issue reset link'}
                  </Button>
                  <Button variant="outline" onClick={() => setResetUser(null)}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
