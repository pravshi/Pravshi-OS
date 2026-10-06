/**
 * Phase 6 API data access — jobs + schedules (API Engineer owns this file).
 *
 * scheduler.ts does not exist yet, so schedule persistence lives here and
 * follows the Phase 6 §3.5 contract signatures (createSchedule(auth, input),
 * org-scoped reads, per-record NOT_FOUND).
 *
 * Rules, same as the queue core:
 *  - org_id is re-stated from auth.ctx on EVERY query — never from input.
 *  - The withPermission() gate in the routes runs BEFORE any validation:
 *    unauthorized callers get FORBIDDEN, never INVALID_REQUEST.
 *  - A row the caller cannot see surfaces as NOT_FOUND (never a leak).
 *  - Job state transitions are enforced by src/lib/jobs/queue.ts
 *    (retryJob/cancelJob); cron/timezone are validated at this boundary
 *    with src/lib/jobs/cron.ts (per the 0045 design notes).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { AuthorizationError } from '@/lib/authz/errors';
import type { Authorization } from '@/lib/authz/require-permission';
import { isValidCron, isValidTimezone, nextRunAt } from '@/lib/jobs/cron';
import { JOB_TYPE_SET, type Job, type JobStatus, type JobType } from '@/lib/jobs/types';
import { auditJobsMutation } from '@/lib/jobs/audit';

function notFound(): AuthorizationError {
  return new AuthorizationError('NOT_FOUND', {
    requestId: randomUUID(),
    reason: 'TARGET_NOT_VISIBLE',
  });
}

function isPgCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function toIsoOrNull(value: unknown): string | null {
  return value == null ? null : toIso(value);
}

// ── jobs ──────────────────────────────────────────────────────────────────────

const JOB_COLUMNS = sql`
  id, org_id, type, status, priority, payload, attempts, max_attempts,
  next_run_at, claimed_by, claimed_at, heartbeat_at, dedup_key,
  error_code, error_message, created_at, updated_at
`;

/** Raw `jobs` row → Job contract type (mirrors queue.ts mapping). */
function mapJobRow(row: Record<string, unknown>): Job {
  const type = String(row.type);
  if (!JOB_TYPE_SET.has(type)) {
    throw new Error(`INTERNAL: unknown job type '${type}' in database`);
  }
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    type: type as JobType,
    status: String(row.status) as JobStatus,
    priority: Number(row.priority),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    nextRunAt: toIso(row.next_run_at),
    claimedBy: row.claimed_by == null ? null : String(row.claimed_by),
    claimedAt: toIsoOrNull(row.claimed_at),
    heartbeatAt: toIsoOrNull(row.heartbeat_at),
    dedupKey: row.dedup_key == null ? null : String(row.dedup_key),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export interface JobListFilters {
  status?: JobStatus;
  type?: JobType;
  page: number;
  limit: number;
}

/** Org-scoped paginated job list, newest first. */
export async function listJobs(
  auth: Authorization,
  filters: JobListFilters,
): Promise<{ jobs: Job[]; total: number }> {
  const orgId = auth.ctx.orgId;
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const conds = [sql`org_id = ${orgId}`];
    if (filters.status !== undefined) conds.push(sql`status = ${filters.status}`);
    if (filters.type !== undefined) conds.push(sql`type = ${filters.type}`);
    const where = sql.join(conds, sql` and `);

    const countRows = await tx.execute<{ count: string }>(
      sql`select count(*)::text as count from jobs where ${where}`,
    );
    const total = Number(countRows.rows[0]?.count ?? '0');

    const offset = (filters.page - 1) * filters.limit;
    const rows = await tx.execute<Record<string, unknown>>(sql`
      select ${JOB_COLUMNS} from jobs
      where ${where}
      order by created_at desc
      limit ${filters.limit} offset ${offset}
    `);
    return { jobs: rows.rows.map(mapJobRow), total };
  });
}

/** One job, org-scoped. Zero rows → NOT_FOUND (missing or another org's). */
export async function getJob(auth: Authorization, jobId: string): Promise<Job> {
  const row = await withAuthorizedDb(
    auth.ctx,
    async (tx) =>
      (
        await tx.execute<Record<string, unknown>>(sql`
        select ${JOB_COLUMNS} from jobs
        where id = ${jobId} and org_id = ${auth.ctx.orgId}
      `)
      ).rows[0] ?? null,
  );
  if (!row) throw notFound();
  return mapJobRow(row);
}

// ── schedules ─────────────────────────────────────────────────────────────────

