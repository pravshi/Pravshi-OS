import { Pool } from '@neondatabase/serverless';

/**
 * Phase 5 — Workflow engine: fresh DB-test helper tree.
 *
 * Written fresh for the workflow module (per the audit §19 test contract);
 * the work-module helpers under tests/work/helpers.ts were the template, but
 * the permission keys, fixtures, and poll helpers here are workflow-specific.
 *
 * Convention: owner (DATABASE_URL_MIGRATE, role app_owner) seeds fixtures and
 * inspects the catalogue; asUser (DATABASE_URL_TEST, role app_user) is where
 * every boundary is probed. Nothing is mocked.
 *
 * The DB test files that use this tree need a live Neon branch and run
 * on CI (via the default vitest glob). They skip cleanly when the branch
 * env vars are absent, via describe.skipIf(!DB_READY).
 */

export const RUN = Math.random().toString(36).slice(2, 8);
export const CODE = `WF${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

/** True only when both branch connection strings are present. */
export const DB_READY = !!process.env.DATABASE_URL_MIGRATE && !!process.env.DATABASE_URL_TEST;

/** Permission keys the 0044 migration seeds for the workflow module. */
export const WORKFLOW_PERMS = {
  view: 'workflows.view',
  create: 'workflows.create',
  edit: 'workflows.edit',
  delete: 'workflows.delete',
  activate: 'workflows.activate',
  execute: 'workflows.execute',
} as const;
export const ALL_WORKFLOW_PERMS: string[] = Object.values(WORKFLOW_PERMS);

export type Ctx = { personId?: string | null; orgId?: string | null };

/** One transaction as app_user, carrying exactly the identity given — nothing more. */
export async function inContext<T extends Record<string, unknown> = Record<string, unknown>>(
  asUser: Pool,
  ctx: Ctx,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = await asUser.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`, [
      ctx.personId ?? '',
      ctx.orgId ?? '',
    ]);
    const result = await c.query<T>(sql, params);
    await c.query('commit');
    return result.rows;
  } catch (error) {
    await c.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

/** The sqlstate of a rejected statement (42501 = insufficient_privilege / RLS deny). */
export async function sqlstateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'NO ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

/** Assert pg_class.relforcerowsecurity for a table. */
export async function assertForceRls(owner: Pool, table: string): Promise<void> {
  const { rows } = await owner.query<{ rls: boolean }>(
    `select c.relforcerowsecurity as rls from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = $1`,
    [table],
  );
  if (!rows[0]?.rls) throw new Error(`FORCE RLS is off on public.${table}`);
}

/* ── fixtures (owner connection) ─────────────────────────────────────────── */

export const mkOrg = async (owner: Pool, slug: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1,$2) returning id`,
      [`WF ${slug}`, slug],
    )
  ).rows[0]!.id;

export const mkPerson = async (owner: Pool, org: string, name: string, status = 'ACTIVE') => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  const personId = (
    await owner.query<{ id: string }>(
      `insert into public.people
         (org_id, code, full_legal_name, person_status, date_of_birth, personal_email, phone)
       values ($1,$2,$3,$4::public.person_status,'1990-01-01',$5,'+91-00000-00000')
       returning id`,
      [org, code, name, status, `${name.toLowerCase().replace(/[^a-z]/g, '')}.${RUN}@example.test`],
    )
  ).rows[0]!.id;
  // authz.is_active() (and therefore every RLS policy and authz.has()) requires an
  // ACTIVE engagement in an ACTIVE organization — a bare person row resolves no
  // permissions. Mirror tests/work/helpers.ts: one department + one engagement.
  // Department codes are unique per org, so each person gets their own.
  const deptCode = `WF${RUN.toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const deptId = (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1,$2,$3) returning id`,
      [org, deptCode, `WF Dept ${deptCode}`],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into public.engagements
       (org_id, person_id, department_id, engagement_type, status, start_date)
     values ($1,$2,$3,'EMPLOYEE','ACTIVE'::public.engagement_status, current_date)`,
    [org, personId, deptId],
  );
  return personId;
};

