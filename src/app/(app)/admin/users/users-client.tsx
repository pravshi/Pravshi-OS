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

/** Client interactivity for /admin/users: dialogs and confirmations. The Server
 *  Component above fetched the data; every mutation re-authorizes server-side. */
export function UsersClient({
  users,
  invitations,
  roles,
}: {
  users: User[];
  invitations: Invitation[];
  roles: Role[];
}) {
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRoles, setInviteRoles] = useState<string[]>([]);
  const [inviteResult, setInviteResult] = useState<{ inviteUrl: string; email: string } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [invitePending, setInvitePending] = useState(false);

  const [editingRoles, setEditingRoles] = useState<User | null>(null);
  const [editRoleIds, setEditRoleIds] = useState<string[]>([]);
  const [editError, setEditError] = useState<string | null>(null);

  const [confirmSuspend, setConfirmSuspend] = useState<User | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
    setInvitePending(true);
    try {
      const result = await inviteUserAction({
        email: inviteEmail.trim(),
        roleIds: inviteRoles,
        expiresInDays: 7,
      });
      setInviteResult(result);
      setInviteEmail('');
      setInviteRoles([]);
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
                      <span className="text-emerald-700">Active</span>
                    ) : (
                      <span className="text-ink-muted">No login</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-ink-muted">
                    {u.roles.length > 0 ? u.roles.join(', ') : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => openRoleEditor(u)}>
                        Roles
                      </Button>
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
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
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
                  <Button variant="outline" onClick={() => { setShowInvite(false); refresh(); }}>
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
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
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
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
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
    </div>
  );
}
