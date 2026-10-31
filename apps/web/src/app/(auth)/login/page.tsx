import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveAuthContext } from '@/lib/auth/session';
import { LoginForm } from './login-form';

/**
 * /login — the sign-in page (server wrapper).
 *
 * An already-authenticated user has no business here (AUD-21): when the
 * request resolves to a PRAVSHI OS identity, the page redirects into the app
 * instead of presenting a second sign-in form. The check lives on THIS page
 * only — never in the (auth) group layout — because /access-denied shares the
 * group and must stay reachable while signed in.
 *
 * `next` (the return path requireAuthenticated captured from a deep link) is
 * handed to the form raw; the form validates it with safeNextPath() before
 * honouring it.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const ctx = await resolveAuthContext(await headers());
  if (ctx) redirect('/');
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : undefined;
  return <LoginForm next={next} />;
}
