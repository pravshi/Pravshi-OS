import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { withAuthorizedDb, type Tx } from '@/lib/db/authorized';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';

/**
 * Task reminders service (Phase 4 V1). Reminders are per-task SELF-reminders:
 * the caller is always the reminded person. Trust boundaries:
 *
 *  - org_id always comes from auth.ctx.orgId, never from the caller; every
 *    query re-states the org predicate explicitly (defense in depth over RLS)
 *  - person_id is stamped from auth.ctx.personId on insert, never from the
 *    body — nobody can plant a reminder on another person. The RLS insert
 *    policy pins this too, so a raw-SQL path can't bypass it either
 *  - only the task's assignee or creator may set reminders: the insert probe
 *    fails closed with NOT_FOUND concealment when the task is invisible OR
 *    when the caller is neither assignee nor creator (a viewer who can see
 *    the task but may not set reminders learns nothing distinguishable)
 *  - listing/deleting is owner-only: a person sees and deletes only their
 *    OWN reminders on a visible task (SELECT probes the task for visibility,
 *    then returns rows pinned to the caller)
 *  - remind_at must be a future instant (checked at the boundary; a CHECK
 *    constraint can't use now(), which is not immutable)
 *  - is_sent records delivery: the worker-plane reminder sweep
 *    (src/lib/jobs/reminder-sweep.ts, claim definer in migration 0064)
 *    flips it atomically at claim time when a due reminder is delivered
 *    as a TASK_DUE notification to the reminder's owner (person_id —
 *    reminders are self-reminders, so the owner is the recipient). This
 *    service never sets it; the sweep is the only writer
 *
 * ── COLUMN CONTRACT WITH MIGRATION 0043 ─────────────────────────────────────
 *
 *   task_reminders: id, org_id, task_id, person_id, remind_at, is_sent,
 *                   created_at
 *
 * The services address the table with raw SQL, so a column-name drift is a
 * runtime error, not a type error. If 0043 names a column differently, update
 * the SQL in this file only. Wire contract: the API speaks camelCase; SQL
 * aliases translate (remind_at AS "remindAt").
 */

const uuid = z.string().uuid();

const REMINDER_COLUMNS = sql`
  r.id,
  r.task_id as "taskId",
  r.person_id as "personId",
  r.remind_at as "remindAt",
  r.is_sent as "isSent",
  r.created_at as "createdAt"
`;

export const CreateReminderSchema = z.object({
  remindAt: z
    .string()
    .datetime({
      offset: true,
      message: 'remindAt must be an ISO 8601 datetime with timezone offset',
    })
    .refine((s) => Date.parse(s) > Date.now() + 60_000, {
      message: 'remindAt must be in the future',
    }),
});
export type CreateReminderInput = z.infer<typeof CreateReminderSchema>;

export type TaskReminder = {
  id: string;
  taskId: string;
  personId: string;
  remindAt: string;
  isSent: boolean;
  createdAt: string;
};

/** The task must be visible AND the caller must be its assignee or creator. */
async function assertTaskSettable(tx: Tx, auth: Authorization, taskId: string): Promise<void> {
  const res = await tx.execute(sql`
    select 1
    from public.work_tasks t
    where t.id = ${taskId}::uuid
      and t.org_id = ${auth.ctx.orgId}::uuid
      and t.deleted_at is null
      and (t.assignee_person_id = ${auth.ctx.personId}::uuid
           or t.created_by = ${auth.ctx.personId}::uuid)
  `);
  await assertTargetAffected(auth, res.rowCount ?? 0);
}

/** The task must be visible (any task the caller may view). */
async function assertTaskVisible(tx: Tx, auth: Authorization, taskId: string): Promise<void> {
  const res = await tx.execute(sql`
    select 1
    from public.work_tasks t
    where t.id = ${taskId}::uuid
      and t.org_id = ${auth.ctx.orgId}::uuid
      and t.deleted_at is null
  `);
  await assertTargetAffected(auth, res.rowCount ?? 0);
}

/**
 * Create a self-reminder on a task. Only the task's assignee or creator may
 * call this; anything else conceals as NOT_FOUND. Returns the created row.
 */
export async function createReminder(
  auth: Authorization,
  taskId: string,
  input: CreateReminderInput,
): Promise<TaskReminder> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    await assertTaskSettable(tx, auth, taskId);
    const res = await tx.execute(sql`
      insert into public.task_reminders as r (org_id, task_id, person_id, remind_at)
      values (
        ${auth.ctx.orgId}::uuid,
        ${taskId}::uuid,
        ${auth.ctx.personId}::uuid,
        ${input.remindAt}::timestamptz
      )
      returning ${REMINDER_COLUMNS}
    `);
    await assertTargetAffected(auth, res.rowCount ?? 0);
    return res.rows[0] as unknown as TaskReminder;
  });
}

/**
 * List the caller's own reminders on a task, soonest first. The task must be
 * visible; a person never sees another person's reminders.
 */
export async function listTaskReminders(
  auth: Authorization,
  taskId: string,
): Promise<TaskReminder[]> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    await assertTaskVisible(tx, auth, taskId);
    const res = await tx.execute(sql`
      select ${REMINDER_COLUMNS}
      from public.task_reminders r
      where r.org_id = ${auth.ctx.orgId}::uuid
        and r.task_id = ${taskId}::uuid
        and r.person_id = ${auth.ctx.personId}::uuid
      order by r.remind_at asc, r.id asc
    `);
    return res.rows as unknown as TaskReminder[];
  });
}

/**
 * Delete one of the caller's own reminders. NOT_FOUND concealment when the
 * row is invisible or not owned by the caller.
 */
export async function deleteReminder(
  auth: Authorization,
  taskId: string,
  reminderId: string,
): Promise<void> {
  await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute(sql`
      delete from public.task_reminders r
      where r.id = ${reminderId}::uuid
        and r.org_id = ${auth.ctx.orgId}::uuid
        and r.task_id = ${taskId}::uuid
        and r.person_id = ${auth.ctx.personId}::uuid
    `);
    await assertTargetAffected(auth, res.rowCount ?? 0);
  });
}

export const ReminderParamsSchema = z.object({
  taskId: uuid,
  reminderId: uuid.optional(),
});
