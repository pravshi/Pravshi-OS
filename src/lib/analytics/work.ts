import { sql, type SQL } from 'drizzle-orm';
import { withAuthorizedDb, type Tx } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/db/context';
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
  type TaskStatus,
} from '@/lib/work/schema';

/**
 * Work / project / task analytics (Phase 7).
 *
 * ── TRUST BOUNDARIES ─────────────────────────────────────────────────────────
 *
 *  - org_id ALWAYS comes from ctx.orgId (the session), never from the caller;
 *    every query re-states the org predicate explicitly (defense in depth over
 *    RLS), and every query runs through withAuthorizedDb() — THE ONLY PATH TO
 *    POSTGRES — so RLS policies evaluate under the caller's identity.
 *    Phase 12 (F-12-01): each metric also accepts an optional trailing
 *    `tx?: Tx`; a composing route may pass ONE shared withAuthorizedDb
 *    transaction for the whole dashboard instead of one per metric. The
 *    transaction is always a withAuthorizedDb transaction — identity and
 *    RLS evaluation are unchanged; only the snapshot is shared.
 *  - Routes own permission gating: call these functions only after
 *    requirePermission() has granted `tasks.view` (task metrics) or
 *    `projects.view` (project metrics). Pass `auth.ctx` in.
 *  - All filter values are parameterized through drizzle `sql` templates —
 *    no string interpolation of caller input into SQL text, ever.
 *  - Callers (routes) validate enums/UUIDs with the work zod schemas before
 *    calling; date strings are re-validated here because they drive
 *    generate_series bounds (an unbounded range would be a DoS vector).
 *
 * ── KNOWN LIMITATIONS (per the Phase 7 metric contracts) ─────────────────────
 *
 *  - Projects have NO status column — project health is reported from the
 *    `is_archived` boolean only (active = is_archived=false, archived =
 *    is_archived=true, both with deleted_at IS NULL).
 *  - Task cycle time is NOT implemented: no `completed_at` column exists on
 *    work_tasks. `getTaskCompletionTrend()` proxies completion with
 *    `updated_at` of rows whose status='done' — a task edited after completion
 *    lands in a later bucket. Document this in the UI; do not present it as
 *    exact completion timestamps.
 *  - Bucket dates are UTC calendar days (updated_at is timestamptz).
 */

/** Filter bag shared by the task-level metrics. Every field is optional. */
export type WorkFilters = {
  /** Restrict to one project. */
  projectId?: string;
  /** Restrict to tasks assigned to one person. */
  assigneePersonId?: string;
  /** Restrict to one priority. */
  priority?: TaskPriority;
  /** Restrict to one status. */
  status?: TaskStatus;
  /** Due-date window, YYYY-MM-DD. */
  dueBefore?: string;
  dueAfter?: string;
  /** Creation window, YYYY-MM-DD. */
  createdFrom?: string;
  createdTo?: string;
};

export type ProjectStats = {
  active: number;
  archived: number;
  total: number;
};

/** Counts for every status bucket — always includes all three, zeros included. */
export type TaskStatusCounts = Record<TaskStatus, number>;

/** Counts for every priority bucket — always includes all four, zeros included. */
export type TaskPriorityCounts = Record<TaskPriority, number>;

export type OverdueTaskRow = {
  id: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  /** YYYY-MM-DD. */
  dueDate: string;
  assigneePersonId: string | null;
  assigneeName: string | null;
};

/** Paginated list envelope (mirrors the work Phase 4 Page<T> convention). */
export type MetricPage<T> = {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
};

export type AssigneeWorkloadRow = {
  assigneePersonId: string | null;
  /** null when the row is the unassigned bucket or the person is gone. */
  assigneeName: string | null;
  todo: number;
  inProgress: number;
  done: number;
  total: number;
};

export type TrendGranularity = 'day' | 'week';

export type TaskCompletionTrendInput = {
  /** Inclusive start, YYYY-MM-DD. */
  from: string;
  /** Inclusive end, YYYY-MM-DD. */
  to: string;
  granularity?: TrendGranularity;
};

export type TrendBucket = {
  /** Bucket start, YYYY-MM-DD. */
  bucket: string;
  completed: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Guard date strings at the analytics boundary (drives ::date casts + generate_series). */
function assertDateString(value: string, field: string): void {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`INVALID_REQUEST: ${field} must be YYYY-MM-DD`);
  }
}

