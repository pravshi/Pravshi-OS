'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OneTimeLink } from '../one-time-link';
import { newIdempotencyKey, platformApi, signInAgain } from '../platform-api';

interface Admin {
  adminId: string;
  email: string;
  fullName: string;
  status: string;
  createdAt: string;
  createdBy: string | null;
  revokedAt: string | null;
  hasLogin: boolean;
  permissions: string[];
}

/** Every invited administrator receives the two view permissions; these are the optional ones. */
const GRANTABLE = [
  ['platform.organizations.create', 'Provision organizations'],
  ['platform.organizations.assign_initial_admin', 'Re-issue first-administrator setup links'],
  ['platform.organizations.suspend', 'Suspend organizations'],
  ['platform.organizations.reactivate', 'Reactivate organizations'],
  ['platform.admins.manage', 'Manage platform administrators'],
] as const;

function ErrorLine({ code, message }: { code: string; message: string }) {
  return (
    <div role="alert" className="mt-3 text-sm text-destructive">
      <p>{message}</p>
      {code === 'STEP_UP_REQUIRED' ? (
        <Button className="mt-2" size="sm" variant="outline" onClick={() => void signInAgain()}>
          Sign in again
        </Button>
      ) : null}
    </div>
  );
}

export function AdminsClient({ selfId, held }: { selfId: string; held: string[] }) {
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [loadError, setLoadError] = useState<{ code: string; message: string } | null>(null);
  const [shown, setShown] = useState<{ title: string; link: string; expiresAt: string } | null>(
    null,
  );

  const load = useCallback(async () => {
    const r = await platformApi<{ admins: Admin[] }>('/admins');
    if (r.ok) {
      setAdmins(r.data.admins);
      setLoadError(null);
    } else {
      setLoadError(r);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Platform administrators</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Platform administrators are never members of an organization. You can grant only
          permissions you hold.
        </p>
      </div>
      {shown ? <OneTimeLink {...shown} onDismiss={() => setShown(null)} /> : null}
      <InviteForm
        held={held}
        onInvited={(s) => {
          setShown(s);
          void load();
        }}
      />
      <section className="rounded-lg border border-line bg-white p-5">
        <h2 className="text-lg font-medium">Administrators</h2>
        {loadError ? <ErrorLine {...loadError} /> : null}
        {admins === null && !loadError ? (
          <p className="mt-3 text-sm text-ink-muted">Loading…</p>
        ) : null}
        {admins ? (
          <ul className="mt-3 divide-y divide-line">
            {admins.map((a) => (
              <AdminRow
                key={a.adminId}
                admin={a}
                self={a.adminId === selfId}
                onChanged={() => void load()}
                onLink={setShown}
              />
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function AdminRow({
  admin,
  self,
  onChanged,
  onLink,
}: {
  admin: Admin;
  self: boolean;
  onChanged: () => void;
  onLink: (s: { title: string; link: string; expiresAt: string }) => void;
}) {
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  async function revoke(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const r = await platformApi(`/admins/${admin.adminId}/revoke`, {
      method: 'POST',
      body: { reason: reason.trim() },
    });
    setPending(false);
    if (!r.ok) {
      setError(r);
      return;
    }
    setRevoking(false);
    onChanged();
  }

  async function reissue() {
    setPending(true);
    setError(null);
    const r = await platformApi<{ setupLink: string; setupExpiresAt: string }>(
      `/admins/${admin.adminId}/setup`,
      { method: 'POST' },
    );
    setPending(false);
    if (!r.ok) {
      setError(r);
      return;
    }
    onLink({
      title: `New setup link for ${admin.email} (the previous one no longer works)`,
      link: r.data.setupLink,
      expiresAt: r.data.setupExpiresAt,
    });
    onChanged();
  }

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{admin.fullName}</span>
        <span className="text-sm text-ink-muted">{admin.email}</span>
        <Badge
          variant={
            admin.status === 'ACTIVE'
              ? 'secondary'
              : admin.status === 'REVOKED'
                ? 'destructive'
                : 'outline'
          }
        >
          {admin.status}
        </Badge>
        {self ? <Badge variant="outline">You</Badge> : null}
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        {admin.permissions.join(', ') || 'no permissions'}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {!self && admin.status !== 'REVOKED' && !revoking ? (
          <Button size="sm" variant="outline" onClick={() => setRevoking(true)}>
            Revoke
          </Button>
        ) : null}
        {admin.status === 'PENDING_ENROLMENT' && !admin.hasLogin && !revoking ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void reissue()}>
            Re-issue setup link
          </Button>
        ) : null}
      </div>
      {revoking ? (
        <form onSubmit={revoke} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1 space-y-2">
            <Label htmlFor={`revoke-${admin.adminId}`}>Reason (recorded in the audit)</Label>
            <Input
              id={`revoke-${admin.adminId}`}
              required
              minLength={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
            />
          </div>
          <Button type="submit" size="sm" variant="destructive" disabled={pending}>
            {pending ? 'Revoking…' : 'Revoke and end their sessions'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setRevoking(false)}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      {error ? <ErrorLine {...error} /> : null}
    </li>
  );
}

function InviteForm({
  held,
  onInvited,
}: {
  held: string[];
  onInvited: (s: { title: string; link: string; expiresAt: string }) => void;
}) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [replayed, setReplayed] = useState(false);
  // One key per invitation: a retry of the same details (a lost answer) replays, never
  // duplicates; changed details are a new invitation (F-CONSOLE-11).
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  useEffect(() => {
    setIdempotencyKey(newIdempotencyKey());
    setReplayed(false);
  }, [email, fullName, permissions]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setReplayed(false);
    const r = await platformApi<
      | { replayed: false; adminId: string; setupLink: string; setupExpiresAt: string }
      | { replayed: true; adminId: string }
    >('/admins', {
      method: 'POST',
      body: { idempotencyKey, email: email.trim(), fullName: fullName.trim(), permissions },
    });
    setPending(false);
    if (!r.ok) {
      setError(r);
      return;
    }
    if (r.data.replayed) {
      setReplayed(true);
      return;
    }
    onInvited({
      title: `Setup link for ${email.trim()}`,
      link: r.data.setupLink,
      expiresAt: r.data.setupExpiresAt,
    });
    setEmail('');
    setFullName('');
    setPermissions([]);
  }

  return (
    <section className="rounded-lg border border-line bg-white p-5">
      <h2 className="text-lg font-medium">Invite an administrator</h2>
      <form onSubmit={submit} className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="i-name">Full name</Label>
          <Input
            id="i-name"
            required
            maxLength={200}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="i-email">Email</Label>
          <Input
            id="i-email"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={pending}
          />
        </div>
        <fieldset className="space-y-2 sm:col-span-2">
          <legend className="text-sm font-medium">
            Permissions (viewing organizations and the audit trail is always included)
          </legend>
          {GRANTABLE.map(([key, label]) => {
            const mayGrant = held.includes(key);
            return (
              <label
                key={key}
                className={`flex items-center gap-2 text-sm ${mayGrant ? '' : 'text-ink-muted'}`}
              >
                <input
                  type="checkbox"
                  checked={permissions.includes(key)}
                  disabled={pending || !mayGrant}
                  onChange={(e) =>
                    setPermissions((p) =>
                      e.target.checked ? [...p, key] : p.filter((x) => x !== key),
                    )
                  }
                />
                {label}
                {mayGrant ? null : ' — you do not hold this'}
              </label>
            );
          })}
        </fieldset>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Inviting…' : 'Invite administrator'}
          </Button>
          {replayed ? (
            <p role="status" className="mt-3 text-sm text-ink-muted">
              This invitation was already sent. Its link is not shown again — use &ldquo;Re-issue
              setup link&rdquo; on the administrator below if it was lost.
            </p>
          ) : null}
          {error ? <ErrorLine {...error} /> : null}
        </div>
      </form>
    </section>
  );
}
