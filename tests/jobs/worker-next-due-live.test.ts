/**
 * WP-W — public.worker_next_due_at() (migration 0066), LIVE DB.
 *
 * The deep-sleep worker sleeps until this instant, so it must be the earliest moment any
 * sweep would act — no earlier (wasted wakes), never later (late reminders, stuck retries).
 * Each source is checked against the predicate of the sweep that acts on it.
 *
 * Isolation: the function is global across orgs and other suites run in parallel on the same
 * database. Every due row here is inserted INSIDE a transaction that is rolled back, with a
 * timestamp in the distant past, so no other session ever sees (or claims) it, and "the
 * earliest instant" is unambiguous. Rows that must be IGNORED get an even earlier timestamp:
 * if one leaked into the answer, the answer would be that timestamp.
 *
 * Gated behind DB_READY; runs in CI against the ephemeral Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from '@neondatabase/serverless';

import {
  DB_READY,
  inContext,
  mkOrg,
  mkPerson,
  mkTask,
  mkWorkflow,
  RUN,
  sqlstateOf,
} from '../workflows/helpers';

describe.skipIf(!DB_READY)('worker_next_due_at (live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  const appUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
  // The worker's own login (0070): worker_next_due_at() is app_worker's alone.
  const appWorker = new Pool({ connectionString: process.env.DATABASE_URL_WORKER });
  let orgId = '';
  let personId = '';
  let workflowId = '';
  let taskId = '';

  beforeAll(async () => {
    if (!DB_READY) return;
    orgId = await mkOrg(owner, `nextdue-${RUN}`);
    personId = await mkPerson(owner, orgId, `NextDue ${RUN}`);
    workflowId = (await mkWorkflow(owner, orgId)).id;
    taskId = await mkTask(owner, orgId, null, `nextdue task ${RUN}`);
  }, 60_000);

  afterAll(async () => {
    if (!DB_READY) return;
    await owner.end();
    await appUser.end();
    await appWorker.end();
  });

  /** Run `seed` and read the answer inside one transaction that is always rolled back. */
  async function dueWith(seed: (c: PoolClient) => Promise<unknown>): Promise<string | null> {
    const c = await owner.connect();
    try {
      await c.query('begin');
      await seed(c);
      const { rows } = await c.query<{ due: string | null }>(
        `select to_char(public.worker_next_due_at() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as due`,
      );
      return rows[0]!.due;
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  }

  const job = (c: PoolClient, status: string, at: string, extra = '') =>
    c.query(
      `insert into public.jobs (org_id, type, status, attempts, max_attempts, next_run_at,
                                claimed_by, claimed_at, heartbeat_at)
       values ($1, 'email', $2, ${extra === 'exhausted' ? 5 : 0}, 5, $3::timestamptz,
               ${status === 'claimed' || status === 'running' ? `'w-x', $3::timestamptz, $3::timestamptz` : 'null, null, null'})`,
      [orgId, status, at],
    );

  /** No ignored row may surface: the answer is either nothing, or later than all of them. */
  const ignored = (due: string | null) => expect(due === null || due > '1996-01-01').toBe(true);

  it('a pending job is due at its next_run_at', async () => {
    expect(await dueWith((c) => job(c, 'pending', '2001-02-03T04:05:06Z'))).toBe(
      '2001-02-03T04:05:06',
    );
  });

  it('a failed job with attempts left is due at its retry time; an exhausted one is not', async () => {
    expect(await dueWith((c) => job(c, 'failed', '2002-01-01T00:00:00Z'))).toBe(
      '2002-01-01T00:00:00',
    );
    ignored(await dueWith((c) => job(c, 'failed', '1990-01-01T00:00:00Z', 'exhausted')));
  });

  it('a claimed or running job is due for the reaper 60 s after its last heartbeat', async () => {
    expect(await dueWith((c) => job(c, 'claimed', '2003-01-01T00:00:00Z'))).toBe(
      '2003-01-01T00:01:00',
    );
    expect(await dueWith((c) => job(c, 'running', '2003-06-01T00:00:00Z'))).toBe(
      '2003-06-01T00:01:00',
    );
  });

  it('terminal jobs are never due', async () => {
    for (const status of ['succeeded', 'cancelled', 'dead_letter']) {
      ignored(await dueWith((c) => job(c, status, '1990-01-01T00:00:00Z')));
    }
  });

  it('an unsent reminder is due at remind_at; a sent one is not', async () => {
    const reminder = (c: PoolClient, at: string, sent: boolean) =>
      c.query(
        `insert into public.task_reminders (org_id, task_id, person_id, remind_at, is_sent)
         values ($1, $2, $3, $4::timestamptz, $5)`,
        [orgId, taskId, personId, at, sent],
      );
    expect(await dueWith((c) => reminder(c, '2004-04-04T04:04:00Z', false))).toBe(
      '2004-04-04T04:04:00',
    );
    ignored(await dueWith((c) => reminder(c, '1990-01-01T00:00:00Z', true)));
  });

  it('an active schedule is due at next_run_at; an inactive one is not', async () => {
    const schedule = (c: PoolClient, at: string, active: boolean) =>
      c.query(
        `insert into public.schedules (org_id, workflow_id, name, cron, timezone, is_active, next_run_at)
         values ($1, $2, $3, '0 9 * * *', 'UTC', $4, $5::timestamptz)`,
        [orgId, workflowId, `nextdue-${RUN}-${Math.random()}`, active, at],
      );
    expect(await dueWith((c) => schedule(c, '2005-05-05T05:05:00Z', true))).toBe(
      '2005-05-05T05:05:00',
    );
    ignored(await dueWith((c) => schedule(c, '1990-01-01T00:00:00Z', false)));
  });

  it('answers the earliest instant across every source', async () => {
    const due = await dueWith(async (c) => {
      await job(c, 'pending', '2001-05-01T00:00:00Z');
      await job(c, 'failed', '2001-03-01T00:00:00Z');
      await job(c, 'claimed', '2001-04-01T00:00:00Z');
      await c.query(
        `insert into public.task_reminders (org_id, task_id, person_id, remind_at)
         values ($1, $2, $3, '2001-02-01T00:00:00Z')`,
        [orgId, taskId, personId],
      );
    });
    expect(due).toBe('2001-02-01T00:00:00');
  });

  it('refuses a signed-in person context (42501), even on the worker login', async () => {
    // On app_worker the function itself refuses a person (its body check); on
    // app_user it is not executable at all (0070).
    for (const pool of [appWorker, appUser]) {
      expect(
        await sqlstateOf(
          inContext(pool, { personId, orgId }, `select public.worker_next_due_at()`),
        ),
      ).toBe('42501');
    }
  });

  it('answers app_worker with no identity — the worker plane — and the TS wrapper parses it', async () => {
    await expect(
      inContext(appWorker, {}, `select public.worker_next_due_at() as due`),
    ).resolves.toBeDefined();
    // app_user cannot ask at all (0070), even with no identity.
    expect(
      await sqlstateOf(inContext(appUser, {}, `select public.worker_next_due_at() as due`)),
    ).toBe('42501');
    const { workerNextDueAt } = await import('@/lib/jobs/worker');
    const due = await workerNextDueAt();
    expect(due === null || Number.isFinite(due.getTime())).toBe(true);
  });
});
