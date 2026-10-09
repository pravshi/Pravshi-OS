/**
 * Phase 11, Wave A (§4.2) — identity freeze triggers (migration 0061).
 *
 * jobs / schedules / workflows / ai_usage_requests gain BEFORE UPDATE
 * freeze triggers in the 0056 pattern: changing an identity column raises
 * 23514, including from a context today's RLS UPDATE policy admits (an
 * org admin holding jobs.retry). The legitimate writers must be
 * unaffected:
 *   - the worker-plane definers (start / heartbeat / fail / backoff /
 *     release / complete) move jobs through their lifecycle;
 *   - the service-shaped direct updates (retry, cancel, schedule
 *     pause/resume/re-point, workflow edits, AI finalize) still land.
 *
 * jobs_claim_next / jobs_sweep_retryable / jobs_reap_stale are global by
 * design and are exercised by the tests/jobs suites; calling them here
 * would race the parallel files sharing this database, so this file
 * drives the job-scoped definers deterministically instead (the claim
 * state is arranged by the owner, exactly the state jobs_claim_next
 * would have produced).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random()
  .toString(36)
  .slice(2, 8)
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, 'X');

const WORKER = 'freeze-worker';

type Ctx = { personId: string; orgId: string };

async function inCtx<T extends Record<string, unknown> = Record<string, unknown>>(
  ctx: Ctx,
  text: string,
  params: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  const client = await asUser.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('app.person_id', $1, true),
              set_config('app.org_id', $2, true),
              set_config('app.aal', 'aal1', true)`,
      [ctx.personId, ctx.orgId],
    );
    const result = await client.query<T>(text, params);
    await client.query('commit');
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function sqlstateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'SUCCEEDED';
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? 'UNKNOWN';
  }
}

/** Assert one frozen-column UPDATE is refused with 23514. */
async function expectFrozen(ctx: Ctx, text: string, params: unknown[]): Promise<void> {
  expect(await sqlstateOf(inCtx(ctx, text, params))).toBe('23514');
}