function assertTaskFilters(f: WorkFilters): void {
  if (f.status !== undefined && !TASK_STATUSES.includes(f.status)) {
    throw new Error(`INVALID_REQUEST: unknown status ${f.status}`);
  }
  if (f.priority !== undefined && !TASK_PRIORITIES.includes(f.priority)) {
    throw new Error(`INVALID_REQUEST: unknown priority ${f.priority}`);
  }
  if (f.dueBefore !== undefined) assertDateString(f.dueBefore, 'dueBefore');
  if (f.dueAfter !== undefined) assertDateString(f.dueAfter, 'dueAfter');
  if (f.createdFrom !== undefined) assertDateString(f.createdFrom, 'createdFrom');
  if (f.createdTo !== undefined) assertDateString(f.createdTo, 'createdTo');
}

/**
 * Parameterized task filter fragments. `alias` is always a code constant
 * ('t'), never caller input.
 */
function taskFilterSql(f: WorkFilters, alias = 't'): SQL[] {
  assertTaskFilters(f);
  const a = sql.raw(alias);
  const clauses: SQL[] = [];
  if (f.projectId !== undefined) clauses.push(sql`${a}.project_id = ${f.projectId}::uuid`);
  if (f.assigneePersonId !== undefined)
    clauses.push(sql`${a}.assignee_person_id = ${f.assigneePersonId}::uuid`);
  if (f.priority !== undefined) clauses.push(sql`${a}.priority = ${f.priority}`);
  if (f.status !== undefined) clauses.push(sql`${a}.status = ${f.status}`);
  if (f.dueBefore !== undefined) clauses.push(sql`${a}.due_date < ${f.dueBefore}::date`);
  if (f.dueAfter !== undefined) clauses.push(sql`${a}.due_date >= ${f.dueAfter}::date`);
  if (f.createdFrom !== undefined) clauses.push(sql`${a}.created_at >= ${f.createdFrom}::date`);
  if (f.createdTo !== undefined)
    clauses.push(sql`${a}.created_at < (${f.createdTo}::date + interval '1 day')`);
  return clauses;
}

/** Joins optional fragments with `and`. */
function andAll(clauses: SQL[]): SQL {
  if (clauses.length === 0) return sql``;
  return sql` and ${sql.join(clauses, sql` and `)}`;
}

const ASSIGNEE_NAME = sql`coalesce(per.preferred_name, per.full_legal_name)`;

// ── Projects ─────────────────────────────────────────────────────────────────

/**
 * Project counts for the caller's org. Active = is_archived=false,
 * archived = is_archived=true; total counts every live (non-soft-deleted)
 * project. Supports an optional creation window only — projects have no
 * status, priority, or due date to filter on.
 *
 * PERMISSION: projects.view (enforced by the route).
 */
export async function getProjectStats(
  ctx: AuthContext,
  filters: Pick<WorkFilters, 'createdFrom' | 'createdTo'> = {},
  tx?: Tx,
): Promise<ProjectStats> {
  if (filters.createdFrom !== undefined) assertDateString(filters.createdFrom, 'createdFrom');
  if (filters.createdTo !== undefined) assertDateString(filters.createdTo, 'createdTo');
  const extra: SQL[] = [];
  if (filters.createdFrom !== undefined)
    extra.push(sql`p.created_at >= ${filters.createdFrom}::date`);
  if (filters.createdTo !== undefined)
    extra.push(sql`p.created_at < (${filters.createdTo}::date + interval '1 day')`);

  const execute = (db: Tx) =>
    db.execute<{ active: number; archived: number; total: number }>(sql`
      select
        count(*) filter (where p.is_archived = false)::int as active,
        count(*) filter (where p.is_archived = true)::int  as archived,
        count(*)::int                                       as total
      from public.work_projects p
      where p.org_id = ${ctx.orgId}::uuid
        and p.deleted_at is null
        ${andAll(extra)}
    `);
  const res = tx ? await execute(tx) : await withAuthorizedDb(ctx, execute);
  const row = res.rows[0] ?? { active: 0, archived: 0, total: 0 };
  return { active: row.active, archived: row.archived, total: row.total };
}

