import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import {
  CODE,
  DB_READY,
  assertForceRls,
  inContext,
  mkOrg,
  mkPerson,
  mkRoleFor,
  mkWorkflow,
  sqlstateOf,
  type Ctx,
} from '../workflows/helpers';

/**
 * Phase 6 — cross-tenant RLS matrix for the automation job system
 * (migration 0045, architecture contracts §2.4/§2.5). Runs on CI against an
 * ephemeral Neon branch; they run under `pnpm test` (the default vitest
 * glob) and skip locally when the branch env vars are absent
 * (describe.skipIf(!DB_READY)).
 *
 * Follows the Phase 5 workflow-rls.test.ts pattern exactly: owner
 * (DATABASE_URL_MIGRATE, role app_owner) seeds fixtures and inspects the
 * catalogue; asUser (DATABASE_URL_TEST, role app_user) is where every
 * boundary is probed. Nothing is mocked.
 *
 * Tenant-isolation properties pinned here (both directions):
 *  - jobs / schedules: select/insert/update for app_user are org-pinned and
 *    need the jobs.* grants. jobs UPDATE admits jobs.retry OR jobs.cancel;
 *    schedules UPDATE gates on jobs.create. NO delete policy on either
 *    table — raw DELETE raises 42501 for everybody except app_owner (jobs
 *    move through the status machine; schedules deactivate via is_active).
 *  - jobs.delete is ADMIN-only: PROJECT_MANAGER holds the four operational
 *    keys and MUST NOT hold jobs.delete (0045 seed matrix).
 *  - Dedup keys are per-org: the same dedup_key in two orgs does not
 *    collide (unique index is on (org_id, dedup_key)).
 *  - The org-guard triggers raise 42501 on foreign-org references:
 *    jobs_org_guard for a bogus org_id; schedules_workflow_org_guard when
 *    the schedule's workflow belongs to a different org.
 */
const ready = DB_READY;
const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const ctxFor = (personId: string, orgId: string): Ctx => ({ personId, orgId });

/** The four operational job keys — everything except the admin-only purge key. */
const JOB_OPS = ['jobs.view', 'jobs.create', 'jobs.retry', 'jobs.cancel'];

let orgA = '';
let orgB = '';
let alice = ''; // org A, the four operational jobs keys (no jobs.delete)
let bob = ''; // org B, the four operational jobs keys
let carol = ''; // org A, NO jobs permissions
let dave = ''; // org A, jobs.view + jobs.cancel only (cancel path without retry)
let adminP = ''; // org A, system ADMIN role
let pmP = ''; // org A, system PROJECT_MANAGER role
let wfA = '';
let wfB = '';
let jobA = ''; // org A job, seeded in 'failed' for the retry tests
let jobB = ''; // org B job
let schedA = ''; // org A schedule on wfA
let schedB = ''; // org B schedule on wfB

const mkJob = async (
  owner: Pool,
  org: string,
  opts: { type?: string; status?: string; dedupKey?: string | null } = {},
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.jobs (org_id, type, status, dedup_key)
       values ($1::uuid, $2, $3, $4) returning id`,
      [org, opts.type ?? 'email', opts.status ?? 'pending', opts.dedupKey ?? null],
    )
  ).rows[0]!.id;

const mkSchedule = async (owner: Pool, org: string, workflowId: string, name: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.schedules (org_id, workflow_id, name, cron, timezone)
       values ($1::uuid, $2::uuid, $3, '0 9 * * *', 'UTC') returning id`,
      [org, workflowId, name],
    )
  ).rows[0]!.id;

/** Assign an existing system role (seeded by the organizations trigger) to a person. */
const assignSystemRole = async (owner: Pool, org: string, person: string, roleKey: string) => {
  const { rowCount } = await owner.query(
    `insert into public.person_roles (person_id, role_id, org_id)
     select $1, r.id, $3 from public.roles r
     where r.org_id = $2 and r.key = $4`,
    [person, org, org, roleKey],
  );
  if (rowCount !== 1) throw new Error(`system role ${roleKey} missing in org ${org}`);
};

