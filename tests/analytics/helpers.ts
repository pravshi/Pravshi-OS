import { Pool } from '@neondatabase/serverless';
import type { AuthContext } from '@/lib/db/context';

/**
 * Phase 7 analytics — shared DB-test harness.
 *
 * Mirrors the established repo pattern (tests/work/helpers.ts,
 * tests/db/work-rls.test.ts): owner (DATABASE_URL_MIGRATE, app_owner) seeds
 * fixtures and bypasses RLS; every metric call goes through the metric
 * functions themselves, which use withAuthorizedDb() — THE ONLY PATH TO
 * POSTGRES — so RLS evaluates under the caller's real session identity.
 * Nothing is mocked; a mocked policy proves only that the mock works.
 *
 * A fabricated AuthContext { personId, orgId, aal } is exactly what Phase 0
 * constructs in tests (see src/lib/db/context.ts): withAuthorizedDb sets
 * app.person_id / app.org_id / app.aal from it, the same as the session
 * layer would.
 */

/** Owner connection: seeds fixtures, bypasses RLS (app_owner policies). */
export const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

/** Unique per run: all fixture tables are permanent; the suite is re-runnable. */
export const RUN = Math.random().toString(36).slice(2, 8);
export const CODE = `A${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

/** Every view permission the Phase 7 metric modules read through. */
export const ANALYTICS_PERMS = [
  'deals.view',
  'pipelines.view',
  'contacts.view',
  'companies.view',
  'activities.view',
  'projects.view',
  'tasks.view',
  'jobs.view',
  'workflows.view',
  'reports.view',
] as const;

/** Fabricate the session identity a metric call runs under. */
export function makeCtx(personId: string, orgId: string): AuthContext {
  return { personId, orgId, aal: 'aal1' };
}

/* ── org / people fixtures (owner connection) ─────────────────────────────── */

export const mkOrg = async (slug: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1,$2) returning id`,
      [`ANALYTICS ${slug}`, slug],
    )
  ).rows[0]!.id;

export const mkDept = async (org: string, code: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1,$2,$3) returning id`,
      [org, code, `Dept ${code}`],
    )
  ).rows[0]!.id;

export const mkPerson = async (org: string, name: string) => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people
         (org_id, code, full_legal_name, person_status, date_of_birth, personal_email, phone)
       values ($1,$2,$3,'ACTIVE'::public.person_status,'1990-01-01',$4,'+91-00000-00000')
       returning id`,
      [org, code, name, `${name.toLowerCase().replace(/[^a-z]/g, '')}.${RUN}@example.test`],
    )
  ).rows[0]!.id;
};

export const mkEngagement = async (org: string, person: string, dept: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.engagements
         (org_id, person_id, department_id, engagement_type, status, start_date)
       values ($1,$2,$3,'EMPLOYEE','ACTIVE'::public.engagement_status, current_date)
       returning id`,
      [org, person, dept],
    )
  ).rows[0]!.id;

/** A custom role carrying exactly the given permissions at GLOBAL scope. */
export const mkRoleFor = async (
  org: string,
  person: string,
  key: string,
  permissions: readonly string[],
) => {
  const roleKey = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const role = (
    await owner.query<{ id: string }>(
      `insert into public.roles (org_id, key, name) values ($1,$2,$3) returning id`,
      [org, roleKey, `ANALYTICS ${roleKey}`],
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

/* ── sales fixtures ───────────────────────────────────────────────────────── */

export const mkPipeline = async (org: string, name: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.pipelines (org_id, name, description) values ($1,$2,$3) returning id`,
      [org, name, `${name} ${RUN}`],
    )
  ).rows[0]!.id;

