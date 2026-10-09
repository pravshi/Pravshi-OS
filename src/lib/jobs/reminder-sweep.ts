/**
 * P1b (AUD-04) — Task Reminder Sweep: delivers due task reminders.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────
 * Phase 4 shipped per-task self-reminders (public.task_reminders, migration
 * 0043) with storage, CRUD and RLS — but nothing ever read due reminders or
 * flipped is_sent, so a reminder could never fire. This sweep is the missing
 * reader: on a cadence from runWorker() it claims a bounded batch of due
 * reminders and delivers one in-app notification (type TASK_DUE) per
 * reminder to the person the reminder belongs to.
 *
 * ── CLAIM (migration 0064) ────────────────────────────────────────────────
 * The claim is public.claim_due_task_reminders(p_limit) — SECURITY DEFINER,
 * the only cross-org task_reminders read path (RLS is FORCED on the table
 * and the worker plane carries no per-request identity, so plain SQL would
 * match zero rows forever — the jobs_claim_next / scheduler_tick_claim
 * problem). The claim is atomic: due rows (remind_at <= now(),
 * is_sent = false) are locked FOR UPDATE SKIP LOCKED and flipped to
 * is_sent = true in the same statement, so concurrent sweeps can never
 * deliver the same reminder twice. Claiming is the point of no return by
 * design (the 0043 contract: "the sweep will flip is_sent when it delivers
 * them"): a reminder whose task was soft-deleted, whose recipient left, or
 * whose recipient muted TASK_DUE is claimed, counted as skipped below, and
 * never re-scanned.
 *
 * ── DELIVERY (the notification handler's privilege path, minus the job) ──
 * Each claimed reminder is delivered in its OWN transaction under a
 * system-actor context bound to the REMINDER ROW's org (the
 * buildJobAuthorization shape: nil-UUID person, org from the row — never
 * from payload or caller input), through the same worker-plane definers
 * the notification job handler uses:
 *   1. notifications_recipient_exists(org, person) — a recipient who is
 *      no longer an active person in the org is skipped (the handler's
 *      NOT_FOUND posture, as a skip: there is no job to dead-letter here).
 *   2. notification_channel_enabled(org, person, 'TASK_DUE', 'in_app') —
 *      the recipient's preference gate, so a muted type stays silent. The
 *      function asserts the org by context kind since migration 0064 —
 *      on this person-less plane the app.org_id claim (the row's org) is
 *      the identity it checks.
 *   3. notifications_insert(...) with event_id `task-reminder:<id>` — the
 *      (org_id, event_id) unique index makes a re-delivery a 23505, which
 *      is treated as already-delivered, exactly like the job handler.
 * Delivery is in-app only: the email channel is enqueued by
 * createNotification under a real caller's authority (D2), and the worker
 * plane has no caller to borrow. One bad reminder never stalls the batch:
 * every per-reminder failure is caught, counted, and logged, and the sweep
 * moves on (the reminder stays claimed — loud in the log, never silently
 * retried forever).
 *
 * ── RUNNING IT ────────────────────────────────────────────────────────────
 * runWorker() calls sweepDueTaskReminders() every reminderSweepIntervalMs
 * (default 60s — reminders are minute-granularity user data; first sweep
 * fires one interval after worker start). A sweep failure is swallowed by
 * the loop so it can never kill the worker.
 */

import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { connectWithWake } from '../db/pool';
import { withAuthorizedDb, type Tx } from '../db/authorized';
import type { AuthContext } from '../db/context';
import { isPgCode } from '../work/errors';
import { notificationTitle } from '../notifications/emit';

/**
 * Nil UUID of the background system actor — the same value worker.ts
 * exports as SYSTEM_ACTOR_ID. Duplicated (not imported) to keep the
 * module graph acyclic: worker.ts imports THIS module for its loop wiring.
 * authz.person_id() validates it against people and resolves NULL, which
 * is what puts the definer calls below on their worker-plane arm.
 */
const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000000';

/** Reminders claimed (and attempted) per sweep. Bounded by design. */
export const TASK_REMINDER_SWEEP_DEFAULT_LIMIT = 50;

/** Hard ceiling for the limit (mirrors the 0064 function guard). */
const TASK_REMINDER_SWEEP_MAX_LIMIT = 1000;

// ── Worker-plane DB (same model as reapStaleJobs in worker.ts) ──────────────

async function withWorkerDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await connectWithWake();
  try {
    const db = drizzle(client);
    return await db.transaction(fn);
  } finally {
    client.release();
  }
}

/**
 * Validate the sweep limit before touching the DB — fail fast on a wiring
 * bug. The 0064 function re-validates server-side; this client check avoids
 * opening a connection for a doomed call.
 */
function validateSweepLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > TASK_REMINDER_SWEEP_MAX_LIMIT) {
    throw new Error(
      `INVALID_REQUEST: limit must be an integer between 1 and ${TASK_REMINDER_SWEEP_MAX_LIMIT}`,
    );
  }
  return limit;
}

// ── Claim ───────────────────────────────────────────────────────────────────

type ClaimedReminderRow = {
  reminder_id: string;
  org_id: string;
  task_id: string;
  person_id: string;
  remind_at: string;
  task_title: string | null;
  task_live: boolean;
};

