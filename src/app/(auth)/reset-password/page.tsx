'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * /reset-password — complete a reset from the emailed link (?token=…).
 *
 * The token travels in the query string here (it must survive the email client),
 * and is posted in the request body from then on. Weak-password rejections name
 * their reason distinctly so the user knows what to fix.
 */

type WeakReason = 'TOO_SHORT' | 'TOO_LONG' | 'TOO_COMMON' | 'BREACHED';

const REASON_TEXT: Record<WeakReason, string> = {
  TOO_SHORT: 'Your password is too short.',
  TOO_LONG: 'Your password is too long.',
  TOO_COMMON: 'That password is too common — choose a less predictable one.',
  BREACHED: 'That password has appeared in a data breach — choose a different one.',
};

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!token) {
      setError('This reset link is missing its token. Please request a new one.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setPending(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        reason?: WeakReason;
        message?: string;
      } | null;

      if (!res.ok || !data) {
        if (data?.error === 'WEAK_PASSWORD' && data.reason && REASON_TEXT[data.reason]) {
          setError(REASON_TEXT[data.reason]);
        } else if (data?.error === 'INVALID_TOKEN') {
          setError(
            'This reset link is invalid, expired, or already used. Please request a new one.',
          );
        } else if (data?.error === 'RATE_LIMITED') {
          setError('Too many attempts. Please wait a minute and try again.');
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

  if (done) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Password updated</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Your password has been changed. All other sessions were signed out.
        </p>
        <p className="mt-6 text-sm">
          <Link href="/login" className="underline underline-offset-4">
            Sign in with your new password
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Minimum 12 characters. This link is single-use and expires in one hour.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">New password</Label>
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
          <Label htmlFor="confirm">Confirm new password</Label>
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
          {pending ? 'Updating…' : 'Update password'}
        </Button>
      </form>
    </div>
  );
}
