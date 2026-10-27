import { sql } from 'drizzle-orm';
import {
  enforcePlatformSessionLimits,
  readRequestSession,
  type PlatformSession,
} from '@/lib/auth/platform-session';
import { withPlatformTx } from '@/lib/db/platform-pool';

/**
 * Session → platform administrator (ADR-008). The platform's counterpart of
 * src/lib/auth/session.ts, and deliberately separate from it: a tenant session resolves to a
 * person and never to an administrator; a platform session resolves to an administrator and
 * never to a person (a login is one or the other — database triggers, 0083).
 *
 *   none       no session, or one past the platform's limits (which is then deleted)
 *   not-admin  a live session whose login is not a platform administrator — a tenant user of
 *              any role, SUPER_ADMIN included, or a revoked administrator
 *   admin      an ACTIVE or PENDING_ENROLMENT administrator; the gate decides what each may
 *              do, and the database re-decides on every call (platform.current_admin():
 *              ACTIVE, aal2, an enrolled second factor)
 */
export interface PlatformActor {
  adminId: string;
  status: 'ACTIVE' | 'PENDING_ENROLMENT';
  session: PlatformSession;
}

export type PlatformAccess =
  { kind: 'none' } | { kind: 'not-admin' } | { kind: 'admin'; actor: PlatformActor };

export async function resolvePlatformAccess(headers: Headers): Promise<PlatformAccess> {
  const current = await readRequestSession(headers);
  if (!current) return { kind: 'none' };
  // Whose login is it — asked BEFORE the platform's session limits are applied, so a tenant
  // user's session is never stamped or deleted by a request to a platform path.
  const rows = await withPlatformTx(null, (tx) =>
    tx.execute<{ admin_id: string; status: string }>(sql`
      select admin_id, status from platform.admin_for_login(${current.authUserId}::uuid)
    `),
  );
  const row = rows.rows[0];
  if (!row || (row.status !== 'ACTIVE' && row.status !== 'PENDING_ENROLMENT')) {
    return { kind: 'not-admin' };
  }
  const session = await enforcePlatformSessionLimits(current);
  if (!session) return { kind: 'none' };
  return { kind: 'admin', actor: { adminId: row.admin_id, status: row.status, session } };
}
