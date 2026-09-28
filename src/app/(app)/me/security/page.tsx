import { SecurityClient } from './security-client';

/**
 * /me/security — the signed-in user's own security settings. The (app) layout
 * already requires authentication; no further permission is needed to manage
 * one's own second factor and sessions.
 *
 * ?enrollment=required — shown when the login flow steered here because the
 * person holds a privileged role (users.manage/roles.manage) but has no
 * verified TOTP factor.
 */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ enrollment?: string }>;
}) {
  const enrollmentRequired = (await searchParams)?.enrollment === 'required';
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Your sign-in security: password, two-factor authentication, active sessions, and login
          history.
        </p>
      </div>
      {enrollmentRequired ? (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <p className="font-medium">Two-factor authentication is required</p>
          <p className="mt-1">
            Your role has privileged access, so you must enroll in two-factor authentication (TOTP)
            before using admin pages. Scan the code below with your authenticator app and enter the
            code to finish enrolling.
          </p>
        </div>
      ) : null}
      <SecurityClient />
    </div>
  );
}
