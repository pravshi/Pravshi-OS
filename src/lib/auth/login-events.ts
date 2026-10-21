import { isIP } from 'node:net';
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

/**
 * Closed login-event vocabulary, mirroring the login_events_type_format CHECK in
 * drizzle/0018 and the accepted list in record_login_event() in drizzle/0019.
 *
 * Only LOGIN_SUCCESS / LOGIN_FAILURE / MFA_CHALLENGE / MFA_FAILURE are emitted
 * today (the login route). The rest are reserved for the flows that will emit them:
 * the password-reset flow, the invitation decline flow (INVITATION_REJECTED — kept
 * even though nothing emits it yet), and session revocation.
 */
export type LoginEventType =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILURE'
  | 'MFA_CHALLENGE'
  | 'MFA_FAILURE'
  | 'PASSWORD_RESET_REQUESTED'
  | 'PASSWORD_RESET_COMPLETED'
  | 'INVITATION_ACCEPTED'
  | 'INVITATION_REJECTED'
  | 'SESSION_REVOKED';

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

/**
 * The client address in an x-forwarded-for value: its first entry, and only when
 * that is a valid IPv4 or IPv6 address (no zone id); anything else is null. A
 * garbage value must never reach an `::inet` cast — the cast throws, and the
 * lockout recorder would silently stop counting — nor become a rate-limit key a
 * client can rotate at will.
 */
export function forwardedIp(header: string | null | undefined): string | null {
  const first = header?.split(',')[0]?.trim() ?? '';
  return isIP(first) !== 0 && !first.includes('%') ? first : null;
}

/**
 * Best-effort client IP: Vercel's forwarded header, validated, else nothing. The
 * platform sets the header; it feeds rate limiting and recording, never access.
 */
export function clientIp(req: Request): string | null {
  return forwardedIp(req.headers.get('x-forwarded-for'));
}
