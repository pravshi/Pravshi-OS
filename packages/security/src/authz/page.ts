import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveAuthContext } from '@/lib/auth/session';
import { loginPathForNext } from '@/lib/auth/next-path';
import { isAuthorizationError } from './errors';
import { requirePermission, type Authorization } from './require-permission';
import type { AuthContext } from '@/lib/db/context';

/**
 * Page-level authorization for Server Components.
 *
 * requireAuthenticated() answers the blueprint's step 1 (authenticated): it resolves the
 * PRAVSHI OS identity and redirects to /login when there is none. The (app) layout calls
 * it, so every authenticated page is covered in one place.
 *
 * requirePagePermission() answers step 4 (permitted) for a specific permission: individual
 * admin pages call it, and refusals land on /access-denied — never leaking which
 * permission was missing or what lies behind the boundary.
 */

/**
 * Redirects to /login when the request carries no PRAVSHI OS identity.
 *
 * The redirect carries the intended page as a `next` parameter (AUD-21), so
 * sign-in can return the user to the deep link they asked for. The path comes
 * from the x-pathname header middleware stamps on the request; the target is
 * built by loginPathForNext(), which admits only same-origin relative paths,
 * and the login flow validates the value again before honouring it.
 */
export async function requireAuthenticated(): Promise<AuthContext> {
  const hdrs = await headers();
  const ctx = await resolveAuthContext(hdrs);
  if (!ctx) redirect(loginPathForNext(hdrs.get('x-pathname')));
  return ctx;
}

/** Throws redirect to /login (unauthenticated) or /access-denied (unauthorized). */
export async function requirePagePermission(permission: string): Promise<Authorization> {
  try {
    return await requirePermission(await headers(), { permission });
  } catch (e) {
    if (isAuthorizationError(e)) {
      redirect(e.code === 'UNAUTHENTICATED' ? '/login' : '/access-denied');
    }
    throw e;
  }
}
