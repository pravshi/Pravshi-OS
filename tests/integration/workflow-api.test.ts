import { beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { RUN, tryImport } from '../work/helpers';

/**
 * Phase 5 — service-level tests for the 10 workflow routes.
 *
 * These tests call the real service functions with genuine Authorizations
 * minted by requirePermission() through real Better Auth sessions (the shared
 * Task 1.15 fixtures), exercising the full path: zod boundary → authorized DB
 * (RLS identity) → the 0044 triggers → soft-delete.
 *
 * ── Contract this file pins ──────────────────────────────────────────────────
 * Route → service mapping (src/app/api/workflows/* + src/app/api/workflow-executions/*):
 *  - GET    /api/workflows                    → listWorkflows    → { rows, total, limit, offset }
 *  - POST   /api/workflows                    → createWorkflow   → 201 + workflow (status DRAFT)
 *  - GET    /api/workflows/[id]               → getWorkflow      → workflow | NOT_FOUND (404)
 *  - PATCH  /api/workflows/[id]               → updateWorkflow   → 200 + workflow (bumps version)
 *  - DELETE /api/workflows/[id]               → deleteWorkflow   → 200 { ok: true } (soft delete)
 *  - POST   /api/workflows/[id]/activate     → activateWorkflow → ACTIVE | 400 on deferred trigger
 *  - POST   /api/workflows/[id]/pause        → pauseWorkflow    → PAUSED | 400 on illegal transition
 *  - POST   /api/workflows/[id]/execute       → executeWorkflow  → 202 { executionId, status }
 *  - GET    /api/workflows/[id]/executions    → listExecutions   → { rows, total, limit, offset }
 *  - GET    /api/workflow-executions/[id]     → getExecution     → execution + steps[]
 * Auth gates: missing permission → AuthorizationError FORBIDDEN (403);
 * no session → UNAUTHENTICATED (401). Cross-tenant read → NOT_FOUND (404
 * concealment, never a tenant leak). Validation/domain failures →
 * Error('INVALID_REQUEST: <message>') (→ 400).
 *
 * DB-gated: the whole suite SKIPS until src/lib/workflows/* exists AND a Neon
 * branch is configured (DATABASE_URL_MIGRATE / DATABASE_URL_TEST), the same
 * runnable pattern as tests/integration/work-api.test.ts.
 *
 * Run with the CI test environment (DATABASE_URL on the pooled host, APP_URL,
 * NODE_ENV=test, BETTER_AUTH_SECRET) — src/env.ts validates at import time.
 */

/** Mirror DATABASE_URL_TEST onto DATABASE_URL when only the test URL is set.
    The fixtures sign in through Better Auth, which reads DATABASE_URL. */
const DB_URL_FALLBACK_KEY = 'DATABASE_URL_TEST';
if (!process.env.DATABASE_URL && process.env[DB_URL_FALLBACK_KEY]) {
  Object.assign(process.env, { DATABASE_URL: process.env[DB_URL_FALLBACK_KEY] });
}

const hasDb = !!process.env[DB_URL_FALLBACK_KEY];

interface WorkflowLike {
  id: string;
  name: string;
  status: string;
  version: number;
  trigger: { type: string; filters?: Record<string, unknown> };
  conditions: unknown[];
  actions: unknown[];
}

interface ExecutionLike {
  id: string;
  status: string;
  triggerType: string;
  workflowVersion: number;
}

interface ExecutionDetailLike extends ExecutionLike {
  steps: { id: string; actionType: string; status: string; stepIndex: number }[];
}

interface PageLike<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
}

interface WorkflowService {
  listWorkflows(auth: unknown, input?: unknown): Promise<PageLike<WorkflowLike>>;
  createWorkflow(auth: unknown, input: unknown): Promise<WorkflowLike>;
  getWorkflow(auth: unknown, id: string): Promise<WorkflowLike>;
  updateWorkflow(auth: unknown, id: string, input: unknown): Promise<WorkflowLike>;
  deleteWorkflow(auth: unknown, id: string): Promise<void>;
  activateWorkflow(auth: unknown, id: string): Promise<WorkflowLike>;
  pauseWorkflow(auth: unknown, id: string): Promise<WorkflowLike>;
  executeWorkflow(
    auth: unknown,
    id: string,
    input: unknown,
  ): Promise<{ executionId: string; status: string }>;
  listExecutions(auth: unknown, id: string, input?: unknown): Promise<PageLike<ExecutionLike>>;
  getExecution(auth: unknown, id: string): Promise<ExecutionDetailLike>;
}

