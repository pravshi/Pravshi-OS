import { sql, type SQL } from 'drizzle-orm';
import { withAuthorizedDb, type Tx } from '@/lib/db/authorized';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';
import { writeAuditEntry } from '@/lib/audit/log';
import { buildDedupKey, dispatchWorkflowEvent } from '@/lib/workflows/events';
import { isPgCode, parseRequest } from './errors';
import {
  CreateTaskSchema,
  ListTasksQuerySchema,
  MoveTaskSchema,
  UpdateTaskSchema,
  type ListTasksQuery,
  type MoveTaskResult,
  type Page,
  type Task,
  type TaskSortField,
  type TaskStatus,
  type TaskWithSubtasks,
  type UpdateTaskInput,
} from './schema';

/**
 * Task service (Phase 4). Trust boundaries:
 *
 *  - org_id always comes from auth.ctx.orgId, never from the caller; every
 *    query re-states the org predicate explicitly (defense in depth over RLS)
 *  - created_by is stamped from auth.ctx.personId on insert, never from the body
 *  - the task's project_id must reference a live project in the caller's org:
 *    write paths (create/update) fail with 400 INVALID_REQUEST on a foreign
 *    project; read paths (list/get) use NOT_FOUND concealment via the
 *    visibility probe (mirroring src/lib/crm/refs.ts). A same-org race is
 *    backstopped by the 0042 trigger, whose 42501 maps to 400 INVALID_REQUEST
 *  - the assignee must be a live, visible person in the caller's org; write
 *    paths fail with 400 INVALID_REQUEST on a foreign assignee
 *  - moveTask() changes ONLY status — project_id is not accepted, so
 *    cross-project moves are impossible through it. Changing projects is PATCH
 *    with projectId (same-org validation above)
 *  - deleteTask() is soft only, via the probe + public.crm_soft_delete()
 *    two-step (same shape as src/lib/crm/soft-delete.ts). DEPENDENCY: the 0042
 *    migration must extend crm_soft_delete's allowlist with
 *    'task' → 'work_tasks' (migration 0037 pattern for 'pipeline'); otherwise
 *    the call raises 42501 'unknown soft-delete entity'
 *  - permission keys are the exact 0008 seed keys (tasks.view / create / edit /
 *    delete; tasks.assign covers assignment); the routes own the key choice
 */

const TASK_COLUMNS = sql`
  t.id,
  t.project_id as "projectId",
  pr.name as "projectName",
  t.title,
  t.description,
  t.status,
  t.priority,
  t.due_date::text as "dueDate",
  t.assignee_person_id as "assigneePersonId",
  coalesce(per.preferred_name, per.full_legal_name) as "assigneeName",
  t.parent_task_id as "parentTaskId",
  sc.total as "subtaskTotal",
  sc.completed as "subtaskCompleted",
  t.created_by as "createdBy",
  t.created_at as "createdAt",
  t.updated_at as "updatedAt"
`;

const TASK_FROM = sql`
  from public.work_tasks t
  left join public.work_projects pr
    on pr.id = t.project_id
   and pr.org_id = t.org_id
   and pr.deleted_at is null
  left join public.people per
    on per.id = t.assignee_person_id
  left join (
    select
      parent_task_id,
      org_id,
      count(*)::int as total,
      count(*) filter (where status = 'done')::int as completed
    from public.work_tasks
    where parent_task_id is not null
      and deleted_at is null
    group by parent_task_id, org_id
  ) sc on sc.parent_task_id = t.id and sc.org_id = t.org_id
`;

const TASK_WHERE = (auth: Authorization) => sql`
  t.org_id = ${auth.ctx.orgId}::uuid
  and t.deleted_at is null
`;

function searchWhere(search: string | undefined) {
  if (!search) return sql``;
  // Prefix ILIKE — the leading constant keeps the btree index on title usable.
  return sql` and t.title ilike ${search} || '%'`;
}

function taskSortSql(sort: TaskSortField, order: 'asc' | 'desc'): SQL {
  // sort/order come from the zod allowlist — never raw caller text.
  const dir = order === 'asc' ? sql`asc` : sql`desc`;
  switch (sort) {
    case 'title':
      return sql`t.title ${dir}, t.id asc`;
    case 'status':
      return sql`case t.status
          when 'todo' then 0
          when 'in_progress' then 1
          else 2
        end ${dir}, t.updated_at desc, t.id asc`;
    case 'priority':
      return sql`case t.priority
          when 'urgent' then 0
          when 'high' then 1
          when 'medium' then 2
          else 3
        end ${dir}, t.id asc`;
    case 'dueDate':
      return sql`t.due_date ${dir} nulls last, t.id asc`;
    case 'createdAt':
      return sql`t.created_at ${dir}, t.id asc`;
    case 'updatedAt':
      return sql`t.updated_at ${dir}, t.id asc`;
  }
}

