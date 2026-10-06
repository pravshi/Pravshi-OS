/**
 * Phase 6 — workflow job execution tests (P0 blocker fix, 0048 bridge).
 *
 * The core Phase 6 → Phase 5 integration: a `workflow_run` job must drive
 * the Phase 5 engine under the job's verified execution principal — NOT the
 * system actor (which is not a person row, so authz.has('workflows.execute')
 * raised FORBIDDEN and every RLS read failed closed).
 *
 * Two layers, matching the repo's test conventions:
 *
 *  1. Mocked handler tests (ALWAYS run): the 0048 definer call
 *     (withQueueDb), dispatchWorkflowEvent, executeWorkflowManual, and the
 *     schedule-row load (withAuthorizedDb) are mocked at the module
 *     boundary. These pin the handler contract:
 *       - enqueue workflow_run job → worker processes → Phase 5 entry point
 *         invoked with an Authorization whose ctx is the definer-verified
 *         (org_id, person_id) — never the system actor;
 *       - definer 22023 (job-row verification failure) → non-retryable
 *         VALIDATION_ERROR (dead-letter, no retry burn);
 *       - definer 42501 (principal failure) propagates to the retry
 *         classifier untouched;
 *       - definer org ≠ job-row org → non-retryable FORBIDDEN
 *         (defense in depth);
 *       - malformed payloads dead-letter BEFORE any DB round-trip.
 *
 *  2. DB-gated tests (describe.skipIf(!DB_READY)): the real 0048 migration
 *     against an ephemeral branch — the definer's verification matrix, the
 *     enqueued_by stamp trigger, and the app_user EXECUTE grant. Skipped
 *     locally when the branch env vars are absent, like the Phase 5 suites.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from '@neondatabase/serverless';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { dispatchWorkflowEventMock, executeWorkflowManualMock, runWorkflowsForEventMock } =
  vi.hoisted(() => ({
    dispatchWorkflowEventMock: vi.fn(async () => undefined),
    executeWorkflowManualMock: vi.fn(async () => ({
      executionId: 'exec-00000000-0000-4000-8000-000000000001',
    })),
    runWorkflowsForEventMock: vi.fn(async () => undefined),
  }));
const { withQueueDbMock } = vi.hoisted(() => ({
  // withQueueDb<T>(fn: (tx) => Promise<T>)
  withQueueDbMock: vi.fn(),
}));
const { withAuthorizedDbMock } = vi.hoisted(() => ({
  // withAuthorizedDb<T>(ctx, fn: (tx) => Promise<T>)
  withAuthorizedDbMock: vi.fn(),
}));

vi.mock('@/lib/workflows/events', () => ({
  dispatchWorkflowEvent: dispatchWorkflowEventMock,
}));
vi.mock('@/lib/workflows/engine', () => ({
  executeWorkflowManual: executeWorkflowManualMock,
  runWorkflowsForEvent: runWorkflowsForEventMock,
}));
vi.mock('@/lib/jobs/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/jobs/queue')>();
  return { ...actual, withQueueDb: withQueueDbMock };
});
vi.mock('@/lib/db/authorized', () => ({
  withAuthorizedDb: withAuthorizedDbMock,
}));
// queue.ts (importOriginal above) pulls in the pool connector, which
// validates runtime env at import time — stub it: the mocked tests never
// touch a real connection.
vi.mock('@/lib/db/pool', () => ({
  connectWithWake: vi.fn(async () => {
    throw new Error('connectWithWake is stubbed in mocked tests');
  }),
}));

// ── Imports under test ────────────────────────────────────────────────────────

import { handleWorkflowRun, handleScheduledTrigger } from '@/lib/jobs/workflow-jobs';
import type { Job } from '@/lib/jobs/types';
import type { JobExecutionContext } from '@/lib/jobs/worker';
import { DB_READY, RUN, mkOrg, mkPerson, mkWorkflow, sqlstateOf } from '../workflows/helpers';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const PERSON = '22222222-2222-4222-8222-222222222222';
const WORKFLOW = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';
const SCHEDULE = '55555555-5555-4555-8555-555555555555';

function mkJob(overrides: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return {
    id: JOB_ID,
    orgId: ORG,
    type: 'workflow_run',
    status: 'running',
    priority: 0,
    payload: {},
    attempts: 0,
    maxAttempts: 5,
    nextRunAt: now,
    claimedBy: 'worker-1',
    claimedAt: now,
    heartbeatAt: now,
    dedupKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mkCtx(job: Job): JobExecutionContext {
  return {
    job,
    auth: undefined as never,
    signal: new AbortController().signal,
  };
}

const validEventInput = {
  type: 'manual',
  entityType: null,
  entityId: null,
  dedupKey: 'test-dedup-1',
  payload: {},
};

/** The 0048 definer resolves the job to (org_id, person_id). */
function mockDefinerOk(orgId = ORG, personId = PERSON) {
  withQueueDbMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      execute: async () => ({ rows: [{ org_id: orgId, person_id: personId }] }),
    }),
  );
}

