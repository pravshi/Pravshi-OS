import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { checkIpRateLimit, ipRateLimitKey } from '@/lib/auth/rate-limit';
import { clientIp } from '@/lib/auth/login-events';
import { sqlstateOf } from '@/lib/auth/bootstrap-setup';
import {
  PlatformUnavailableError,
  withPlatformTx,
  type PlatformActorSettings,
} from '@/lib/db/platform-pool';
import { resolvePlatformAccess, type PlatformActor } from './identity';

/**
 * The gate every platform API route passes first (ADR-008, design §5). In order:
 *
 *   401  no session (or one past the platform's 12 h / 30 min limits)
 *   404  a session that is not a platform administrator — a tenant user of any role. The
 *        platform's existence is not confirmed to them, and nothing platform-side runs.
 *   403  MFA_REQUIRED       the administrator has no second factor yet, or this session was
 *                           not signed in with one (aal2)
 *   403  FORBIDDEN          the permission is missing — a DENIED platform audit entry is written
 *   403  STEP_UP_REQUIRED   a sensitive action on a session older than 10 minutes: sign in again
 *   429  RATE_LIMITED       sensitive actions are limited per administrator and per client IP
 *   503  PLATFORM_UNAVAILABLE  this deployment has no DATABASE_URL_PLATFORM
 *
 * The database re-checks the actor, aal2, the factor and the permission inside every function;
 * this gate decides the HTTP answer and refuses early, it is not the only check.
 */
export type PlatformPermission =
  | 'platform.organizations.view'
  | 'platform.organizations.create'
  | 'platform.organizations.assign_initial_admin'
  | 'platform.organizations.suspend'
  | 'platform.organizations.reactivate'
  | 'platform.audit.view'
  | 'platform.admins.manage';

/** The operations a DENIED / ERROR entry may name (platform.record_failure's allow-list). */
export type PlatformOperation =
  | 'platform.admin.invite'
  | 'platform.admin.revoke'
  | 'platform.organization.provision'
  | 'platform.organization.admin_setup_reissue'
  | 'platform.organization.suspend'
  | 'platform.organization.reactivate'
  | 'platform.organization.list'
  | 'platform.audit.list'
  | 'platform.admin.list';

export interface PlatformGate {
  operation: PlatformOperation;
  /** Required unless the route serves the administrator's own identity. */
  permission?: PlatformPermission;
  /** Sensitive: a session created within the last 10 minutes (sign in again). */
  stepUp?: boolean;
  /** Per-administrator and per-IP limit for this operation: max calls per window. */
  rateLimit?: { max: number; windowSeconds: number };
}

export interface PlatformRequest {
  actor: PlatformActor;
  requestId: string;
  /** For the database calls: the acting administrator, on this aal2 session. */
  settings: PlatformActorSettings;
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const settingsOf = (actor: PlatformActor): PlatformActorSettings => ({
  adminId: actor.adminId,
  aal: actor.session.aal,
  sessionId: actor.session.sessionId,
});

/** Records a DENIED / ERROR platform audit entry. Never throws: the answer is already decided. */
export async function recordPlatformFailure(
  actor: PlatformActor,
  operation: PlatformOperation,
  result: 'DENIED' | 'ERROR',
  reasonCode: string,
  requestId: string,
  targetOrgId: string | null = null,
): Promise<void> {
  try {
    await withPlatformTx(settingsOf(actor), (tx) =>
      tx.execute(sql`
        select platform.record_failure(${operation}, ${result}, ${reasonCode},
                                       ${targetOrgId}::uuid, ${requestId}::uuid)
      `),
    );
  } catch (e) {
    console.error('[platform] failure audit not recorded', {
      operation,
      name: e instanceof Error ? e.name : typeof e,
      sqlstate: sqlstateOf(e),
    });
  }
}

/**
 * The gate. Returns the request context, or the Response that refuses it. Never throws: a
 * failure inside it is answered here and logged by name and SQLSTATE only — a driver error's
 * message carries the query's parameters (session id, login id, client IP).
 */
export async function gatePlatformRequest(
  req: Request,
  gate: PlatformGate,
): Promise<PlatformRequest | Response> {
  try {
    return await gate_(req, gate);
  } catch (e) {
    if (e instanceof PlatformUnavailableError) return json(503, { error: 'PLATFORM_UNAVAILABLE' });
    const sqlstate = sqlstateOf(e);
    // The database no longer accepts this administrator as an actor (their factor was removed,
    // or the session went past a limit, after the checks above): treat as not enrolled.
    if (sqlstate === '42501') return json(403, { error: 'MFA_REQUIRED' });
    console.error('[platform] gate failed', {
      name: e instanceof Error ? e.name : typeof e,
      sqlstate,
    });
    return json(500, { error: 'INTERNAL', message: 'Something went wrong. Nothing was changed.' });
  }
}

async function gate_(req: Request, gate: PlatformGate): Promise<PlatformRequest | Response> {
  const requestId = randomUUID();
  const access = await resolvePlatformAccess(req.headers);
  // A tenant user gets the answer of any unknown API path; nothing platform-side runs for them.
  if (access.kind === 'none') return json(401, { error: 'UNAUTHENTICATED' });
  if (access.kind === 'not-admin') return json(404, { error: 'NOT_FOUND' });
  const { actor } = access;
  if (actor.status !== 'ACTIVE' || actor.session.aal !== 'aal2') {
    return json(403, { error: 'MFA_REQUIRED' });
  }
  const settings = settingsOf(actor);

  // Limited before anything is recorded, so refusals cannot flood the audit trail.
  if (gate.rateLimit) {
    const { max, windowSeconds } = gate.rateLimit;
    const byAdmin = await checkIpRateLimit(
      `${gate.operation}:admin:${actor.adminId}`,
      max,
      windowSeconds,
    );
    const byIp = await checkIpRateLimit(
      ipRateLimitKey(gate.operation, clientIp(req)),
      max,
      windowSeconds,
    );
    if (!byAdmin || !byIp) {
      await recordPlatformFailure(actor, gate.operation, 'DENIED', 'RATE_LIMITED', requestId);
      return json(429, { error: 'RATE_LIMITED' });
    }
  }
  if (gate.permission) {
    const held = await withPlatformTx(settings, (tx) =>
      tx.execute<{ permissions: string[] }>(sql`select permissions from platform.whoami()`),
    );
    if (!(held.rows[0]?.permissions ?? []).includes(gate.permission)) {
      await recordPlatformFailure(actor, gate.operation, 'DENIED', 'NO_PERMISSION', requestId);
      return json(403, { error: 'FORBIDDEN' });
    }
  }
  if (gate.stepUp && !actor.session.fresh) {
    await recordPlatformFailure(actor, gate.operation, 'DENIED', 'STEP_UP_REQUIRED', requestId);
    return json(403, { error: 'STEP_UP_REQUIRED' });
  }
  return { actor, requestId, settings };
}
