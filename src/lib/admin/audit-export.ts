import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { Authorization } from '@/lib/authz/require-permission';

/**
 * Audit log export. Reads the same append-only audit_logs rows the /admin/audit-logs
 * page shows, and serializes them for download as CSV or JSON.
 *
 * Memory discipline: rows are fetched in keyset-paginated batches (newest first) and
 * handed to the caller one batch at a time, so an export never holds more than one
 * batch in memory no matter how large the table grows. The hard cap exists so a
 * single export cannot run away: at most EXPORT_ROW_CAP rows leave the database.
 */

export const EXPORT_ROW_CAP = 10_000;
const EXPORT_BATCH_SIZE = 1_000;

export type AuditExportFilters = {
  action?: string;
  result?: string;
};

/** The full record shape the JSON export carries. */
export type AuditExportRecord = {
  id: string;
  occurredAt: Date;
  actor: string | null;
  action: string;
  severity: string;
  entityType: string;
  entityId: string | null;
  result: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
};

export type ExportOutcome = {
  rows: number;
  truncated: boolean;
};

/**
 * How many rows the filtered export would deliver, before the cap. One aggregate
 * query, run before streaming starts, so the response can carry the exact row
 * count and truncation flag as headers (headers precede the body).
 */
export async function countAuditExportRows(
  auth: Authorization,
  filters: AuditExportFilters,
): Promise<number> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{ count: string }>(sql`
      select count(*) as count
      from public.audit_logs a
      where a.org_id = ${auth.ctx.orgId}::uuid
        and (${filters.action ?? null}::text is null or a.action = ${filters.action ?? null}::text)
        and (${filters.result ?? null}::text is null or a.result = ${filters.result ?? null}::text)
    `);
    return Number(res.rows[0]?.count ?? 0);
  });
}

/**
 * Pages through the filtered audit rows, newest first, invoking onBatch for each
 * batch. Returns the total rows delivered and whether the cap truncated the export.
 * Keyset pagination on (occurred_at, id) keeps the walk stable if rows are appended
 * mid-export; the table's PK is (id, occurred_at) so the pair is unique.
 */
export async function streamAuditExportBatches(
  auth: Authorization,
  filters: AuditExportFilters,
  onBatch: (batch: AuditExportRecord[]) => void | Promise<void>,
): Promise<ExportOutcome> {
  let rows = 0;
  let truncated = false;
  let lastOccurredAt: Date | null = null;
  let lastId: string | null = null;

  await withAuthorizedDb(auth.ctx, async (tx) => {
    for (;;) {
      // Fetch one row past the batch size: its presence proves more data exists.
      const res = await tx.execute<AuditExportRecord>(sql`
        select
          a.id,
          a.occurred_at as "occurredAt",
          a.actor_email_snapshot as "actor",
          a.action,
          a.severity,
          a.entity_type as "entityType",
          a.entity_id as "entityId",
          a.result,
          a.before,
          a.after,
          a.metadata
        from public.audit_logs a
        where a.org_id = ${auth.ctx.orgId}::uuid
          and (${filters.action ?? null}::text is null or a.action = ${filters.action ?? null}::text)
          and (${filters.result ?? null}::text is null or a.result = ${filters.result ?? null}::text)
          and (
            ${lastOccurredAt?.toISOString() ?? null}::timestamptz is null
            or (a.occurred_at, a.id) < (
              ${lastOccurredAt?.toISOString() ?? null}::timestamptz,
              ${lastId ?? null}::uuid
            )
          )
        order by a.occurred_at desc, a.id desc
        limit ${EXPORT_BATCH_SIZE + 1}
      `);
      const batch = res.rows;
      if (batch.length === 0) break;

      const hasMore = batch.length > EXPORT_BATCH_SIZE;
      const deliver = batch.slice(0, EXPORT_BATCH_SIZE).slice(0, EXPORT_ROW_CAP - rows);
      if (deliver.length > 0) {
        await onBatch(deliver);
        rows += deliver.length;
        const last = deliver[deliver.length - 1]!;
        lastOccurredAt = last.occurredAt;
        lastId = last.id;
      }
      // Truncated only when the cap is reached while the probe row shows data
      // remains beyond it.
      if (rows >= EXPORT_ROW_CAP) {
        truncated = hasMore;
        break;
      }
      if (!hasMore) break;
    }
  });

  return { rows, truncated };
}

/** RFC 4180: quote when the cell holds a comma, quote, or line break; double quotes. */
export function csvEscapeCell(value: string | null | undefined): string {
  const s = value ?? '';
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export const AUDIT_CSV_HEADER = 'timestamp,actor,action,severity,entity,details';

function detailsJson(r: AuditExportRecord): string {
  return JSON.stringify({ result: r.result, entityId: r.entityId, metadata: r.metadata ?? {} });
}

/** CSV columns: timestamp, actor, action, severity, entity, details. */
export function auditRecordToCsvRow(r: AuditExportRecord): string {
  return [
    csvEscapeCell(r.occurredAt instanceof Date ? r.occurredAt.toISOString() : String(r.occurredAt)),
    csvEscapeCell(r.actor),
    csvEscapeCell(r.action),
    csvEscapeCell(r.severity),
    csvEscapeCell(r.entityType),
    csvEscapeCell(detailsJson(r)),
  ].join(',');
}

/** The JSON export carries full records; dates serialize as ISO strings. */
export function auditRecordToJson(r: AuditExportRecord): Record<string, unknown> {
  return {
    id: r.id,
    occurredAt: r.occurredAt instanceof Date ? r.occurredAt.toISOString() : r.occurredAt,
    actor: r.actor,
    action: r.action,
    severity: r.severity,
    entityType: r.entityType,
    entityId: r.entityId,
    result: r.result,
    before: r.before ?? null,
    after: r.after ?? null,
    metadata: r.metadata ?? {},
  };
}