/** The referenced project must be live and visible in the caller's org. */
async function assertProjectVisible(tx: Tx, auth: Authorization, projectId: string): Promise<void> {
  const res = await tx.execute(sql`
    select 1
    from public.work_projects p
    where p.id = ${projectId}::uuid
      and p.org_id = ${auth.ctx.orgId}::uuid
      and p.deleted_at is null
  `);
  await assertTargetAffected(auth, res.rowCount ?? 0);
}

/**
 * Write-path variant: a foreign project reference in a create/update is a
 * 400 INVALID_REQUEST, not 404 concealment. Read paths (list/get) keep the
 * NOT_FOUND probe above; writes name the bad reference explicitly so callers
 * can distinguish "bad request" from "invisible target".
 */
async function assertProjectVisibleForWrite(
  tx: Tx,
  auth: Authorization,
  projectId: string,
): Promise<void> {
  const res = await tx.execute(sql`
    select 1
    from public.work_projects p
    where p.id = ${projectId}::uuid
      and p.org_id = ${auth.ctx.orgId}::uuid
      and p.deleted_at is null
  `);
  if ((res.rowCount ?? 0) === 0) {
    throw new Error('INVALID_REQUEST: project not found in your organization');
  }
}

/**
 * Write-path variant for assignees: a foreign person reference in a
 * create/update/assign is a 400 INVALID_REQUEST, not 404 concealment.
 */
async function assertAssigneeVisibleForWrite(
  tx: Tx,
  auth: Authorization,
  personId: string,
): Promise<void> {
  const res = await tx.execute(sql`
    select 1
    from public.people per
    where per.id = ${personId}::uuid
  `);
  if ((res.rowCount ?? 0) === 0) {
    throw new Error('INVALID_REQUEST: assignee not found in your organization');
  }
}

/**
 * The parent task must be a live top-level task in the caller's org.
 * One level only: a subtask may never be a parent (enforced here, not just UI).
 */
async function assertParentTaskVisible(
  tx: Tx,
  auth: Authorization,
  parentTaskId: string,
  projectId: string | null | undefined,
): Promise<void> {
  const res = await tx.execute<{ project_id: string | null }>(sql`
    select t.project_id
    from public.work_tasks t
    where t.id = ${parentTaskId}::uuid
      and t.org_id = ${auth.ctx.orgId}::uuid
      and t.deleted_at is null
      and t.parent_task_id is null
  `);
  await assertTargetAffected(auth, res.rowCount ?? 0);
  // Subtask must live in the same project as its parent (or both unprojected).
  const parentProjectId = res.rows[0]?.project_id ?? null;
  const childProjectId = projectId ?? null;
  if (parentProjectId !== childProjectId) {
    throw new Error('INVALID_REQUEST: subtask must be in the same project as its parent task');
  }
}

/** Map a tasks write failure to the 400 it deserves; anything else rethrows. */
function invalidTaskWrite(error: unknown, projectChanged: boolean): never {
  if (isPgCode(error, '23503')) {
    throw new Error('INVALID_REQUEST: the referenced project or assignee does not exist');
  }
  if (isPgCode(error, '23514')) {
    throw new Error('INVALID_REQUEST: a value violates a database constraint');
  }
  if (isPgCode(error, '22008')) {
    throw new Error('INVALID_REQUEST: dueDate is not a valid calendar date');
  }
  if (isPgCode(error, '23505')) {
    throw new Error('INVALID_REQUEST: this task conflicts with an existing one');
  }
  if (projectChanged && isPgCode(error, '42501')) {
    // The 0042 same-org trigger backstop: the pre-write probe passed, so a
    // 42501 here means the target project left the caller's org mid-flight
    // (or the trigger rejected it) — a 400, never a 500.
    throw new Error('INVALID_REQUEST: the target project is not in your organization');
  }
  throw error;
}

