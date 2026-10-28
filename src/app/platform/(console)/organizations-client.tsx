'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DeliveryNotice, type DeliveryShown } from './delivery-notice';
import { newIdempotencyKey, platformApi, signInAgain } from './platform-api';

interface Organization {
  orgId: string;
  name: string;
  slug: string;
  typeKey: string;
  templateVersion: number;
  status: string;
  timezone: string;
  createdAt: string;
  suspendedAt: string | null;
  activeMembers: number;
  firstAdminSetupPending: boolean;
}

interface OrganizationType {
  typeKey: string;
  displayName: string;
  description: string | null;
  latestVersion: number;
}

/** The outcome of an email-only setup-link delivery — never the link itself. */
type Shown = DeliveryShown | null;

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

export function OrganizationsClient(props: {
  canCreate: boolean;
  canSuspend: boolean;
  canReactivate: boolean;
  canReissue: boolean;
}) {
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [loadError, setLoadError] = useState<{ code: string; message: string } | null>(null);
  const [shown, setShown] = useState<Shown>(null);

  const load = useCallback(async () => {
    const r = await platformApi<{ organizations: Organization[] }>('/organizations');
    if (r.ok) {
      setOrgs(r.data.organizations);
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
        <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Organization metadata only — the console never shows an organization&apos;s people or
          records.
        </p>
      </div>

      {shown ? <DeliveryNotice shown={shown} onDismiss={() => setShown(null)} /> : null}

      {props.canCreate ? (
        <ProvisionForm
          onProvisioned={(s) => {
            setShown(s);
            void load();
          }}
        />
      ) : null}

      <section className="rounded-lg border border-line bg-white p-5">
        <h2 className="text-lg font-medium">All organizations</h2>
        {loadError ? <ErrorLine {...loadError} /> : null}
        {orgs === null && !loadError ? (
          <p className="mt-3 text-sm text-ink-muted">Loading…</p>
        ) : null}
        {orgs && orgs.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">No organizations yet.</p>
        ) : null}
        {orgs && orgs.length > 0 ? (
          <ul className="mt-3 divide-y divide-line">
            {orgs.map((o) => (
              <OrganizationRow
                key={o.orgId}
                org={o}
                {...props}
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

function OrganizationRow({
  org,
  canSuspend,
  canReactivate,
  canReissue,
  onChanged,
  onLink,
}: {
  org: Organization;
  canSuspend: boolean;
  canReactivate: boolean;
  canReissue: boolean;
  onChanged: () => void;
  onLink: (s: Shown) => void;
}) {
  const [mode, setMode] = useState<'idle' | 'suspend' | 'reactivate'>('idle');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  async function changeStatus(e: React.FormEvent) {
    e.preventDefault();
    if (mode === 'idle') return;
    setPending(true);
    setError(null);
    const r = await platformApi<{ status: string }>(`/organizations/${org.orgId}/${mode}`, {
      method: 'POST',
      body: { reason: reason.trim() },
    });
    setPending(false);
    if (!r.ok) {
      setError(r);
      return;
    }
    setMode('idle');
    setReason('');
    onChanged();
  }

  async function reissue() {
    setPending(true);
    setError(null);
    const r = await platformApi<{ emailed: boolean; recipient: string; setupExpiresAt: string }>(
      `/organizations/${org.orgId}/admin-setup`,
      { method: 'POST' },
    );
    setPending(false);
    if (!r.ok) {
      setError(r);
      return;
    }
    onLink({
      title: `New setup link for the first administrator of ${org.name} (the previous one no longer works)`,
      emailed: r.data.emailed,
      recipient: r.data.recipient,
      expiresAt: r.data.setupExpiresAt,
    });
    onChanged();
  }

  async function revokeLink() {
    const reason = window.prompt(
      'Reason for revoking the pending setup link (recorded in the audit):',
    );
    if (!reason || reason.trim().length < 3) return;
    setPending(true);
    setError(null);
    const r = await platformApi(`/organizations/${org.orgId}/admin-setup/revoke`, {
      method: 'POST',
      body: { reason: reason.trim() },
    });
    setPending(false);
    if (!r.ok) {
      setError(r);
      return;
    }
    onChanged();
  }

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{org.name}</span>
        <span className="font-mono text-xs text-ink-muted">{org.slug}</span>
        <Badge variant={org.status === 'ACTIVE' ? 'secondary' : 'destructive'}>{org.status}</Badge>
        {org.firstAdminSetupPending ? <Badge variant="outline">Setup pending</Badge> : null}
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        {org.typeKey} v{org.templateVersion} · {org.timezone} · {org.activeMembers} active members ·
        created {new Date(org.createdAt).toLocaleDateString()}
        {org.suspendedAt ? ` · suspended ${new Date(org.suspendedAt).toLocaleString()}` : ''}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {canSuspend && org.status === 'ACTIVE' && mode === 'idle' ? (
          <Button size="sm" variant="outline" onClick={() => setMode('suspend')}>
            Suspend
          </Button>
        ) : null}
        {canReactivate && org.status === 'SUSPENDED' && mode === 'idle' ? (
          <Button size="sm" variant="outline" onClick={() => setMode('reactivate')}>
            Reactivate
          </Button>
        ) : null}
        {canReissue && org.status === 'ACTIVE' && org.firstAdminSetupPending && mode === 'idle' ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void reissue()}>
            Re-issue setup link
          </Button>
        ) : null}
        {canReissue && org.status === 'ACTIVE' && org.firstAdminSetupPending && mode === 'idle' ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void revokeLink()}>
            Revoke setup link
          </Button>
        ) : null}
      </div>
      {mode !== 'idle' ? (
        <form onSubmit={changeStatus} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1 space-y-2">
            <Label htmlFor={`reason-${org.orgId}`}>
              Reason for {mode === 'suspend' ? 'suspending' : 'reactivating'} (recorded in the
              audit)
            </Label>
            <Input
              id={`reason-${org.orgId}`}
              required
              minLength={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            variant={mode === 'suspend' ? 'destructive' : 'default'}
            disabled={pending}
          >
            {pending ? 'Saving…' : mode === 'suspend' ? 'Suspend organization' : 'Reactivate'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setMode('idle');
              setError(null);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      {error ? <ErrorLine {...error} /> : null}
    </li>
  );
}

function ProvisionForm({ onProvisioned }: { onProvisioned: (s: Shown) => void }) {
  const [types, setTypes] = useState<OrganizationType[] | null>(null);
  const [typesError, setTypesError] = useState<{ code: string; message: string } | null>(null);
  const [form, setForm] = useState({
    name: '',
    slug: '',
    timezone: 'Asia/Kolkata',
    typeKey: '',
    adminFullName: '',
    adminEmail: '',
  });
  // One key per submission attempt: a retry after a network failure replays, never duplicates.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [replayed, setReplayed] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await platformApi<{ types: OrganizationType[] }>('/organization-types');
      if (r.ok) {
        setTypes(r.data.types);
        setForm((f) => ({ ...f, typeKey: f.typeKey || r.data.types[0]?.typeKey || '' }));
      } else {
        setTypesError(r);
      }
    })();
  }, []);

  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm((f) => ({ ...f, [k]: e.target.value }));
      // Changed details are a new request: a new key.
      setIdempotencyKey(newIdempotencyKey());
      setReplayed(false);
    };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setReplayed(false);
    const r = await platformApi<
      | {
          replayed: false;
          orgId: string;
          emailed: boolean;
          recipient: string;
          setupExpiresAt: string;
        }
      | { replayed: true; orgId: string }
    >('/organizations', { method: 'POST', body: { idempotencyKey, ...form } });
    setPending(false);
    if (!r.ok) {
      setError(r);
      return;
    }
    if (r.data.replayed) {
      setReplayed(true);
      onProvisioned(null);
      return;
    }
    onProvisioned({
      title: `${form.name} is provisioned.`,
      emailed: r.data.emailed,
      recipient: r.data.recipient,
      expiresAt: r.data.setupExpiresAt,
    });
    setForm((f) => ({ ...f, name: '', slug: '', adminFullName: '', adminEmail: '' }));
    setIdempotencyKey(newIdempotencyKey());
  }

  return (
    <section className="rounded-lg border border-line bg-white p-5">
      <h2 className="text-lg font-medium">Provision an organization</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Creates the organization from its type&apos;s latest published template, an Executive
        department, and its first administrator, who receives a 72-hour setup link by email (it is
        never shown here).
      </p>
      {typesError ? <ErrorLine {...typesError} /> : null}
      {types && types.length === 0 ? (
        <p className="mt-3 text-sm text-destructive">
          No organization type has a published template, so nothing can be provisioned.
        </p>
      ) : null}
      <form onSubmit={submit} className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="p-name">Organization name</Label>
          <Input
            id="p-name"
            required
            maxLength={200}
            value={form.name}
            onChange={set('name')}
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="p-slug">Slug</Label>
          <Input
            id="p-slug"
            required
            maxLength={63}
            pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
            title="Lowercase letters, digits and hyphens"
            value={form.slug}
            onChange={set('slug')}
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="p-type">Organization type</Label>
          <select
            id="p-type"
            required
            className="h-9 w-full rounded-md border border-line bg-white px-3 text-sm"
            value={form.typeKey}
            onChange={set('typeKey')}
            disabled={pending || !types}
          >
            {(types ?? []).map((t) => (
              <option key={t.typeKey} value={t.typeKey}>
                {t.displayName} (template v{t.latestVersion})
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="p-tz">Time zone (IANA)</Label>
          <Input
            id="p-tz"
            required
            maxLength={64}
            value={form.timezone}
            onChange={set('timezone')}
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="p-admin-name">First administrator&apos;s full name</Label>
          <Input
            id="p-admin-name"
            required
            maxLength={200}
            value={form.adminFullName}
            onChange={set('adminFullName')}
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="p-admin-email">First administrator&apos;s work email</Label>
          <Input
            id="p-admin-email"
            type="email"
            required
            maxLength={254}
            value={form.adminEmail}
            onChange={set('adminEmail')}
            disabled={pending}
          />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={pending || !types || types.length === 0}>
            {pending ? 'Provisioning…' : 'Provision organization'}
          </Button>
          {replayed ? (
            <p role="status" className="mt-3 text-sm text-ink-muted">
              This request was already completed. Its setup link is not shown again — use
              &ldquo;Re-issue setup link&rdquo; on the organization if it was lost.
            </p>
          ) : null}
          {error ? <ErrorLine {...error} /> : null}
        </div>
      </form>
    </section>
  );
}
