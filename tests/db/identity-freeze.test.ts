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
 *
 * ACTOR CONSTRUCTION (CI fix wave, PR #69 run 1): the actors are built
 * with tests/workflows/helpers (mkOrg / mkPerson / mkRoleFor) — the
 * construction every passing RLS suite uses (tests/jobs/jobs-rls.test.ts
 * in particular, whose alice updates jobs rows and whose org-move probe
 * receives this same freeze's 23514). mkPerson mirrors provisioning
 * (full people row + ACTIVE engagement created with the person) and
 * mkRoleFor FAILS LOUDLY when a grant key is not in the catalogue. The
 * first version of this file built its operator through
 * tests/authz/fixtures.mkCustomRole — whose grant inserts are
 * insert-selects with NO row-count check, so a grant that does not land
 * is invisible at setup — and every direct UPDATE by that operator then
 * matched zero rows under the UPDATE policies (org + is_active +
 * has(...)): the frozen-column probes completed with 'SUCCEEDED' (zero
 * rows, no error, the freeze trigger never reached) and the legitimate
 * updates reported rowCount 0, while the caller-agnostic worker
 * definers kept passing and masked the defect. The suite now also opens
 * with an actor-capability precondition that resolves org_id /
 * is_active / has() for both probe contexts explicitly, so an actor
 * regression can never again masquerade as a freeze failure.
 *
 * WORKFLOWS SOFT-DELETE (CI fix wave, PR #69 run 2): the workflows case
 * originally ended with a direct `set deleted_at = now()` UPDATE as
 * app_user, expected to land. The server log showed it raising "new row
 * violates row-level security policy": PostgreSQL checks an UPDATE's
 * new row against the SELECT policy as well as the UPDATE policy's
 * WITH CHECK (the updated row must remain visible to its updater), and
 * workflows_select requires deleted_at is null — so the refusal comes
 * from the policy layer, not the freeze (deleted_at is deliberately
 * mutable). That is precisely why production soft-deletes workflows
 * through the two-step in src/lib/workflows/service.ts (a no-op probe
 * UPDATE as app_user, then the crm_soft_delete definer). The case now
 * pins the 42501 refusal, mirrors the production two-step, and also
 * probes the frozen columns as the owner — RLS-exempt, so a 23514 there
 * is the trigger alone — pinning the policy and trigger layers
 * separately.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { mkOrg, mkPerson, mkRoleFor, mkWorkflow } from '../workflows/helpers';

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

/**
 * The same probe as the owner. The owner is RLS-exempt (workflows &
 * friends carry an owner policy of using (true) / with check (true)),
 * but BEFORE UPDATE triggers fire for the owner exactly as for app_user
 * — so a 23514 here can only be the freeze trigger itself, never the
 * policy stack. This pins the trigger layer independently of RLS.
 */
async function expectFrozenAsOwner(text: string, params: unknown[]): Promise<void> {
  expect(await sqlstateOf(owner.query(text, params))).toBe('23514');
}

describe.skipIf(!HAS_DB)('identity freeze (Phase 11 §4.2)', () => {
  let orgA = '';
  let orgB = '';
  let alice = ''; // orgA operator: jobs.view/create/retry/cancel, workflows.view/edit/delete, ai.use
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
    orgA = await mkOrg(owner, `p11fz-a-${RUN.toLowerCase()}`);
    orgB = await mkOrg(owner, `p11fz-b-${RUN.toLowerCase()}`);
    // mkPerson creates the ACTIVE engagement (and its department) with the
    // person — the state authz.is_active() and every policy read.
    alice = await mkPerson(owner, orgA, 'Freeze Operator A');
    empA = await mkPerson(owner, orgA, 'Freeze Requester A');
    // mkRoleFor throws if any key is missing from the catalogue, so the
    // operator's grants are proven at setup, not inferred from failures.
    // jobs.view / workflows.view ride along (production operators hold
    // them, and the SELECT policies gate this file's RETURNING probes).
    await mkRoleFor(owner, orgA, alice, `P11FZOPS${RUN}`, [
      'jobs.view',
      'jobs.create',
      'jobs.retry',
      'jobs.cancel',
      'workflows.view',
      'workflows.edit',
      'workflows.delete',
      'ai.use',
    ]);
    await mkRoleFor(owner, orgA, empA, `P11FZEMP${RUN}`, ['ai.use']);

    workflowA = (await mkWorkflow(owner, orgA, { name: 'Freeze workflow', createdBy: alice })).id;
    workflowA2 = (await mkWorkflow(owner, orgA, { name: 'Freeze workflow 2', createdBy: alice }))
      .id;
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

  it('actor preconditions: both probe contexts resolve org, liveness and grants', async () => {
    // The UPDATE policies below gate on org_id = authz.org_id() AND
    // authz.is_active() AND authz.has(<key>) (has() itself resolves
    // through scope_for, which also requires is_active). If an actor
    // ever stops resolving these, its UPDATEs match zero rows and the
    // freeze probes would report 'SUCCEEDED' instead of 23514 — this
    // precondition names that failure directly instead of letting it
    // masquerade as a freeze regression (PR #69 run 1).
    type Probe = {
      org: string | null;
      active: boolean;
      retry: boolean;
      cancel: boolean;
      createk: boolean;
      wfedit: boolean;
      wfdelete: boolean;
      aiuse: boolean;
    };
    const probe = async (ctx: Ctx): Promise<Probe> =>
      (
        await inCtx<Probe>(
          ctx,
          `select authz.org_id() as org, authz.is_active() as active,
                  authz.has('jobs.retry') as retry, authz.has('jobs.cancel') as cancel,
                  authz.has('jobs.create') as createk, authz.has('workflows.edit') as wfedit,
                  authz.has('workflows.delete') as wfdelete, authz.has('ai.use') as aiuse`,
        )
      ).rows[0]!;

    const a = await probe(aliceCtx());
    expect(a.org).toBe(orgA);
    expect(a.active).toBe(true);
    expect(a.retry).toBe(true);
    expect(a.cancel).toBe(true);
    expect(a.createk).toBe(true);
    expect(a.wfedit).toBe(true);
    // The workflows case ends with the production soft-delete two-step,
    // whose definer half (crm_soft_delete) fail-closes without this key.
    expect(a.wfdelete).toBe(true);
    expect(a.aiuse).toBe(true);

    const e = await probe(empCtx());
    expect(e.org).toBe(orgA);
    expect(e.active).toBe(true);
    expect(e.aiuse).toBe(true);
    expect(e.wfdelete).toBe(false);
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
    const res = await inCtx<{ id: string }>(
      aliceCtx(),
      `update public.jobs set status = 'cancelled' where id = $1 returning id`,
      [jobA],
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows).toHaveLength(1);
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
    const retried = await inCtx<{ id: string }>(
      aliceCtx(),
      `update public.jobs
          set status = 'pending', attempts = 0, next_run_at = now(),
              claimed_by = null, claimed_at = null, heartbeat_at = null,
              error_code = null, error_message = null, updated_at = now()
        where id = $1 returning id`,
      [jobFail],
    );
    expect(retried.rowCount).toBe(1);
    expect(retried.rows).toHaveLength(1);
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
    const edited = await inCtx<{ id: string }>(
      ctx,
      `update public.schedules
          set name = 'Freeze schedule (renamed)', is_active = false,
              last_run_at = now(), next_run_at = now(), workflow_id = $2, updated_at = now()
        where id = $1 returning id`,
      [scheduleA, workflowA2],
    );
    expect(edited.rowCount).toBe(1);
    expect(edited.rows).toHaveLength(1);
  });

  it('workflows: identity columns refuse with 23514; edits and status changes still land', async () => {
    const ctx = aliceCtx();
    // Layer 1, in the real policy context: the BEFORE UPDATE freeze
    // trigger fires before the policy's WITH CHECK stage, so each probe
    // surfaces the trigger's 23514 — including the org_id probe, whose
    // new row would ALSO fail WITH CHECK (org) had the trigger not
    // raised first.
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
    // Layer 1 again, isolated: as the owner, row security cannot refuse
    // anything (owner policy: using (true) / with check (true)), yet the
    // same four probes still raise 23514 — that refusal is the trigger
    // alone, a property of the table rather than of the app_user policy
    // stack.
    await expectFrozenAsOwner(`update public.workflows set org_id = $2 where id = $1`, [
      workflowA,
      orgB,
    ]);
    await expectFrozenAsOwner(`update public.workflows set created_by = $2 where id = $1`, [
      workflowA,
      empA,
    ]);
    await expectFrozenAsOwner(`update public.workflows set created_at = now() where id = $1`, [
      workflowA,
    ]);
    await expectFrozenAsOwner(`update public.workflows set id = $2 where id = $1`, [
      workflowA,
      randomUUID(),
    ]);
    const edited = await inCtx<{ id: string }>(
      ctx,
      `update public.workflows
          set name = 'Freeze workflow (edited)', description = 'edited',
              trigger = '{"type":"manual"}'::jsonb, status = 'ACTIVE',
              updated_by = $2, updated_at = now()
        where id = $1 returning id`,
      [workflowA, alice],
    );
    expect(edited.rowCount).toBe(1);
    expect(edited.rows).toHaveLength(1);
    // Soft-delete last. deleted_at is NOT frozen — the trigger passes a
    // direct `set deleted_at` UPDATE — but the statement is still
    // refused, by layer 2 (the policy stack): PostgreSQL checks an
    // UPDATE's new row against the SELECT policy too (the updated row
    // must remain visible to its updater), and workflows_select
    // requires deleted_at is null, so the new row fails that check with
    // 42501. Pin the refusal as the documented reason the direct path
    // is not the production path…
    expect(
      await sqlstateOf(
        inCtx(ctx, `update public.workflows set deleted_at = now() where id = $1`, [workflowA]),
      ),
    ).toBe('42501');
    // …then soft-delete the production way (src/lib/workflows/service.ts
    // deleteWorkflow runs both steps in ONE transaction; nothing in the
    // definer depends on the probe's lock, so the two statements here
    // run back-to-back in alice's context): a no-op probe UPDATE as
    // app_user under the real UPDATE policy, then the crm_soft_delete
    // definer, whose M1 probe requires the workflows.delete key alice
    // holds. The freeze must not block either step.
    const probe = await inCtx<{ id: string }>(
      ctx,
      `update public.workflows set updated_at = updated_at where id = $1 returning id`,
      [workflowA],
    );
    expect(probe.rowCount).toBe(1);
    expect(probe.rows).toHaveLength(1);
    await inCtx(ctx, `select public.crm_soft_delete('workflow', $1::uuid)`, [workflowA]);
    const afterDelete = await owner.query<{ deleted_at: Date | null }>(
      `select deleted_at from public.workflows where id = $1`,
      [workflowA],
    );
    expect(afterDelete.rows[0]!.deleted_at).not.toBeNull();
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
