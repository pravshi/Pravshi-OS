import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import {
  CODE,
  DB_READY,
  ALL_WORKFLOW_PERMS,
  listSteps,
  mkOrg,
  mkProject,
  mkTask,
  mkWorkflow,
  waitForExecution,
} from './helpers';
import { mkAccount, headersFor } from '../authz/fixtures';
import '@/lib/workflows/triggers';
import { buildDedupKey, dispatchWorkflowEvent } from '@/lib/workflows/events';
import { executeWorkflowManual } from '@/lib/workflows/engine';
import { createTask } from '@/lib/work/tasks';
import { requirePermission, type Authorization } from '@/lib/authz/require-permission';

/**
 * Phase 5 — full workflow-engine pipeline DB tests (A8). Runs on CI against
 * an ephemeral Neon branch; it is NOT matched by vitest's default
 * an ephemeral Neon branch; they run on CI under `pnpm test` (the default
 * vitest glob) and skip locally when the branch env vars are absent
 * (describe.skipIf(!DB_READY)).
 *
 * These tests exercise the REAL engine path — dispatchWorkflowEvent →
 * runWorkflowsForEvent (awaited inline per D1; the tests still poll
 * workflow_executions defensively) — plus the manual gate
 * executeWorkflowManual. Every write flows through withAuthorizedDb under a
 * real app_user identity (cast Authorization; the services only read
 * auth.ctx).
 *
 * NOTE: `import '@/lib/workflows/triggers'` below used to be load-bearing —
 * the workflow modules had a circular import (schema → events → engine →
 * actions → schema) and importing events.ts first crashed test collection.
 * The cycle was broken 2026-10-04 (WORKFLOW_TRIGGER_TYPES moved into
 * schema.ts); the import is kept as a harmless import-order probe.
 *
 * A8's flagged untested paths, pinned here:
 *  - idempotency: re-delivering the same dedup key records exactly one execution;
 *  - NOT_FOUND snapshot: an invisible/deleted source record closes the
 *    execution FAILED with error_code NOT_FOUND (never throws to the caller);
 *  - template-throw: an unresolvable {{path}} fails the step INVALID_REQUEST,
 *    stops the remaining actions, and closes the execution FAILED;
 *  - manual execute gate: FORBIDDEN without workflows.execute, INVALID_REQUEST
 *    for non-ACTIVE workflows, exactly-once runs for ACTIVE ones;
 *  - disabled-workflow exclusion: DRAFT/PAUSED/ARCHIVED workflows never run.
 */
const ready = DB_READY;
const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

/**
 * Real Authorization minted by requirePermission() through a real Better Auth
 * session. The engine's buildSnapshot calls getTask → assertTargetAffected →
 * assertAuthorization, which rejects the cast fake object the test used to use.
 * Request workflows.view (every test actor holds it); the engine only needs
 * the Authorization to be genuine, not a specific permission.
 */
const authFor = (cookie: string) => async (): Promise<Authorization> =>
  (await requirePermission(headersFor(cookie), { permission: 'workflows.view' })) as Authorization;

let orgA = '';
let orgB = '';
let alice = ''; // org A, all workflow perms
let bob = ''; // org B, all workflow perms
let dave = ''; // org A, workflows.view only (no execute)
let aliceCookie = '';
let bobCookie = '';
let daveCookie = '';
let projectA = '';
let projectB = '';

const taskCreatedTrigger = (entityType = 'task') => ({ type: 'task.created', entityType });

/** Dispatch, then wait for the execution to reach a terminal state. */
async function dispatchAndWait(
  auth: Authorization,
  workflowId: string,
  event: Parameters<typeof dispatchWorkflowEvent>[1],
  timeoutMs = 15000,
) {
  const eventDedupKey = buildDedupKey(event.dedupKey);
  await dispatchWorkflowEvent(auth, event);
  const dedupKey = `${workflowId}:${eventDedupKey}`;
  return waitForExecution(owner, workflowId, dedupKey, timeoutMs);
}

async function countExecutions(workflowId: string, dedupKey: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `select count(*) n from public.workflow_executions where workflow_id = $1::uuid and dedup_key = $2`,
    [workflowId, dedupKey],
  );
  return Number(rows[0]!.n);
}