/** The definer raises a pg error with the given SQLSTATE code. */
function mockDefinerRaises(code: '22023' | '42501', message: string) {
  withQueueDbMock.mockImplementationOnce(async () => {
    const error = new Error(message) as Error & { code?: string };
    error.code = code;
    throw error;
  });
}

beforeAll(() => {
  vi.clearAllMocks();
});

// ── Layer 1: mocked handler contract ──────────────────────────────────────────

describe('handleWorkflowRun — 0048 execution bridge (mocked)', () => {
  it('dispatches eventInput under the definer-verified principal, never the system actor', async () => {
    mockDefinerOk();
    const job = mkJob({
      payload: { workflowId: WORKFLOW, eventInput: validEventInput, depth: 0 },
    });

    await handleWorkflowRun(mkCtx(job));

    expect(withQueueDbMock).toHaveBeenCalledTimes(1);
    expect(runWorkflowsForEventMock).toHaveBeenCalledTimes(1);
    const [auth, event] = runWorkflowsForEventMock.mock.calls[0] as unknown as [
      { ctx: { personId: string; orgId: string }; permission: string },
      typeof validEventInput & {
        id: string;
        orgId: string;
        actorPersonId: string;
        occurredAt: string;
      },
    ];
    // The engine runs as the REAL principal bound to the job row …
    expect(auth.ctx.personId).toBe(PERSON);
    expect(auth.ctx.orgId).toBe(ORG);
    expect(auth.permission).toBe('workflows.execute');
    // … and never as the system actor.
    expect(auth.ctx.personId).not.toMatch(/^system:job:/);
    expect(auth.ctx.personId).not.toBe('00000000-0000-4000-8000-000000000000');
    // The full event is stamped from the job's principal (worker bypasses the dispatcher).
    expect(event.type).toBe(validEventInput.type);
    expect(event.dedupKey).toBe(validEventInput.dedupKey);
    expect(event.orgId).toBe(ORG);
    expect(event.actorPersonId).toBe(PERSON);
    expect(typeof event.id).toBe('string');
    expect(typeof event.occurredAt).toBe('string');
    expect(executeWorkflowManualMock).not.toHaveBeenCalled();
  });

  it('executes manualInput via executeWorkflowManual under the verified principal', async () => {
    mockDefinerOk();
    const manualInput = { dedupKey: 'manual-1', extra: 'passes through' };
    const job = mkJob({ payload: { workflowId: WORKFLOW, manualInput } });

    await handleWorkflowRun(mkCtx(job));

    expect(executeWorkflowManualMock).toHaveBeenCalledTimes(1);
    const [auth, workflowId, input] = executeWorkflowManualMock.mock.calls[0] as unknown as [
      { ctx: { personId: string; orgId: string } },
      string,
      unknown,
    ];
    expect(auth.ctx.personId).toBe(PERSON);
    expect(auth.ctx.orgId).toBe(ORG);
    expect(workflowId).toBe(WORKFLOW);
    expect(input).toEqual(manualInput);
    expect(dispatchWorkflowEventMock).not.toHaveBeenCalled();
    expect(runWorkflowsForEventMock).not.toHaveBeenCalled();
  });

  it('prefers eventInput when both inputs are present', async () => {
    mockDefinerOk();
    const job = mkJob({
      payload: {
        workflowId: WORKFLOW,
        eventInput: validEventInput,
        manualInput: { dedupKey: 'm' },
      },
    });

    await handleWorkflowRun(mkCtx(job));

    expect(runWorkflowsForEventMock).toHaveBeenCalledTimes(1);
    expect(executeWorkflowManualMock).not.toHaveBeenCalled();
  });

  it('dead-letters an over-depth payload without touching the DB', async () => {
    const job = mkJob({
      payload: { workflowId: WORKFLOW, eventInput: validEventInput, depth: 6 },
    });

    await expect(handleWorkflowRun(mkCtx(job))).rejects.toMatchObject({
      name: 'WorkflowJobError',
      code: 'VALIDATION_ERROR',
    });
    expect(withQueueDbMock).not.toHaveBeenCalled();
    expect(dispatchWorkflowEventMock).not.toHaveBeenCalled();
  });

  it('dead-letters a payload with neither input without touching the DB', async () => {
    const job = mkJob({ payload: { workflowId: WORKFLOW } });

    await expect(handleWorkflowRun(mkCtx(job))).rejects.toMatchObject({
      name: 'WorkflowJobError',
      code: 'VALIDATION_ERROR',
    });
    expect(withQueueDbMock).not.toHaveBeenCalled();
  });

  it('maps definer 22023 (job-row verification failure) to non-retryable VALIDATION_ERROR', async () => {
    mockDefinerRaises('22023', 'workflow_execute_as_job: job xxx is pending, not running');
    const job = mkJob({
      payload: { workflowId: WORKFLOW, eventInput: validEventInput },
    });

    await expect(handleWorkflowRun(mkCtx(job))).rejects.toMatchObject({
      name: 'WorkflowJobError',
      code: 'VALIDATION_ERROR',
    });
    expect(dispatchWorkflowEventMock).not.toHaveBeenCalled();
    expect(executeWorkflowManualMock).not.toHaveBeenCalled();
  });

  it('lets definer 42501 (principal failure) propagate to the retry classifier untouched', async () => {
    mockDefinerRaises('42501', 'workflow_execute_as_job: no live principal');
    const job = mkJob({
      payload: { workflowId: WORKFLOW, eventInput: validEventInput },
    });

    await expect(handleWorkflowRun(mkCtx(job))).rejects.toMatchObject({ code: '42501' });
    expect(dispatchWorkflowEventMock).not.toHaveBeenCalled();
  });

  it('rejects non-retryable when the definer org differs from the job row (defense in depth)', async () => {
    mockDefinerOk(OTHER_ORG, PERSON);
    const job = mkJob({
      payload: { workflowId: WORKFLOW, eventInput: validEventInput },
    });

    await expect(handleWorkflowRun(mkCtx(job))).rejects.toMatchObject({
      name: 'WorkflowJobError',
      code: 'FORBIDDEN',
    });
    expect(dispatchWorkflowEventMock).not.toHaveBeenCalled();
    expect(executeWorkflowManualMock).not.toHaveBeenCalled();
  });
});

