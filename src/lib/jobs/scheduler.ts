/**
 * Phase 6 Scheduler — cron-like schedules that the tick turns into jobs.
 *
 * Owner: Scheduler Tick Engineer. Other agents MUST NOT modify this file.
 *
 * ── AUTHORITY MODEL ──────────────────────────────────────────────────────────
 * createSchedule / pauseSchedule / resumeSchedule / deleteSchedule run on the
 * REQUEST plane: they take an Authorization, stamp org_id from auth.ctx
 * (never from input), and gate on permissions BEFORE validation (FORBIDDEN
 * before INVALID_REQUEST, per the queue.ts convention).
 *
 * tickScheduler runs on the WORKER plane: its contract signature carries no
 * Authorization, because a tick fires schedules across ALL orgs. RLS is
 * FORCED on public.schedules, so plain SQL through a pooled connection is
 * fail-closed (zero rows). The privilege path is two SECURITY DEFINER
 * functions from drizzle/0046_scheduler_tick.sql (the jobs_claim_next()
 * pattern from 0045):
 *   scheduler_tick_claim(p_now) — due-schedule scan (FOR UPDATE, row-locked)
 *   scheduler_tick_fire(...)    — enqueue + schedule-advance, atomic
 *
 * The tick holds pg_advisory_xact_lock(hashtext('scheduler-tick')) for the
 * whole transaction, so concurrent tick instances serialize. On top of that,
 * each fired job carries dedup_key `sched:<scheduleId>:<windowStart>` (the
 * window is the SCHEDULED time, minute-precision UTC — never now()), and the
 * fire function re-checks due-ness under the row lock. A double tick is an
 * idempotent no-op on both layers.
 */
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { withAuthorizedDb, type Tx } from '../db/authorized';
import { connectWithWake } from '../db/pool';
import type { Authorization } from '../authz/require-permission';
import { AuthorizationError } from '../authz/errors';
import { cronWindowStart, isValidCron, isValidTimezone, nextRunAt } from './cron';

// ── Permissions (seeded by 0045; names frozen by contract §2.5) ───────────────

const PERM_CREATE = 'jobs.create';
const PERM_DELETE = 'jobs.delete';

/**
 * Permission gate BEFORE validation — mirrors queue.ts requireJobPermission:
 * a caller without the permission gets FORBIDDEN even when the input would
 * also fail validation.
 */
async function requireSchedulePermission(auth: Authorization, permission: string): Promise<void> {
  const check = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ ok: boolean }>(sql`select authz.has(${permission}) as ok`),
  );
  if (check.rows[0]?.ok !== true) {
    throw new AuthorizationError('FORBIDDEN', {
      requestId: auth.requestId,
      reason: 'PERMISSION_DENIED',
    });
  }
}

/** Worker-plane transaction: pooled connection, no per-request identity
 *  (there is no user on the tick path — see header note). */
async function withSchedulerDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await connectWithWake();
  try {
    const db = drizzle(client);
    return await db.transaction(fn);
  } finally {
    client.release();
  }
}

function invalidRequest(message: string): Error {
  return new Error(`INVALID_REQUEST: ${message}`);
}

function notFound(): AuthorizationError {
  return new AuthorizationError('NOT_FOUND', {
    requestId: '00000000-0000-4000-8000-000000000000',
    reason: 'TARGET_NOT_VISIBLE',
    // The error is intentionally generic: missing vs. other-org is indistinguishable
  });
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

// ── Schedule contract type ────────────────────────────────────────────────────

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
  createdAt: string;
  updatedAt: string;
}

const SCHEDULE_COLUMNS = sql`
  id, org_id, workflow_id, name, cron, timezone, is_active,
  last_run_at, next_run_at, created_at, updated_at
`;

