/**
 * Database maintenance on the worker plane (Core V1 audit WP-2, migration 0065).
 *
 *   1. Audit-log partitions — public.maintain_audit_log_partitions() keeps
 *      audit_logs partitioned twelve months ahead. audit_logs has no DEFAULT
 *      partition, so without this the window set by migration 0011 simply runs
 *      out and every audited write starts failing (finding D-1).
 *   2. Data retention — public.run_data_retention(limit) deletes operational
 *      history and expired auth bookkeeping past fixed periods (the table is in
 *      the 0065 header), at most `limit` rows per target per call (finding D-2).
 *
 * Both are SECURITY DEFINER functions that refuse a person context, so they run
 * the way reapStaleJobs() does: a plain pooled transaction with no identity set.
 * The two run in SEPARATE transactions — a failure in one never blocks the other.
 *
 * Failure posture: never throws (a DB blip must never kill the worker), but never
 * silent either. Errors are logged with their SQLSTATE only — a driver error's
 * message can carry query text — and a partition window that has shrunk below
 * PARTITION_WINDOW_ALERT_DAYS is logged as an error, because by then something
 * has been failing for months.
 */
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { connectWorkerWithWake } from '../db/worker-pool';
import type { Tx } from '../db/authorized';

/** Rows per retention target per call. 0065 accepts 1..10000. */
export const RETENTION_BATCH_DEFAULT = 5000;
export const RETENTION_BATCH_MAX = 10000;

/** Log an error when fewer than this many days of audit partitions remain. */
export const PARTITION_WINDOW_ALERT_DAYS = 60;

export interface DbMaintenanceResult {
  /** null when the partition step failed. */
  partitions: { created: number; windowEnd: string } | null;
  /** Per-target deleted counts; null when the retention step failed. */
  retention: Record<string, number> | null;
}

// ── Worker-plane DB (same model as reapStaleJobs in worker.ts) ──────────────

async function withWorkerDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await connectWorkerWithWake();
  try {
    const db = drizzle(client);
    return await db.transaction(fn);
  } finally {
    client.release();
  }
}

export function sqlstateOf(error: unknown): string {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return 'none';
}

function validateBatchLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > RETENTION_BATCH_MAX) {
    throw new Error(
      `INVALID_REQUEST: retention batch limit must be an integer between 1 and ${RETENTION_BATCH_MAX}`,
    );
  }
  return limit;
}

/** Whole days from `now` until `windowEnd` (a YYYY-MM-DD date, exclusive bound). */
export function daysUntil(windowEnd: string, now: Date = new Date()): number {
  return Math.floor((Date.parse(`${windowEnd}T00:00:00Z`) - now.getTime()) / 86_400_000);
}

export async function maintainAuditLogPartitions(): Promise<{
  created: number;
  windowEnd: string;
}> {
  const rows = await withWorkerDb((tx) =>
    tx.execute<{ created: number; window_end: string }>(
      sql`select created, window_end::text as window_end
          from public.maintain_audit_log_partitions()`,
    ),
  );
  const row = rows.rows[0];
  return { created: Number(row?.created ?? 0), windowEnd: String(row?.window_end ?? '') };
}

export async function runDataRetention(
  limit = RETENTION_BATCH_DEFAULT,
): Promise<Record<string, number>> {
  const safeLimit = validateBatchLimit(limit);
  const rows = await withWorkerDb((tx) =>
    tx.execute<{ target: string; deleted: number }>(
      sql`select target, deleted from public.run_data_retention(${safeLimit})`,
    ),
  );
  return Object.fromEntries(rows.rows.map((r) => [r.target, Number(r.deleted)]));
}

/** One maintenance pass: partitions, then retention. Never throws. */
export async function runDbMaintenance(
  limit = RETENTION_BATCH_DEFAULT,
): Promise<DbMaintenanceResult> {
  const result: DbMaintenanceResult = { partitions: null, retention: null };

  try {
    result.partitions = await maintainAuditLogPartitions();
    const remaining = daysUntil(result.partitions.windowEnd);
    if (!(remaining >= PARTITION_WINDOW_ALERT_DAYS)) {
      console.error('[jobs] audit partition window ends soon', {
        windowEnd: result.partitions.windowEnd,
        daysRemaining: remaining,
      });
    }
  } catch (error) {
    console.error('[jobs] audit partition maintenance failed', { sqlstate: sqlstateOf(error) });
  }

  try {
    result.retention = await runDataRetention(limit);
  } catch (error) {
    console.error('[jobs] data retention failed', { sqlstate: sqlstateOf(error) });
  }

  const deleted = Object.fromEntries(
    Object.entries(result.retention ?? {}).filter(([, n]) => n > 0),
  );
  console.log('[jobs] db maintenance', {
    partitionsCreated: result.partitions?.created ?? null,
    windowEnd: result.partitions?.windowEnd ?? null,
    deleted,
  });
  return result;
}