/** A custom role carrying exactly the given permission keys at GLOBAL scope, assigned to one person. */
export const mkRoleFor = async (
  owner: Pool,
  org: string,
  person: string,
  key: string,
  permissions: string[],
) => {
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
  await owner.query(
    `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
    [person, role, org],
  );
};

export interface WorkflowFixture {
  readonly id: string;
  readonly orgId: string;
}

/**
 * Insert a workflow definition directly as app_owner (bypasses the API layer;
 * the API contract is covered by tests/integration). Trigger/conditions/
 * actions are caller-supplied JSONB; status defaults to ACTIVE.
 */
export const mkWorkflow = async (
  owner: Pool,
  org: string,
  opts: {
    name?: string;
    status?: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
    trigger?: Record<string, unknown>;
    conditions?: unknown[];
    actions?: Record<string, unknown>[];
    createdBy?: string | null;
  } = {},
): Promise<WorkflowFixture> => {
  const name = opts.name ?? `wf-${CODE}-${Math.random().toString(36).slice(2, 6)}`;
  const id = (
    await owner.query<{ id: string }>(
      `insert into public.workflows
         (org_id, name, status, trigger, conditions, actions, created_by)
       values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::uuid)
       returning id`,
      [
        org,
        name,
        opts.status ?? 'ACTIVE',
        JSON.stringify(opts.trigger ?? { type: 'manual' }),
        JSON.stringify(opts.conditions ?? []),
        JSON.stringify(opts.actions ?? []),
        opts.createdBy ?? null,
      ],
    )
  ).rows[0]!.id;
  return { id, orgId: org };
};

/** A work project, for action-executor fixtures. */
export const mkProject = async (owner: Pool, org: string, name: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.work_projects (org_id, name) values ($1,$2) returning id`,
      [org, name],
    )
  ).rows[0]!.id;

/** A work task, for event-source fixtures. */
export const mkTask = async (owner: Pool, org: string, projectId: string | null, title: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.work_tasks (org_id, project_id, title) values ($1,$2,$3) returning id`,
      [org, projectId, title],
    )
  ).rows[0]!.id;

/* ── pipeline helpers ────────────────────────────────────────────────────── */

/** Execution row as the engine's definer functions record it. */
export interface ExecutionRow {
  readonly id: string;
  readonly workflow_id: string;
  readonly dedup_key: string;
  readonly status: string;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly result_summary: Record<string, unknown> | null;
  readonly workflow_version: number;
}

/** Poll the executions table until the (workflow, dedupKey) execution lands
 *  in a terminal state — or throw on timeout. Dispatch is awaited inline
 *  (D1), so the row is usually terminal on return; the poll stays as a
 *  defensive backstop. */
export async function waitForExecution(
  owner: Pool,
  workflowId: string,
  dedupKey: string,
  timeoutMs = 15000,
): Promise<ExecutionRow> {
  const started = Date.now();
  for (;;) {
    const { rows } = await owner.query<ExecutionRow>(
      `select id, workflow_id, dedup_key, status, error_code, error_message,
              result_summary, workflow_version
         from public.workflow_executions
        where workflow_id = $1 and dedup_key = $2`,
      [workflowId, dedupKey],
    );
    const row = rows[0];
    if (row && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.status)) return row;
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `timed out waiting for execution (workflow=${workflowId} dedup=${dedupKey}) — ` +
          `last status=${row?.status ?? 'none'}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Step rows for an execution, in step order. */
export async function listSteps(owner: Pool, executionId: string) {
  const { rows } = await owner.query<{
    step_index: number;
    action_type: string;
    action_params: Record<string, unknown>;
    status: string;
    error_code: string | null;
    result: Record<string, unknown> | null;
  }>(
    `select step_index, action_type, action_params, status, error_code, result
       from public.workflow_execution_steps
      where execution_id = $1
      order by step_index`,
    [executionId],
  );
  return rows;
}

/**
 * Best-effort dynamic import for contract-dependent modules. Returns null only
 * when the module cannot be resolved; any other import failure (a bug in the
 * module itself) is rethrown so it fails loudly.
 */
export async function tryImport<T>(path: string): Promise<T | null> {
  try {
    return (await import(path)) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Cannot find module|Failed to resolve|ERR_MODULE_NOT_FOUND/.test(message)) return null;
    throw error;
  }
}