export interface Schedule {
  id: string;
  orgId: string;
  workflowId: string;
  name: string;
  cron: string;
  timezone: string;
  isActive: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const SCHEDULE_COLUMNS = sql`
  id, org_id, workflow_id, name, cron, timezone, is_active,
  last_run_at, next_run_at, created_by, created_at, updated_at
`;

function mapScheduleRow(row: Record<string, unknown>): Schedule {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    workflowId: String(row.workflow_id),
    name: String(row.name),
    cron: String(row.cron),
    timezone: String(row.timezone),
    isActive: row.is_active === true,
    lastRunAt: toIsoOrNull(row.last_run_at),
    nextRunAt: toIsoOrNull(row.next_run_at),
    createdBy: row.created_by == null ? null : String(row.created_by),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const cronField = z.string().refine(isValidCron, 'cron must be a valid 5-field cron expression');
const timezoneField = z.string().refine(isValidTimezone, 'timezone must be a valid IANA timezone');

/** Phase 6 §3.5 ScheduleInput, validated at the API boundary. */
export const CreateScheduleSchema = z.strictObject({
  workflowId: z.string().uuid(),
  name: z.string().min(1).max(200),
  cron: cronField,
  timezone: timezoneField.default('UTC'),
  isActive: z.boolean().default(true),
});

export async function createSchedule(auth: Authorization, input: unknown): Promise<Schedule> {
  const parsed = CreateScheduleSchema.parse(input);
  const next = computeNextRun(parsed.cron, parsed.timezone);

  try {
    const schedule = await withAuthorizedDb(auth.ctx, async (tx) => {
      const rows = await tx.execute<Record<string, unknown>>(sql`
        insert into schedules
          (org_id, workflow_id, name, cron, timezone, is_active, next_run_at, created_by)
        values
          (${auth.ctx.orgId}, ${parsed.workflowId}, ${parsed.name}, ${parsed.cron},
           ${parsed.timezone}, ${parsed.isActive}, ${next.toISOString()}::timestamptz,
           ${auth.ctx.personId})
        returning ${SCHEDULE_COLUMNS}
      `);
      const row = rows.rows[0];
      if (!row) throw new Error('INTERNAL: schedule insert returned no row');
      return mapScheduleRow(row);
    });
    // Audited after the insert commits (own transaction, fail-open).
    await auditJobsMutation(auth, {
      action: 'schedule.created',
      entityType: 'schedule',
      entityId: schedule.id,
      severity: 'LOW',
      metadata: {
        name: schedule.name,
        workflowId: schedule.workflowId,
        cron: schedule.cron,
        timezone: schedule.timezone,
        isActive: schedule.isActive,
      },
    });
    return schedule;
  } catch (error) {
    // 23503: workflow_id does not exist. 42501: the org-guard trigger rejected
    // a foreign-org workflow. Both are "not visible" to this caller.
    if (isPgCode(error, '23503') || isPgCode(error, '42501')) throw notFound();
    throw error;
  }
}

/** nextRunAt() throws on unsatisfiable cron — surface that as INVALID_REQUEST. */
function computeNextRun(cron: string, timezone: string): Date {
  try {
    return nextRunAt(cron, timezone);
  } catch (error) {
    throw new Error(`INVALID_REQUEST: ${(error as Error).message}`);
  }
}

export interface ScheduleListFilters {
  isActive?: boolean;
  page: number;
  limit: number;
}

/** Org-scoped paginated schedule list, newest first. */
export async function listSchedules(
  auth: Authorization,
  filters: ScheduleListFilters,
): Promise<{ schedules: Schedule[]; total: number }> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const conds = [sql`org_id = ${auth.ctx.orgId}`];
    if (filters.isActive !== undefined) conds.push(sql`is_active = ${filters.isActive}`);
    const where = sql.join(conds, sql` and `);

    const countRows = await tx.execute<{ count: string }>(
      sql`select count(*)::text as count from schedules where ${where}`,
    );
    const total = Number(countRows.rows[0]?.count ?? '0');

    const offset = (filters.page - 1) * filters.limit;
    const rows = await tx.execute<Record<string, unknown>>(sql`
      select ${SCHEDULE_COLUMNS} from schedules
      where ${where}
      order by created_at desc
      limit ${filters.limit} offset ${offset}
    `);
    return { schedules: rows.rows.map(mapScheduleRow), total };
  });
}