export async function listTasks(auth: Authorization, input: unknown): Promise<Page<Task>> {
  const query: ListTasksQuery = parseRequest(ListTasksQuerySchema, input ?? {});
  const projectWhere = query.projectId ? sql` and t.project_id = ${query.projectId}::uuid` : sql``;
  const statusWhere = query.status ? sql` and t.status = ${query.status}` : sql``;
  const priorityWhere = query.priority ? sql` and t.priority = ${query.priority}` : sql``;
  const assigneeWhere = query.assigneePersonId
    ? sql` and t.assignee_person_id = ${query.assigneePersonId}::uuid`
    : sql``;
  const dueBeforeWhere = query.dueBefore ? sql` and t.due_date <= ${query.dueBefore}::date` : sql``;
  const dueAfterWhere = query.dueAfter ? sql` and t.due_date >= ${query.dueAfter}::date` : sql``;
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.execute<Task>(sql`
        select ${TASK_COLUMNS}
        ${TASK_FROM}
        where ${TASK_WHERE(auth)}
          ${searchWhere(query.search)} ${projectWhere} ${statusWhere}
          ${priorityWhere} ${assigneeWhere} ${dueBeforeWhere} ${dueAfterWhere}
        order by ${taskSortSql(query.sort, query.order)}
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.work_tasks t
        where ${TASK_WHERE(auth)}
          ${searchWhere(query.search)} ${projectWhere} ${statusWhere}
          ${priorityWhere} ${assigneeWhere} ${dueBeforeWhere} ${dueAfterWhere}
      `),
    ]);
    return {
      rows: rows.rows,
      total: counts.rows[0]?.total ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  });
}

/** Tasks assigned to the caller: the /mine endpoint. */
export async function listMyTasks(auth: Authorization, input: unknown): Promise<Page<Task>> {
  const query: ListTasksQuery = parseRequest(ListTasksQuerySchema, input ?? {});
  return listTasks(auth, { ...query, assigneePersonId: auth.ctx.personId });
}

/** Tasks in one project: the project-tasks endpoint forces projectId from the path. */
export async function listProjectTasks(
  auth: Authorization,
  projectId: string,
  input: unknown,
): Promise<Page<Task>> {
  const query: ListTasksQuery = parseRequest(ListTasksQuerySchema, input ?? {});
  // Concealment: an invisible project 404s before any task row is read.
  await withAuthorizedDb(auth.ctx, async (tx) => {
    await assertProjectVisible(tx, auth, projectId);
  });
  return listTasks(auth, { ...query, projectId });
}

export async function getTask(auth: Authorization, id: string): Promise<Task> {
  const task = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Task>(sql`
      select ${TASK_COLUMNS}
      ${TASK_FROM}
      where ${TASK_WHERE(auth)}
        and t.id = ${id}::uuid
    `);
    return res.rows[0] ?? null;
  });
  await assertTargetAffected(auth, task ? 1 : 0);
  return task as Task;
}

export async function createTask(auth: Authorization, input: unknown): Promise<Task> {
  const data = parseRequest(CreateTaskSchema, input);
  let id: string;
  try {
    id = await withAuthorizedDb(auth.ctx, async (tx) => {
      if (data.projectId) await assertProjectVisibleForWrite(tx, auth, data.projectId);
      if (data.assigneePersonId)
        await assertAssigneeVisibleForWrite(tx, auth, data.assigneePersonId);
      if (data.parentTaskId) {
        await assertParentTaskVisible(tx, auth, data.parentTaskId, data.projectId);
      }
      const res = await tx.execute<{ id: string }>(sql`
        insert into public.work_tasks (
          org_id, project_id, title, description, status, priority,
          due_date, assignee_person_id, parent_task_id, created_by
        ) values (
          ${auth.ctx.orgId}::uuid,
          ${data.projectId ?? null}::uuid,
          ${data.title},
          ${data.description ?? null},
          ${data.status},
          ${data.priority},
          ${data.dueDate ?? null}::date,
          ${data.assigneePersonId ?? null}::uuid,
          ${data.parentTaskId ?? null}::uuid,
          ${auth.ctx.personId}::uuid
        )
        returning id
      `);
      const row = res.rows[0];
      if (!row) throw new Error('Task creation failed.');
      return row.id;
    });
  } catch (error) {
    invalidTaskWrite(error, false);
  }
  // Phase 5 trigger emission (D3): the insert committed when
  // withAuthorizedDb resolved above — never inside the tx.
  await dispatchWorkflowEvent(auth, {
    type: 'task.created',
    entityType: 'task',
    entityId: id,
    dedupKey: buildDedupKey('task', id),
    payload: {
      taskId: id,
      taskTitle: data.title,
      projectId: data.projectId ?? null,
      status: data.status,
      priority: data.priority,
      assigneePersonId: data.assigneePersonId ?? null,
    },
  });
  // Nit-8: assignment-at-creation is a real assignment — emit task.assigned
  // too, so it is visible to task.assigned workflows (updateTask already
  // emits both on its path).
  if (data.assigneePersonId !== undefined && data.assigneePersonId !== null) {
    const created = await getTask(auth, id);
    await dispatchWorkflowEvent(auth, {
      type: 'task.assigned',
      entityType: 'task',
      entityId: id,
      dedupKey: buildDedupKey('task_assign', id, data.assigneePersonId, created.updatedAt),
      payload: {
        taskId: id,
        taskTitle: created.title,
        assigneePersonId: data.assigneePersonId,
        projectId: created.projectId,
      },
    });
  }
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'task.created',
      entityType: 'task',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: {
        title: data.title,
        projectId: data.projectId ?? null,
        status: data.status,
        priority: data.priority,
      },
    },
    auth.meta,
  );
  return getTask(auth, id);
}

