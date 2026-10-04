import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import {
  ALL_WORKFLOW_PERMS,
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
} from './helpers';

/**
 * Phase 5 — cross-tenant RLS matrix for the workflow tables (A1 migration
 * 0044, audit §8.2). Runs on CI against an ephemeral Neon branch; it is NOT
 * an ephemeral Neon branch; they run on CI under `pnpm test` (the default
 * vitest glob) and skip locally when the branch env vars are absent
 * (describe.skipIf(!DB_READY)).
 *
 * Tenant-isolation properties pinned here (both directions):
 *  - workflows: select/insert/update for app_user are org-pinned and need the
 *    workflows.* grants; NO delete policy — raw DELETE raises 42501 for
 *    everybody except app_owner (soft-delete via crm_soft_delete only);
 *    soft-deleted rows are invisible to app_user.
 *  - workflow_executions / workflow_execution_steps: app_user gets SELECT
 *    only (still org-pinned + workflows.view); writes go exclusively through
 *    the SECURITY DEFINER record functions, which derive org/actor from the
 *    transaction context and raise 42501 for foreign workflows/executions
 *    (the A8-flagged "definer RLS 42501" case).
 *  - The org-guard triggers raise 42501 on cross-org references even for
 *    app_owner direct writes.
 */
const ready = DB_READY;
const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const ctxFor = (personId: string, orgId: string): Ctx => ({ personId, orgId });

let orgA = '';
let orgB = '';
let alice = ''; // org A, all workflow perms
let bob = ''; // org B, all workflow perms
let carol = ''; // org A, NO workflow perms
let wfA = '';
let wfB = '';

const recordExecution = (ctx: Ctx, workflowId: string, dedupKey: string, entityId?: string) =>
  inContext<{ id: string | null }>(
    asUser,
    ctx,
    `select public.workflow_record_execution(
       $1::uuid, 1, $2, 'task.created', 'task', $3::uuid, 'RUNNING', $4::uuid) as id`,
    [workflowId, dedupKey, entityId ?? '11111111-1111-4111-8111-111111111111', ctx.orgId],
  );

beforeAll(async () => {
  if (!ready) return;
  orgA = await mkOrg(owner, `rls-a-${CODE}`);
  orgB = await mkOrg(owner, `rls-b-${CODE}`);
  alice = await mkPerson(owner, orgA, 'Alice Wf');
  bob = await mkPerson(owner, orgB, 'Bob Wf');
  carol = await mkPerson(owner, orgA, 'Carol Wf');
  await mkRoleFor(owner, orgA, alice, `WF_ADMIN_${CODE}`, ALL_WORKFLOW_PERMS);
  await mkRoleFor(owner, orgB, bob, `WF_ADMIN_${CODE}`, ALL_WORKFLOW_PERMS);
  wfA = (await mkWorkflow(owner, orgA, { name: `wf-a-${CODE}`, createdBy: alice })).id;
  wfB = (await mkWorkflow(owner, orgB, { name: `wf-b-${CODE}`, createdBy: bob })).id;
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

describe.skipIf(!ready)('workflow RLS: catalogue', () => {
  it('forces RLS on all three workflow tables', async () => {
    await assertForceRls(owner, 'workflows');
    await assertForceRls(owner, 'workflow_executions');
    await assertForceRls(owner, 'workflow_execution_steps');
  });

  it('seeds the six workflow permission keys (module workflows, non-sensitive)', async () => {
    const { rows } = await owner.query<{ key: string; module: string; is_sensitive: boolean }>(
      `select key, module, is_sensitive from public.permissions where key like 'workflows.%' order by key`,
    );
    expect(rows.map((r) => r.key)).toEqual([
      'workflows.activate',
      'workflows.create',
      'workflows.delete',
      'workflows.edit',
      'workflows.execute',
      'workflows.view',
    ]);
    expect(rows.every((r) => r.module === 'workflows' && r.is_sensitive === false)).toBe(true);
  });
});

describe.skipIf(!ready)('workflow RLS: workflows table matrix', () => {
  it('select: each tenant sees only its own workflows', async () => {
    const a = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `select id from public.workflows`,
    );
    expect(a.map((r) => r.id)).toContain(wfA);
    expect(a.map((r) => r.id)).not.toContain(wfB);

    const b = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `select id from public.workflows where id = $1::uuid`,
      [wfA],
    );
    expect(b).toHaveLength(0); // cross-tenant read → zero rows
  });

  it('select: no workflows.view grant → zero rows', async () => {
    const rows = await inContext(asUser, ctxFor(carol, orgA), `select id from public.workflows`);
    expect(rows).toHaveLength(0);
  });

  it('insert: cross-org insert fails with 42501', async () => {
    const code = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(bob, orgB),
        `insert into public.workflows (org_id, name, trigger) values ($1::uuid, $2, '{"type":"manual"}')`,
        [orgA, `x-${CODE}`],
      ),
    );
    expect(code).toBe('42501');
  });

  it('insert: own-org insert with workflows.create succeeds', async () => {
    const rows = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `insert into public.workflows (org_id, name, trigger) values ($1::uuid, $2, '{"type":"manual"}') returning id`,
      [orgA, `own-${CODE}`],
    );
    expect(rows).toHaveLength(1);
  });

  it('insert: without workflows.create fails with 42501', async () => {
    const code = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(carol, orgA),
        `insert into public.workflows (org_id, name, trigger) values ($1::uuid, $2, '{"type":"manual"}')`,
        [orgA, `y-${CODE}`],
      ),
    );
    expect(code).toBe('42501');
  });

  it('update: cross-tenant update touches zero rows', async () => {
    const rows = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `update public.workflows set name = $1 where id = $2::uuid returning id`,
      [`hijacked-${CODE}`, wfA],
    );
    expect(rows).toHaveLength(0);
  });

  it('update: own-org update with workflows.edit succeeds', async () => {
    const rows = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `update public.workflows set description = 'edited' where id = $1::uuid returning id`,
      [wfA],
    );
    expect(rows).toHaveLength(1);
  });

  it('delete: raw DELETE raises 42501 even for own rows (soft-delete only)', async () => {
    const code = await sqlstateOf(
      inContext(asUser, ctxFor(alice, orgA), `delete from public.workflows where id = $1::uuid`, [
        wfA,
      ]),
    );
    expect(code).toBe('42501');
  });

  it('soft-deleted workflows are invisible to app_user select', async () => {
    const doomed = (await mkWorkflow(owner, orgA, { name: `doomed-${CODE}`, createdBy: alice })).id;
    await owner.query(`update public.workflows set deleted_at = now() where id = $1::uuid`, [
      doomed,
    ]);
    const rows = await inContext<{ id: string }>(
      asUser,
      ctxFor(alice, orgA),
      `select id from public.workflows where id = $1::uuid`,
      [doomed],
    );
    expect(rows).toHaveLength(0);
  });
});