describe.skipIf(!HAS_DB)('identity freeze (Phase 11 §4.2)', () => {
  let orgA = '';
  let orgB = '';
  let alice = ''; // orgA operator: jobs.retry/cancel/create, workflows.edit, ai.use
  let empA = ''; // orgA requester: ai.use (owns the usage row)
  let workflowA = '';
  let workflowA2 = '';
  let scheduleA = '';
  let jobA = ''; // probe job for frozen/mutable direct updates
  let jobFail = ''; // lifecycle: start → fail → backoff → retry
  let jobDone = ''; // lifecycle: start → complete
  let jobRelease = ''; // lifecycle: release claim
  let usageRowA = '';

  const aliceCtx = (): Ctx => ({ personId: alice, orgId: orgA });
  const empCtx = (): Ctx => ({ personId: empA, orgId: orgA });

  const insertJob = async (over: Record<string, unknown> = {}): Promise<string> => {
    const { rows } = await owner.query<{ id: string }>(
      `insert into public.jobs
         (org_id, type, status, payload, dedup_key, enqueued_by, next_run_at)
       values ($1, $2, 'pending', $3::jsonb, $4, $5, now() - interval '1 minute')
       returning id`,
      [
        orgA,
        (over.type as string) ?? 'notification',
        JSON.stringify((over.payload as object) ?? { kind: 'freeze-probe' }),
        (over.dedupKey as string) ?? `frz-${RUN}-${randomUUID().slice(0, 8)}`,
        alice,
      ],
    );
    return rows[0]!.id;
  };

  /** Arrange the exact state jobs_claim_next would produce, deterministically. */
  const arrangeClaimed = (jobId: string) =>
    owner.query(
      `update public.jobs
          set status = 'claimed', claimed_by = $2, claimed_at = now(), heartbeat_at = now()
        where id = $1`,
      [jobId, WORKER],
    );

  beforeAll(async () => {
    const fixtures = await import('../authz/fixtures');
    orgA = await fixtures.mkOrg(owner, `p11fz-a-${RUN.toLowerCase()}`);
    orgB = await fixtures.mkOrg(owner, `p11fz-b-${RUN.toLowerCase()}`);
    const deptA = await fixtures.mkDept(owner, orgA, `FZA${RUN}`);
    alice = await fixtures.mkPerson(owner, orgA, 'Freeze Operator A');
    empA = await fixtures.mkPerson(owner, orgA, 'Freeze Requester A');
    await fixtures.mkEngagement(owner, orgA, alice, deptA);
    await fixtures.mkEngagement(owner, orgA, empA, deptA);
    const opsRole = await fixtures.mkCustomRole(owner, orgA, `P11FZOPS${RUN}`, [
      ['jobs.retry', 'GLOBAL'],
      ['jobs.cancel', 'GLOBAL'],
      ['jobs.create', 'GLOBAL'],
      ['workflows.edit', 'GLOBAL'],
      ['ai.use', 'GLOBAL'],
    ]);
    await fixtures.assignRoleId(owner, alice, orgA, opsRole);
    const empRole = await fixtures.mkCustomRole(owner, orgA, `P11FZEMP${RUN}`, [
      ['ai.use', 'GLOBAL'],
    ]);
    await fixtures.assignRoleId(owner, empA, orgA, empRole);

    const wf = await owner.query<{ id: string }>(
      `insert into public.workflows (org_id, name, trigger, created_by)
       values ($1, 'Freeze workflow', '{"type":"manual"}'::jsonb, $2) returning id`,
      [orgA, alice],
    );
    workflowA = wf.rows[0]!.id;
    const wf2 = await owner.query<{ id: string }>(
      `insert into public.workflows (org_id, name, trigger, created_by)
       values ($1, 'Freeze workflow 2', '{"type":"manual"}'::jsonb, $2) returning id`,
      [orgA, alice],
    );
    workflowA2 = wf2.rows[0]!.id;
    const sc = await owner.query<{ id: string }>(
      `insert into public.schedules (org_id, workflow_id, name, cron, created_by)
       values ($1, $2, 'Freeze schedule', '0 9 * * *', $3) returning id`,
      [orgA, workflowA, alice],
    );
    scheduleA = sc.rows[0]!.id;

    jobA = await insertJob();
    jobFail = await insertJob({ type: 'email' });
    jobDone = await insertJob({ type: 'cleanup' });
    jobRelease = await insertJob({ type: 'webhook' });

    const usage = await owner.query<{ id: string }>(
      `insert into public.ai_usage_requests
         (org_id, person_id, request_id, capability, provider, model, status)
       values ($1, $2, $3, 'deal_summary', 'mock', 'mock-1', 'STARTED') returning id`,
      [orgA, empA, randomUUID()],
    );
    usageRowA = usage.rows[0]!.id;
  });

  afterAll(async () => {
    await owner.end();
    await asUser.end();
  });

  it('jobs: every identity column refuses with 23514, even for a jobs.retry holder', async () => {
    const ctx = aliceCtx();
    await expectFrozen(ctx, `update public.jobs set org_id = $2 where id = $1`, [jobA, orgB]);
    await expectFrozen(ctx, `update public.jobs set type = 'email' where id = $1`, [jobA]);
    await expectFrozen(ctx, `update public.jobs set enqueued_by = $2 where id = $1`, [jobA, empA]);
    await expectFrozen(ctx, `update public.jobs set dedup_key = 'forged' where id = $1`, [jobA]);
    await expectFrozen(
      ctx,
      `update public.jobs set payload = '{"kind":"forged"}'::jsonb where id = $1`,
      [jobA],
    );
    await expectFrozen(ctx, `update public.jobs set created_at = now() where id = $1`, [jobA]);
    await expectFrozen(ctx, `update public.jobs set id = $2 where id = $1`, [jobA, randomUUID()]);
    const after = await owner.query<{ type: string; enqueued_by: string }>(
      `select type, enqueued_by from public.jobs where id = $1`,
      [jobA],
    );
    expect(after.rows[0]).toEqual({ type: 'notification', enqueued_by: alice });
  });

  it('jobs: service-shaped direct updates (cancel) still land', async () => {
    const res = await inCtx(
      aliceCtx(),
      `update public.jobs set status = 'cancelled' where id = $1`,
      [jobA],
    );
    expect(res.rowCount).toBe(1);
  });

  it('jobs: the worker definers run the lifecycle — start, heartbeat, fail, backoff, retry', async () => {
    await arrangeClaimed(jobFail);
    const started = await inCtx<{ status: string }>(
      aliceCtx(),
      `select status from public.jobs_start($1, $2::uuid)`,
      [WORKER, jobFail],
    );
    expect(started.rows[0]!.status).toBe('running');
    const beat = await inCtx<{ ok: boolean }>(
      aliceCtx(),
      `select public.jobs_heartbeat($1, $2::uuid) as ok`,
      [WORKER, jobFail],
    );
    expect(beat.rows[0]!.ok).toBe(true);
    const failed = await inCtx<{ status: string; attempts: number }>(
      aliceCtx(),
      `select status, attempts from public.jobs_fail($1, $2::uuid, 'ERR_PROBE', 'probe failure', true)`,
      [WORKER, jobFail],
    );
    expect(failed.rows[0]!.status).toBe('failed');
    expect(failed.rows[0]!.attempts).toBe(1);
    const backedOff = await inCtx<{ ok: boolean }>(
      aliceCtx(),
      `select public.jobs_apply_backoff($1::uuid, now() - interval '1 minute') as ok`,
      [jobFail],
    );
    expect(backedOff.rows[0]!.ok).toBe(true);
    // The retryJob service shape: every lifecycle column at once.
    const retried = await inCtx(
      aliceCtx(),
      `update public.jobs
          set status = 'pending', attempts = 0, next_run_at = now(),
              claimed_by = null, claimed_at = null, heartbeat_at = null,
              error_code = null, error_message = null, updated_at = now()
        where id = $1`,
      [jobFail],
    );
    expect(retried.rowCount).toBe(1);
  });

  it('jobs: the worker definers complete and release jobs', async () => {
    await arrangeClaimed(jobDone);
    await inCtx(aliceCtx(), `select * from public.jobs_start($1, $2::uuid)`, [WORKER, jobDone]);
    const done = await inCtx<{ status: string }>(
      aliceCtx(),
      `select status from public.jobs_complete($1, $2::uuid)`,
      [WORKER, jobDone],
    );
    expect(done.rows[0]!.status).toBe('succeeded');

    await arrangeClaimed(jobRelease);
    const released = await inCtx<{ ok: boolean }>(
      aliceCtx(),
      `select public.jobs_release_claim($1::uuid, $2) as ok`,
      [jobRelease, WORKER],
    );
    expect(released.rows[0]!.ok).toBe(true);
    const after = await owner.query<{ status: string; claimed_by: string | null }>(
      `select status, claimed_by from public.jobs where id = $1`,
      [jobRelease],
    );
    expect(after.rows[0]).toEqual({ status: 'pending', claimed_by: null });
  });

  it('schedules: identity columns refuse with 23514; product edits still land', async () => {
    const ctx = aliceCtx();
    await expectFrozen(ctx, `update public.schedules set org_id = $2 where id = $1`, [
      scheduleA,
      orgB,
    ]);
    await expectFrozen(ctx, `update public.schedules set created_by = $2 where id = $1`, [
      scheduleA,
      empA,
    ]);
    await expectFrozen(ctx, `update public.schedules set created_at = now() where id = $1`, [
      scheduleA,
    ]);
    await expectFrozen(ctx, `update public.schedules set id = $2 where id = $1`, [
      scheduleA,
      randomUUID(),
    ]);
    // pause / resume / tick / re-point shapes — workflow_id is a product edit.
    const edited = await inCtx(
      ctx,
      `update public.schedules
          set name = 'Freeze schedule (renamed)', is_active = false,
              last_run_at = now(), next_run_at = now(), workflow_id = $2, updated_at = now()
        where id = $1`,
      [scheduleA, workflowA2],
    );
    expect(edited.rowCount).toBe(1);
  });

  it('workflows: identity columns refuse with 23514; edits and status changes still land', async () => {
    const ctx = aliceCtx();
    await expectFrozen(ctx, `update public.workflows set org_id = $2 where id = $1`, [
      workflowA,
      orgB,
    ]);
    await expectFrozen(ctx, `update public.workflows set created_by = $2 where id = $1`, [
      workflowA,
      empA,
    ]);
    await expectFrozen(ctx, `update public.workflows set created_at = now() where id = $1`, [
      workflowA,
    ]);
    await expectFrozen(ctx, `update public.workflows set id = $2 where id = $1`, [
      workflowA,
      randomUUID(),
    ]);
    const edited = await inCtx(
      ctx,
      `update public.workflows
          set name = 'Freeze workflow (edited)', description = 'edited',
              trigger = '{"type":"manual"}'::jsonb, status = 'ACTIVE',
              updated_by = $2, updated_at = now()
        where id = $1`,
      [workflowA, alice],
    );
    expect(edited.rowCount).toBe(1);
    // Soft-delete last: the UPDATE policy hides deleted rows afterwards.
    const deleted = await inCtx(
      ctx,
      `update public.workflows set deleted_at = now() where id = $1`,
      [workflowA],
    );
    expect(deleted.rowCount).toBe(1);
  });

  it('ai_usage_requests: identity columns refuse with 23514; the finalize set still lands', async () => {
    const ctx = empCtx();
    await expectFrozen(ctx, `update public.ai_usage_requests set person_id = $2 where id = $1`, [
      usageRowA,
      alice,
    ]);
    await expectFrozen(
      ctx,
      `update public.ai_usage_requests set capability = 'company_summary' where id = $1`,
      [usageRowA],
    );
    await expectFrozen(ctx, `update public.ai_usage_requests set org_id = $2 where id = $1`, [
      usageRowA,
      orgB,
    ]);
    await expectFrozen(
      ctx,
      `update public.ai_usage_requests set created_at = now() where id = $1`,
      [usageRowA],
    );
    await expectFrozen(ctx, `update public.ai_usage_requests set id = $2 where id = $1`, [
      usageRowA,
      randomUUID(),
    ]);
    // finalizeAiUsageRequest's exact mutable set.
    const finalized = await inCtx<{ status: string }>(
      ctx,
      `update public.ai_usage_requests
          set status = 'SUCCEEDED', prompt_tokens = 10, completion_tokens = 32,
              total_tokens = 42, provider_attempts = 1, tool_calls_count = 0,
              duration_ms = 10, error_code = null
        where id = $1 returning status`,
      [usageRowA],
    );
    expect(finalized.rows).toEqual([{ status: 'SUCCEEDED' }]);
  });
});