/** Create a role with grants, returning its ID (no person assignment — mkAccount takes customRoles). */
async function mkRole(
  owner: Pool,
  org: string,
  key: string,
  permissions: readonly string[],
): Promise<string> {
  const roleKey = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const role = (
    await owner.query<{ id: string }>(
      `insert into public.roles (org_id, key, name) values ($1,$2,$3) returning id`,
      [org, roleKey, `WF ${roleKey}`],
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

async function mkDept(owner: Pool, org: string, code: string): Promise<string> {
  return (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1,$2,$3) returning id`,
      [org, code, `WF Dept ${code}`],
    )
  ).rows[0]!.id;
}

beforeAll(async () => {
  if (!ready) return;
  orgA = await mkOrg(owner, `pipe-a-${CODE}`);
  orgB = await mkOrg(owner, `pipe-b-${CODE}`);
  const deptA = await mkDept(owner, orgA, `D${CODE}A`);
  const deptB = await mkDept(owner, orgB, `D${CODE}B`);
  // Roles first (no assignment); mkAccount assigns via customRoles.
  const pipeRoleA = await mkRole(owner, orgA, `WF_PIPE_${CODE}`, ALL_WORKFLOW_PERMS);
  // D2: workflow actions execute under the trigger actor's own Authorization,
  // so the actor also needs the RLS permissions the action executors' service
  // calls require (projects.view for the project write-visibility probe,
  // tasks.view for the engine's source-record snapshot, tasks.create for the
  // work_tasks insert policy). Both orgs need it (bob fires org-B workflows).
  const actRoleA = await mkRole(owner, orgA, `WF_ACT_${CODE}`, [
    'projects.view',
    'tasks.view',
    'tasks.create',
  ]);
  const pipeRoleB = await mkRole(owner, orgB, `WF_PIPE_${CODE}`, ALL_WORKFLOW_PERMS);
  const actRoleB = await mkRole(owner, orgB, `WF_ACT_${CODE}`, [
    'projects.view',
    'tasks.view',
    'tasks.create',
  ]);
  const viewRoleA = await mkRole(owner, orgA, `WF_VIEW_${CODE}`, ['workflows.view']);
  const aliceAcct = await mkAccount(owner, {
    org: orgA,
    dept: deptA,
    run: CODE,
    label: 'AlicePipe',
    customRoles: [pipeRoleA, actRoleA],
  });
  const bobAcct = await mkAccount(owner, {
    org: orgB,
    dept: deptB,
    run: CODE,
    label: 'BobPipe',
    customRoles: [pipeRoleB, actRoleB],
  });
  const daveAcct = await mkAccount(owner, {
    org: orgA,
    dept: deptA,
    run: CODE,
    label: 'DavePipe',
    customRoles: [viewRoleA],
  });
  alice = aliceAcct.personId;
  aliceCookie = aliceAcct.cookie;
  bob = bobAcct.personId;
  bobCookie = bobAcct.cookie;
  dave = daveAcct.personId;
  daveCookie = daveAcct.cookie;
  projectA = await mkProject(owner, orgA, `proj-a-${CODE}`);
  projectB = await mkProject(owner, orgB, `proj-b-${CODE}`);
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
});

describe.skipIf(!ready)('workflow pipeline: full success path', () => {
  it('create workflow → emit event → execution RUNNING→SUCCEEDED, steps recorded, action ran', async () => {
    const sourceTask = await mkTask(owner, orgA, projectA, `source-${CODE}`);
    const wf = await mkWorkflow(owner, orgA, {
      name: `success-${CODE}`,
      trigger: taskCreatedTrigger(),
      // Prevent infinite loop: the create_task action's output must not re-trigger.
      conditions: [{ field: 'task.title', operator: 'not_contains', value: 'Auto:' }],
      actions: [
        {
          type: 'create_task',
          params: { title: 'Auto: {{event.payload.taskTitle}}', projectId: projectA },
        },
      ],
      createdBy: alice,
    });

    const auth = await authFor(aliceCookie)();
    const event = {
      type: 'task.created' as const,
      entityType: 'task' as const,
      entityId: sourceTask,
      dedupKey: buildDedupKey('task', sourceTask),
      payload: { taskId: sourceTask, taskTitle: 'Source task' },
    };
    const exec = await dispatchAndWait(auth, wf.id, event);

    // Engine dedup key: workflow.id + ':' + event.dedupKey (the D4 construction).
    expect(exec.dedup_key).toBe(`${wf.id}:${event.dedupKey}`);
    expect(exec.status).toBe('SUCCEEDED');
    expect(exec.workflow_version).toBe(1);
    expect(exec.error_code).toBeNull();
    expect(exec.result_summary).toMatchObject({ steps: 1 });

    const steps = await listSteps(owner, exec.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      step_index: 0,
      action_type: 'create_task',
      status: 'SUCCEEDED',
    });
    expect(steps[0]!.action_params).toMatchObject({
      title: 'Auto: Source task',
      projectId: projectA,
    });
    expect(steps[0]!.result).toMatchObject({ taskId: expect.any(String) });

    // The executor really ran createTask under the actor's auth: the task exists.
    const created = await owner.query<{ id: string }>(
      `select id from public.work_tasks where org_id = $1::uuid and title = 'Auto: Source task'`,
      [orgA],
    );
    expect(created.rows).toHaveLength(1);
  });

  it('conditions gate: unmet conditions → SUCCEEDED with skipped_conditions, no steps', async () => {
    const sourceTask = await mkTask(owner, orgA, projectA, `cond-${CODE}`);
    const wf = await mkWorkflow(owner, orgA, {
      name: `conds-${CODE}`,
      trigger: taskCreatedTrigger(),
      conditions: [{ field: 'deal.is_won', operator: 'equals', value: true }],
      actions: [{ type: 'create_task', params: { title: 'should not run', projectId: projectA } }],
      createdBy: alice,
    });

    const auth = await authFor(aliceCookie)();
    const exec = await dispatchAndWait(auth, wf.id, {
      type: 'task.created',
      entityType: 'task',
      entityId: sourceTask,
      dedupKey: buildDedupKey('task', sourceTask, 'cond'),
      payload: {},
    });

    expect(exec.status).toBe('SUCCEEDED');
    expect(exec.result_summary).toMatchObject({ decision: 'skipped_conditions' });
    expect(await listSteps(owner, exec.id)).toHaveLength(0);
  });
});

describe.skipIf(!ready)('workflow pipeline: idempotency (A8 flagged)', () => {
  it('re-delivering the same dedup key records exactly one execution', async () => {
    // actions: [] — the idempotency property (single execution row per
    // (workflow, dedupKey)) does not need a real executor.
    const sourceTask = await mkTask(owner, orgA, projectA, `idem-${CODE}`);
    const wf = await mkWorkflow(owner, orgA, {
      name: `idem-${CODE}`,
      trigger: taskCreatedTrigger(),
      actions: [],
      createdBy: alice,
    });

    const auth = await authFor(aliceCookie)();
    const event = {
      type: 'task.created' as const,
      entityType: 'task' as const,
      entityId: sourceTask,
      dedupKey: buildDedupKey('task', sourceTask, 'idem'),
      payload: {},
    };
    const first = await dispatchAndWait(auth, wf.id, event);
    expect(first.status).toBe('SUCCEEDED');

    // Second delivery of the same occurrence: the definer returns NULL on the
    // (workflow_id, dedup_key) conflict and the engine skips the run.
    await dispatchWorkflowEvent(auth, event);
    await new Promise((r) => setTimeout(r, 3000));
    expect(await countExecutions(wf.id, `${wf.id}:${event.dedupKey}`)).toBe(1);
  });
});

describe.skipIf(!ready)('workflow pipeline: tenant isolation', () => {
  it('an org B event cannot fire an org A workflow (and vice versa)', async () => {
    // actions: [] on both — tenant isolation is a MATCHING property (the
    // org-B event must never match the org-A workflow).
    const taskA = await mkTask(owner, orgA, projectA, `iso-a-${CODE}`);
    const taskB = await mkTask(owner, orgB, projectB, `iso-b-${CODE}`);
    const wfA = await mkWorkflow(owner, orgA, {
      name: `iso-a-${CODE}`,
      trigger: taskCreatedTrigger(),
      actions: [],
      createdBy: alice,
    });
    const wfB = await mkWorkflow(owner, orgB, {
      name: `iso-b-${CODE}`,
      trigger: taskCreatedTrigger(),
      actions: [],
      createdBy: bob,
    });

    // Bob's org-B event fires only the org-B workflow.
    const bEvent = {
      type: 'task.created' as const,
      entityType: 'task' as const,
      entityId: taskB,
      dedupKey: buildDedupKey('task', taskB),
      payload: {},
    };
    const bExec = await dispatchAndWait(await authFor(bobCookie)(), wfB.id, bEvent);
    expect(bExec.status).toBe('SUCCEEDED');

    await new Promise((r) => setTimeout(r, 2000));
    expect(await countExecutions(wfA.id, `${wfA.id}:${bEvent.dedupKey}`)).toBe(0);

    // Alice's org-A event fires only the org-A workflow.
    const aEvent = {
      type: 'task.created' as const,
      entityType: 'task' as const,
      entityId: taskA,
      dedupKey: buildDedupKey('task', taskA),
      payload: {},
    };
    const aExec = await dispatchAndWait(await authFor(aliceCookie)(), wfA.id, aEvent);
    expect(aExec.status).toBe('SUCCEEDED');
    expect(await countExecutions(wfB.id, `${wfB.id}:${aEvent.dedupKey}`)).toBe(0);
  });
});

describe.skipIf(!ready)('workflow pipeline: disabled workflows never run', () => {
  it.each(['DRAFT', 'PAUSED', 'ARCHIVED'] as const)(
    '%s workflow: dispatch → no execution',
    async (status) => {
      const sourceTask = await mkTask(owner, orgA, projectA, `dis-${CODE}`);
      const wf = await mkWorkflow(owner, orgA, {
        name: `dis-${status}-${CODE}`,
        status,
        trigger: taskCreatedTrigger(),
        actions: [{ type: 'create_task', params: { title: 'must not run', projectId: projectA } }],
        createdBy: alice,
      });

      const dedupKey = buildDedupKey('task', sourceTask, status);
      await dispatchWorkflowEvent(await authFor(aliceCookie)(), {
        type: 'task.created',
        entityType: 'task',
        entityId: sourceTask,
        dedupKey,
        payload: {},
      });

      // The SQL matcher narrows on status='ACTIVE'; give the pipeline time to
      // prove nothing was claimed, then assert the row never appeared.
      await new Promise((r) => setTimeout(r, 3000));
      expect(await countExecutions(wf.id, `${wf.id}:${dedupKey}`)).toBe(0);
    },
  );
});

describe.skipIf(!ready)('workflow pipeline: failure recording (A8 flagged)', () => {
  it('unresolvable template → step FAILED (INVALID_REQUEST), remaining actions stop, execution FAILED', async () => {
    const sourceTask = await mkTask(owner, orgA, projectA, `fail-${CODE}`);
    const wf = await mkWorkflow(owner, orgA, {
      name: `fail-${CODE}`,
      trigger: taskCreatedTrigger(),
      actions: [
        { type: 'create_task', params: { title: '{{event.nope}}', projectId: projectA } },
        { type: 'create_task', params: { title: 'never runs', projectId: projectA } },
      ],
      createdBy: alice,
    });

    const exec = await dispatchAndWait(await authFor(aliceCookie)(), wf.id, {
      type: 'task.created',
      entityType: 'task',
      entityId: sourceTask,
      dedupKey: buildDedupKey('task', sourceTask, 'tmpl'),
      payload: {},
    });

    expect(exec.status).toBe('FAILED');
    expect(exec.error_code).toBe('INVALID_REQUEST');
    expect(exec.error_message).toContain('unresolvable template reference');
    expect(exec.result_summary).toMatchObject({ failedStep: 0, decision: 'template_failed' });

    const steps = await listSteps(owner, exec.id);
    expect(steps).toHaveLength(1); // the second action never ran
    expect(steps[0]).toMatchObject({ status: 'FAILED', error_code: 'INVALID_REQUEST' });
  });

  it('NOT_FOUND snapshot (invisible/deleted source) → execution FAILED with error_code NOT_FOUND', async () => {
    const wf = await mkWorkflow(owner, orgA, {
      name: `notfound-${CODE}`,
      trigger: taskCreatedTrigger(),
      actions: [{ type: 'create_task', params: { title: 'never runs', projectId: projectA } }],
      createdBy: alice,
    });
    const ghostTask = '99999999-9999-4999-8999-999999999999';

    const exec = await dispatchAndWait(await authFor(aliceCookie)(), wf.id, {
      type: 'task.created',
      entityType: 'task',
      entityId: ghostTask,
      dedupKey: buildDedupKey('task', ghostTask),
      payload: {},
    });

    expect(exec.status).toBe('FAILED');
    expect(exec.error_code).toBe('NOT_FOUND');
    expect(exec.error_message).toContain('source record not visible');
    expect(exec.result_summary).toMatchObject({ decision: 'snapshot_failed' });
  });
});

describe.skipIf(!ready)('workflow pipeline: manual execute gate (A8 flagged)', () => {
  it('FORBIDDEN without workflows.execute', async () => {
    const wf = await mkWorkflow(owner, orgA, {
      name: `man-forbid-${CODE}`,
      trigger: { type: 'manual' },
      actions: [{ type: 'create_task', params: { title: 'manual x', projectId: projectA } }],
      createdBy: alice,
    });
    await expect(executeWorkflowManual(await authFor(daveCookie)(), wf.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('INVALID_REQUEST for a non-ACTIVE workflow', async () => {
    const wf = await mkWorkflow(owner, orgA, {
      name: `man-draft-${CODE}`,
      status: 'DRAFT',
      trigger: { type: 'manual' },
      actions: [{ type: 'create_task', params: { title: 'manual y', projectId: projectA } }],
      createdBy: alice,
    });
    await expect(executeWorkflowManual(await authFor(aliceCookie)(), wf.id)).rejects.toThrow(
      /INVALID_REQUEST: only ACTIVE workflows can be executed/,
    );
  });

  it('NOT_FOUND for a missing or foreign workflow id', async () => {
    await expect(
      executeWorkflowManual(await authFor(aliceCookie)(), '99999999-9999-4999-8999-999999999999'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('ACTIVE manual run executes exactly once and SUCCEEDs', async () => {
    // actions: [] — the manual gate (permission check, ACTIVE check,
    // fresh-uuid dedup per run) does not need a real executor.
    const wf = await mkWorkflow(owner, orgA, {
      name: `man-ok-${CODE}`,
      trigger: { type: 'manual' },
      actions: [],
      createdBy: alice,
    });

    // executeWorkflowManual awaits the pipeline: no polling needed.
    const { executionId } = await executeWorkflowManual(await authFor(aliceCookie)(), wf.id, {
      input: { label: 'hello' },
    });
    expect(executionId).toMatch(/^[0-9a-f-]{36}$/i);

    const { rows } = await owner.query<{
      status: string;
      trigger_type: string;
      error_code: string | null;
      result_summary: Record<string, unknown>;
    }>(
      `select status, trigger_type, error_code, result_summary
         from public.workflow_executions where id = $1::uuid`,
      [executionId],
    );
    expect(rows[0]!.status).toBe('SUCCEEDED');
    expect(rows[0]!.trigger_type).toBe('manual');
    expect(rows[0]!.error_code).toBeNull();
    expect(rows[0]!.result_summary).toMatchObject({ steps: 0 });

    // Manual runs carry a fresh-uuid dedup key: re-running executes again.
    const again = await executeWorkflowManual(await authFor(aliceCookie)(), wf.id, {
      input: { label: 'hello' },
    });
    expect(again.executionId).not.toBe(executionId);
  });
});

describe.skipIf(!ready)('workflow pipeline: dispatch never breaks the caller (D3)', () => {
  it('dispatch never rejects, even when the run will fail', async () => {
    const wf = await mkWorkflow(owner, orgA, {
      name: `d3-${CODE}`,
      trigger: taskCreatedTrigger(),
      actions: [{ type: 'create_task', params: { title: 'd3 task', projectId: projectA } }],
      createdBy: alice,
    });
    const ghostTask = '77777777-7777-4777-8777-777777777777';
    const dedupKey = buildDedupKey('task', ghostTask, 'd3');

    // The pipeline will fail (NOT_FOUND snapshot) — but the dispatch itself
    // is awaited inline (D1) and must resolve, never reject, to the caller.
    await expect(
      dispatchWorkflowEvent(await authFor(aliceCookie)(), {
        type: 'task.created',
        entityType: 'task',
        entityId: ghostTask,
        dedupKey,
        payload: {},
      }),
    ).resolves.toBeUndefined();

    const exec = await waitForExecution(owner, wf.id, `${wf.id}:${dedupKey}`, 15000);
    expect(exec.status).toBe('FAILED');
    expect(exec.error_code).toBe('NOT_FOUND');
  });
});

describe.skipIf(!ready)('workflow engine: D4 chaining bound (real engine)', () => {
  it('task.created → create_task chain terminates at exactly 5 deliveries', async () => {
    // Self-perpetuating workflow: every created task emits task.created,
    // which matches again and creates the next task. The AsyncLocalStorage
    // depth guard (D4) must drop the 6th dispatch: exactly 5 executions are
    // recorded and exactly 6 tasks exist (seed + 5 chained). Before the
    // 2026-10-04 fix the guard was dead code on the fire-and-forget path and
    // this looped unboundedly (P0-1).
    const chainedTitle = `chained-${CODE}`;
    const seedTitle = `chain-seed-${CODE}`;
    const wf = await mkWorkflow(owner, orgA, {
      name: `chain-${CODE}`,
      trigger: { type: 'task.created' },
      // CODE-scoped condition: isolates this test from leftover ACTIVE
      // workflows (e.g., from vitest retries or other tests) that also match
      // task.created. Without this, multiple workflows firing on each task
      // causes a query explosion (~95k queries observed in CI).
      conditions: [{ field: 'task.title', operator: 'contains', value: CODE }],
      actions: [{ type: 'create_task', params: { title: chainedTitle, projectId: projectA } }],
      createdBy: alice,
    });

    const auth = await authFor(aliceCookie)();
    // Seed through the REAL service so its post-commit emission enters the
    // engine — this is the production chaining path (service → dispatch →
    // engine → service → dispatch …). Dispatch is awaited inline (D1), so
    // when createTask returns the whole chain has settled: no polling.
    const seed = await createTask(auth, { title: seedTitle, projectId: projectA });

    const { rows: execRows } = await owner.query<{ n: string }>(
      `select count(*) n from public.workflow_executions where workflow_id = $1::uuid`,
      [wf.id],
    );
    expect(Number(execRows[0]!.n)).toBe(5);

    const { rows: taskRows } = await owner.query<{ n: string }>(
      `select count(*) n from public.work_tasks
        where org_id = $1::uuid and title in ($2, $3) and deleted_at is null`,
      [orgA, seedTitle, chainedTitle],
    );
    // Seed task + 5 chained tasks. The 6th chained task was never created:
    // its dispatch was dropped by the depth guard before the engine ran.
    expect(Number(taskRows[0]!.n)).toBe(6);

    // Every recorded execution succeeded — the chain stopped because of the
    // depth guard, not because an action failed.
    const { rows: failedRows } = await owner.query<{ n: string }>(
      `select count(*) n from public.workflow_executions
        where workflow_id = $1::uuid and status <> 'SUCCEEDED'`,
      [wf.id],
    );
    expect(Number(failedRows[0]!.n)).toBe(0);

    // The seed task itself is untouched by the workflow (it was the trigger,
    // not an action output).
    expect(seed.title).toBe(seedTitle);
    // Heavy real-DB chain (5 full engine executions, ~100 queries): the
    // 30s default is legitimate for unit-speed tests, but a cold Neon branch
    // legitimately exceeds it. The D4 guard itself is proven — this only
    // budgets the branch's latency.
  }, 90_000);
});