/** One schedule, org-scoped. Zero rows → NOT_FOUND (missing or another org's). */
export async function getSchedule(auth: Authorization, scheduleId: string): Promise<Schedule> {
  const row = await withAuthorizedDb(
    auth.ctx,
    async (tx) =>
      (
        await tx.execute<Record<string, unknown>>(sql`
        select ${SCHEDULE_COLUMNS} from schedules
        where id = ${scheduleId} and org_id = ${auth.ctx.orgId}
      `)
      ).rows[0] ?? null,
  );
  if (!row) throw notFound();
  return mapScheduleRow(row);
}

export const UpdateScheduleSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  cron: cronField.optional(),
  timezone: timezoneField.optional(),
  isActive: z.boolean().optional(),
});

export async function updateSchedule(
  auth: Authorization,
  scheduleId: string,
  input: unknown,
): Promise<Schedule> {
  const parsed = UpdateScheduleSchema.parse(input);
  if (
    parsed.name === undefined &&
    parsed.cron === undefined &&
    parsed.timezone === undefined &&
    parsed.isActive === undefined
  ) {
    throw new Error('INVALID_REQUEST: nothing to update');
  }

  const updated = await withAuthorizedDb(auth.ctx, async (tx) => {
    // Visibility probe first: missing or another org's → NOT_FOUND.
    const current = await tx.execute<Record<string, unknown>>(sql`
      select ${SCHEDULE_COLUMNS} from schedules
      where id = ${scheduleId} and org_id = ${auth.ctx.orgId}
    `);
    const row = current.rows[0];
    if (!row) throw notFound();
    const schedule = mapScheduleRow(row);
    const beforeIsActive = schedule.isActive;

    // A changed cron or timezone shifts the firing plan; recompute the next
    // run. Activating a schedule whose next run is unknown does too.
    const cronChanged = parsed.cron !== undefined && parsed.cron !== schedule.cron;
    const tzChanged = parsed.timezone !== undefined && parsed.timezone !== schedule.timezone;
    let nextRun: Date | null = null;
    if (cronChanged || tzChanged) {
      nextRun = computeNextRun(parsed.cron ?? schedule.cron, parsed.timezone ?? schedule.timezone);
    } else if (parsed.isActive === true && schedule.nextRunAt === null) {
      nextRun = computeNextRun(schedule.cron, schedule.timezone);
    }

    const sets = [
      parsed.name !== undefined ? sql`name = ${parsed.name}` : null,
      parsed.cron !== undefined ? sql`cron = ${parsed.cron}` : null,
      parsed.timezone !== undefined ? sql`timezone = ${parsed.timezone}` : null,
      parsed.isActive !== undefined ? sql`is_active = ${parsed.isActive}` : null,
      nextRun !== null ? sql`next_run_at = ${nextRun.toISOString()}::timestamptz` : null,
    ].filter((s): s is NonNullable<typeof s> => s !== null);

    const rows = await tx.execute<Record<string, unknown>>(sql`
      update schedules
      set ${sql.join(sets, sql`, `)}, updated_at = now()
      where id = ${scheduleId} and org_id = ${auth.ctx.orgId}
      returning ${SCHEDULE_COLUMNS}
    `);
    const updatedRow = rows.rows[0];
    if (!updatedRow) throw notFound(); // RLS fail-closed: treat as invisible
    return { schedule: mapScheduleRow(updatedRow), beforeIsActive };
  });
  // Audited after the update commits (own transaction, fail-open).
  await auditJobsMutation(auth, {
    action: 'schedule.updated',
    entityType: 'schedule',
    entityId: scheduleId,
    severity: 'LOW',
    metadata: {
      fields: Object.keys(parsed).join(','),
      isActive: `${updated.beforeIsActive}->${updated.schedule.isActive}`,
    },
  });
  return updated.schedule;
}

/**
 * DELETE has no RLS policy by design (0045): schedules deactivate via
 * is_active and history purges go through a retention cleanup job, not
 * app_user. So DELETE deactivates — the Phase 5 soft-delete convention —
 * rather than deleting the row.
 */
export async function deleteSchedule(auth: Authorization, scheduleId: string): Promise<void> {
  await withAuthorizedDb(auth.ctx, async (tx) => {
    const rows = await tx.execute(sql`
      update schedules
      set is_active = false, updated_at = now()
      where id = ${scheduleId} and org_id = ${auth.ctx.orgId}
    `);
    if ((rows.rowCount ?? 0) === 0) throw notFound();
  });
  // Audited after the deactivation commits (own transaction, fail-open).
  await auditJobsMutation(auth, {
    action: 'schedule.deleted',
    entityType: 'schedule',
    entityId: scheduleId,
    severity: 'MEDIUM',
    metadata: { deactivated: true },
  });
}
