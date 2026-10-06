/**
 * Jobs UI server helpers (Phase 6).
 *
 * Server-only data access for src/app/(app)/jobs/**. There is no queue
 * service read path yet (queue.ts exposes enqueue/claim/start/complete/fail/
 * /heartbeat/cancel/retry; the read API belongs to the API Engineer under
 * contract §4), so these helpers query through withAuthorizedDb: org_id is
 * re-stated on every query AND the 0045 RLS policies fail closed on top.
 *
 * Never import this module from a 'use client' component — it ships raw
 * payload shapes (sanitized separately for display) and db access.
 */
import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/db/context';
import type { Authorization } from '@/lib/authz/require-permission';
import {
  JOB_STATUSES,
  JOB_STATUS_SET,
  JOB_TYPES,
  JOB_TYPE_SET,
  type JobStatus,
  type JobType,
} from '@/lib/jobs/types';

// ── Row mapping ───────────────────────────────────────────────────────────────

export interface JobRow {
  id: string;
  orgId: string;
  type: JobType;
  status: JobStatus;
  priority: number;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  nextRunAt: string;
  claimedBy: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  dedupKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRow {
  id: string;
  orgId: string;
  workflowId: string;
  workflowName: string | null;
  name: string;
  cron: string;
  timezone: string;
  isActive: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function mapJobRow(row: Record<string, unknown>): JobRow {
  const type = String(row.type);
  const status = String(row.status);
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    type: (JOB_TYPE_SET.has(type) ? type : 'cleanup') as JobType,
    status: (JOB_STATUS_SET.has(status) ? status : 'pending') as JobStatus,
    priority: Number(row.priority),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    nextRunAt: toIso(row.next_run_at),
    claimedBy: row.claimed_by == null ? null : String(row.claimed_by),
    claimedAt: row.claimed_at == null ? null : toIso(row.claimed_at),
    heartbeatAt: row.heartbeat_at == null ? null : toIso(row.heartbeat_at),
    dedupKey: row.dedup_key == null ? null : String(row.dedup_key),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapScheduleRow(row: Record<string, unknown>): ScheduleRow {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    workflowId: String(row.workflow_id),
    workflowName: row.workflow_name == null ? null : String(row.workflow_name),
    name: String(row.name),
    cron: String(row.cron),
    timezone: String(row.timezone),
    isActive: Boolean(row.is_active),
    lastRunAt: row.last_run_at == null ? null : toIso(row.last_run_at),
    nextRunAt: row.next_run_at == null ? null : toIso(row.next_run_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const JOB_COLUMNS = sql`
  id, org_id, type, status, priority, payload, attempts, max_attempts,
  next_run_at, claimed_by, claimed_at, heartbeat_at, dedup_key,
  error_code, error_message, created_at, updated_at
`;

// ── Stats ─────────────────────────────────────────────────────────────────────

export interface JobsStats {
  pending: number;
  running: number;
  failed24h: number;
  deadLetter: number;
}

export async function getJobsStats(auth: Authorization): Promise<JobsStats> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{
      pending: string;
      running: string;
      failed24h: string;
      dead_letter: string;
    }>(sql`
      select
        count(*) filter (where status = 'pending') as pending,
        count(*) filter (where status in ('claimed', 'running')) as running,
        count(*) filter (where status = 'failed' and updated_at >= now() - interval '24 hours') as failed24h,
        count(*) filter (where status = 'dead_letter') as dead_letter
      from jobs
      where org_id = ${auth.ctx.orgId}
    `);
    const r = res.rows[0];
    return {
      pending: Number(r?.pending ?? 0),
      running: Number(r?.running ?? 0),
      failed24h: Number(r?.failed24h ?? 0),
      deadLetter: Number(r?.dead_letter ?? 0),
    };
  });
}

// ── List / detail ─────────────────────────────────────────────────────────────

export interface ListJobsOptions {
  status?: JobStatus;
  type?: JobType;
  limit?: number;
  offset?: number;
}

export function parseJobsFilter(params: { status?: string; type?: string }): ListJobsOptions {
  const status = JOB_STATUS_SET.has(params.status ?? '') ? (params.status as JobStatus) : undefined;
  const type = JOB_TYPE_SET.has(params.type ?? '') ? (params.type as JobType) : undefined;
  return { status, type, limit: 50, offset: 0 };
}

export async function listJobs(auth: Authorization, opts: ListJobsOptions): Promise<JobRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Record<string, unknown>>(sql`
      select ${JOB_COLUMNS} from jobs
      where org_id = ${auth.ctx.orgId}
        ${opts.status ? sql`and status = ${opts.status}` : sql``}
        ${opts.type ? sql`and type = ${opts.type}` : sql``}
      order by created_at desc
      limit ${limit} offset ${offset}
    `);
    return res.rows.map(mapJobRow);
  });
}