/** Raw `schedules` row → Schedule contract type. */
function mapScheduleRow(row: Record<string, unknown>): Schedule {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    workflowId: String(row.workflow_id),
    name: String(row.name),
    cron: String(row.cron),
    timezone: String(row.timezone),
    isActive: row.is_active === true,
    lastRunAt: row.last_run_at == null ? null : toIso(row.last_run_at),
    nextRunAt: row.next_run_at == null ? null : toIso(row.next_run_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export interface ScheduleInput {
  workflowId: string;
  name: string;
  cron: string;
  timezone: string;
  isActive?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ScheduleInputSchema = z.strictObject({
  workflowId: z.string().regex(UUID_RE, 'workflowId must be a uuid'),
  name: z.string().min(1).max(200),
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64),
  isActive: z.boolean().default(true),
});

// ── create ────────────────────────────────────────────────────────────────────

/**
 * Create a cron schedule for a workflow. Permission: jobs.create.
 * - cron must be a strict 5-field expression (cron.ts)
 * - timezone must be a valid IANA name (cron.ts)
 * - workflowId must belong to the caller's org AND be ACTIVE (schedules only
 *   ever fire ACTIVE workflows; the DB trigger additionally rejects
 *   cross-org references). The lookup runs under the caller's RLS identity,
 *   so the caller also needs workflows.view to see the workflow — a workflow
 *   the caller cannot see (missing, deleted, or another org's) is NOT_FOUND.
 * - initial next_run_at is computed from the cron, strictly after creation
 */
export async function createSchedule(auth: Authorization, input: ScheduleInput): Promise<Schedule> {
  await requireSchedulePermission(auth, PERM_CREATE);

  let parsed: z.infer<typeof ScheduleInputSchema>;
  try {
    parsed = ScheduleInputSchema.parse(input);
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw invalidRequest(`invalid schedule input: ${e.message}`);
    }
    throw e;
  }
  if (!isValidCron(parsed.cron)) {
    throw invalidRequest(`invalid cron expression: "${parsed.cron}"`);
  }
  if (!isValidTimezone(parsed.timezone)) {
    throw invalidRequest(`invalid IANA timezone: "${parsed.timezone}"`);
  }

  const orgId = auth.ctx.orgId;
  const now = new Date();

  return withAuthorizedDb(auth.ctx, async (tx) => {
    // Workflow must exist, belong to this org, and be ACTIVE. RLS org-pins
    // the read; zero rows is indistinguishable from "other org's".
    const wf = await tx.execute<Record<string, unknown>>(sql`
      select id, status from public.workflows
      where id = ${parsed.workflowId}::uuid and org_id = ${orgId}::uuid
    `);
    const wfRow = wf.rows[0];
    if (!wfRow) {
      throw notFound();
    }
    if (String(wfRow.status) !== 'ACTIVE') {
      throw invalidRequest(
        `cannot schedule workflow ${parsed.workflowId}: status is '${wfRow.status}', must be ACTIVE`,
      );
    }

    const firstRun = nextRunAt(parsed.cron, parsed.timezone, now);
    const result = await tx.execute<Record<string, unknown>>(sql`
      insert into public.schedules
        (org_id, workflow_id, name, cron, timezone, is_active, next_run_at, created_by)
      values (
        ${orgId}::uuid,
        ${parsed.workflowId}::uuid,
        ${parsed.name},
        ${parsed.cron},
        ${parsed.timezone},
        ${parsed.isActive},
        ${firstRun.toISOString()}::timestamptz,
        ${auth.ctx.personId}::uuid
      )
      returning ${SCHEDULE_COLUMNS}
    `);
    const row = result.rows[0];
    if (!row) throw new Error('INTERNAL: schedule insert returned no row');
    return mapScheduleRow(row);
  });
}

/** Load one schedule, org-scoped. Zero rows → NOT_FOUND (missing or other org's). */
async function loadScheduleForUpdate(tx: Tx, orgId: string, scheduleId: string): Promise<Schedule> {
  const result = await tx.execute<Record<string, unknown>>(sql`
    select ${SCHEDULE_COLUMNS} from public.schedules
    where id = ${scheduleId}::uuid and org_id = ${orgId}::uuid
    for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw notFound();
  }
  return mapScheduleRow(row);
}

// ── pause / resume / delete ───────────────────────────────────────────────────

/** Deactivate a schedule (it stays in history; the tick skips inactive rows). */
export async function pauseSchedule(auth: Authorization, scheduleId: string): Promise<Schedule> {
  await requireSchedulePermission(auth, PERM_CREATE);
  return withAuthorizedDb(auth.ctx, async (tx) => {
    await loadScheduleForUpdate(tx, auth.ctx.orgId, scheduleId);
    const result = await tx.execute<Record<string, unknown>>(sql`
      update public.schedules
      set is_active = false, updated_at = now()
      where id = ${scheduleId}::uuid and org_id = ${auth.ctx.orgId}::uuid
      returning ${SCHEDULE_COLUMNS}
    `);
    const row = result.rows[0];
    if (!row) throw new Error('INTERNAL: pause schedule update returned no row');
    return mapScheduleRow(row);
  });
}

/** Reactivate a schedule. next_run_at is recomputed from the cron so a
 *  schedule paused for a long time does not fire a stale backlog. */
export async function resumeSchedule(auth: Authorization, scheduleId: string): Promise<Schedule> {
  await requireSchedulePermission(auth, PERM_CREATE);
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const schedule = await loadScheduleForUpdate(tx, auth.ctx.orgId, scheduleId);
    const next = nextRunAt(schedule.cron, schedule.timezone, new Date());
    const result = await tx.execute<Record<string, unknown>>(sql`
      update public.schedules
      set is_active = true,
          next_run_at = ${next.toISOString()}::timestamptz,
          updated_at = now()
      where id = ${scheduleId}::uuid and org_id = ${auth.ctx.orgId}::uuid
      returning ${SCHEDULE_COLUMNS}
    `);
    const row = result.rows[0];
    if (!row) throw new Error('INTERNAL: resume schedule update returned no row');
    return mapScheduleRow(row);
  });
}

/**
 * Hard-delete a schedule. There is intentionally NO delete RLS policy on
 * schedules (0045: deactivation is the lifecycle; purges run through a
 * retention cleanup job), so the delete itself goes through the
 * scheduler_admin_delete() SECURITY DEFINER function — after the caller's
 * jobs.delete permission AND the row's visibility to their org are verified
 * above (missing vs. other-org's schedule is indistinguishable: NOT_FOUND).
 */
export async function deleteSchedule(auth: Authorization, scheduleId: string): Promise<void> {
  await requireSchedulePermission(auth, PERM_DELETE);
  await withAuthorizedDb(auth.ctx, async (tx) => {
    // Visibility check under the caller's identity: the row must belong to
    // their org, otherwise NOT_FOUND (missing vs. other-org indistinguishable).
    await loadScheduleForUpdate(tx, auth.ctx.orgId, scheduleId);
  });
  await withSchedulerDb(async (tx) => {
    await tx.execute(sql`
      select public.scheduler_admin_delete(${scheduleId}::uuid)
    `);
  });
}

// ── tick ──────────────────────────────────────────────────────────────────────

/** Dedup key for one fired window: the window is the SCHEDULED time's
 *  minute-precision UTC (never now()), so re-ticks of the same window are
 *  the same key. */
export function scheduleDedupKey(scheduleId: string, scheduledAt: Date): string {
  return `sched:${scheduleId}:${cronWindowStart(scheduledAt)}`;
}

/**
 * Fire every due schedule exactly once per window. Worker plane: no
 * Authorization — the tick is global across orgs.
 *
 * Sequence (one transaction):
 *   1. pg_advisory_xact_lock(hashtext('scheduler-tick')) — serializes
 *      concurrent tick instances; transaction-scoped so it releases on
 *      commit/rollback even on crash.
 *   2. scheduler_tick_claim(now) — SECURITY DEFINER scan of due active
 *      schedules (row-locked FOR UPDATE).
 *   3. For each due row: fire via scheduler_tick_fire, which inserts one
 *      'scheduled_trigger' job (dedup_key `sched:<id>:<windowStart>`,
 *      INSERT ... ON CONFLICT DO NOTHING → double-fire is a no-op) and
 *      advances last_run_at / next_run_at from cron.ts.
 *
 * Returns the number of jobs newly enqueued by this tick.
 */
export async function tickScheduler(now: Date = new Date()): Promise<number> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw invalidRequest('tickScheduler requires a valid Date');
  }
  const firedAtIso = now.toISOString();

  return withSchedulerDb(async (tx) => {
    // 1. Serialize ticks across instances FIRST (contract §3.5).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('scheduler-tick'))`);

    // 2. Cross-org due scan through the SECURITY DEFINER privilege path.
    const due = await tx.execute<Record<string, unknown>>(sql`
      select ${SCHEDULE_COLUMNS}
      from public.scheduler_tick_claim(${firedAtIso}::timestamptz)
    `);

    // 3. Fire each due schedule.
    let enqueued = 0;
    for (const row of due.rows) {
      const schedule = mapScheduleRow(row);
      // The window is the SCHEDULED firing time (next_run_at on the row),
      // minute-precision UTC — not now(). A re-tick of the same window
      // produces the identical dedup key.
      const scheduledAt = new Date(schedule.nextRunAt as string);
      const windowStart = cronWindowStart(scheduledAt);
      const dedupKey = `sched:${schedule.id}:${windowStart}`;
      const next = nextRunAt(schedule.cron, schedule.timezone, now);
      const fired = await tx.execute<{ fired: boolean }>(sql`
        select public.scheduler_tick_fire(
          ${schedule.id}::uuid,
          ${firedAtIso}::timestamptz,
          ${next.toISOString()}::timestamptz,
          ${windowStart},
          ${dedupKey}
        ) as fired
      `);
      if (fired.rows[0]?.fired === true) enqueued += 1;
    }
    return enqueued;
  });
}