describe.skipIf(!ready)('workflow RLS: executions/steps are definer-write only', () => {
  it('executions select: cross-tenant read → zero rows', async () => {
    const execId = (await recordExecution(ctxFor(alice, orgA), wfA, `sel-${CODE}`))[0]!.id;
    expect(execId).toBeTruthy();
    const foreign = await inContext(
      asUser,
      ctxFor(bob, orgB),
      `select id from public.workflow_executions where id = $1::uuid`,
      [execId],
    );
    expect(foreign).toHaveLength(0);
  });

  it('executions select: no workflows.view → zero rows', async () => {
    const rows = await inContext(
      asUser,
      ctxFor(carol, orgA),
      `select id from public.workflow_executions`,
    );
    expect(rows).toHaveLength(0);
  });

  it('direct insert into workflow_executions as app_user → 42501 (definer only)', async () => {
    const code = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(alice, orgA),
        `insert into public.workflow_executions
           (org_id, workflow_id, workflow_version, dedup_key, status, trigger_type)
         values ($1::uuid, $2::uuid, 1, $3, 'RUNNING', 'manual')`,
        [orgA, wfA, `direct-${CODE}`],
      ),
    );
    expect(code).toBe('42501');
  });

  it('direct insert into workflow_execution_steps as app_user → 42501 (definer only)', async () => {
    const execId = (await recordExecution(ctxFor(alice, orgA), wfA, `step-${CODE}`))[0]!.id;
    const code = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(alice, orgA),
        `insert into public.workflow_execution_steps
           (org_id, execution_id, step_index, action_type, action_params)
         values ($1::uuid, $2::uuid, 0, 'create_task', '{}')`,
        [orgA, execId],
      ),
    );
    expect(code).toBe('42501');
  });

  it('definer record: own workflow returns an id; duplicate dedup key → NULL (idempotent)', async () => {
    const first = (await recordExecution(ctxFor(alice, orgA), wfA, `idem-${CODE}`))[0]!.id;
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    const second = (await recordExecution(ctxFor(alice, orgA), wfA, `idem-${CODE}`))[0]!.id;
    expect(second).toBeNull();
  });

  it('definer record: foreign workflow raises 42501 (no org escape)', async () => {
    const code = await sqlstateOf(recordExecution(ctxFor(bob, orgB), wfA, `foreign-${CODE}`));
    expect(code).toBe('42501');
  });

  it('definer step record: foreign execution raises 42501', async () => {
    const execId = (await recordExecution(ctxFor(alice, orgA), wfA, `fstep-${CODE}`))[0]!.id;
    const code = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(bob, orgB),
        `select public.workflow_record_step($1::uuid, 0, 'create_task', '{}', $2::uuid)`,
        [execId, orgB],
      ),
    );
    expect(code).toBe('42501');
  });

  it('definer record: org_id mismatch raises 42501', async () => {
    // F9: the explicit p_org_id must equal the transaction context's org.
    const code = await sqlstateOf(
      inContext<{ id: string | null }>(
        asUser,
        ctxFor(alice, orgA),
        `select public.workflow_record_execution(
           $1::uuid, 1, $2, 'task.created', 'task', $3::uuid, 'RUNNING', $4::uuid) as id`,
        [wfA, `mismatch-${CODE}`, '11111111-1111-4111-8111-111111111111', orgB],
      ),
    );
    expect(code).toBe('42501');
  });
});

describe.skipIf(!ready)('workflow RLS: org-guard triggers (owner writes)', () => {
  it('execution whose org differs from its workflow org → 42501', async () => {
    const code = await sqlstateOf(
      owner.query(
        `insert into public.workflow_executions
           (org_id, workflow_id, workflow_version, dedup_key, status, trigger_type)
         values ($1::uuid, $2::uuid, 1, $3, 'RUNNING', 'manual')`,
        [orgB, wfA, `guard-${CODE}`],
      ),
    );
    expect(code).toBe('42501');
  });

  it('step whose org differs from its execution org → 42501', async () => {
    const execId = (await recordExecution(ctxFor(alice, orgA), wfA, `sguard-${CODE}`))[0]!.id;
    const code = await sqlstateOf(
      owner.query(
        `insert into public.workflow_execution_steps
           (org_id, execution_id, step_index, action_type, action_params)
         values ($1::uuid, $2::uuid, 0, 'create_task', '{}')`,
        [orgB, execId],
      ),
    );
    expect(code).toBe('42501');
  });
});
