'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { safeNextPath } from '@/lib/auth/next-path';

/**
 * The sign-in form. Posts to /api/auth/login (never to Better Auth directly),
 * so every password outcome is recorded as a login event.
 *
 * Failure is deliberately generic: unknown email and wrong password answer the same,
 * because distinguishing them would let anyone probe which addresses hold logins.
 *
 * `next` is the post-login return path the server page extracted from the
 * query string (AUD-21). It is re-validated here with safeNextPath() before
 * any navigation honours it — only same-origin relative paths survive — and
 * it is threaded through the MFA challenge so a deep link survives the
 * second factor too.
 */
export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const returnTo = safeNextPath(next ?? null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = (await res.json().catch(() => null)) as {
        twoFactorRedirect?: boolean;
        mfaEnrollmentRequired?: boolean;
        error?: string;
      } | null;

      if (!res.ok || !data) {
        setError('The email or password is incorrect.');
        return;
      }
      if (data.twoFactorRedirect === true) {
        const params = new URLSearchParams({ email: email.trim() });
        if (returnTo) params.set('next', returnTo);
        router.push(`/mfa?${params.toString()}`);
        return;
      }
      // Privileged roles without a verified TOTP factor are steered to enroll
      // right after login. The admin layout enforces the same gate server-side.
      if (data.mfaEnrollmentRequired === true) {
        router.push('/me/security?enrollment=required');
        return;
      }
      router.push(returnTo ?? '/');
      router.refresh();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm text-ink-muted">Use the work email your administrator invited.</p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Work email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending}
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <p className="mt-4 text-center text-sm text-ink-muted">
        <Link href="/forgot-password" className="underline underline-offset-4">
          Forgot password?
        </Link>
      </p>
    </div>
  );
}