const UPDATE_COLUMNS: Record<keyof UpdateTaskInput, string> = {
  projectId: 'project_id',
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority',
  dueDate: 'due_date',
  assigneePersonId: 'assignee_person_id',
  parentTaskId: 'parent_task_id',
};

export async function updateTask(auth: Authorization, id: string, input: unknown): Promise<Task> {
  const data = parseRequest(UpdateTaskSchema, input);
  const projectChanged = data.projectId !== undefined && data.projectId !== null;
  try {
    const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
      if (projectChanged) {
        await assertProjectVisibleForWrite(tx, auth, data.projectId as string);
      }
      if (data.assigneePersonId !== undefined && data.assigneePersonId !== null) {
        await assertAssigneeVisibleForWrite(tx, auth, data.assigneePersonId);
      }
      if (data.parentTaskId !== undefined && data.parentTaskId !== null) {
        // Parent must be a live top-level task in the same org and project.
        // Fetch the task's current project for the same-project check.
        const cur = await tx.execute<{ project_id: string | null }>(sql`
          select t.project_id
          from public.work_tasks t
          where t.id = ${id}::uuid
            and ${TASK_WHERE(auth)}
        `);
        const currentProjectId = cur.rows[0]?.project_id ?? data.projectId ?? null;
        await assertParentTaskVisible(tx, auth, data.parentTaskId, currentProjectId);
      }
      const sets = Object.entries(data).map(([key, value]) => {
        const column = UPDATE_COLUMNS[key as keyof UpdateTaskInput];
        if (column === 'due_date') return sql`${sql.raw(column)} = ${value ?? null}::date`;
        if (
          column === 'project_id' ||
          column === 'assignee_person_id' ||
          column === 'parent_task_id'
        )
          return sql`${sql.raw(column)} = ${value ?? null}::uuid`;
        return sql`${sql.raw(column)} = ${value ?? null}`;
      });
      const res = await tx.execute(sql`
        update public.work_tasks t
        set ${sql.join(sets, sql`, `)}, updated_at = now()
        where t.id = ${id}::uuid
          and ${TASK_WHERE(auth)}
        returning t.id
      `);
      return res.rowCount ?? 0;
    });
    await assertTargetAffected(auth, affected);
  } catch (error) {
    invalidTaskWrite(error, projectChanged);
  }
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'task.updated',
      entityType: 'task',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { fields: Object.keys(data).join(',') },
    },
    auth.meta,
  );
  // Phase 5 trigger emission (D3): post-commit. updateTask() never reads the
  // row before the UPDATE, so before/after comparison would require a
  // structural change — instead emission is input-based: a present `status`
  // key means the caller wrote the status column, a present
  // `assigneePersonId` key (including explicit null = unassign) means the
  // caller wrote the assignee column. (In practice every update bumps
  // updated_at, so a same-value write is still a real write.) fromStatus is
  // not knowable on this path and is carried as null.
  const task = await getTask(auth, id);
  if (data.status !== undefined) {
    await dispatchWorkflowEvent(auth, {
      type: 'task.status_changed',
      entityType: 'task',
      entityId: id,
      dedupKey: buildDedupKey('task_status', id, data.status, task.updatedAt),
      payload: {
        taskId: id,
        taskTitle: task.title,
        fromStatus: null,
        toStatus: data.status,
        projectId: task.projectId,
      },
    });
  }
  if (data.assigneePersonId !== undefined) {
    await dispatchWorkflowEvent(auth, {
      type: 'task.assigned',
      entityType: 'task',
      entityId: id,
      // P1-4: the post-update updatedAt is the per-occurrence component —
      // re-assigning the same person after an unassign is a distinct
      // occurrence, not a re-delivery (mirrors the task_status key shape).
      dedupKey: buildDedupKey('task_assign', id, data.assigneePersonId ?? '', task.updatedAt),
      payload: {
        taskId: id,
        taskTitle: task.title,
        assigneePersonId: data.assigneePersonId,
        projectId: task.projectId,
      },
    });
  }
  return task;
}