export const mkStage = async (
  org: string,
  pipeline: string,
  name: string,
  position: number,
  opts: { isWon?: boolean; isLost?: boolean } = {},
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.pipeline_stages
         (org_id, pipeline_id, name, position, probability, is_won, is_lost)
       values ($1,$2,$3,$4,0,$5,$6) returning id`,
      [org, pipeline, name, position, opts.isWon ?? false, opts.isLost ?? false],
    )
  ).rows[0]!.id;

export interface DealOpts {
  value?: string | null;
  currency?: string;
  stage?: string | null;
  createdAt?: Date;
  closedAt?: Date | null;
  deletedAt?: Date | null;
}

/**
 * A deal on a pipeline. Inserted as owner; the deals_record_stage_history
 * trigger writes the creation row (from_stage_id NULL → stage) with
 * changed_at = now() — callers backdate it via setHistoryChangedAt when the
 * test needs the creation inside a specific range.
 */
export const mkDeal = async (
  org: string,
  ownerPerson: string,
  title: string,
  pipeline: string,
  opts: DealOpts = {},
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.deals
         (org_id, title, owner_person_id, pipeline_id, pipeline_stage_id,
          value, currency, created_at, closed_at, deleted_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [
        org,
        title,
        ownerPerson,
        pipeline,
        opts.stage ?? null,
        opts.value ?? null,
        opts.currency ?? 'INR',
        opts.createdAt ?? new Date(),
        opts.closedAt ?? null,
        opts.deletedAt ?? null,
      ],
    )
  ).rows[0]!.id;

/** Move a deal to another stage (writes a history row via the trigger). */
export const moveDealToStage = async (dealId: string, stageId: string) => {
  await owner.query(`update public.deals set pipeline_stage_id = $2 where id = $1`, [
    dealId,
    stageId,
  ]);
};

/** Backdate the creation history row (from_stage_id IS NULL) of a deal. */
export const setHistoryChangedAt = async (dealId: string, changedAt: Date) => {
  await owner.query(
    `update public.deal_stage_history set changed_at = $2
     where deal_id = $1 and from_stage_id is null`,
    [dealId, changedAt],
  );
};

/* ── CRM fixtures ─────────────────────────────────────────────────────────── */

export const mkContact = async (
  org: string,
  ownerPerson: string,
  firstName: string,
  createdAt: Date = new Date(),
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.contacts (org_id, first_name, owner_person_id, created_at)
       values ($1,$2,$3,$4) returning id`,
      [org, firstName, ownerPerson, createdAt],
    )
  ).rows[0]!.id;

export const mkCompany = async (
  org: string,
  ownerPerson: string,
  name: string,
  createdAt: Date = new Date(),
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.companies (org_id, name, owner_person_id, created_at)
       values ($1,$2,$3,$4) returning id`,
      [org, name, ownerPerson, createdAt],
    )
  ).rows[0]!.id;

export const mkActivity = async (
  org: string,
  ownerPerson: string,
  type: 'CALL' | 'EMAIL' | 'MEETING' | 'NOTE',
  entityId: string,
  createdAt: Date = new Date(),
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.activities
         (org_id, entity_type, entity_id, type, subject, owner_person_id, created_at)
       values ($1,'deal',$2,$3,$4,$5,$6) returning id`,
      [org, entityId, type, `${type} ${RUN}`, ownerPerson, createdAt],
    )
  ).rows[0]!.id;

/* ── work fixtures ────────────────────────────────────────────────────────── */

export const mkWorkProject = async (org: string, name: string, archived = false) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.work_projects (org_id, name, is_archived) values ($1,$2,$3) returning id`,
      [org, name, archived],
    )
  ).rows[0]!.id;

export const mkWorkTask = async (
  org: string,
  title: string,
  opts: {
    status?: 'todo' | 'in_progress' | 'done';
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    dueDate?: string | null;
    projectId?: string | null;
  } = {},
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.work_tasks (org_id, title, status, priority, due_date, project_id)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [
        org,
        title,
        opts.status ?? 'todo',
        opts.priority ?? 'medium',
        opts.dueDate ?? null,
        opts.projectId ?? null,
      ],
    )
  ).rows[0]!.id;

/* ── automation / workflow fixtures ───────────────────────────────────────── */

export const mkJob = async (
  org: string,
  status: string,
  type = 'workflow_run',
  createdAt: Date = new Date(),
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.jobs (org_id, status, type, created_at) values ($1,$2,$3,$4) returning id`,
      [org, status, type, createdAt],
    )
  ).rows[0]!.id;

export const mkWorkflow = async (org: string, name: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.workflows (org_id, name, trigger) values ($1,$2,'{"type":"manual"}'::jsonb)
       returning id`,
      [org, name],
    )
  ).rows[0]!.id;

export const mkWorkflowExecution = async (
  org: string,
  workflowId: string,
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
  createdAt: Date = new Date(),
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.workflow_executions
         (org_id, workflow_id, workflow_version, dedup_key, status, trigger_type, created_at)
       values ($1,$2,1,$3,$4,'manual',$5) returning id`,
      [
        org,
        workflowId,
        `dedup-${RUN}-${Math.random().toString(36).slice(2, 10)}`,
        status,
        createdAt,
      ],
    )
  ).rows[0]!.id;
