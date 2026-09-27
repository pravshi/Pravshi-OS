'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth/client';

/**
 * /me/security — the user's own security settings. No special permission needed:
 * everyone manages their own second factor and sessions. All calls go through the
 * Better Auth client (the /api/auth/[...all] catch-all), which the guard test
 * allow-lists as the identity-establishing path.
 */
export function SecurityClient() {
  const { data: session } = authClient.useSession();

  const [twoFactorEnabled, setTwoFactorEnabled] = useState<boolean | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [sessions, setSessions] = useState<
    { token: string; createdAt: Date; userAgent?: string | null }[]
  >([]);

  useEffect(() => {
    setTwoFactorEnabled(
      (session?.user as { twoFactorEnabled?: boolean | null } | undefined)?.twoFactorEnabled ??
        false,
    );
  }, [session]);

  useEffect(() => {
    authClient
      .listSessions()
      .then(({ data }) => setSessions((data ?? []) as typeof sessions))
      .catch(() => setSessions([]));
  }, []);

  async function startEnrollment(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setEnrolling(true);
    try {
      const { data, error: err } = await authClient.twoFactor.enable({
        password,
        method: 'totp',
      });
      if (err || !data || !('totpURI' in data)) {
        setError('Could not start enrollment. Check your password.');
        return;
      }
      setTotpUri(data.totpURI);
      setBackupCodes(data.backupCodes ?? null);
    } finally {
      setEnrolling(false);
    }
  }

  async function confirmEnrollment(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error: err } = await authClient.twoFactor.verifyTotp({
      code: verifyCode.trim(),
    });
    if (err) {
      setError('The code is incorrect. Try again.');
      return;
    }
    setTotpUri(null);
    setVerifyCode('');
    setTwoFactorEnabled(true);
  }

  async function disableTwoFactor(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error: err } = await authClient.twoFactor.disable({ password });
    if (err) {
      setError('Could not disable. Check your password.');
      return;
    }
    setPassword('');
    setTwoFactorEnabled(false);
  }

  async function regenerateBackupCodes(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { data, error: err } = await authClient.twoFactor.generateBackupCodes({ password });
    if (err || !data) {
      setError('Could not generate codes. Check your password.');
      return;
    }
    setBackupCodes(data.backupCodes);
  }

  async function revokeSession(token: string) {
    await authClient.revokeSession({ token });
    setSessions((s) => s.filter((x) => x.token !== token));
  }

  async function revokeOthers() {
    await authClient.revokeOtherSessions();
    const { data } = await authClient.listSessions();
    setSessions((data ?? []) as typeof sessions);
  }

  return (
    <div className="space-y-10">
      {/* ── two-factor ── */}
      <section className="rounded-lg border border-line bg-white p-5">
        <h2 className="text-lg font-medium">Two-factor authentication</h2>
        {twoFactorEnabled === null ? (
          <p className="mt-2 text-sm text-ink-muted">Loading…</p>
        ) : twoFactorEnabled ? (
          <div className="mt-3 space-y-4">
            <p className="text-sm text-emerald-700">
              Two-factor authentication is on for your account.
            </p>
            {backupCodes ? (
              <div>
                <p className="text-sm font-medium">Your new backup codes — save them now:</p>
                <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm">
                  {backupCodes.map((c) => (
                    <li key={c} className="rounded bg-cream-dark px-2 py-1">
                      {c}
                    </li>
                  ))}
                </ul>
                <Button className="mt-3" variant="outline" onClick={() => setBackupCodes(null)}>
                  I saved them
                </Button>
              </div>
            ) : (
              <form onSubmit={regenerateBackupCodes} className="flex items-end gap-2">
                <div className="space-y-2">
                  <Label htmlFor="regen-pw">Password</Label>
                  <Input
                    id="regen-pw"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <Button type="submit" variant="outline">
                  New backup codes
                </Button>
              </form>
            )}
            <form
              onSubmit={disableTwoFactor}
              className="flex items-end gap-2 border-t border-line pt-4"
            >
              <div className="space-y-2">
                <Label htmlFor="disable-pw">Password</Label>
                <Input
                  id="disable-pw"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="submit" variant="destructive">
                Turn off two-factor
              </Button>
            </form>
          </div>
        ) : totpUri ? (
          <div className="mt-3 space-y-4">
            <p className="text-sm">
              Add this key to your authenticator app (Google Authenticator, 1Password, …), then
              enter the 6-digit code to finish.
            </p>
            <p className="break-all rounded bg-cream-dark p-2 font-mono text-xs">{totpUri}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigator.clipboard.writeText(totpUri)}
            >
              Copy key
            </Button>
            {backupCodes && (
              <div>
                <p className="text-sm font-medium">Backup codes — save these now:</p>
                <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm">
                  {backupCodes.map((c) => (
                    <li key={c} className="rounded bg-cream-dark px-2 py-1">
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <form onSubmit={confirmEnrollment} className="flex items-end gap-2">
              <div className="space-y-2">
                <Label htmlFor="totp-code">Authenticator code</Label>
                <Input
                  id="totp-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value)}
                />
              </div>
              <Button type="submit">Verify and enable</Button>
            </form>
          </div>
        ) : (
          <form onSubmit={startEnrollment} className="mt-3 flex items-end gap-2">
            <div className="space-y-2">
              <Label htmlFor="enroll-pw">Password</Label>
              <Input
                id="enroll-pw"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={enrolling}
              />
            </div>
            <Button type="submit" disabled={enrolling}>
              {enrolling ? 'Starting…' : 'Set up authenticator app'}
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </section>

      {/* ── sessions ── */}
      <section className="rounded-lg border border-line bg-white p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Active sessions</h2>
          {sessions.length > 1 && (
            <Button variant="outline" size="sm" onClick={revokeOthers}>
              Sign out other sessions
            </Button>
          )}
        </div>
        <ul className="mt-3 space-y-2">
          {sessions.map((s) => (
            <li
              key={s.token}
              className="flex items-center justify-between rounded border border-line px-3 py-2 text-sm"
            >
              <span className="text-ink-muted">
                {s.userAgent ?? 'Unknown device'} · {new Date(s.createdAt).toLocaleString()}
              </span>
              <Button variant="outline" size="sm" onClick={() => revokeSession(s.token)}>
                Sign out
              </Button>
            </li>
          ))}
          {sessions.length === 0 && <li className="text-sm text-ink-muted">No active sessions.</li>}
        </ul>
        <p className="mt-3 text-xs text-ink-muted">
          Signed in as {session?.user?.email ?? '…'}. Sessions that need a second factor are marked
          when you sign in.
        </p>
      </section>
    </div>
  );
}
