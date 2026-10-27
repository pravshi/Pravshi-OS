'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SETUP_TOKEN_PATTERN } from '@/lib/auth/setup-token';
import { isCommonPassword } from '@/lib/auth/common-passwords';

/**
 * The setup form: reads the #token=… fragment the bootstrap script printed, collects
 * the owner's first password, and posts both to /api/bootstrap/complete.
 *
 * The token travels in the fragment (never a query string) so it stays out of request
 * lines, access logs and Referer headers. Nothing here logs the token, and the failure
 * messages deliberately do not distinguish an unknown token from an expired or used
 * one — the server answers SETUP_TOKEN_INVALID for all three.
 */

type WeakReason = 'TOO_SHORT' | 'TOO_LONG' | 'TOO_COMMON' | 'BREACHED';

const REASON_TEXT: Record<WeakReason, string> = {
  TOO_SHORT: 'Your password is too short.',
  TOO_LONG: 'Your password is too long.',
  TOO_COMMON: 'That password is too common — choose a less predictable one.',
  BREACHED: 'That password has appeared in a data breach — choose a different one.',
};

/**
 * HIBP k-anonymity check, client-side. Only the first 5 hex chars of the SHA-1 leave
 * the browser — the same privacy property as the server check on the reset path —
 * and a network failure fails open: the local common-password list still applies.
 */
async function isBreachedPassword(password: string): Promise<boolean> {
  try {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    const prefix = hex.slice(0, 5);
    const suffix = hex.slice(5);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        signal: ctrl.signal,
      });
      if (!res.ok) return false;
      const body = await res.text();
      return body.split('\n').some((line) => line.split(':')[0]?.trim() === suffix);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * The three one-time setup links share this form; only the endpoint and the copy differ.
 *   bootstrap       scripts/bootstrap/run.mjs — the installation owner (/setup)
 *   platform-admin  a platform administrator: bootstrapped, invited or recovered (/platform/setup)
 *   org-admin       the first administrator of a provisioned organization (/setup/organization)
 */
export type SetupVariant = 'bootstrap' | 'platform-admin' | 'org-admin';

const COPY: Record<
  SetupVariant,
  {
    endpoint: string;
    title: string;
    intro: string;
    label: string;
    submit: string;
    doneText: string;
    signIn: string;
    askWho: string;
  }
> = {
  bootstrap: {
    endpoint: '/api/bootstrap/complete',
    title: 'Set up Pravshi OS',
    intro:
      'Create the owner password for this installation. This link is single-use and expires one hour after the bootstrap ran.',
    label: 'Owner password',
    submit: 'Create owner login',
    doneText: 'Your owner login is ready. Sign in, then enrol two-factor authentication.',
    signIn: '/login',
    askWho: 'Ask the operator to check the bootstrap state.',
  },
  'platform-admin': {
    endpoint: '/api/platform/setup/complete',
    title: 'Platform administrator setup',
    intro:
      'Create your platform administrator password. This link is single-use; a link from the operator expires after 60 minutes, an invitation after 72 hours.',
    label: 'Password',
    submit: 'Set password',
    doneText:
      'Your password is set. Sign in, then enrol two-factor authentication — the console requires it for every action.',
    signIn: '/login?next=%2Fplatform',
    askWho: 'Ask a platform administrator (or the operator) for a new link.',
  },
  'org-admin': {
    endpoint: '/api/setup/organization/complete',
    title: 'Set up your organization',
    intro:
      'You are the first administrator of your organization. Create your password. This link is single-use and expires 72 hours after it was issued.',
    label: 'Password',
    submit: 'Create login',
    doneText: 'Your login is ready. Sign in, then enrol two-factor authentication.',
    signIn: '/login',
    askWho: 'Ask the Pravshi platform team for a new link.',
  },
};

function readFragmentToken(): string {
  const hash = window.location.hash;
  if (!hash.startsWith('#')) return '';
  const token = new URLSearchParams(hash.slice(1)).get('token') ?? '';
  return SETUP_TOKEN_PATTERN.test(token) ? token : '';
}

export function SetupForm({
  minPasswordLength,
  maxPasswordLength,
  variant = 'bootstrap',
}: {
  minPasswordLength: number;
  maxPasswordLength: number;
  variant?: SetupVariant;
}) {
  const copy = COPY[variant];
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [weakReason, setWeakReason] = useState<WeakReason | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setToken(readFragmentToken());
  }, []);

  async function checkPassword(pw: string): Promise<WeakReason | null> {
    if (pw.length < minPasswordLength) return 'TOO_SHORT';
    if (pw.length > maxPasswordLength) return 'TOO_LONG';
    if (isCommonPassword(pw)) return 'TOO_COMMON';
    if (await isBreachedPassword(pw)) return 'BREACHED';
    return null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setWeakReason(null);

    if (!token) {
      setError(`This setup link is missing its token. ${copy.askWho}`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setPending(true);
    try {
      const weak = await checkPassword(password);
      if (weak) {
        setWeakReason(weak);
        return;
      }

      const res = await fetch(copy.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        minPasswordLength?: number;
        maxPasswordLength?: number;
      } | null;

      if (!res.ok || !data) {
        if (data?.error === 'SETUP_TOKEN_INVALID') {
          setError(`This setup link is invalid, expired, or already used. ${copy.askWho}`);
        } else if (data?.error === 'SETUP_CANNOT_COMPLETE') {
          setError(`Setup could not be completed. ${copy.askWho}`);
        } else if (data?.error === 'PASSWORD_TOO_SHORT') {
          setWeakReason('TOO_SHORT');
        } else if (data?.error === 'PASSWORD_TOO_LONG') {
          setWeakReason('TOO_LONG');
        } else if (data?.error === 'PASSWORD_TOO_COMMON') {
          setWeakReason('TOO_COMMON');
        } else if (data?.error === 'PASSWORD_BREACHED') {
          setWeakReason('BREACHED');
        } else if (data?.error === 'RATE_LIMITED') {
          setError('Too many attempts. Wait a minute and try again.');
        } else {
          setError('Something went wrong. Please try again.');
        }
        return;
      }
      setDone(true);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setPending(false);
    }
  }

  if (token === null) {
    // Fragment not read yet — render nothing rather than a wrong state.
    return null;
  }

  if (done) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Setup complete</h1>
        <p className="mt-2 text-sm text-ink-muted">{copy.doneText}</p>
        <Button className="mt-6 w-full" onClick={() => router.push(copy.signIn)}>
          Go to sign in
        </Button>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
      <p className="mt-2 text-sm text-ink-muted">
        {copy.intro} Minimum {minPasswordLength} characters.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">{copy.label}</Label>
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

        {weakReason && (
          <p role="alert" className="text-sm text-destructive">
            {REASON_TEXT[weakReason]}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={pending || !token}>
          {pending ? 'Saving…' : copy.submit}
        </Button>
      </form>
    </div>
  );
}