// ── Tasks by status / priority ───────────────────────────────────────────────

/**
 * Task counts per status (todo / in_progress / done). All three buckets are
 * always returned, zeros included, so UI chips never need null handling.
 * Soft-deleted tasks are excluded.
 *
 * PERMISSION: tasks.view (enforced by the route).
 */
export async function getTasksByStatus(
  ctx: AuthContext,
  filters: Omit<WorkFilters, 'status'> = {},
  tx?: Tx,
): Promise<TaskStatusCounts> {
  const execute = (db: Tx) =>
    db.execute<{ todo: number; in_progress: number; done: number }>(sql`
      select
        count(*) filter (where t.status = 'todo')::int        as todo,
        count(*) filter (where t.status = 'in_progress')::int  as in_progress,
        count(*) filter (where t.status = 'done')::int         as done
      from public.work_tasks t
      where t.org_id = ${ctx.orgId}::uuid
        and t.deleted_at is null
        ${andAll(taskFilterSql(filters))}
    `);
  const res = tx ? await execute(tx) : await withAuthorizedDb(ctx, execute);
  const row = res.rows[0] ?? { todo: 0, in_progress: 0, done: 0 };
  return { todo: row.todo, in_progress: row.in_progress, done: row.done };
}

/**
 * Task counts per priority (low / medium / high / urgent). All four buckets
 * are always returned, zeros included.
 *
 * PERMISSION: tasks.view (enforced by the route).
 */
export async function getTasksByPriority(
  ctx: AuthContext,
  filters: Omit<WorkFilters, 'priority'> = {},
  tx?: Tx,
): Promise<TaskPriorityCounts> {
  const execute = (db: Tx) =>
    db.execute<{ low: number; medium: number; high: number; urgent: number }>(sql`
      select
        count(*) filter (where t.priority = 'low')::int    as low,
        count(*) filter (where t.priority = 'medium')::int  as medium,
        count(*) filter (where t.priority = 'high')::int    as high,
        count(*) filter (where t.priority = 'urgent')::int  as urgent
      from public.work_tasks t
      where t.org_id = ${ctx.orgId}::uuid
        and t.deleted_at is null
        ${andAll(taskFilterSql(filters))}
    `);
  const res = tx ? await execute(tx) : await withAuthorizedDb(ctx, execute);
  const row = res.rows[0] ?? { low: 0, medium: 0, high: 0, urgent: 0 };
  return { low: row.low, medium: row.medium, high: row.high, urgent: row.urgent };
}

// ── Overdue tasks ────────────────────────────────────────────────────────────

/**
 * Overdue tasks: due_date < CURRENT_DATE AND status != 'done'. Tasks without
 * a due date are never overdue. Most-overdue first.
 *
 * INDEX: the (org_id, due_date) leading predicate matches
 * `work_tasks_due_date_idx (org_id, due_date) WHERE deleted_at IS NULL`, so
 * this stays an index range scan, not a full-org scan, as orgs grow.
 *
 * PERMISSION: tasks.view (enforced by the route).
 */
export async function getOverdueTasks(
  ctx: AuthContext,
  opts: { limit?: number; offset?: number } = {},
  tx?: Tx,
): Promise<MetricPage<OverdueTaskRow>> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const run = async (db: Tx): Promise<MetricPage<OverdueTaskRow>> => {
    const base = sql`
      from public.work_tasks t
      left join public.work_projects pr
        on pr.id = t.project_id
       and pr.org_id = t.org_id
       and pr.deleted_at is null
      left join public.people per
        on per.id = t.assignee_person_id
      where t.org_id = ${ctx.orgId}::uuid
        and t.deleted_at is null
        and t.due_date < CURRENT_DATE
        and t.status <> 'done'
    `;
    const [totalRes, rowsRes] = await Promise.all([
      db.execute<{ total: number }>(sql`select count(*)::int as total ${base}`),
      db.execute<OverdueTaskRow>(sql`
        select
          t.id,
          t.title,
          t.project_id as "projectId",
          pr.name as "projectName",
          t.status,
          t.priority,
          t.due_date::text as "dueDate",
          t.assignee_person_id as "assigneePersonId",
          ${ASSIGNEE_NAME} as "assigneeName"
        ${base}
        order by t.due_date asc, t.priority desc, t.id asc
        limit ${limit} offset ${offset}
      `),
    ]);
    return { rows: rowsRes.rows, total: totalRes.rows[0]?.total ?? 0, limit, offset };
  };
  return tx ? run(tx) : withAuthorizedDb(ctx, run);
}

