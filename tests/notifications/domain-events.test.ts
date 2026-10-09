/**
 * P1b — domain-event notifications + task-reminder delivery (AUD-05, AUD-04).
 *
 * AUD-05: emitNotification had ZERO callers, so built-in domain events
 * never notified anyone. P1b wires post-commit, failure-isolated emission
 * (emitNotificationSafely) into the task and deal services:
 *   - task assigned / reassigned → TASK_ASSIGNED to the NEW assignee
 *   - task completed             → TASK_COMPLETED to the task's creator
 *   - deal stage changed         → DEAL_STAGE_CHANGED to the deal owner
 * These tests drive the REAL services against the migrated database and
 * drain the resulting notification jobs through the REAL handler, exactly
 * like tests/notifications/integration.test.ts. An emission happens under
 * the ACTOR's authorization: the pipeline's enqueue gate requires
 * jobs.create (D2), so actors without it complete the domain operation
 * with no notification — pinned by the last actor test below.
 *
 * AUD-04: task reminders had storage + CRUD but no reader. P1b adds the
 * worker-plane sweep (src/lib/jobs/reminder-sweep.ts + the 0064 claim
 * definer): a due reminder is claimed (is_sent flips atomically) and
 * delivered as a TASK_DUE in-app notification to the reminder's owner,
 * through the notification family's definers, honouring the recipient's
 * channel preference. These tests call the sweep directly.
 *
 * Fixture idioms mirror tests/notifications/integration.test.ts: owner
 * pool (DATABASE_URL_MIGRATE) for seeding and cross-checks, fabricated
 * Authorization objects, per-run orgs/people, NO cleanup deletes (every
 * run uses fresh orgs). Requires DATABASE_URL_MIGRATE; skipped otherwise.
 * The suite runs in CI, where the full migration chain (incl. 0064) is
 * applied to an empty Postgres.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { describe, it, expect, beforeAll } from 'vitest';

const MIGRATE_URL = process.env.DATABASE_URL_MIGRATE;
const HAS_DB = typeof MIGRATE_URL === 'string' && MIGRATE_URL.length > 0;

const RUN = randomUUID().slice(0, 8);
const stamp = () => new Date().toISOString();

type TasksSvc = typeof import('@/lib/work/tasks');
type DealsSvc = typeof import('@/lib/crm/deals');
type PipelinesSvc = typeof import('@/lib/crm/pipelines');
type RemindersSvc = typeof import('@/lib/work/reminders');
type PrefsSvc = typeof import('@/lib/notifications/preferences');
type WorkerMod = typeof import('@/lib/jobs/worker');
type HandlersMod = typeof import('@/lib/jobs/handlers');
type SweepMod = typeof import('@/lib/jobs/reminder-sweep');
type Job = import('@/lib/jobs/types').Job;
type Authorization = import('@/lib/authz/require-permission').Authorization;

/** A permission bundle for a fabricated actor (all GLOBAL scope). */
const PERMS = {
  manager: [
    'people.view',
    'tasks.view',
    'tasks.create',
    'tasks.edit',
    'tasks.assign',
    'deals.view',
    'deals.create',
    'deals.edit',
    'pipelines.view',
    'pipelines.edit',
    'jobs.view',
    'jobs.create',
    'notifications.view',
    'notifications.preferences.manage',
  ],
  assignee: ['tasks.view', 'tasks.edit', 'notifications.view', 'notifications.preferences.manage'],
  creator: [
    'people.view',
    'tasks.view',
    'tasks.create',
    'tasks.edit',
    'tasks.assign',
    'jobs.view',
    'jobs.create',
    'notifications.view',
  ],
  dealOwner: [
    'deals.view',
    'deals.create',
    'deals.edit',
    'jobs.view',
    'jobs.create',
    'notifications.view',
  ],
  /** Everything a task actor needs — but no jobs.* (D2 emission gate). */
  noJobs: [
    'people.view',
    'tasks.view',
    'tasks.create',
    'tasks.edit',
    'tasks.assign',
    'notifications.view',
  ],
} as const;