/**
 * Kanban status move. Changes ONLY status — the MoveTaskSchema has no
 * project_id field, so cross-project moves are impossible through this path.
 * A move to the status the task is already in is a no-op: 200, no UPDATE, no
 * audit row.
 */
export async function moveTask(
  auth: Authorization,
  id: string,
  input: unknown,
): Promise<MoveTaskResult> {
  const data = parseRequest(MoveTaskSchema, input);
  const toStatus = data.status;
  const result = await withAuthorizedDb(auth.ctx, async (tx) => {
    const cur = await tx.execute<{ status: TaskStatus }>(sql`
      select t.status
      from public.work_tasks t
      where t.id = ${id}::uuid
        and ${TASK_WHERE(auth)}
    `);
    const row = cur.rows[0] ?? null;
    await assertTargetAffected(auth, row ? 1 : 0);
    const fromStatus = (row as { status: TaskStatus }).status;
    if (fromStatus === toStatus) {
      return { fromStatus, toStatus, noop: true };
    }
    const upd = await tx.execute(sql`
      update public.work_tasks t
      set status = ${toStatus}, updated_at = now()
      where t.id = ${id}::uuid
        and ${TASK_WHERE(auth)}
      returning t.id
    `);
    await assertTargetAffected(auth, upd.rowCount ?? 0);
    return { fromStatus, toStatus, noop: false };
  });

  if (!result.noop) {
    await writeAuditEntry(
      auth.ctx,
      {
        action: 'task.moved',
        entityType: 'task',
        entityId: id,
        result: 'SUCCESS',
        severity: 'LOW',
        metadata: {
          fromStatus: result.fromStatus,
          toStatus: result.toStatus,
          actorPersonId: auth.ctx.personId,
        },
      },
      auth.meta,
    );
    // Phase 5 trigger emission (D3): post-commit, and only on a real move —
    // the noop branch above is skipped. Reads the committed row for the
    // payload snapshot (title/projectId) and updated_at for the dedup key.
    const moved = await getTask(auth, id);
    await dispatchWorkflowEvent(auth, {
      type: 'task.status_changed',
      entityType: 'task',
      entityId: id,
      dedupKey: buildDedupKey('task_status', id, result.toStatus, moved.updatedAt),
      payload: {
        taskId: id,
        taskTitle: moved.title,
        fromStatus: result.fromStatus,
        toStatus: result.toStatus,
        projectId: moved.projectId,
      },
    });
  }
  return { ok: true, taskId: id, fromStatus: result.fromStatus, toStatus: result.toStatus };
}

/**
 * Assign (or, with null, unassign) a task. The assignee must be live and
 * visible in the caller's org; unassign accepts null. The PATCH route exposes
 * this under tasks.edit; the dedicated tasks.assign key covers assignment
 * flows built on these service functions.
 */
export async function assignTask(
  auth: Authorization,
  id: string,
  personId: string | null,
): Promise<Task> {
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    if (personId !== null) {
      await assertAssigneeVisibleForWrite(tx, auth, personId);
    }
    const res = await tx.execute(sql`
      update public.work_tasks t
      set assignee_person_id = ${personId}::uuid, updated_at = now()
      where t.id = ${id}::uuid
        and ${TASK_WHERE(auth)}
      returning t.id
    `);
    return res.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: personId === null ? 'task.unassigned' : 'task.assigned',
      entityType: 'task',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { personId, actorPersonId: auth.ctx.personId },
    },
    auth.meta,
  );
  return getTask(auth, id);
}

export async function unassignTask(auth: Authorization, id: string): Promise<Task> {
  return assignTask(auth, id, null);
}