interface FixturesModule {
  mkOrg(owner: Pool, slug: string): Promise<string>;
  mkDept(owner: Pool, org: string, code: string): Promise<string>;
  mkCustomRole(
    owner: Pool,
    org: string,
    key: string,
    grants: [permission: string, scope: string][],
  ): Promise<string>;
  mkAccount(
    owner: Pool,
    input: {
      org: string;
      dept: string;
      run: string;
      label: string;
      customRoles?: string[];
    },
  ): Promise<{ personId: string; cookie: string }>;
  headersFor(cookie: string, extra?: Record<string, string>): Headers;
  outcomeOf(
    promise: Promise<unknown>,
  ): Promise<{ code: string; status?: number; requestId?: string }>;
}

interface AuthzModule {
  requirePermission(headers: Headers, opts: { permission: string }): Promise<unknown>;
}

const service = hasDb ? await tryImport<WorkflowService>('@/lib/workflows/service') : null;
const fx = service ? await tryImport<FixturesModule>('../authz/fixtures') : null;
const authz = service ? await tryImport<AuthzModule>('@/lib/authz/require-permission') : null;

const ready = !!service && !!fx && !!authz;
const S = () => service!;
const F = () => fx!;

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

const authFor =
  (account: { cookie: string }) =>
  (permission: string): Promise<unknown> =>
    authz!.requirePermission(F().headersFor(account.cookie), { permission });

const codeOf = async (run: Promise<unknown>): Promise<string> => {
  const outcome = await F().outcomeOf(run);
  return outcome.code;
};

const messageOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
    return 'NO ERROR';
  } catch (err) {
    return (err as Error).message ?? String(err);
  }
};

const ALL_WORKFLOW_PERMS = [
  'workflows.view',
  'workflows.create',
  'workflows.edit',
  'workflows.delete',
  'workflows.activate',
  'workflows.execute',
] as const;

