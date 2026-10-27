import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { PlatformUnavailableError } from '@/lib/db/platform-pool';
import { resolvePlatformAccess, type PlatformActor } from './identity';
import { whoami, type WhoAmI } from './service';

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
    throw e;
  }
  if (access.kind === 'none') redirect(`/login?next=${encodeURIComponent(path)}`);
  if (access.kind === 'not-admin') notFound();

  const { actor } = access;
  const enrolled = actor.status === 'ACTIVE' && actor.session.aal === 'aal2';
  if (!enrolled) {
    if (path !== '/platform/security') redirect('/platform/security');
    return { unavailable: false, actor, me: null, enrolled };
  }
  const me = await whoami({
    actor,
    requestId: randomUUID(),
    settings: { adminId: actor.adminId, aal: 'aal2' },
  });
  return { unavailable: false, actor, me, enrolled };
}
