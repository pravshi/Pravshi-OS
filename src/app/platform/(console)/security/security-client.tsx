'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TotpQrCode } from '@/components/security/totp-qr-code';
import { authClient } from '@/lib/auth/client';

/**
 * TOTP enrolment for a platform administrator, through Better Auth's two-factor endpoints (the
 * same ones a tenant user enrols with). Once the code is verified, the administrator signs in
 * again: the console needs a session that was created with the second factor (aal2), and a
 * session's assurance is fixed when it is created.
 */
export function PlatformSecurityClient({ enrolled }: { enrolled: boolean }) {
  const [password, setPassword] = useState('');
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const { data, error: err } = await authClient.twoFactor.enable({ password, method: 'totp' });
      if (err || !data || !('totpURI' in data)) {
        setError('Could not start enrolment. Check your password.');
        return;
      }
      setTotpUri(data.totpURI);
      setBackupCodes(data.backupCodes ?? null);
      setPassword('');
    } finally {
      setPending(false);
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const { error: err } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
      if (err) {
        setError('The code is incorrect. Try again.');
        return;
      }
      setVerified(true);
    } finally {
      setPending(false);
    }
  }

  async function signInAgain() {
    await authClient.signOut();
    window.location.assign('/login?next=%2Fplatform');
  }

  if (enrolled) {
    return (
      <div className="max-w-xl space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
        <p className="text-sm text-ink-muted">
          Two-factor authentication is enrolled and this session was signed in with it. Sensitive
          actions (provisioning, suspending, re-issuing links, managing administrators) need a
          sign-in from the last 10 minutes; the console asks you to sign in again when they do.
          Sessions end after 30 minutes without activity, and after 12 hours in any case.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Enrol two-factor authentication</h1>
        <p className="mt-1 text-sm text-ink-muted">
          The platform console requires an authenticator app (TOTP) for every action. Until it is
          enrolled and you have signed in with it, nothing else is available.
        </p>
      </div>

      {verified ? (
        <section className="rounded-lg border border-line bg-white p-5">
          <p className="text-sm text-emerald-700">Two-factor authentication is enrolled.</p>
          <p className="mt-2 text-sm text-ink-muted">
            Sign in again with your password and a code to open the console.
          </p>
          <Button className="mt-4" onClick={() => void signInAgain()}>
            Sign in again
          </Button>
        </section>
      ) : totpUri ? (
        <section className="rounded-lg border border-line bg-white p-5">
          <p className="text-sm">
            Scan this code with your authenticator app, then enter the code it shows.
          </p>
          <div className="mt-3">
            <TotpQrCode uri={totpUri} />
          </div>
          {backupCodes ? (
            <div className="mt-4">
              <p className="text-sm font-medium">Backup codes — store them somewhere safe:</p>
              <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm">
                {backupCodes.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
            </div>
          ) : null}
          <form onSubmit={confirm} className="mt-4 flex items-end gap-2">
            <div className="space-y-2">
              <Label htmlFor="totp-code">Code</Label>
              <Input
                id="totp-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={pending}
              />
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? 'Checking…' : 'Verify'}
            </Button>
          </form>
        </section>
      ) : (
        <section className="rounded-lg border border-line bg-white p-5">
          <form onSubmit={start} className="max-w-sm space-y-3">
            <div className="space-y-2">
              <Label htmlFor="pw">Your password</Label>
              <Input
                id="pw"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={pending}
              />
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? 'Starting…' : 'Start enrolment'}
            </Button>
          </form>
        </section>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
