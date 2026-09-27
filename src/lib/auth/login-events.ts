import { sql } from 'drizzle-orm';
import { authDb } from '@/lib/db/auth-client';

/**
 * Login-event recording for the authentication routes.
 *
 * Every authentication outcome — success, failure, MFA challenge, MFA failure — is
 * recorded through public.record_login_event(), the only write path for login_events.
 * Recording must never break authentication itself: if the event write fails, the
 * login still proceeds and the failure is logged server-side. A login that didn't
 * happen because event recording threw would be a stranger failure mode than a
 * missing event row.
 */

export type LoginEventType =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILURE'
  | 'MFA_CHALLENGE'
  | 'MFA_FAILURE';

export async function resolveLoginOrg(email: string): Promise<string | null> {
  try {
    const res = await authDb.execute<{ org_id: string | null }>(sql`
      select public.resolve_login_org(${email}::public.citext) as org_id
    `);
    return res.rows[0]?.org_id ?? null;
  } catch {
    return null;
  }
}

export async function recordLoginEvent(opts: {
  orgId: string | null;
  eventType: LoginEventType;
  email: string | null;
  authUserId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await authDb.execute(sql`
      select public.record_login_event(
        ${opts.orgId}::uuid,
        ${opts.eventType},
        ${opts.email}::public.citext,
        ${opts.authUserId}::uuid,
        ${opts.ip}::inet,
        ${opts.userAgent},
        ${JSON.stringify(opts.metadata ?? {})}::jsonb
      )
    `);
  } catch (e) {
    console.error('[auth] login event recording failed', {
      eventType: opts.eventType,
      name: e instanceof Error ? e.name : typeof e,
    });
  }
}

/** Best-effort client IP: Vercel's forwarded header, else nothing. Never trusted for decisions. */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? null;
  return ip && ip.length > 0 ? ip : null;
}
