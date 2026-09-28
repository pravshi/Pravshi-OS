import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { Authorization } from '@/lib/authz/require-permission';

/**
 * Audit log reading. The logs are append-only (the database rejects UPDATE/DELETE),
 * so this module only ever SELECTs. audit_logs.view at GLOBAL scope is what makes
 * the login_events rows visible here too (migration 0018).
 */

export type AuditLogEntry = {
  id: string;
  occurredAt: Date;
  actorLabel: string | null;
  action: string;
  entityType: string | null;
  result: string;
  severity: string | null;
};

export interface AuditLogFilters {
  action?: string;
  result?: string;
  severity?: string;
  limit?: number;
}

export async function queryAuditLogs(
  auth: Authorization,
  filters: AuditLogFilters = {},
): Promise<AuditLogEntry[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<AuditLogEntry>(sql`
      select
        a.id,
        a.occurred_at as "occurredAt",
        a.actor_label as "actorLabel",
        a.action,
        a.entity_type as "entityType",
        a.result,
        a.severity
      from public.audit_logs a
      where a.org_id = ${auth.ctx.orgId}::uuid
        and (${filters.action ?? null}::text is null or a.action = ${filters.action ?? null}::text)
        and (${filters.result ?? null}::text is null or a.result = ${filters.result ?? null}::text)
        and (${filters.severity ?? null}::text is null or a.severity = ${filters.severity ?? null}::text)
      order by a.occurred_at desc
      limit ${limit}
    `);
    return res.rows;
  });
}

export type LoginEventEntry = {
  id: string;
  occurredAt: Date;
  eventType: string;
  email: string | null;
};

export async function queryLoginEvents(
  auth: Authorization,
  limit = 100,
): Promise<LoginEventEntry[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<LoginEventEntry>(sql`
      select
        l.id,
        l.occurred_at as "occurredAt",
        l.event_type as "eventType",
        l.email
      from public.login_events l
      where l.org_id = ${auth.ctx.orgId}::uuid
      order by l.occurred_at desc
      limit ${safeLimit}
    `);
    return res.rows;
  });
}
