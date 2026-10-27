import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { PlatformUnavailableError } from '@/lib/db/platform-pool';
import { resolvePlatformAccess, type PlatformActor } from './identity';
import { sqlstateOf } from '@/lib/auth/bootstrap-setup';
import { loginPathForNext } from '@/lib/auth/next-path';
import { PlatformError, whoami, type WhoAmI } from './service';

/**
 * The server-side gate of the console's pages (/platform/**, except /platform/setup), the
 * page counterpart of gatePlatformRequest(). What a page renders is UX; every operation it
 * offers goes through /api/platform and that gate.
 *
 *   no session                       → /login?next=<this page>
 *   a session that is not a platform
 *   administrator (any tenant user)  → 404, as for any unknown path
 *   an administrator without a
 *   second factor on this session    → /platform/security (enrol TOTP), unless already there
 *   console not configured           → { unavailable: true }
 */
export type PlatformPageContext =
  | { unavailable: true }
  | { unavailable: false; actor: PlatformActor; me: WhoAmI | null; enrolled: boolean };

export async function requirePlatformPage(): Promise<PlatformPageContext> {
  const h = new Headers(await headers());
  const path = h.get('x-pathname') ?? '/platform';
  let access;
  try {
    access = await resolvePlatformAccess(h);
  } catch (e) {
    if (e instanceof PlatformUnavailableError) return { unavailable: true };
    throw sanitised(e);
  }
  if (access.kind === 'none') redirect(loginPathForNext(path));
  if (access.kind === 'not-admin') notFound();

  const { actor } = access;
  let enrolled = actor.status === 'ACTIVE' && actor.session.aal === 'aal2';
  let me: WhoAmI | null = null;
  if (enrolled) {
    try {
      me = await whoami({
        actor,
        requestId: randomUUID(),
        settings: {
          adminId: actor.adminId,
          aal: actor.session.aal,
          sessionId: actor.session.sessionId,
        },
      });
    } catch (e) {
      // The database no longer accepts this session as an actor (e.g. the factor was removed).
      if (!(e instanceof PlatformError && e.code === 'MFA_REQUIRED')) throw sanitised(e);
      enrolled = false;
    }
  }
  if (!enrolled && path !== '/platform/security') redirect('/platform/security');
  return { unavailable: false, actor, me, enrolled };
}

/** A driver error's message carries the query's parameters: pages rethrow name and SQLSTATE only. */
function sanitised(e: unknown): Error {
  const sqlstate = sqlstateOf(e);
  console.error('[platform] page gate failed', {
    name: e instanceof Error ? e.name : typeof e,
    sqlstate,
  });
  return new Error(`platform page unavailable (${sqlstate ?? 'no sqlstate'})`);
}