beforeAll(async () => {
  if (!ready) return;
  orgA = await mkOrg(owner, `rls-jobs-a-${CODE}`);
  orgB = await mkOrg(owner, `rls-jobs-b-${CODE}`);
  alice = await mkPerson(owner, orgA, 'Alice Jobs');
  bob = await mkPerson(owner, orgB, 'Bob Jobs');
  carol = await mkPerson(owner, orgA, 'Carol Jobs');
  dave = await mkPerson(owner, orgA, 'Dave Jobs');
  adminP = await mkPerson(owner, orgA, 'Admin Jobs');
  pmP = await mkPerson(owner, orgA, 'PM Jobs');
  await mkRoleFor(owner, orgA, alice, `JOBS_OPS_A_${CODE}`, JOB_OPS);
  await mkRoleFor(owner, orgB, bob, `JOBS_OPS_B_${CODE}`, JOB_OPS);
  await mkRoleFor(owner, orgA, dave, `JOBS_CANCEL_${CODE}`, ['jobs.view', 'jobs.cancel']);
  await assignSystemRole(owner, orgA, adminP, 'ADMIN');
  await assignSystemRole(owner, orgA, pmP, 'PROJECT_MANAGER');
  wfA = (await mkWorkflow(owner, orgA, { name: `wf-jobs-a-${CODE}`, createdBy: alice })).id;
  wfB = (await mkWorkflow(owner, orgB, { name: `wf-jobs-b-${CODE}`, createdBy: bob })).id;
  jobA = await mkJob(owner, orgA, { type: 'email', status: 'failed', dedupKey: `jobA-${CODE}` });
  jobB = await mkJob(owner, orgB, { type: 'webhook', status: 'pending', dedupKey: `jobB-${CODE}` });
  schedA = await mkSchedule(owner, orgA, wfA, `sched-a-${CODE}`);
  schedB = await mkSchedule(owner, orgB, wfB, `sched-b-${CODE}`);
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

describe.skipIf(!ready)('jobs RLS: catalogue and grant matrix', () => {
  it('forces RLS on jobs and schedules', async () => {
    await assertForceRls(owner, 'jobs');
    await assertForceRls(owner, 'schedules');
  });

  it('seeds the five jobs permission keys (module jobs, non-sensitive)', async () => {
    const { rows } = await owner.query<{ key: string; module: string; is_sensitive: boolean }>(
      `select key, module, is_sensitive from public.permissions where key like 'jobs.%' order by key`,
    );
    expect(rows.map((r) => r.key)).toEqual([
      'jobs.cancel',
      'jobs.create',
      'jobs.delete',
      'jobs.retry',
      'jobs.view',
    ]);
    expect(rows.every((r) => r.module === 'jobs' && r.is_sensitive === false)).toBe(true);
  });

  it('ADMIN holds all five jobs keys at GLOBAL; PROJECT_MANAGER holds the four non-delete keys', async () => {
    const { rows } = await owner.query<{ role_key: string; key: string; scope: string }>(
      `select r.key as role_key, p.key, rp.scope::text as scope
         from public.role_permissions rp
         join public.roles r on r.id = rp.role_id
         join public.permissions p on p.id = rp.permission_id
        where r.org_id = $1::uuid and r.is_system
          and r.key in ('ADMIN', 'PROJECT_MANAGER')
          and p.key like 'jobs.%'
        order by r.key, p.key`,
      [orgA],
    );
    const held = new Map(rows.map((r) => [`${r.role_key}:${r.key}`, r.scope]));
    for (const key of ['jobs.view', 'jobs.create', 'jobs.retry', 'jobs.cancel', 'jobs.delete']) {
      expect(held.get(`ADMIN:${key}`)).toBe('GLOBAL');
    }
    for (const key of JOB_OPS) {
      expect(held.get(`PROJECT_MANAGER:${key}`)).toBe('DEPARTMENT');
    }
    expect(held.has('PROJECT_MANAGER:jobs.delete')).toBe(false);
  });

  it('jobs.delete resolves true for ADMIN and false for PROJECT_MANAGER (authz.has)', async () => {
    const admin = await inContext<{ has: boolean }>(
      asUser,
      ctxFor(adminP, orgA),
      `select authz.has('jobs.delete') as has`,
    );
    expect(admin[0]!.has).toBe(true);
    const pm = await inContext<{ has: boolean }>(
      asUser,
      ctxFor(pmP, orgA),
      `select authz.has('jobs.delete') as has`,
    );
    expect(pm[0]!.has).toBe(false);
    const pmView = await inContext<{ has: boolean }>(
      asUser,
      ctxFor(pmP, orgA),
      `select authz.has('jobs.view') as has`,
    );
    expect(pmView[0]!.has).toBe(true);
  });
});

describe.skipIf(!ready)('jobs RLS: jobs table matrix', () => {
  it('select: each tenant sees only its own jobs', async () => {
    const a = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `select id from public.jobs`,
    );
    expect(a.map((r) => r.id)).toContain(jobA);
    expect(a.map((r) => r.id)).not.toContain(jobB);

    const b = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `select id from public.jobs where id = $1::uuid`,
      [jobA],
    );
    expect(b).toHaveLength(0); // cross-tenant read → zero rows
  });

  it('select: no jobs.view grant → zero rows', async () => {
    const rows = await inContext(asUser, ctxFor(carol, orgA), `select id from public.jobs`);
    expect(rows).toHaveLength(0);
  });

  it('insert: cross-org insert fails with 42501', async () => {
    const code = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(bob, orgB),
        `insert into public.jobs (org_id, type) values ($1::uuid, 'email')`,
        [orgA],
      ),
    );
    expect(code).toBe('42501');
  });

  it('insert: own-org insert with jobs.create succeeds', async () => {
    const rows = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.jobs (org_id, type) values ($1::uuid, 'cleanup') returning id`,
      [orgA],
    );
    expect(rows).toHaveLength(1);
  });

  it('insert: without jobs.create fails with 42501', async () => {
    const code = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(carol, orgA),
        `insert into public.jobs (org_id, type) values ($1::uuid, 'email')`,
        [orgA],
      ),
    );
    expect(code).toBe('42501');
  });

  it('insert: job whose org_id is not a real organization → 42501 (jobs_org_guard)', async () => {
    const code = await sqlstateOf(
      owner.query(`insert into public.jobs (org_id, type) values ($1::uuid, 'email')`, [
        '99999999-9999-4999-8999-999999999999',
      ]),
    );
    expect(code).toBe('42501');
  });

  it('update: cross-tenant retry touches zero rows', async () => {
    const rows = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `update public.jobs set status = 'pending' where id = $1::uuid returning id`,
      [jobA],
    );
    expect(rows).toHaveLength(0);
  });

  it('update: retry of own failed job with jobs.retry succeeds', async () => {
    const rows = await inContext<{ id: string; status: string }>(
      asUser,
      ctxFor(alice, orgA),
      `update public.jobs set status = 'pending', attempts = attempts + 1
        where id = $1::uuid returning id, status`,
      [jobA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
  });

  it('update: cancel path admits jobs.cancel alone (no jobs.retry)', async () => {
    const rows = await inContext<{ id: string; status: string }>(
      asUser,
      ctxFor(dave, orgA),
      `update public.jobs set status = 'cancelled' where id = $1::uuid returning id, status`,
      [jobA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('cancelled');
  });

  it('update: without jobs.retry / jobs.cancel touches zero rows', async () => {
    const rows = await inContext<{ id: string }>(
      asUser,
      ctxFor(carol, orgA),
      `update public.jobs set status = 'pending' where id = $1::uuid returning id`,
      [jobA],
    );
    expect(rows).toHaveLength(0);
  });

  it('update: moving a job to another org fails with 42501 (WITH CHECK pins org_id)', async () => {
    const code = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(alice, orgA),
        `update public.jobs set org_id = $1::uuid where id = $2::uuid`,
        [orgB, jobA],
      ),
    );
    expect(code).toBe('42501');
  });

  it('delete: raw DELETE raises 42501 even for own rows (status machine owns lifecycle)', async () => {
    const code = await sqlstateOf(
      inContext(asUser, ctxFor(alice, orgA), `delete from public.jobs where id = $1::uuid`, [jobA]),
    );
    expect(code).toBe('42501');
  });

  it('delete: app_owner can purge a job row (retention path)', async () => {
    const doomed = await mkJob(owner, orgA, { dedupKey: `doomed-${CODE}` });
    const { rowCount } = await owner.query(`delete from public.jobs where id = $1::uuid`, [doomed]);
    expect(rowCount).toBe(1);
  });
});

describe.skipIf(!ready)('jobs RLS: schedules table matrix', () => {
  it('select: each tenant sees only its own schedules', async () => {
    const a = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `select id from public.schedules`,
    );
    expect(a.map((r) => r.id)).toContain(schedA);
    expect(a.map((r) => r.id)).not.toContain(schedB);

    const b = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `select id from public.schedules where id = $1::uuid`,
      [schedA],
    );
    expect(b).toHaveLength(0); // cross-tenant read → zero rows
  });

  it('select: no jobs.view grant → zero rows', async () => {
    const rows = await inContext(asUser, ctxFor(carol, orgA), `select id from public.schedules`);
    expect(rows).toHaveLength(0);
  });

  it('insert: own-org schedule on own workflow succeeds', async () => {
    const rows = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.schedules (org_id, workflow_id, name, cron, timezone)
       values ($1::uuid, $2::uuid, $3, '0 9 * * *', 'UTC') returning id`,
      [orgA, wfA, `own-sched-${CODE}`],
    );
    expect(rows).toHaveLength(1);
  });

  it('insert: schedule whose workflow belongs to another org → 42501 (schedules_workflow_org_guard)', async () => {
    // org_id matches the caller's org (RLS WITH CHECK passes); the workflow is
    // foreign, so the org-guard trigger is what rejects it.
    const code = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(alice, orgA),
        `insert into public.schedules (org_id, workflow_id, name, cron, timezone)
         values ($1::uuid, $2::uuid, $3, '0 9 * * *', 'UTC')`,
        [orgA, wfB, `x-sched-${CODE}`],
      ),
    );
    expect(code).toBe('42501');
  });

  it('insert: without jobs.create fails with 42501', async () => {
    const code = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(carol, orgA),
        `insert into public.schedules (org_id, workflow_id, name, cron, timezone)
         values ($1::uuid, $2::uuid, $3, '0 9 * * *', 'UTC')`,
        [orgA, wfA, `y-sched-${CODE}`],
      ),
    );
    expect(code).toBe('42501');
  });

  it('update: cross-tenant update touches zero rows', async () => {
    const rows = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `update public.schedules set name = $1 where id = $2::uuid returning id`,
      [`hijacked-${CODE}`, schedA],
    );
    expect(rows).toHaveLength(0);
  });

  it('update: own schedule with jobs.create succeeds', async () => {
    const rows = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `update public.schedules set is_active = false where id = $1::uuid returning id`,
      [schedA],
    );
    expect(rows).toHaveLength(1);
  });

  it('update: without jobs.create touches zero rows', async () => {
    const rows = await inContext<{ id: string }>(
      asUser,
      ctxFor(carol, orgA),
      `update public.schedules set is_active = false where id = $1::uuid returning id`,
      [schedA],
    );
    expect(rows).toHaveLength(0);
  });

  it('update: retargeting a schedule at another org workflow → 42501 (org-guard)', async () => {
    const code = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(alice, orgA),
        `update public.schedules set workflow_id = $1::uuid where id = $2::uuid`,
        [wfB, schedA],
      ),
    );
    expect(code).toBe('42501');
  });

  it('delete: raw DELETE raises 42501 even for own rows (no delete policy)', async () => {
    const code = await sqlstateOf(
      inContext(asUser, ctxFor(alice, orgA), `delete from public.schedules where id = $1::uuid`, [
        schedA,
      ]),
    );
    expect(code).toBe('42501');
  });

  it('delete: PROJECT_MANAGER cannot delete schedules via the purge key either (no jobs.delete grant)', async () => {
    // The RLS layer denies DELETE to everyone but app_owner; the permission
    // layer denies jobs.delete to PROJECT_MANAGER (proved in the catalogue
    // describe above). Both layers fail closed independently.
    const code = await sqlstateOf(
      inContext(asUser, ctxFor(pmP, orgA), `delete from public.schedules where id = $1::uuid`, [
        schedA,
      ]),
    );
    expect(code).toBe('42501');
    const has = await inContext<{ has: boolean }>(
      asUser,
      ctxFor(pmP, orgA),
      `select authz.has('jobs.delete') as has`,
    );
    expect(has[0]!.has).toBe(false);
  });
});