// ── Tasks by assignee ────────────────────────────────────────────────────────

/**
 * Task workload grouped by assignee_person_id. The null group is the
 * unassigned bucket (assigneeName is null there). Rows ordered by total
 * descending so the busiest assignees come first.
 *
 * PERMISSION: tasks.view (enforced by the route).
 */
export async function getTasksByAssignee(
  ctx: AuthContext,
  filters: Omit<WorkFilters, 'assigneePersonId'> = {},
  tx?: Tx,
): Promise<AssigneeWorkloadRow[]> {
  const execute = (db: Tx) =>
    db.execute<AssigneeWorkloadRow>(sql`
      select
        t.assignee_person_id as "assigneePersonId",
        ${ASSIGNEE_NAME} as "assigneeName",
        count(*) filter (where t.status = 'todo')::int       as todo,
        count(*) filter (where t.status = 'in_progress')::int as "inProgress",
        count(*) filter (where t.status = 'done')::int        as done,
        count(*)::int                                          as total
      from public.work_tasks t
      left join public.people per
        on per.id = t.assignee_person_id
      where t.org_id = ${ctx.orgId}::uuid
        and t.deleted_at is null
        ${andAll(taskFilterSql(filters))}
      group by 1, 2
      order by total desc, "assigneeName" asc nulls last, 1
    `);
  const res = tx ? await execute(tx) : await withAuthorizedDb(ctx, execute);
  return res.rows;
}

// ── Completion trend ─────────────────────────────────────────────────────────

/**
 * Tasks completed over time. LIMITATION (no completed_at column exists): a
 * task counts in the bucket containing its `updated_at` while its status is
 * 'done'. A task edited after completion shifts to a later bucket, and a task
 * completed before `from` but touched inside the range counts in the range —
 * this is an approximation, not an exact completion log. Buckets with zero
 * completions are included (zero-filled series).
 *
 * The range is capped at 370 days to keep generate_series bounded.
 *
 * PERMISSION: tasks.view (enforced by the route).
 */
export async function getTaskCompletionTrend(
  ctx: AuthContext,
  range: TaskCompletionTrendInput,
  filters: Omit<WorkFilters, 'status' | 'createdFrom' | 'createdTo'> = {},
  tx?: Tx,
): Promise<TrendBucket[]> {
  const granularity: TrendGranularity = range.granularity ?? 'day';
  if (granularity !== 'day' && granularity !== 'week') {
    throw new Error(`INVALID_REQUEST: granularity must be 'day' or 'week'`);
  }
  assertDateString(range.from, 'from');
  assertDateString(range.to, 'to');
  if (range.from > range.to) {
    throw new Error('INVALID_REQUEST: from must be <= to');
  }
  const spanDays = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000;
  if (spanDays > 370) {
    throw new Error('INVALID_REQUEST: range must be <= 370 days');
  }

  // Whitelisted interval — granularity is an enum, never caller SQL text.
  const step: SQL = granularity === 'week' ? sql`interval '7 days'` : sql`interval '1 day'`;

  const execute = (db: Tx) =>
    db.execute<TrendBucket>(sql`
      with bounds as (
        select ${range.from}::date as start_d, ${range.to}::date as end_d
      ),
      buckets as (
        select (generate_series(start_d, end_d, ${step}))::date as day
        from bounds
      )
      select
        to_char(b.day, 'YYYY-MM-DD') as bucket,
        count(t.id)::int as completed
      from buckets b
      left join public.work_tasks t
        on t.status = 'done'
       and t.updated_at >= b.day
       and t.updated_at < b.day + ${step}
       and t.org_id = ${ctx.orgId}::uuid
       and t.deleted_at is null
       ${andAll(taskFilterSql(filters, 't'))}
      group by b.day
      order by b.day
    `);
  const res = tx ? await execute(tx) : await withAuthorizedDb(ctx, execute);
  return res.rows;
}