describe('handleScheduledTrigger — 0048 execution bridge (mocked)', () => {
  const scheduleRow = {
    id: SCHEDULE,
    orgId: ORG,
    workflowId: WORKFLOW,
    cron: '* * * * *',
    timezone: 'UTC',
    isActive: true,
    lastRunAt: null,
  };

  function mockScheduleLoad(row: typeof scheduleRow | undefined) {
    withAuthorizedDbMock.mockImplementation(
      async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: async () => ({ rows: row === undefined ? [] : [row] }),
        }),
    );
  }

  it('loads the schedule under the verified principal and delegates a scheduled event', async () => {
    mockDefinerOk();
    mockScheduleLoad(scheduleRow);
    const windowStart = '2026-10-06T06:00:00.000Z';
    const job = mkJob({
      type: 'scheduled_trigger',
      payload: { scheduleId: SCHEDULE, workflowId: WORKFLOW, windowStart },
    });

    await handleScheduledTrigger(mkCtx(job));

    expect(runWorkflowsForEventMock).toHaveBeenCalledTimes(1);
    const [auth, event] = runWorkflowsForEventMock.mock.calls[0] as unknown as [
      { ctx: { personId: string; orgId: string } },
      { type: string; dedupKey: string; entityType: null; payload: Record<string, unknown> },
    ];
    expect(auth.ctx.personId).toBe(PERSON);
    expect(auth.ctx.orgId).toBe(ORG);
    expect(event.type).toBe('scheduled');
    expect(event.entityType).toBeNull();
    expect(event.dedupKey).toBe(`sched:${SCHEDULE}:${windowStart}`);
    expect(event.payload.scheduleId).toBe(SCHEDULE);
  });

  it('no-ops on an inactive schedule', async () => {
    mockDefinerOk();
    mockScheduleLoad({ ...scheduleRow, isActive: false });
    const job = mkJob({
      type: 'scheduled_trigger',
      payload: {
        scheduleId: SCHEDULE,
        workflowId: WORKFLOW,
        windowStart: '2026-10-06T06:00:00.000Z',
      },
    });

    await handleScheduledTrigger(mkCtx(job));

    expect(dispatchWorkflowEventMock).not.toHaveBeenCalled();
  });

  it('dead-letters a missing schedule as NOT_FOUND', async () => {
    mockDefinerOk();
    mockScheduleLoad(undefined);
    const job = mkJob({
      type: 'scheduled_trigger',
      payload: {
        scheduleId: SCHEDULE,
        workflowId: WORKFLOW,
        windowStart: '2026-10-06T06:00:00.000Z',
      },
    });

    await expect(handleScheduledTrigger(mkCtx(job))).rejects.toMatchObject({
      name: 'WorkflowJobError',
      code: 'NOT_FOUND',
    });
    expect(dispatchWorkflowEventMock).not.toHaveBeenCalled();
  });
});

