import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Authorization } from '@/lib/authz/require-permission';
import { withAuthorizedDb } from '@/lib/db/authorized';

/**
 * Executions read model — Phase 10 contract §4.1 [DECISION] and §4.4.
 *
 * There is deliberately NO executions table (§4.1): execution history is
 * the union of two stores that already exist —
 *
 *   outbound  the Phase 6 `jobs` rows of type 'webhook' / 'email',
 *             enriched through integration_webhook_deliveries (the link
 *             row carries the subscription + the event key the job was
 *             enqueued for; deployment-level webhook jobs from Phase 6
 *             have no link row and surface with a null event key)
 *   inbound   integration_inbound_events rows (receipt + processing
 *             record; the body itself is never stored, §4.1)
 *
 * merged into one chronological list. Retry is NOT re-implemented here:
 * rows carry their jobId and the retry surface stays /api/jobs/[id]/retry
 * (§4.4); inbound events are receipts, not retryable jobs, and carry a
 * null jobId.
 *
 * VISIBILITY (RLS, stated plainly): each source keeps its own SELECT
 * policy — jobs rows require jobs.view, deliveries and inbound rows
 * require integrations.view. The route admits only integrations.view
 * holders, and in V1 those are exactly SUPER_ADMIN / ADMIN (0057), who
 * also hold jobs.view — so the merge is complete for every caller the
 * route admits. If a future grant ever splits the two, job rows fail
 * closed (absent from the list) rather than leaking; the per-source
 * counts below inherit the same property.
 *
 * Dates: source rows carry Date objects (the merge core below is pure and
 * unit-pinned); the route serialises to ISO strings via Response.json.
 */

export type IntegrationExecutionKind = 'webhook_delivery' | 'email' | 'inbound_event';

/** One row of the merged history — the only shape list/get ever return. */
export interface IntegrationExecution {
  readonly id: string;
  readonly kind: IntegrationExecutionKind;
  /** Job status (pending…dead_letter) or inbound status (RECEIVED…FAILED), untranslated. */
  readonly status: string;
  /** 'webhooks' | 'email' for jobs; the stored provider_key for inbound rows. */
  readonly providerKey: string | null;
  /** Deliveries event_key / workflow.action for outbound; external_event_id for inbound; null when neither exists. */
  readonly eventKey: string | null;
  readonly subscriptionId: string | null;
  readonly connectionId: string | null;
  /** The Phase 6 job id — the retry surface's address. Null for inbound receipts. */
  readonly jobId: string | null;
  /** Subscription URL for webhook deliveries (from the subscription row); null otherwise. */
  readonly targetUrl: string | null;
  /** Normalised job error_code; inbound failures live in `status`, so null there. */
  readonly errorCode: string | null;
  /** Job attempt count; null for inbound receipts. */
  readonly attempts: number | null;
  /** When the execution entered the system (job created_at / event received_at). */
  readonly occurredAt: Date;
  /** Last transition (job updated_at / event processed_at); null while an inbound row is unprocessed. */
  readonly updatedAt: Date | null;
}