async function claimDueReminders(limit: number): Promise<ClaimedReminderRow[]> {
  const rows = await withWorkerDb((tx) =>
    tx.execute<ClaimedReminderRow>(sql`
      select reminder_id, org_id, task_id, person_id, remind_at, task_title, task_live
      from public.claim_due_task_reminders(${limit})
    `),
  );
  return rows.rows;
}

// ── Delivery ────────────────────────────────────────────────────────────────

type ReminderDelivery = 'delivered' | 'skipped';

/**
 * Deliver one claimed reminder. Runs under a system-actor context bound to
 * the reminder row's org; every check and the insert go through the
 * notification family's SECURITY DEFINER functions, whose context-kind org
 * assertion (0061 PART 3A / 0064 PART 2) binds them to that org claim.
 */
async function deliverReminder(row: ClaimedReminderRow): Promise<ReminderDelivery> {
  if (!row.task_live || row.task_title === null) {
    // The task is gone or soft-deleted: the reminder was claimed (retired)
    // and there is nothing truthful left to notify about.
    console.info(
      `[jobs] task reminder skipped reminder=${row.reminder_id} org=${row.org_id} ` +
        'reason=task_not_live',
    );
    return 'skipped';
  }
  const ctx: AuthContext = { personId: SYSTEM_ACTOR_ID, orgId: row.org_id, aal: 'aal1' };
  const title = row.task_title;
  return withAuthorizedDb(ctx, async (tx) => {
    const recipient = await tx.execute<{ recipient_exists: boolean }>(sql`
      select public.notifications_recipient_exists(${row.org_id}::uuid, ${row.person_id}::uuid)
        as recipient_exists
    `);
    if (recipient.rows[0]?.recipient_exists !== true) {
      console.info(
        `[jobs] task reminder skipped reminder=${row.reminder_id} org=${row.org_id} ` +
          'reason=recipient_not_active',
      );
      return 'skipped' as const;
    }
    const enabled = await tx.execute<{ enabled: boolean }>(sql`
      select public.notification_channel_enabled(
        ${row.org_id}::uuid, ${row.person_id}::uuid, 'TASK_DUE', 'in_app'
      ) as enabled
    `);
    if (enabled.rows[0]?.enabled !== true) {
      console.info(
        `[jobs] task reminder skipped reminder=${row.reminder_id} org=${row.org_id} ` +
          'reason=disabled_by_preference',
      );
      return 'skipped' as const;
    }
    const eventId = `task-reminder:${row.reminder_id}`;
    const data = {
      type: 'TASK_DUE',
      eventId,
      entityType: 'task',
      entityId: row.task_id,
      link: `/work/tasks/${row.task_id}`,
      source: 'task_reminder',
      reminderId: row.reminder_id,
    };
    try {
      await tx.execute(sql`
        select public.notifications_insert(
          ${row.org_id}::uuid,
          ${row.person_id}::uuid,
          ${notificationTitle('Reminder', title)},
          ${`You asked to be reminded about the task "${title}".`},
          ${JSON.stringify(data)}::jsonb,
          'TASK_DUE',
          ${eventId}
        )
      `);
    } catch (error) {
      // 23505: the (org_id, event_id) unique index fired — this reminder
      // was already delivered (e.g. a crashed sweep inserted before its
      // claim committed elsewhere). Already-delivered is delivered; the
      // job handler takes the same posture.
      if (isPgCode(error, '23505')) {
        console.info(
          `[jobs] task reminder duplicate reminder=${row.reminder_id} org=${row.org_id} ` +
            '— already delivered, no-op (unique index deduped)',
        );
        return 'delivered' as const;
      }
      throw error;
    }
    return 'delivered' as const;
  });
}

// ── Sweep ───────────────────────────────────────────────────────────────────

export interface TaskReminderSweepResult {
  claimed: number;
  delivered: number;
  skipped: number;
  failed: number;
}

/**
 * Claim one bounded batch of due task reminders and deliver each as a
 * TASK_DUE in-app notification. Error-isolated per reminder: a failure is
 * counted and logged, never thrown into the batch (only a claim failure —
 * DB down, bad limit — throws, and the worker loop swallows it there).
 */
export async function sweepDueTaskReminders(
  limit: number = TASK_REMINDER_SWEEP_DEFAULT_LIMIT,
): Promise<TaskReminderSweepResult> {
  const safeLimit = validateSweepLimit(limit);
  const claimed = await claimDueReminders(safeLimit);
  const result: TaskReminderSweepResult = {
    claimed: claimed.length,
    delivered: 0,
    skipped: 0,
    failed: 0,
  };
  for (const row of claimed) {
    try {
      const outcome = await deliverReminder(row);
      if (outcome === 'delivered') result.delivered += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      console.error(
        `[jobs] task reminder delivery failed reminder=${row.reminder_id} org=${row.org_id}`,
        error,
      );
    }
  }
  if (result.claimed > 0) {
    console.info(
      `[jobs] task reminder sweep claimed=${result.claimed} delivered=${result.delivered} ` +
        `skipped=${result.skipped} failed=${result.failed}`,
    );
  }
  return result;
}
