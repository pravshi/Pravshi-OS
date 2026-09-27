'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * /invite — the invitation-acceptance page. The link in the invitation email is
 * /invite#token=…: a fragment, so the token never appears in a request line, an
 * access log or a Referer header. This page reads the fragment client-side and posts
 * it in request bodies from here on.
 *
 * States: loading → (invalid link | preview + acceptance form) → accepted.
 * The invalid-link state is deliberately coarse — invalid, expired and already-used
 * all look the same, so token probers learn nothing.
 */
type Phase =
  | { kind: 'loading' }
  | { kind: 'no-token' }
  | { kind: 'invalid' }
  | { kind: 'form'; email: string; orgName: string; token: string }
  | { kind: 'accepted' };

function tokenFromFragment(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.hash.match(/[#&]token=([A-Za-z0-9_-]{43})/);
  return match?.[1] ?? null;
}

export default function InvitePage() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const token = tokenFromFragment();
    if (!token) {
      setPhase({ kind: 'no-token' });
      return;
    }
    // Drop the fragment from the address bar: it has served its purpose, and leaving
    // a live token in browser history is unnecessary exposure.
    window.history.replaceState(null, '', window.location.pathname);
    fetch('/api/invitations/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as {
          email?: string;
          orgName?: string;
          valid?: boolean;
        } | null;
        if (!res.ok || !data || data.valid !== true || !data.email || !data.orgName) {
          setPhase({ kind: 'invalid' });
          return;
        }
        setPhase({ kind: 'form', email: data.email, orgName: data.orgName, token });
      })
      .catch(() => setPhase({ kind: 'invalid' }));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (phase.kind !== 'form') return;
    setError(null);
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    setPending(true);
    try {
      const res = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: phase.token, fullName: fullName.trim(), password }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(
          data?.error === 'PASSWORD_TOO_SHORT'
            ? 'The password is too short.'
            : 'This invitation link is invalid, expired, or already used.',
        );
        if (data?.error === 'INVITATION_INVALID') setPhase({ kind: 'invalid' });
        return;
      }
      setPhase({ kind: 'accepted' });
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setPending(false);
    }
  }

  if (phase.kind === 'loading') {
    return <p className="text-sm text-ink-muted">Checking your invitation…</p>;
  }

  if (phase.kind === 'no-token' || phase.kind === 'invalid') {
    return (
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Invitation not found</h1>
        <p className="mt-3 text-sm text-ink-muted">
          This invitation link is invalid, expired, or already used. Ask your
          administrator to send a new one.
        </p>
      </div>
    );
  }

  if (phase.kind === 'accepted') {
    return (
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome aboard</h1>
        <p className="mt-3 text-sm text-ink-muted">
          Your account is ready. Sign in to get started.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Accept your invitation</h1>
      <p className="mt-2 text-sm text-ink-muted">
        You&apos;ve been invited to join <strong>{phase.orgName}</strong> as{' '}
        <strong>{phase.email}</strong>. Choose your name and password to create your login.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="fullName">Full legal name</Label>
          <Input
            id="fullName"
            autoComplete="name"
            required
            maxLength={200}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={pending}
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Creating your account…' : 'Accept invitation'}
        </Button>
      </form>

      <p className="mt-4 text-xs text-ink-muted">
        This link is single-use and expires automatically.
      </p>
    </div>
  );
}