/**
 * Soft delete only: sets deleted_at via public.crm_soft_delete('task', …).
 * Same two-step as src/lib/crm/soft-delete.ts: a no-op UPDATE runs as
 * app_user under the table's real UPDATE policy (org, liveness, edit scope),
 * taking a row lock; the SECURITY DEFINER function performs the write in the
 * same transaction. Requires the 0042 migration to add 'task' → 'work_tasks'
 * to the function's allowlist.
 */
export async function deleteTask(auth: Authorization, id: string): Promise<void> {
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    const probe = await tx.execute<{ id: string }>(sql`
      update public.work_tasks t
      set updated_at = updated_at
      where t.id = ${id}::uuid
        and ${TASK_WHERE(auth)}
      returning t.id
    `);
    const rowId = probe.rows[0]?.id;
    if (rowId) {
      await tx.execute(sql`select public.crm_soft_delete('task', ${rowId}::uuid)`);
    }
    return probe.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'task.deleted',
      entityType: 'task',
      entityId: id,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: {},
    },
    auth.meta,
  );
}

// ── Subtasks ─────────────────────────────────────────────────────────────────
// Subtasks are tasks with parent_task_id set. One level only — enforced by
// assertParentTaskVisible() on write. These are convenience wrappers around
// the canonical createTask/listTasks/moveTask paths.

/** List the direct subtasks of a parent task. Defaults to oldest-first;
 *  explicit sort/order query params are honored like listTasks. */
export async function listSubtasks(
  auth: Authorization,
  parentId: string,
  input: unknown,
): Promise<Page<Task>> {
  // Subtask lists default to oldest-first (createdAt asc); explicit
  // sort/order params override. The raw input is inspected so the zod
  // defaults in ListTasksQuerySchema (updatedAt/desc) don't mask an
  // omitted sort param.
  const raw = (input ?? {}) as Record<string, unknown>;
  const query: ListTasksQuery = parseRequest(ListTasksQuerySchema, {
    ...raw,
    sort: raw.sort ?? 'createdAt',
    order: raw.order ?? 'asc',
  });
  // Parent visibility probe first — fails closed before any subtask rows leak.
  await getTask(auth, parentId);
  const where = sql`${TASK_WHERE(auth)} and t.parent_task_id = ${parentId}::uuid`;
  const [rows, counts] = await withAuthorizedDb(auth.ctx, async (tx) => {
    const [r, c] = await Promise.all([
      tx.execute<Task>(sql`
        select ${TASK_COLUMNS}
        ${TASK_FROM}
        where ${where} ${searchWhere(query.search)}
        order by ${taskSortSql(query.sort, query.order)}
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.work_tasks t
        where ${where} ${searchWhere(query.search)}
      `),
    ]);
    return [r, c] as const;
  });
  return {
    rows: rows.rows,
    total: counts.rows[0]?.total ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

/**
 * Create a subtask under a parent task. The parent's project is inherited —
 * the caller does not supply projectId (it is ignored if present).
 */
export async function createSubtask(
  auth: Authorization,
  parentId: string,
  input: unknown,
): Promise<Task> {
  // Validate the parent first (visibility + top-level check).
  const parent = await getTask(auth, parentId);
  if (parent.parentTaskId) {
    throw new Error('INVALID_REQUEST: a subtask cannot have its own subtasks');
  }
  const data = parseRequest(CreateTaskSchema, input);
  return createTask(auth, {
    ...data,
    projectId: parent.projectId,
    parentTaskId: parentId,
  });
}

/** A task together with all of its direct subtasks (oldest first). */
export async function getTaskWithSubtasks(
  auth: Authorization,
  id: string,
): Promise<TaskWithSubtasks> {
  const task = await getTask(auth, id);
  const subtasks = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Task>(sql`
      select ${TASK_COLUMNS}
      ${TASK_FROM}
      where ${TASK_WHERE(auth)}
        and t.parent_task_id = ${id}::uuid
      order by t.created_at asc, t.id asc
    `);
    return res.rows;
  });
  return { ...task, subtasks };
}

/**
 * Set a task's status. Thin wrapper around moveTask() — the subtask checkbox
 * in the UI toggles 'done' ⇄ 'todo' through this.
 */
export async function setTaskStatus(
  auth: Authorization,
  id: string,
  input: unknown,
): Promise<Task> {
  const data = parseRequest(MoveTaskSchema, input);
  await moveTask(auth, id, data);
  return getTask(auth, id);
}
