import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveAuthContext } from '@/lib/auth/session';
import { ForgotPasswordForm } from './forgot-password-form';

/**
 * /forgot-password — request a reset link (server wrapper).
 *
 * Like /login, an already-authenticated user is redirected into the app
 * (AUD-21): asking for a reset link for the account you are signed in as is
 * never the intent, and the signed-in password path is /me/security. The
 * check lives on THIS page only — the (auth) layout must not blanket-redirect,
 * because /access-denied shares the group and stays reachable while signed in.
 */
export default async function ForgotPasswordPage() {
  const ctx = await resolveAuthContext(await headers());
  if (ctx) redirect('/');
  return <ForgotPasswordForm />;
}
