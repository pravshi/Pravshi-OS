/**
 * Phase 6 — scheduler tick DB tests (contract §7.2).
 *
 * Runs on CI against an ephemeral Neon branch (migrations 0045 + 0046
 * applied); skipped locally when the branch env vars are absent, the same
 * way the Phase 5 workflow suites do (describe.skipIf(!DB_READY)).
 *
 * Uses a REAL Authorization minted by requirePermission() through a real
 * Better Auth session — createSchedule/pauseSchedule/resumeSchedule/
 * deleteSchedule assert on it, so a cast fake would not exercise the
 * permission gates.
 *
 * Pinned behaviors:
 *  - due schedules → exactly one 'scheduled_trigger' job enqueued, with the
 *    windowed dedup key sched:<scheduleId>:<windowStart> and payload
 *    { scheduleId, workflowId, windowStart }
 *  - double tick → idempotent no-op (second tick enqueues 0)
 *  - re-firing the same window → ON CONFLICT no-op (no duplicate job row)
 *  - next_run_at advances from the cron; last_run_at is stamped
 *  - inactive schedules are skipped
 *  - createSchedule validates cron/timezone, requires an ACTIVE workflow in
 *    the caller's org, and computes the initial next_run_at
 *  - pause/resume/delete permission gates (jobs.create / jobs.delete)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { mkAccount, headersFor } from '../authz/fixtures';
import { CODE, DB_READY, mkOrg, mkWorkflow, RUN } from '../workflows/helpers';
import { requirePermission, type Authorization } from '@/lib/authz/require-permission';
import { nextRunAt, cronWindowStart } from '@/lib/jobs/cron';
import {
  createSchedule,
  deleteSchedule,
  pauseSchedule,
  resumeSchedule,
  tickScheduler,
  type Schedule,
} from '@/lib/jobs/scheduler';

const ready = DB_READY;
const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

const SCHED_PERMS = ['jobs.view', 'jobs.create', 'jobs.delete', 'workflows.view'] as const;

let org = '';
let auth: Authorization;
let noPermAuth: Authorization;
let activeWorkflow = '';
let draftWorkflow = '';

const windowOf = (s: Schedule) => cronWindowStart(new Date(s.nextRunAt as string));

async function jobCount(scheduleId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `select count(*) n from public.jobs where dedup_key like $1`,
    [`sched:${scheduleId}:%`],
  );
  return Number(rows[0]!.n);
}

async function loadJobRow(scheduleId: string) {
  const { rows } = await owner.query<Record<string, unknown>>(
    `select id, org_id, type, status, payload, dedup_key from public.jobs
     where dedup_key like $1`,
    [`sched:${scheduleId}:%`],
  );
  return rows[0];
}

async function loadScheduleRow(scheduleId: string) {
  const { rows } = await owner.query<{
    is_active: boolean;
    last_run_at: string | null;
    next_run_at: string | null;
  }>(`select is_active, last_run_at, next_run_at from public.schedules where id = $1::uuid`, [
    scheduleId,
  ]);
  return rows[0];
}

async function forceDue(scheduleId: string, at: Date) {
  await owner.query(
    `update public.schedules set next_run_at = $2::timestamptz where id = $1::uuid`,
    [scheduleId, at.toISOString()],
  );
}

/** Custom role carrying exactly the given permission keys, assigned to one person. */
async function mkRoleWith(owner: Pool, orgId: string, key: string, permissions: readonly string[]) {
  const roleKey = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const role = (
    await owner.query<{ id: string }>(
      `insert into public.roles (org_id, key, name) values ($1,$2,$3) returning id`,
      [orgId, roleKey, `Sched ${roleKey}`],
    )
  ).rows[0]!.id;
  for (const permission of permissions) {
    const { rowCount } = await owner.query(
      `insert into public.role_permissions (role_id, permission_id, scope)
       select $1, p.id, 'GLOBAL'::public.access_scope from public.permissions p where p.key = $2`,
      [role, permission],
    );
    if (rowCount !== 1) {
      throw new Error(`permission key ${permission} is not in the catalogue — cannot grant it`);
    }
  }
  return role;
}

