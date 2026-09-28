import { SecurityClient } from './security-client';

/**
 * /me/security — the signed-in user's own security settings. The (app) layout
 * already requires authentication; no further permission is needed to manage
 * one's own second factor and sessions.
 */
export default function SecurityPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Your sign-in security: password, two-factor authentication, active sessions, and login
          history.
        </p>
      </div>
      <SecurityClient />
    </div>
  );
}