describe.skipIf(!ready)('jobs RLS: dedup keys are org-scoped', () => {
  it('same dedup_key in two orgs → both inserts allowed (no cross-org collision)', async () => {
    const key = `shared-dedup-${CODE}`;
    const a = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.jobs (org_id, type, dedup_key) values ($1::uuid, 'email', $2) returning id`,
      [orgA, key],
    );
    expect(a).toHaveLength(1);
    const b = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `insert into public.jobs (org_id, type, dedup_key) values ($1::uuid, 'email', $2) returning id`,
      [orgB, key],
    );
    expect(b).toHaveLength(1);
  });

  it('duplicate dedup_key within the same org → 23505', async () => {
    const key = `same-org-dedup-${CODE}`;
    const first = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.jobs (org_id, type, dedup_key) values ($1::uuid, 'email', $2) returning id`,
      [orgA, key],
    );
    expect(first).toHaveLength(1);
    const code = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(alice, orgA),
        `insert into public.jobs (org_id, type, dedup_key) values ($1::uuid, 'email', $2)`,
        [orgA, key],
      ),
    );
    expect(code).toBe('23505');
  });

  it('jobs without dedup keys never collide (partial unique index)', async () => {
    const a = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.jobs (org_id, type) values ($1::uuid, 'cleanup') returning id`,
      [orgA],
    );
    const b = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.jobs (org_id, type) values ($1::uuid, 'cleanup') returning id`,
      [orgA],
    );
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.id).not.toBe(b[0]!.id);
  });
});