async function mkDept(owner: Pool, orgId: string, code: string) {
  return (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1,$2,$3) returning id`,
      [orgId, code, `Sched Dept ${code}`],
    )
  ).rows[0]!.id;
}

const authFor = (cookie: string, permission: string) => async (): Promise<Authorization> =>
  (await requirePermission(headersFor(cookie), { permission })) as Authorization;

beforeAll(async () => {
  if (!ready) return;
  // The tick is global across orgs: start clean so assertions on per-tick
  // counts are not polluted by schedules orphaned from earlier runs.
  await owner.query(`delete from public.schedules`);
  await owner.query(`delete from public.jobs where type = 'scheduled_trigger'`);
  org = await mkOrg(owner, `sched-${CODE}`);
  const dept = await mkDept(owner, org, `SD${CODE}`);
  const schedRole = await mkRoleWith(owner, org, `SCHED_${CODE}`, SCHED_PERMS);
  // The no-permission actor holds jobs.view (enough to mint an Authorization)
  // but NOT jobs.create / jobs.delete, so the gates can be probed.
  const viewRole = await mkRoleWith(owner, org, `SCHED_VIEW_${CODE}`, ['jobs.view']);
  const acct = await mkAccount(owner, {
    org,
    dept,
    run: RUN,
    label: 'sched-tick',
    customRoles: [schedRole],
  });
  const noPermAcct = await mkAccount(owner, {
    org,
    dept,
    run: RUN,
    label: 'sched-noperm',
    customRoles: [viewRole],
  });
  auth = await authFor(acct.cookie, 'jobs.create')();
  noPermAuth = await authFor(noPermAcct.cookie, 'jobs.view')();
  activeWorkflow = (await mkWorkflow(owner, org, { status: 'ACTIVE' })).id;
  draftWorkflow = (await mkWorkflow(owner, org, { status: 'DRAFT' })).id;
}, 60_000);

afterAll(async () => {
  await owner.end();
});

describe.skipIf(!ready)('scheduler tick', () => {
  it('createSchedule computes the initial next_run_at from the cron', async () => {
    const before = new Date();
    const s = await createSchedule(auth, {
      workflowId: activeWorkflow,
      name: 'morning report',
      cron: '0 9 * * *',
      timezone: 'UTC',
    });
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.orgId).toBe(org);
    expect(s.workflowId).toBe(activeWorkflow);
    expect(s.isActive).toBe(true);
    expect(s.lastRunAt).toBeNull();
    // Initial next_run_at is the first 09:00 UTC strictly after creation.
    expect(s.nextRunAt).toBe(nextRunAt('0 9 * * *', 'UTC', before).toISOString());
    await deleteSchedule(auth, s.id);
  });

  it('createSchedule rejects invalid cron / timezone', async () => {
    await expect(
      createSchedule(auth, {
        workflowId: activeWorkflow,
        name: 'bad cron',
        cron: 'not a cron',
        timezone: 'UTC',
      }),
    ).rejects.toThrow(/INVALID_REQUEST/);
    await expect(
      createSchedule(auth, {
        workflowId: activeWorkflow,
        name: 'bad tz',
        cron: '0 9 * * *',
        timezone: 'Mars/Olympus',
      }),
    ).rejects.toThrow(/INVALID_REQUEST/);
  });

  it('createSchedule rejects non-ACTIVE and foreign-org workflows', async () => {
    await expect(
      createSchedule(auth, {
        workflowId: draftWorkflow,
        name: 'draft wf',
        cron: '0 9 * * *',
        timezone: 'UTC',
      }),
    ).rejects.toThrow(/INVALID_REQUEST.*must be ACTIVE/);
    const otherOrg = await mkOrg(owner, `sched-foreign-${CODE}`);
    const foreignWf = (await mkWorkflow(owner, otherOrg, { status: 'ACTIVE' })).id;
    await expect(
      createSchedule(auth, {
        workflowId: foreignWf,
        name: 'foreign wf',
        cron: '0 9 * * *',
        timezone: 'UTC',
      }),
    ).rejects.toThrow(/Not found/);
  });

  it('createSchedule requires jobs.create', async () => {
    await expect(
      createSchedule(noPermAuth, {
        workflowId: activeWorkflow,
        name: 'no perm',
        cron: '0 9 * * *',
        timezone: 'UTC',
      }),
    ).rejects.toThrow(/do not have access/);
  });

  it('tick enqueues exactly one job per due schedule and advances it', async () => {
    const s = await createSchedule(auth, {
      workflowId: activeWorkflow,
      name: 'every minute',
      cron: '* * * * *',
      timezone: 'UTC',
    });
    const dueAt = new Date(Date.now() - 2 * 60_000);
    await forceDue(s.id, dueAt);
    const before = (await loadScheduleRow(s.id))!;

    const enqueued = await tickScheduler(new Date());
    expect(enqueued).toBe(1);

    // Exactly one job row: type, org, payload, dedup key.
    expect(await jobCount(s.id)).toBe(1);
    const job = await loadJobRow(s.id);
    expect(job).toBeDefined();
    expect(job!.type).toBe('scheduled_trigger');
    expect(job!.org_id).toBe(org);
    expect(job!.status).toBe('pending');
    const payload = job!.payload as Record<string, string>;
    expect(payload.scheduleId).toBe(s.id);
    expect(payload.workflowId).toBe(activeWorkflow);
    expect(payload.windowStart).toBe(windowOf({ ...s, nextRunAt: dueAt.toISOString() }));
    expect(job!.dedup_key).toBe(`sched:${s.id}:${payload.windowStart}`);

    // Schedule advanced: last_run_at stamped, next_run_at recomputed from cron.
    const after = (await loadScheduleRow(s.id))!;
    expect(after.last_run_at).not.toBeNull();
    expect(new Date(after.last_run_at as string).getTime()).toBeGreaterThan(
      before.last_run_at ? new Date(before.last_run_at).getTime() : 0,
    );
    expect(new Date(after.next_run_at as string).getTime()).toBeGreaterThan(dueAt.getTime());

    await deleteSchedule(auth, s.id);
  });

  it('double tick is an idempotent no-op (exactly 1 job)', async () => {
    const s = await createSchedule(auth, {
      workflowId: activeWorkflow,
      name: 'double tick',
      cron: '* * * * *',
      timezone: 'UTC',
    });
    await forceDue(s.id, new Date(Date.now() - 2 * 60_000));

    expect(await tickScheduler(new Date())).toBe(1);
    // Second tick: the schedule already advanced past now → nothing due.
    expect(await tickScheduler(new Date())).toBe(0);
    expect(await jobCount(s.id)).toBe(1);

    await deleteSchedule(auth, s.id);
  });

  it('re-firing the same window is a dedup no-op (no duplicate job row)', async () => {
    const s = await createSchedule(auth, {
      workflowId: activeWorkflow,
      name: 'same window',
      cron: '* * * * *',
      timezone: 'UTC',
    });
    const dueAt = new Date(Date.now() - 3 * 60_000);
    await forceDue(s.id, dueAt);
    expect(await tickScheduler(new Date())).toBe(1);

    // Force the SAME window due again: the dedup key collides, the fire is a
    // no-op (ON CONFLICT DO NOTHING) and the count stays 0.
    await forceDue(s.id, dueAt);
    expect(await tickScheduler(new Date())).toBe(0);
    expect(await jobCount(s.id)).toBe(1);

    await deleteSchedule(auth, s.id);
  });

  it('inactive schedules are skipped', async () => {
    const s = await createSchedule(auth, {
      workflowId: activeWorkflow,
      name: 'paused one',
      cron: '* * * * *',
      timezone: 'UTC',
    });
    await pauseSchedule(auth, s.id);
    // Even when the stored next_run_at is in the past, a paused schedule
    // must not fire.
    await forceDue(s.id, new Date(Date.now() - 5 * 60_000));
    expect(await tickScheduler(new Date())).toBe(0);
    expect(await jobCount(s.id)).toBe(0);

    // Resume recomputes next_run_at from the cron (no stale backlog).
    const resumed = await resumeSchedule(auth, s.id);
    expect(resumed.isActive).toBe(true);
    expect(new Date(resumed.nextRunAt as string).getTime()).toBeGreaterThan(Date.now() - 60_000);

    await deleteSchedule(auth, s.id);
  });

  it('deleteSchedule requires jobs.delete', async () => {
    const s = await createSchedule(auth, {
      workflowId: activeWorkflow,
      name: 'delete gate',
      cron: '0 9 * * *',
      timezone: 'UTC',
    });
    await expect(deleteSchedule(noPermAuth, s.id)).rejects.toThrow(/do not have access/);
    // The schedule survived the denied delete.
    expect((await loadScheduleRow(s.id))!.is_active).toBe(true);
    await deleteSchedule(auth, s.id);
    expect(await loadScheduleRow(s.id)).toBeUndefined();
  });
});
