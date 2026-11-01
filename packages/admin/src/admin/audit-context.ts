import { sql } from 'drizzle-orm';
import type { Tx } from '@/lib/db/authorized';
import type { Authorization } from '@/lib/authz/require-permission';

/**
 * Carries the request's correlation id into the transaction, for the audit entry the
 * administrative write functions record themselves (migration 0067: create_department,
 * archive_department, create_team, update_team, archive_team, set_team_members).
 *
 * Those functions take no request id parameter; they read the transaction-local
 * app.request_id through public.audit_request_id(). Call this inside the same
 * withAuthorizedDb() transaction, immediately before the write function. The setting is
 * transaction-scoped (set_config(..., true)), so it cannot outlive the request on a
 * pooled connection. The id is the uuid requirePermission() issued — never client input.
 */
export async function setAuditRequestId(tx: Tx, auth: Authorization): Promise<void> {
  await tx.execute(sql`select set_config('app.request_id', ${auth.requestId}, true)`);
}