// ── Layer 2: the real 0048 migration, DB-gated ────────────────────────────────

describe.skipIf(!DB_READY)('workflow_execute_as_job() — 0048 verification matrix (live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  const appUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

  let org = '';
  let person = '';
  let otherOrg = '';
  let otherPerson = '';
  let workflow = '';

  async function insertJob(o: {
    orgId: string;
    type: string;
    status?: string;
    enqueuedBy?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<string> {
    const { rows } = await owner.query<{ id: string }>(
      `insert into public.jobs (org_id, type, status, payload, enqueued_by)
       values ($1, $2, $3, $4::jsonb, $5::uuid)
       returning id`,
      [
        o.orgId,
        o.type,
        o.status ?? 'running',
        JSON.stringify(o.payload ?? {}),
        o.enqueuedBy ?? null,
      ],
    );
    return rows[0]!.id;
  }

  async function bridge(
    jobId: string,
    pool: Pool = owner,
  ): Promise<{ org_id: string; person_id: string }> {
    const { rows } = await pool.query<{ org_id: string; person_id: string }>(
      `select org_id, person_id from public.workflow_execute_as_job($1::uuid)`,
      [jobId],
    );
    return rows[0]!;
  }

  beforeAll(async () => {
    org = await mkOrg(owner, `wexec${RUN}`);
    person = await mkPerson(owner, org, `Wexec User ${RUN}`);
    otherOrg = await mkOrg(owner, `wexecb${RUN}`);
    otherPerson = await mkPerson(owner, otherOrg, `Wexec Other ${RUN}`);
    workflow = (await mkWorkflow(owner, org, { createdBy: person })).id;
  });

  afterAll(async () => {
    await owner.end();
    await appUser.end();
  });

  it('returns the verified principal for a running workflow_run job', async () => {
    const jobId = await insertJob({ orgId: org, type: 'workflow_run', enqueuedBy: person });
    const row = await bridge(jobId);
    expect(row.org_id).toBe(org);
    expect(row.person_id).toBe(person);
  });

  it('rejects a job that is not running with 22023', async () => {
    const jobId = await insertJob({
      orgId: org,
      type: 'workflow_run',
      status: 'claimed',
      enqueuedBy: person,
    });
    expect(await sqlstateOf(bridge(jobId))).toBe('22023');
  });

  it('rejects a non-workflow job type with 22023', async () => {
    const jobId = await insertJob({ orgId: org, type: 'notification', enqueuedBy: person });
    expect(await sqlstateOf(bridge(jobId))).toBe('22023');
  });

  it('rejects a missing job with 22023', async () => {
    expect(await sqlstateOf(bridge('66666666-6666-4666-8666-666666666666'))).toBe('22023');
  });

  it('rejects a null execution principal with 42501', async () => {
    const jobId = await insertJob({ orgId: org, type: 'workflow_run', enqueuedBy: null });
    expect(await sqlstateOf(bridge(jobId))).toBe('42501');
  });

  it('rejects a principal with no live engagement with 42501', async () => {
    const suspended = await mkPerson(owner, org, `Wexec Susp ${RUN}`);
    // The engagements guard requires an authenticated actor — run the UPDATE
    // with app.person_id / app.org_id context on a dedicated client.
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
        [person, org],
      );
      await c.query(
        `update public.engagements set status = 'SUSPENDED' where person_id = $1::uuid`,
        [suspended],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    const jobId = await insertJob({ orgId: org, type: 'workflow_run', enqueuedBy: suspended });
    expect(await sqlstateOf(bridge(jobId))).toBe('42501');
  });

  it('rejects a principal from another org with 42501 (no cross-org)', async () => {
    const jobId = await insertJob({ orgId: org, type: 'workflow_run', enqueuedBy: otherPerson });
    expect(await sqlstateOf(bridge(jobId))).toBe('42501');
  });

  it('resolves the schedule owner for a scheduled_trigger job', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `insert into public.schedules
         (org_id, workflow_id, name, cron, next_run_at, created_by)
       values ($1::uuid, $2::uuid, $3, '* * * * *', now() + interval '1 hour', $4::uuid)
       returning id`,
      [org, workflow, `wexec sched ${RUN}`, person],
    );
    const scheduleId = rows[0]!.id;
    const jobId = await insertJob({
      orgId: org,
      type: 'scheduled_trigger',
      payload: { scheduleId, workflowId: workflow },
    });
    const row = await bridge(jobId);
    expect(row.org_id).toBe(org);
    expect(row.person_id).toBe(person);
  });

  it('rejects a scheduled_trigger whose schedule lives in another org with 42501', async () => {
    const otherWorkflow = (await mkWorkflow(owner, otherOrg, { createdBy: otherPerson })).id;
    const { rows } = await owner.query<{ id: string }>(
      `insert into public.schedules
         (org_id, workflow_id, name, cron, next_run_at, created_by)
       values ($1::uuid, $2::uuid, $3, '* * * * *', now() + interval '1 hour', $4::uuid)
       returning id`,
      [otherOrg, otherWorkflow, `wexec xsched ${RUN}`, otherPerson],
    );
    const jobId = await insertJob({
      orgId: org,
      type: 'scheduled_trigger',
      payload: { scheduleId: rows[0]!.id, workflowId: otherWorkflow },
    });
    expect(await sqlstateOf(bridge(jobId))).toBe('42501');
  });

  it('rejects a scheduled_trigger with a dangling scheduleId with 22023', async () => {
    const jobId = await insertJob({
      orgId: org,
      type: 'scheduled_trigger',
      payload: {
        scheduleId: '77777777-7777-4777-8777-777777777777',
        workflowId: workflow,
      },
    });
    expect(await sqlstateOf(bridge(jobId))).toBe('22023');
  });

  it('is executable by app_user (grant check)', async () => {
    const jobId = await insertJob({ orgId: org, type: 'workflow_run', enqueuedBy: person });
    const row = await bridge(jobId, appUser);
    expect(row.person_id).toBe(person);
  });

  it('stamps enqueued_by from app.person_id on insert (trigger)', async () => {
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.person_id', $1, true)`, [person]);
      const { rows } = await client.query<{ enqueued_by: string | null }>(
        `insert into public.jobs (org_id, type, payload)
         values ($1::uuid, 'workflow_run', '{}'::jsonb)
         returning enqueued_by`,
        [org],
      );
      expect(rows[0]!.enqueued_by).toBe(person);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('leaves enqueued_by null (without raising) for a non-UUID worker identity', async () => {
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.person_id', $1, true)`, ['system:job:whatever']);
      const { rows } = await client.query<{ enqueued_by: string | null }>(
        `insert into public.jobs (org_id, type, payload)
         values ($1::uuid, 'workflow_run', '{}'::jsonb)
         returning enqueued_by`,
        [org],
      );
      expect(rows[0]!.enqueued_by).toBeNull();
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});