export interface IntegrationExecutionPage {
  readonly rows: readonly IntegrationExecution[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/* ── Source row shapes (what the two queries return) ─────────────────────── */

export type JobExecutionSourceRow = {
  readonly id: string;
  readonly type: 'webhook' | 'email';
  readonly status: string;
  readonly errorCode: string | null;
  readonly attempts: number;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
  readonly eventKey: string | null;
  readonly subscriptionId: string | null;
  readonly targetUrl: string | null;
};

export type InboundExecutionSourceRow = {
  readonly id: string;
  readonly providerKey: string;
  readonly connectionId: string | null;
  readonly externalEventId: string | null;
  readonly status: string;
  readonly receivedAt: Date | string;
  readonly processedAt: Date | string | null;
};

/* ── Pure core: row shaping + merge (unit-pinned, no DB) ─────────────────── */

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function jobToExecution(row: JobExecutionSourceRow): IntegrationExecution {
  return {
    id: row.id,
    kind: row.type === 'webhook' ? 'webhook_delivery' : 'email',
    status: row.status,
    providerKey: row.type === 'webhook' ? 'webhooks' : 'email',
    eventKey: row.eventKey,
    subscriptionId: row.subscriptionId,
    connectionId: null,
    jobId: row.id,
    targetUrl: row.targetUrl,
    errorCode: row.errorCode,
    attempts: row.attempts,
    occurredAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export function inboundToExecution(row: InboundExecutionSourceRow): IntegrationExecution {
  return {
    id: row.id,
    kind: 'inbound_event',
    status: row.status,
    providerKey: row.providerKey,
    eventKey: row.externalEventId,
    subscriptionId: null,
    connectionId: row.connectionId,
    jobId: null,
    targetUrl: null,
    errorCode: null,
    attempts: null,
    occurredAt: toDate(row.receivedAt),
    updatedAt: row.processedAt === null ? null : toDate(row.processedAt),
  };
}

/**
 * Merges both sources into one chronological page: newest first, ties
 * broken by id descending so the order is total and stable across calls.
 * `total` is the pre-slice count the caller computed across both sources
 * (the service passes the sum of the per-source counts).
 */
export function mergeExecutionRows(
  rows: readonly IntegrationExecution[],
  total: number,
  limit: number,
  offset: number,
): IntegrationExecutionPage {
  const sorted = [...rows].sort((a, b) => {
    const byTime = b.occurredAt.getTime() - a.occurredAt.getTime();
    if (byTime !== 0) return byTime;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return { rows: sorted.slice(offset, offset + limit), total, limit, offset };
}

/* ── Input schema (exported for Wave G route reuse) ──────────────────────── */

export const ListExecutionsQuerySchema = z.strictObject({
  kind: z.enum(['webhook_delivery', 'email', 'inbound_event']).optional(),
  /** Matched against the source's own status vocabulary (job or inbound). */
  status: z.string().min(1).max(32).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

/* ── The merged read ─────────────────────────────────────────────────────── */

/**
 * Lists the org's integration executions, newest first. Each source is
 * fetched with a window of limit+offset rows (its own ordering), so the
 * merge never materialises more than the page can reach; per-source
 * counts give the merged total. All queries predicate on the caller's
 * org in addition to RLS (the module convention).
 */
export async function listExecutions(
  auth: Authorization,
  input: unknown,
): Promise<IntegrationExecutionPage> {
  const query = ListExecutionsQuerySchema.parse(input ?? {});
  const window = query.limit + query.offset;
  const wantJobs = query.kind === undefined || query.kind !== 'inbound_event';
  const wantInbound = query.kind === undefined || query.kind === 'inbound_event';

  return withAuthorizedDb(auth.ctx, async (tx) => {
    const merged: IntegrationExecution[] = [];
    let total = 0;

    if (wantJobs) {
      const typeFilter: SQL =
        query.kind === 'email'
          ? sql` and j.type = 'email'`
          : query.kind === 'webhook_delivery'
            ? sql` and j.type = 'webhook'`
            : sql` and j.type in ('webhook', 'email')`;
      const statusFilter = query.status ? sql` and j.status = ${query.status}` : sql``;
      const [rows, counts] = await Promise.all([
        tx.execute<JobExecutionSourceRow>(sql`
          select j.id, j.type, j.status,
                 j.error_code as "errorCode",
                 j.attempts,
                 j.created_at as "createdAt",
                 j.updated_at as "updatedAt",
                 d.event_key as "eventKey",
                 d.subscription_id as "subscriptionId",
                 s.url as "targetUrl"
          from public.jobs j
          left join public.integration_webhook_deliveries d
            on d.job_id = j.id and d.org_id = j.org_id
          left join public.integration_webhook_subscriptions s
            on s.id = d.subscription_id and s.org_id = j.org_id
          where j.org_id = ${auth.ctx.orgId}::uuid${typeFilter}${statusFilter}
          order by j.created_at desc, j.id desc
          limit ${window}
        `),
        tx.execute<{ total: number }>(sql`
          select count(*)::int as total
          from public.jobs j
          where j.org_id = ${auth.ctx.orgId}::uuid${typeFilter}${statusFilter}
        `),
      ]);
      merged.push(...rows.rows.map(jobToExecution));
      total += counts.rows[0]?.total ?? 0;
    }

    if (wantInbound) {
      const statusFilter = query.status ? sql` and e.status = ${query.status}` : sql``;
      const [rows, counts] = await Promise.all([
        tx.execute<InboundExecutionSourceRow>(sql`
          select e.id,
                 e.provider_key as "providerKey",
                 e.connection_id as "connectionId",
                 e.external_event_id as "externalEventId",
                 e.status,
                 e.received_at as "receivedAt",
                 e.processed_at as "processedAt"
          from public.integration_inbound_events e
          where e.org_id = ${auth.ctx.orgId}::uuid${statusFilter}
          order by e.received_at desc, e.id desc
          limit ${window}
        `),
        tx.execute<{ total: number }>(sql`
          select count(*)::int as total
          from public.integration_inbound_events e
          where e.org_id = ${auth.ctx.orgId}::uuid${statusFilter}
        `),
      ]);
      merged.push(...rows.rows.map(inboundToExecution));
      total += counts.rows[0]?.total ?? 0;
    }

    return mergeExecutionRows(merged, total, query.limit, query.offset);
  });
}
