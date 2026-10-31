'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { safeNextPath } from '@/lib/auth/next-path';

/**
 * /mfa — the second-factor challenge. Reached after /api/auth/login answers
 * twoFactorRedirect. Posts the code to /api/auth/mfa/verify, which records
 * MFA_FAILURE on a wrong code like every other authentication outcome.
 *
 * Two modes (AUD-21): the authenticator code, and a backup code — one of the
 * single-use codes issued at enrolment, for the user whose authenticator is
 * lost. The library verifies and retires the code; this page only carries it.
 *
 * `next` is the post-login return path from the login page, re-validated with
 * safeNextPath() before it is honoured, exactly as on the login form.
 */
function MfaForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get('email') ?? undefined;
  const returnTo = safeNextPath(searchParams.get('next'));

  const [mode, setMode] = useState<'totp' | 'backup-code'>('totp');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const backup = mode === 'backup-code';
  const codeReady = backup ? code.trim().length >= 11 : code.trim().length >= 6;

  function switchMode(next: 'totp' | 'backup-code') {
    setMode(next);
    setCode('');
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch('/api/auth/mfa/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: code.trim(),
          email,
          method: backup ? 'backup-code' : 'totp',
        }),
      });
      if (!res.ok) {
        setError(
          backup
            ? 'That backup code is incorrect or has already been used. Each code works once — try another.'
            : 'The code is incorrect. Check your authenticator app and try again.',
        );
        setCode('');
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
      <h1 className="text-2xl font-semibold tracking-tight">Two-factor authentication</h1>
      <p className="mt-2 text-sm text-ink-muted">
        {backup
          ? 'Enter one of the backup codes you saved when you set up two-factor authentication. Each code works once.'
          : 'Enter the 6-digit code from your authenticator app.'}
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="code">{backup ? 'Backup code' : 'Authenticator code'}</Label>
          <Input
            id="code"
            inputMode={backup ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            required
            minLength={backup ? 11 : 6}
            maxLength={backup ? 11 : 10}
            placeholder={backup ? 'abcde-fghij' : undefined}
            value={code}
            onChange={(e) =>
              setCode(backup ? e.target.value.trim() : e.target.value.replace(/\s/g, ''))
            }
            disabled={pending}
            autoFocus
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={pending || !codeReady}>
          {pending ? 'Verifying…' : 'Verify'}
        </Button>
      </form>

      <p className="mt-4 text-center text-sm text-ink-muted">
        {backup ? (
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => switchMode('totp')}
          >
            Use your authenticator app instead
          </button>
        ) : (
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => switchMode('backup-code')}
          >
            Use a backup code instead
          </button>
        )}
      </p>
    </div>
  );
}

export default function MfaPage() {
  return (
    <Suspense>
      <MfaForm />
    </Suspense>
  );
}