/** Zero rows → null (missing or another org's job — fail-closed). */
export async function getJob(auth: Authorization, jobId: string): Promise<JobRow | null> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Record<string, unknown>>(sql`
      select ${JOB_COLUMNS} from jobs
      where id = ${jobId} and org_id = ${auth.ctx.orgId}
    `);
    return res.rows[0] ? mapJobRow(res.rows[0]) : null;
  });
}

export async function listDeadLetterJobs(auth: Authorization, limit = 50): Promise<JobRow[]> {
  return listJobs(auth, { status: 'dead_letter', limit });
}

// ── Schedules ─────────────────────────────────────────────────────────────────

export async function listSchedules(auth: Authorization): Promise<ScheduleRow[]> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Record<string, unknown>>(sql`
      select s.id, s.org_id, s.workflow_id, w.name as workflow_name,
             s.name, s.cron, s.timezone, s.is_active,
             s.last_run_at, s.next_run_at, s.created_at, s.updated_at
      from schedules s
      left join workflows w on w.id = s.workflow_id and w.org_id = s.org_id
      where s.org_id = ${auth.ctx.orgId}
      order by s.created_at desc
    `);
    return res.rows.map(mapScheduleRow);
  });
}

export function getAuthContext(auth: Authorization): AuthContext {
  return auth.ctx;
}

// ── Payload sanitization ──────────────────────────────────────────────────────

/**
 * Secret-key patterns: values under these keys are redacted, never rendered.
 * Matches headers, tokens, passwords, signing material, and the webhook
 * payload's signatureSecretRef (a *reference*, but still never echoed raw).
 */
const SENSITIVE_KEY_PATTERN =
  /secret|password|passwd|pwd|token|api[-_ ]?key|apikey|credential|bearer|private|signature|signing|jwt|refresh[-_ ]?token|access[-_ ]?key|session[-_ ]?(id|key)|cookie|passphrase/i;

const MAX_STRING_LEN = 400;
const MAX_ARRAY_ITEMS = 50;
const MAX_JSON_CHARS = 60_000;

/** Recursively sanitize a payload for display: redact secrets, truncate long strings. */
export function sanitizePayload(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LEN ? value.slice(0, MAX_STRING_LEN) + '…' : value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map(sanitizePayload);
    return value.length > MAX_ARRAY_ITEMS
      ? [...items, `…(${value.length - MAX_ARRAY_ITEMS} more)`]
      : items;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '••• redacted •••' : sanitizePayload(v);
    }
    return out;
  }
  return value;
}

/** Sanitized payload rendered as bounded pretty JSON. */
export function sanitizedPayloadJson(payload: Record<string, unknown>): string {
  const json = JSON.stringify(sanitizePayload(payload), null, 2);
  return json.length > MAX_JSON_CHARS ? json.slice(0, MAX_JSON_CHARS) + '\n…(truncated)' : json;
}

/** One-line, bounded error excerpt for table cells. */
export function errorExcerpt(job: Pick<JobRow, 'errorCode' | 'errorMessage'>): string {
  const msg = job.errorMessage?.trim() ?? '';
  if (!msg) return job.errorCode ? `(${job.errorCode})` : '—';
  const oneLine = msg.replace(/\s+/g, ' ');
  return oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine;
}

// ── Status presentation ───────────────────────────────────────────────────────

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  pending: 'Pending',
  claimed: 'Claimed',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  dead_letter: 'Dead letter',
  cancelled: 'Cancelled',
};

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  workflow_run: 'Workflow run',
  scheduled_trigger: 'Scheduled trigger',
  retry: 'Retry',
  webhook: 'Webhook',
  cleanup: 'Cleanup',
  notification: 'Notification',
  email: 'Email',
};

export function jobStatusBadgeClass(status: JobStatus): string {
  switch (status) {
    case 'pending':
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
    case 'claimed':
    case 'running':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';
    case 'succeeded':
      return 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300';
    case 'failed':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
    case 'dead_letter':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300';
    case 'cancelled':
      return 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}

export { JOB_STATUSES, JOB_TYPES, type JobStatus, type JobType };