describe.skipIf(!ready)('workflow API: definitions', () => {
  let orgA = '';
  let orgB = '';
  let alice!: { personId: string; cookie: string };
  let bob!: { personId: string; cookie: string };
  let viewer!: { personId: string; cookie: string };
  let stranger!: { personId: string; cookie: string };

  const authA = (perm: string) => authFor(alice)(perm);
  const authB = (perm: string) => authFor(bob)(perm);
  const authV = (perm: string) => authFor(viewer)(perm);
  const authS = (perm: string) => authFor(stranger)(perm);

  const draftInput = (name: string) => ({
    name,
    description: 'e2e fixture',
    trigger: { type: 'deal.stage_changed', entityType: 'deal', filters: { isWon: true } },
    conditions: [],
    actions: [{ type: 'create_task', params: { title: `Onboard ${RUN}` } }],
  });

  beforeAll(async () => {
    orgA = await F().mkOrg(owner, `wf-api-a-${RUN}`);
    orgB = await F().mkOrg(owner, `wf-api-b-${RUN}`);
    const deptA = await F().mkDept(owner, orgA, `${RUN}_AA`);
    const deptB = await F().mkDept(owner, orgB, `${RUN}_AB`);
    const deptV = await F().mkDept(owner, orgA, `${RUN}_AV`);
    const deptS = await F().mkDept(owner, orgA, `${RUN}_AS`);
    const roleA = await F().mkCustomRole(
      owner,
      orgA,
      `${RUN}_AR`,
      ALL_WORKFLOW_PERMS.map((p) => [p, 'GLOBAL'] as [string, string]),
    );
    const roleB = await F().mkCustomRole(
      owner,
      orgB,
      `${RUN}_BR`,
      ALL_WORKFLOW_PERMS.map((p) => [p, 'GLOBAL'] as [string, string]),
    );
    const roleV = await F().mkCustomRole(owner, orgA, `${RUN}_VR`, [['workflows.view', 'GLOBAL']]);
    alice = await F().mkAccount(owner, {
      org: orgA,
      dept: deptA,
      run: RUN,
      label: 'WF-API-Alice',
      customRoles: [roleA],
    });
    bob = await F().mkAccount(owner, {
      org: orgB,
      dept: deptB,
      run: RUN,
      label: 'WF-API-Bob',
      customRoles: [roleB],
    });
    viewer = await F().mkAccount(owner, {
      org: orgA,
      dept: deptV,
      run: RUN,
      label: 'WF-API-Viewer',
      customRoles: [roleV],
    });
    stranger = await F().mkAccount(owner, {
      org: orgA,
      dept: deptS,
      run: RUN,
      label: 'WF-API-Stranger',
    });
  }, 120_000);

  it('creates a workflow as DRAFT and lists it with the { rows, total, limit, offset } envelope', async () => {
    const created = await S().createWorkflow(
      await authA('workflows.create'),
      draftInput(`Won deal onboarding ${RUN}`),
    );
    expect(created.id).toBeTruthy();
    expect(created.status).toBe('DRAFT');
    expect(created.version).toBe(1);
    expect(created.trigger.type).toBe('deal.stage_changed');

    const page = await S().listWorkflows(await authA('workflows.view'));
    expect(Array.isArray(page.rows)).toBe(true);
    expect(typeof page.total).toBe('number');
    expect(typeof page.limit).toBe('number');
    expect(typeof page.offset).toBe('number');
    expect(page.rows.map((w) => w.id)).toContain(created.id);
  });

  it('lists only the caller org workflows (tenant isolation)', async () => {
    const mine = await S().createWorkflow(
      await authA('workflows.create'),
      draftInput(`Mine ${RUN}`),
    );
    await S().createWorkflow(await authB('workflows.create'), draftInput(`Theirs ${RUN}`));
    const pageA = await S().listWorkflows(await authA('workflows.view'));
    const pageB = await S().listWorkflows(await authB('workflows.view'));
    expect(pageA.rows.map((w) => w.id)).toContain(mine.id);
    expect(pageB.rows.map((w) => w.id)).not.toContain(mine.id);
  });

  it('conceals a foreign workflow as NOT_FOUND (404)', async () => {
    const foreign = await S().createWorkflow(
      await authB('workflows.create'),
      draftInput(`Foreign ${RUN}`),
    );
    expect(await codeOf(S().getWorkflow(await authA('workflows.view'), foreign.id))).toBe(
      'NOT_FOUND',
    );
    expect(
      await codeOf(
        S().getWorkflow(await authA('workflows.view'), '00000000-0000-0000-0000-000000000000'),
      ),
    ).toBe('NOT_FOUND');
  });

  it('updates a workflow and bumps the version', async () => {
    const created = await S().createWorkflow(
      await authA('workflows.create'),
      draftInput(`Versioned ${RUN}`),
    );
    const updated = await S().updateWorkflow(await authA('workflows.edit'), created.id, {
      name: `Versioned v2 ${RUN}`,
    });
    expect(updated.name).toBe(`Versioned v2 ${RUN}`);
    expect(updated.version).toBe(2);
  });

  it('soft-deletes; the deleted workflow is no longer readable', async () => {
    const created = await S().createWorkflow(
      await authA('workflows.create'),
      draftInput(`Doomed ${RUN}`),
    );
    await S().deleteWorkflow(await authA('workflows.delete'), created.id);
    expect(await codeOf(S().getWorkflow(await authA('workflows.view'), created.id))).toBe(
      'NOT_FOUND',
    );
    const page = await S().listWorkflows(await authA('workflows.view'));
    expect(page.rows.map((w) => w.id)).not.toContain(created.id);
  });

  it('rejects invalid input with INVALID_REQUEST (400)', async () => {
    // Blank name.
    expect(
      await messageOf(S().createWorkflow(await authA('workflows.create'), draftInput('   '))),
    ).toMatch(/^INVALID_REQUEST:/);
    // Unknown trigger type.
    expect(
      await messageOf(
        S().createWorkflow(await authA('workflows.create'), {
          ...draftInput(`Bad trigger ${RUN}`),
          trigger: { type: 'time.travel' },
        }),
      ),
    ).toMatch(/^INVALID_REQUEST:/);
    // Unknown action type.
    expect(
      await messageOf(
        S().createWorkflow(await authA('workflows.create'), {
          ...draftInput(`Bad action ${RUN}`),
          actions: [{ type: 'send_telepathy', params: {} }],
        }),
      ),
    ).toMatch(/^INVALID_REQUEST:/);
  });

  it('activates DRAFT → ACTIVE and pauses ACTIVE → PAUSED', async () => {
    const created = await S().createWorkflow(
      await authA('workflows.create'),
      draftInput(`Lifecycle ${RUN}`),
    );
    const active = await S().activateWorkflow(await authA('workflows.activate'), created.id);
    expect(active.status).toBe('ACTIVE');
    // Re-activation is an illegal transition.
    expect(
      await messageOf(S().activateWorkflow(await authA('workflows.activate'), created.id)),
    ).toMatch(/^INVALID_REQUEST:/);
    const paused = await S().pauseWorkflow(await authA('workflows.activate'), created.id);
    expect(paused.status).toBe('PAUSED');
    // Pausing a PAUSED workflow is illegal.
    expect(
      await messageOf(S().pauseWorkflow(await authA('workflows.activate'), created.id)),
    ).toMatch(/^INVALID_REQUEST:/);
  });

  it('refuses to activate a deferred-trigger workflow (400: trigger type not yet supported)', async () => {
    const scheduled = await S().createWorkflow(await authA('workflows.create'), {
      name: `Daily digest ${RUN}`,
      trigger: { type: 'scheduled' },
      conditions: [],
      actions: [],
    });
    expect(scheduled.status).toBe('DRAFT');
    const message = await messageOf(
      S().activateWorkflow(await authA('workflows.activate'), scheduled.id),
    );
    expect(message).toMatch(/^INVALID_REQUEST: trigger type not yet supported/);
  });

  it('executes an ACTIVE workflow manually → { executionId, status } and records the step', async () => {
    const created = await S().createWorkflow(
      await authA('workflows.create'),
      draftInput(`Runnable ${RUN}`),
    );
    // Executing a DRAFT is rejected.
    expect(
      await messageOf(S().executeWorkflow(await authA('workflows.execute'), created.id, {})),
    ).toMatch(/^INVALID_REQUEST:/);
    await S().activateWorkflow(await authA('workflows.activate'), created.id);
    const result = await S().executeWorkflow(await authA('workflows.execute'), created.id, {});
    expect(result.executionId).toBeTruthy();
    expect(result.status).toBe('SUCCEEDED');

    const detail = await S().getExecution(await authA('workflows.view'), result.executionId);
    expect(detail.status).toBe('SUCCEEDED');
    expect(detail.steps).toHaveLength(1);
    expect(detail.steps[0]!.actionType).toBe('create_task');
    expect(detail.steps[0]!.status).toBe('SUCCEEDED');

    const history = await S().listExecutions(await authA('workflows.view'), created.id);
    expect(history.rows.map((e) => e.id)).toContain(result.executionId);
    expect(typeof history.total).toBe('number');
  });

  it('conceals a foreign execution as NOT_FOUND', async () => {
    expect(
      await codeOf(
        S().getExecution(await authA('workflows.view'), '00000000-0000-0000-0000-000000000000'),
      ),
    ).toBe('NOT_FOUND');
  });

  it('auth gates: FORBIDDEN without the permission, UNAUTHENTICATED without a session', async () => {
    const input = draftInput(`Gated ${RUN}`);
    // Viewer holds workflows.view only: create is 403.
    expect(await codeOf(S().createWorkflow(await authV('workflows.view'), input))).toBe(
      'FORBIDDEN',
    );
    // Stranger holds nothing: even listing is 403.
    expect(await codeOf(S().listWorkflows(await authS('workflows.view')))).toBe('FORBIDDEN');
    // No session at all: 401.
    const noAuth = await F().outcomeOf(
      authz!.requirePermission(F().headersFor(''), { permission: 'workflows.view' }),
    );
    expect(noAuth.code).toBe('UNAUTHENTICATED');
  });
});