describe.skipIf(!HAS_DB)('P1b domain-event notifications + reminder delivery (real DB)', () => {
  let pool: Pool;
  let tasks: TasksSvc;
  let deals: DealsSvc;
  let pipelines: PipelinesSvc;
  let reminders: RemindersSvc;
  let prefs: PrefsSvc;
  let buildJobAuthorization: WorkerMod['buildJobAuthorization'];
  let handleNotification: HandlersMod['handleNotification'];
  let sweepDueTaskReminders: SweepMod['sweepDueTaskReminders'];

  let orgA: string;
  let orgB: string;
  // People (org A unless noted).
  let manager: string;
  let assignee: string;
  let creator: string;
  let dealOwner: string;
  let third: string;
  let muted: string;
  let outsiderB: string; // the only org-B person: actor AND recipient there
  // Fabricated authorizations.
  let managerAuth: Authorization;
  let assigneeAuth: Authorization;
  let creatorAuth: Authorization;
  let ownerAuth: Authorization;
  let noJobsAuth: Authorization;
  let mutedAuth: Authorization;
  let outsiderAuth: Authorization;

  async function owner<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    return pool.query<T>(text, params);
  }

  async function mkOrg(slug: string): Promise<string> {
    const id = randomUUID();
    await owner(
      `insert into public.organizations (id, name, slug, status)
       values ($1, $2, $3, 'ACTIVE')`,
      [id, `P1b ${RUN} ${slug}`, `p1b-${RUN}-${slug}`],
    );
    return id;
  }

  async function mkRoleFor(orgId: string, keys: readonly string[]): Promise<string> {
    const { rows } = await owner<{ id: string }>(
      `select id from public.permissions where key = any($1::text[])`,
      [[...keys]],
    );
    const found = new Set(rows.map((r) => r.id));
    if (found.size !== keys.length) {
      // Fail loudly rather than seed an actor missing a grant.
      throw new Error(`permission catalogue lookup missed keys: ${keys.join(', ')}`);
    }
    const roleId = randomUUID();
    // roles.key is NOT NULL with a format check (^[A-Z][A-Z0-9_]{1,39}$) and a
    // non-partial unique index on (org_id, key) — sibling idiom
    // (integration.test.ts:107): sanitise the RUN-suffixed label into key form.
    const roleKey = `p1b-role-${RUN}-${randomUUID().slice(0, 6)}`
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_');
    await owner(
      `insert into public.roles (id, org_id, key, name, is_system) values ($1, $2, $3, $4, false)`,
      [roleId, orgId, roleKey, `p1b-role-${RUN}-${randomUUID().slice(0, 6)}`],
    );
    for (const permId of found) {
      await owner(
        `insert into public.role_permissions (role_id, permission_id, scope)
         values ($1, $2, 'GLOBAL'::public.access_scope)`,
        [roleId, permId],
      );
    }
    return roleId;
  }

  function makeAuth(personId: string, orgId: string): Authorization {
    return {
      ctx: { personId, orgId, aal: 'aal1' },
      meta: {
        userAgent: 'vitest-p1b',
        ipAddress: '127.0.0.1',
        requestId: `p1b-${RUN}`,
        occurredAt: stamp(),
      },
      permissions: new Set<string>(),
      scopeFor: () => 'GLOBAL',
      hasPermission: (key: string) => key.length > 0,
      requirePermission: (key: string) => {
        void key;
      },
    } as unknown as Authorization;
  }

  /** One department per org, created lazily (engagements.department_id is NOT NULL). */
  const deptByOrg = new Map<string, string>();
  async function mkDept(orgId: string): Promise<string> {
    const cached = deptByOrg.get(orgId);
    if (cached) return cached;
    const id = randomUUID();
    await owner(`insert into public.departments (id, org_id, code, name) values ($1, $2, $3, $4)`, [
      id,
      orgId,
      `P1B_${RUN}`.toUpperCase(),
      `P1b dept ${RUN}`,
    ]);
    deptByOrg.set(orgId, id);
    return id;
  }

  /**
   * Create a person + ACTIVE engagement holding `keys`; returns ids + auth.
   * Fixture shapes mirror integration.test.ts / tests/authz/fixtures.ts: the
   * person carries a generated identity code and no login (auth is fabricated
   * below; nothing in this suite resolves a session), and the role attaches
   * via person_roles — engagements has no role_id column.
   */
  async function mkPerson(
    orgId: string,
    label: string,
    keys: readonly string[],
  ): Promise<{ personId: string; auth: Authorization }> {
    const roleId = await mkRoleFor(orgId, keys);
    const personId = randomUUID();
    const { rows: codeRows } = await owner<{ c: string }>(
      `select authz.next_identity_code($1::uuid, 'EMP', '2026') as c`,
      [orgId],
    );
    await owner(
      `insert into public.people (id, org_id, code, full_legal_name, person_status, work_email)
       values ($1, $2, $3, $4, 'ACTIVE'::public.person_status, $5)`,
      [personId, orgId, codeRows[0]!.c, `P1b ${label}`, `p1b-${RUN}-${label}@example.invalid`],
    );
    const deptId = await mkDept(orgId);
    await owner(
      `insert into public.engagements
         (id, org_id, person_id, department_id, engagement_type, status, start_date)
       values ($1, $2, $3, $4, 'EMPLOYEE', 'ACTIVE'::public.engagement_status, current_date)`,
      [randomUUID(), orgId, personId, deptId],
    );
    await owner(
      `insert into public.person_roles (person_id, role_id, org_id) values ($1, $2, $3)`,
      [personId, roleId, orgId],
    );
    return { personId, auth: makeAuth(personId, orgId) };
  }

  const toIso = (v: unknown): string =>
    v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

  /** Load a full Job row (the integration suite's drain shape). */
  async function loadJob(jobId: string): Promise<Job> {
    const { rows } = await owner(
      `select id, org_id, type, status, priority, payload, attempts, max_attempts,
              next_run_at, claimed_by, claimed_at, heartbeat_at, dedup_key,
              error_code, error_message, created_at, updated_at
       from public.jobs where id = $1`,
      [jobId],
    );
    const row = rows[0];
    if (!row) throw new Error(`drain: job ${jobId} not found`);
    return {
      id: String(row.id),
      orgId: String(row.org_id),
      type: row.type as Job['type'],
      status: row.status as Job['status'],
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

  /** Run every pending notification job in the org through the real handler. */
  async function drainNotifications(orgId: string): Promise<void> {
    const { rows } = await owner<{ id: string }>(
      `select id from public.jobs
        where org_id = $1 and type = 'notification' and status = 'pending'
        order by created_at`,
      [orgId],
    );
    for (const row of rows) {
      const job = await loadJob(row.id);
      const auth = buildJobAuthorization(job);
      await handleNotification({ job, auth, signal: new AbortController().signal });
    }
  }

  type NotificationRow = {
    id: string;
    org_id: string;
    person_id: string;
    type: string;
    event_id: string | null;
    data: Record<string, unknown>;
  };

  async function notificationRows(
    orgId: string,
    personId: string,
    type: string,
    entityId?: string,
  ): Promise<NotificationRow[]> {
    const { rows } = await owner<NotificationRow>(
      `select id, org_id, person_id, type, event_id, data
         from public.notifications
        where org_id = $1 and person_id = $2 and type = $3
          and ($4::text is null or data->>'entityId' = $4)`,
      [orgId, personId, type, entityId ?? null],
    );
    return rows;
  }

  async function makeDue(reminderId: string): Promise<void> {
    await owner(
      `update public.task_reminders set remind_at = now() - interval '1 minute' where id = $1`,
      [reminderId],
    );
  }

  async function reminderState(reminderId: string): Promise<{ is_sent: boolean }> {
    const { rows } = await owner<{ is_sent: boolean }>(
      `select is_sent from public.task_reminders where id = $1`,
      [reminderId],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();

  beforeAll(async () => {
    pool = new Pool({ connectionString: MIGRATE_URL });
    tasks = await import('@/lib/work/tasks');
    deals = await import('@/lib/crm/deals');
    pipelines = await import('@/lib/crm/pipelines');
    reminders = await import('@/lib/work/reminders');
    prefs = await import('@/lib/notifications/preferences');
    ({ buildJobAuthorization } = await import('@/lib/jobs/worker'));
    ({ handleNotification } = await import('@/lib/jobs/handlers'));
    ({ sweepDueTaskReminders } = await import('@/lib/jobs/reminder-sweep'));

    orgA = await mkOrg('a');
    orgB = await mkOrg('b');
    ({ personId: manager, auth: managerAuth } = await mkPerson(orgA, 'manager', PERMS.manager));
    ({ personId: assignee, auth: assigneeAuth } = await mkPerson(orgA, 'assignee', PERMS.assignee));
    ({ personId: creator, auth: creatorAuth } = await mkPerson(orgA, 'creator', PERMS.creator));
    ({ personId: dealOwner, auth: ownerAuth } = await mkPerson(orgA, 'owner', PERMS.dealOwner));
    ({ personId: third } = await mkPerson(orgA, 'third', PERMS.assignee));
    ({ personId: muted, auth: mutedAuth } = await mkPerson(orgA, 'muted', PERMS.assignee));
    ({ auth: noJobsAuth } = await mkPerson(orgA, 'nojobs', PERMS.noJobs));
    ({ personId: outsiderB, auth: outsiderAuth } = await mkPerson(orgB, 'outsider', PERMS.manager));
  }, 120_000);

  // ── (a) task assignment ──────────────────────────────────────────────────

  it('assigning notifies the new assignee exactly once; reassigning notifies only the new assignee; unassigning notifies nobody', async () => {
    const task = await tasks.createTask(managerAuth, {
      title: `${RUN} assign flow`,
      assigneePersonId: assignee,
    });
    await drainNotifications(orgA);
    const first = await notificationRows(orgA, assignee, 'TASK_ASSIGNED', task.id);
    expect(first).toHaveLength(1);
    expect(first[0]!.org_id).toBe(orgA);

    const reassigned = await tasks.assignTask(managerAuth, task.id, third);
    expect(reassigned.assigneePersonId).toBe(third);
    await drainNotifications(orgA);
    expect(await notificationRows(orgA, third, 'TASK_ASSIGNED', task.id)).toHaveLength(1);
    // The previous assignee is NOT notified again.
    expect(await notificationRows(orgA, assignee, 'TASK_ASSIGNED', task.id)).toHaveLength(1);

    const unassigned = await tasks.assignTask(managerAuth, task.id, null);
    expect(unassigned.assigneePersonId).toBeNull();
    await drainNotifications(orgA);
    // Still exactly the two assignment notifications for this task.
    const { rows } = await owner<{ c: string }>(
      `select count(*)::text as c from public.notifications
          where org_id = $1 and type = 'TASK_ASSIGNED' and data->>'entityId' = $2`,
      [orgA, task.id],
    );
    expect(rows[0]!.c).toBe('2');
  }, 120_000);

  it('self-assignment creates no notification', async () => {
    const task = await tasks.createTask(managerAuth, {
      title: `${RUN} self assign`,
      assigneePersonId: manager,
    });
    await drainNotifications(orgA);
    expect(await notificationRows(orgA, manager, 'TASK_ASSIGNED', task.id)).toHaveLength(0);
  }, 120_000);

  it('an actor without jobs.create completes the assignment and no notification is created (D2 gate)', async () => {
    const task = await tasks.createTask(noJobsAuth, {
      title: `${RUN} no-jobs actor`,
      assigneePersonId: assignee,
    });
    // The domain operation itself succeeded — emission failure (the
    // pipeline's FORBIDDEN) never rolls it back.
    expect(task.assigneePersonId).toBe(assignee);
    await drainNotifications(orgA);
    expect(await notificationRows(orgA, assignee, 'TASK_ASSIGNED', task.id)).toHaveLength(0);
  }, 120_000);

  // ── (b) task completion ──────────────────────────────────────────────────

  it("completing another person's task notifies the creator exactly once; self-completion does not", async () => {
    const task = await tasks.createTask(creatorAuth, { title: `${RUN} completion flow` });
    await tasks.assignTask(creatorAuth, task.id, assignee);
    await drainNotifications(orgA); // drains the TASK_ASSIGNED job

    const done = await tasks.moveTask(assigneeAuth, task.id, { status: 'done' });
    expect(done.toStatus).toBe('done');
    await drainNotifications(orgA);
    const rows = await notificationRows(orgA, creator, 'TASK_COMPLETED', task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(orgA);
    // The completer is not notified about their own completion.
    expect(await notificationRows(orgA, assignee, 'TASK_COMPLETED', task.id)).toHaveLength(0);

    const own = await tasks.createTask(creatorAuth, { title: `${RUN} self completion` });
    await tasks.moveTask(creatorAuth, own.id, { status: 'done' });
    await drainNotifications(orgA);
    expect(await notificationRows(orgA, creator, 'TASK_COMPLETED', own.id)).toHaveLength(0);
  }, 120_000);

  // ── (c) deal stage changes ───────────────────────────────────────────────

  it("a deal stage change via updateDeal notifies the owner; the owner changing their own deal's stage does not", async () => {
    const deal = await deals.createDeal(ownerAuth, {
      title: `${RUN} stage deal`,
      stage: 'NEW',
    });
    const updated = await deals.updateDeal(managerAuth, deal.id, { stage: 'QUALIFIED' });
    expect(updated.stage).toBe('QUALIFIED');
    await drainNotifications(orgA);
    const rows = await notificationRows(orgA, dealOwner, 'DEAL_STAGE_CHANGED', deal.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(orgA);
    // The actor is not the recipient.
    expect(await notificationRows(orgA, manager, 'DEAL_STAGE_CHANGED', deal.id)).toHaveLength(0);

    await deals.updateDeal(ownerAuth, deal.id, { stage: 'PROPOSAL' });
    await drainNotifications(orgA);
    expect(await notificationRows(orgA, dealOwner, 'DEAL_STAGE_CHANGED', deal.id)).toHaveLength(1);
  }, 120_000);

  it('a pipeline stage move notifies the deal owner', async () => {
    const deal = await deals.createDeal(ownerAuth, { title: `${RUN} pipeline deal` });
    expect(deal.pipelineId).not.toBeNull();
    expect(deal.pipelineStageId).not.toBeNull();
    const { rows } = await owner<{ id: string }>(
      `select id from public.pipeline_stages
        where pipeline_id = $1 and id <> $2 and deleted_at is null
        order by position limit 1`,
      [deal.pipelineId, deal.pipelineStageId],
    );
    expect(rows).toHaveLength(1);
    const moved = await pipelines.moveDealToStage(managerAuth, deal.id, {
      stageId: rows[0]!.id,
    });
    expect(moved.ok).toBe(true);
    await drainNotifications(orgA);
    expect(await notificationRows(orgA, dealOwner, 'DEAL_STAGE_CHANGED', deal.id)).toHaveLength(1);
  }, 120_000);

  // ── (d) preference suppression (domain path) ─────────────────────────────

  it('a recipient who disabled the type receives no notification (preference gate)', async () => {
    await prefs.upsertPreferences(mutedAuth, [
      { eventType: 'TASK_ASSIGNED', channel: 'in_app', enabled: false },
    ]);
    const task = await tasks.createTask(managerAuth, {
      title: `${RUN} muted assignment`,
      assigneePersonId: muted,
    });
    await drainNotifications(orgA);
    expect(await notificationRows(orgA, muted, 'TASK_ASSIGNED', task.id)).toHaveLength(0);
    // Suppression happens before enqueue: no notification job exists either.
    const { rows } = await owner<{ c: string }>(
      `select count(*)::text as c from public.jobs
        where org_id = $1 and type = 'notification'
          and payload->>'personId' = $2 and payload->'data'->>'entityId' = $3`,
      [orgA, muted, task.id],
    );
    expect(rows[0]!.c).toBe('0');
    await prefs.upsertPreferences(mutedAuth, [
      { eventType: 'TASK_ASSIGNED', channel: 'in_app', enabled: true },
    ]);
  }, 120_000);

  // ── (e) reminder sweep ───────────────────────────────────────────────────

  it('sweep delivers a due reminder once, flips is_sent, and leaves future reminders untouched', async () => {
    const task = await tasks.createTask(managerAuth, {
      title: `${RUN} reminder task`,
      assigneePersonId: assignee,
    });
    const due = await reminders.createReminder(assigneeAuth, task.id, { remindAt: inOneHour() });
    const future = await reminders.createReminder(assigneeAuth, task.id, {
      remindAt: new Date(Date.now() + 7_200_000).toISOString(),
    });
    expect(due.isSent).toBe(false);
    await makeDue(due.id);

    const result = await sweepDueTaskReminders();
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const rows = (await notificationRows(orgA, assignee, 'TASK_DUE', task.id)).filter(
      (r) => r.data.reminderId === due.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(orgA);
    expect(rows[0]!.event_id).toBe(`task-reminder:${due.id}`);
    expect((await reminderState(due.id)).is_sent).toBe(true);

    // The future reminder is untouched: unclaimed, undelivered.
    expect((await reminderState(future.id)).is_sent).toBe(false);
    const futureRows = (await notificationRows(orgA, assignee, 'TASK_DUE', task.id)).filter(
      (r) => r.data.reminderId === future.id,
    );
    expect(futureRows).toHaveLength(0);

    // A second sweep delivers nothing twice.
    await sweepDueTaskReminders();
    const again = (await notificationRows(orgA, assignee, 'TASK_DUE', task.id)).filter(
      (r) => r.data.reminderId === due.id,
    );
    expect(again).toHaveLength(1);
  }, 120_000);

  it("sweep honours the TASK_DUE preference: a muted recipient's reminder is claimed but not delivered", async () => {
    await prefs.upsertPreferences(mutedAuth, [
      { eventType: 'TASK_DUE', channel: 'in_app', enabled: false },
    ]);
    const task = await tasks.createTask(managerAuth, {
      title: `${RUN} muted reminder task`,
      assigneePersonId: muted,
    });
    const rem = await reminders.createReminder(mutedAuth, task.id, { remindAt: inOneHour() });
    await makeDue(rem.id);
    const result = await sweepDueTaskReminders();
    expect(result.failed).toBe(0);
    // Claimed (retired — it will not be re-scanned) …
    expect((await reminderState(rem.id)).is_sent).toBe(true);
    // … but the preference gate suppressed delivery.
    const rows = (await notificationRows(orgA, muted, 'TASK_DUE', task.id)).filter(
      (r) => r.data.reminderId === rem.id,
    );
    expect(rows).toHaveLength(0);
    await prefs.upsertPreferences(mutedAuth, [
      { eventType: 'TASK_DUE', channel: 'in_app', enabled: true },
    ]);
  }, 120_000);

  it('a reminder on a soft-deleted task is claimed without delivery', async () => {
    const task = await tasks.createTask(managerAuth, {
      title: `${RUN} deleted reminder task`,
      assigneePersonId: assignee,
    });
    const rem = await reminders.createReminder(assigneeAuth, task.id, { remindAt: inOneHour() });
    await owner(`update public.work_tasks set deleted_at = now() where id = $1`, [task.id]);
    await makeDue(rem.id);
    const result = await sweepDueTaskReminders();
    expect(result.failed).toBe(0);
    expect((await reminderState(rem.id)).is_sent).toBe(true);
    const rows = (await notificationRows(orgA, assignee, 'TASK_DUE', task.id)).filter(
      (r) => r.data.reminderId === rem.id,
    );
    expect(rows).toHaveLength(0);
  }, 120_000);

  // ── (e/f) cross-org delivery + tenant isolation ──────────────────────────

  it('cross-org reminders deliver within their own org only; no notification row ever crosses orgs', async () => {
    const taskB = await tasks.createTask(outsiderAuth, { title: `${RUN} org-b reminder task` });
    const remB = await reminders.createReminder(outsiderAuth, taskB.id, { remindAt: inOneHour() });
    await makeDue(remB.id);
    const result = await sweepDueTaskReminders();
    expect(result.failed).toBe(0);

    const rowsB = (await notificationRows(orgB, outsiderB, 'TASK_DUE', taskB.id)).filter(
      (r) => r.data.reminderId === remB.id,
    );
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]!.org_id).toBe(orgB);
    // Nothing for the org-B reminder leaked into org A.
    const { rows: leaked } = await owner<{ c: string }>(
      `select count(*)::text as c from public.notifications
        where org_id = $1 and data->>'reminderId' = $2`,
      [orgA, remB.id],
    );
    expect(leaked[0]!.c).toBe('0');

    // Global invariant (also trigger-enforced): a notification's org is
    // always its recipient's org.
    const { rows: cross } = await owner<{ c: string }>(
      `select count(*)::text as c
         from public.notifications n
         join public.people p on p.id = n.person_id
        where n.org_id <> p.org_id`,
    );
    expect(cross[0]!.c).toBe('0');
  }, 120_000);
});
