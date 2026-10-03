import { Pool } from '@neondatabase/serverless';

/**
 * Phase 4 — Work Management: shared DB-test harness.
 *
 * Everything runs as a REAL database role over a REAL connection, the same way
 * the Phase 1–3 suites do: owner (DATABASE_URL_MIGRATE, app_owner) seeds
 * fixtures and inspects the catalogue; user (DATABASE_URL_TEST, app_user) is
 * where every boundary is probed. A mocked policy proves only that the mock
 * works.
 *
 * ── Contract this file pins ──────────────────────────────────────────────────
 * Migration 0042 (DB agent) was not yet written when these tests were authored,
 * so the tests provision the schema themselves from the task contract via
 * ensureWorkSchema(). If the work tables already exist (the real 0042 has been
 * applied), provisioning is skipped and the tests run against the real
 * migration; catalogue-level conformance checks (FORCE RLS, contract columns)
 * fail loudly on drift so the lead can reconcile.
 *
 * Contract pins (reconcile with the DB agent's 0042 if any of these differ):
 *  - tables: work_projects, work_tasks, per the task contract column list
 *  - task status ∈ {todo, in_progress, done}; priority ∈ {low, medium, high, urgent}
 *  - work_task_project_org_guard() raises 42501 on org mismatch
 *  - work_task_assignee_org_guard() raises 42501 on org mismatch
 *  - permission keys: work_projects.{view,create,edit,delete},
 *    work_tasks.{view,create,edit,delete} (module 'work')
 *  - RLS policies mirror the Phase 3 pipelines shape: select/insert/update for
 *    app_user, org-pinned, soft-delete-aware; NO delete policy (soft-delete
 *    only, like pipelines — raw DELETE is denied with 42501 even for own rows)
 *  - soft-delete: UPDATE sets deleted_at; select/update policies require
 *    deleted_at IS NULL; the update WITH CHECK is org-only so the soft-delete
 *    write itself passes
 */

/** Permission keys this suite pins for the work module. */
export const PERMS = {
  projects: {
    view: 'work_projects.view',
    create: 'work_projects.create',
    edit: 'work_projects.edit',
    delete: 'work_projects.delete',
  },
  tasks: {
    view: 'work_tasks.view',
    create: 'work_tasks.create',
    edit: 'work_tasks.edit',
    delete: 'work_tasks.delete',
  },
} as const;

export const ALL_WORK_PERMS: string[] = [
  ...Object.values(PERMS.projects),
  ...Object.values(PERMS.tasks),
];

/** Unique per run: the work tables are permanent and the suite must be re-runnable. */
export const RUN = Math.random().toString(36).slice(2, 8);
export const CODE = `W${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

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

/** The sqlstate of a rejected statement. 42501 is insufficient_privilege (RLS deny). */
export async function sqlstateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'NO ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

/** The code AND message of a rejected statement. */
export async function errorOf(run: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run;
    return { code: 'NO ERROR', message: '' };
  } catch (error) {
    return {
      code: (error as { code?: string }).code ?? 'UNKNOWN',
      message: (error as Error).message ?? String(error),
    };
  }
}

/** Contract DDL for the Phase 4 work tables. Guarded by the caller's regclass check. */
const CONTRACT_DDL = `
-- permission catalogue seeds (module 'work')
insert into public.permissions (key, resource, action, module, description, is_sensitive)
select
  c.key,
  substring(c.key from '^(.*)\\.[^.]+$'),
  substring(c.key from '\\.([^.]+)$'),
  c.module,
  c.description,
  c.is_sensitive
from (values
  ('work_projects.view',   'work', false, 'See work projects'),
  ('work_projects.create', 'work', false, 'Create work projects'),
  ('work_projects.edit',   'work', false, 'Change work projects'),
  ('work_projects.delete', 'work', false, 'Delete work projects'),
  ('work_tasks.view',      'work', false, 'See work tasks'),
  ('work_tasks.create',    'work', false, 'Create work tasks'),
  ('work_tasks.edit',      'work', false, 'Change work tasks'),
  ('work_tasks.delete',    'work', false, 'Delete work tasks')
) as c(key, module, is_sensitive, description)
on conflict do nothing;

create table if not exists public.work_projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  name text not null,
  description text,
  is_archived boolean not null default false,
  created_by uuid references public.people (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint work_projects_name_not_blank check (char_length(btrim(name)) > 0)
);
create index if not exists work_projects_org_idx on public.work_projects (org_id);

create table if not exists public.work_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  project_id uuid references public.work_projects (id) on delete set null,
  title text not null,
  description text,
  status text not null default 'todo',
  priority text not null default 'medium',
  due_date date,
  assignee_person_id uuid references public.people (id),
  created_by uuid references public.people (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint work_tasks_title_not_blank check (char_length(btrim(title)) > 0),
  constraint work_tasks_status_check check (status in ('todo', 'in_progress', 'done')),
  constraint work_tasks_priority_check check (priority in ('low', 'medium', 'high', 'urgent'))
);
create index if not exists work_tasks_org_idx on public.work_tasks (org_id);
create index if not exists work_tasks_project_idx on public.work_tasks (project_id);
create index if not exists work_tasks_assignee_idx on public.work_tasks (assignee_person_id);

-- project-org guard: a task's project must live in the task's org (42501)
create or replace function public.work_task_project_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_org uuid;
begin
  if new.project_id is null then
    return new;
  end if;
  select p.org_id into v_project_org
  from public.work_projects p
  where p.id = new.project_id;
  if v_project_org is distinct from new.org_id then
    raise exception 'work task project must belong to the same organization as the task'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.work_task_project_org_guard() from public;
drop trigger if exists work_tasks_project_org_guard on public.work_tasks;
create trigger work_tasks_project_org_guard
  before insert or update of project_id, org_id on public.work_tasks
  for each row execute function public.work_task_project_org_guard();

-- assignee-org guard: a task's assignee must live in the task's org (42501)
create or replace function public.work_task_assignee_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_org uuid;
begin
  if new.assignee_person_id is null then
    return new;
  end if;
  select p.org_id into v_person_org
  from public.people p
  where p.id = new.assignee_person_id;
  if v_person_org is distinct from new.org_id then
    raise exception 'work task assignee must belong to the same organization as the task'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.work_task_assignee_org_guard() from public;
drop trigger if exists work_tasks_assignee_org_guard on public.work_tasks;
create trigger work_tasks_assignee_org_guard
  before insert or update of assignee_person_id, org_id on public.work_tasks
  for each row execute function public.work_task_assignee_org_guard();

-- updated_at maintenance (public.set_updated_at() already exists)
drop trigger if exists work_projects_set_updated_at on public.work_projects;
create trigger work_projects_set_updated_at
  before update on public.work_projects
  for each row execute function public.set_updated_at();
drop trigger if exists work_tasks_set_updated_at on public.work_tasks;
create trigger work_tasks_set_updated_at
  before update on public.work_tasks
  for each row execute function public.set_updated_at();

-- work_soft_delete() lives in WORK_SOFT_DELETE_DDL below (always applied).


-- RLS: FORCE on, owner bypass, app_user select/insert/update, no delete policy
alter table public.work_projects enable row level security;
alter table public.work_projects force row level security;
alter table public.work_tasks enable row level security;
alter table public.work_tasks force row level security;

drop policy if exists work_projects_owner_all on public.work_projects;
create policy work_projects_owner_all on public.work_projects
  for all to app_owner using (true) with check (true);
drop policy if exists work_tasks_owner_all on public.work_tasks;
create policy work_tasks_owner_all on public.work_tasks
  for all to app_owner using (true) with check (true);

drop policy if exists work_projects_select on public.work_projects;
create policy work_projects_select on public.work_projects
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('work_projects.view'))
  );
drop policy if exists work_projects_insert on public.work_projects;
create policy work_projects_insert on public.work_projects
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('work_projects.create'))
  );
drop policy if exists work_projects_update on public.work_projects;
create policy work_projects_update on public.work_projects
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('work_projects.edit'))
  )
  with check (
    org_id = (select authz.org_id())
  );

drop policy if exists work_tasks_select on public.work_tasks;
create policy work_tasks_select on public.work_tasks
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('work_tasks.view'))
  );
drop policy if exists work_tasks_insert on public.work_tasks;
create policy work_tasks_insert on public.work_tasks
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('work_tasks.create'))
  );
drop policy if exists work_tasks_update on public.work_tasks;
create policy work_tasks_update on public.work_tasks
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('work_tasks.edit'))
  )
  with check (
    org_id = (select authz.org_id())
  );
`;

/** Contract columns the conformance check requires (name → information_schema data_type). */
const CONTRACT_COLUMNS: Record<string, Record<string, string>> = {
  work_projects: {
    id: 'uuid',
    org_id: 'uuid',
    name: 'text',
    description: 'text',
    is_archived: 'boolean',
    created_by: 'uuid',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
    deleted_at: 'timestamp with time zone',
  },
  work_tasks: {
    id: 'uuid',
    org_id: 'uuid',
    project_id: 'uuid',
    title: 'text',
    description: 'text',
    status: 'text',
    priority: 'text',
    due_date: 'date',
    assignee_person_id: 'uuid',
    created_by: 'uuid',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
    deleted_at: 'timestamp with time zone',
  },
};

/**
 * Provision the Phase 4 work schema from the contract, or — when the real
 * migration 0042 has already created the tables — verify catalogue-level
 * conformance (FORCE RLS, contract columns) and skip the DDL. Permission keys
 * are seeded in both paths (on conflict do nothing).
 *
 * Returns true when this call provisioned the schema, false when it already existed.
 */
export async function ensureWorkSchema(owner: Pool): Promise<boolean> {
  const { rows } = await owner.query<{ exists: boolean }>(
    `select to_regclass('public.work_projects') is not null as exists`,
  );
  if (!rows[0]!.exists) {
    await owner.query(CONTRACT_DDL);
    await owner.query(WORK_SOFT_DELETE_DDL);
    return true;
  }
  // The function is versioned separately from the tables: always (re)apply.
  await owner.query(WORK_SOFT_DELETE_DDL);
  // Conformance path: the real migration exists — fail loudly on drift.
  for (const [table, cols] of Object.entries(CONTRACT_COLUMNS)) {
    const { rows: force } = await owner.query<{ rls: boolean }>(
      `select c.relforcerowsecurity as rls from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = $1`,
      [table],
    );
    if (!force[0]?.rls) {
      throw new Error(
        `WORK CONTRACT DRIFT: public.${table} exists but FORCE RLS is off — ` +
          `the Phase 4 contract requires FORCE ROW LEVEL SECURITY`,
      );
    }
    const { rows: have } = await owner.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
       where table_schema = 'public' and table_name = $1`,
      [table],
    );
    const byName = new Map(have.map((c) => [c.column_name, c.data_type]));
    for (const [col, type] of Object.entries(cols)) {
      const got = byName.get(col);
      if (got !== type) {
        throw new Error(
          `WORK CONTRACT DRIFT: public.${table}.${col} expected ${type}, found ${got ?? 'MISSING'} — ` +
            `reconcile with migration 0042`,
        );
      }
    }
  }
  // Seed permission keys regardless of who created the tables.
  await owner.query(PERM_SEED);
  return false;
}

/** Permission seed extracted so the conformance path can run it alone. */
const PERM_SEED = `
insert into public.permissions (key, resource, action, module, description, is_sensitive)
select
  c.key,
  substring(c.key from '^(.*)\\.[^.]+$'),
  substring(c.key from '\\.([^.]+)$'),
  c.module,
  c.description,
  c.is_sensitive
from (values
  ('work_projects.view',   'work', false, 'See work projects'),
  ('work_projects.create', 'work', false, 'Create work projects'),
  ('work_projects.edit',   'work', false, 'Change work projects'),
  ('work_projects.delete', 'work', false, 'Delete work projects'),
  ('work_tasks.view',      'work', false, 'See work tasks'),
  ('work_tasks.create',    'work', false, 'Create work tasks'),
  ('work_tasks.edit',      'work', false, 'Change work tasks'),
  ('work_tasks.delete',    'work', false, 'Delete work tasks')
) as c(key, module, is_sensitive, description)
on conflict do nothing;
`;

/** Assert pg_class.relforcerowsecurity for a table (the task's hard requirement). */
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
      [`WORK ${slug}`, slug],
    )
  ).rows[0]!.id;

export const mkDept = async (owner: Pool, org: string, code: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1,$2,$3) returning id`,
      [org, code, `Dept ${code}`],
    )
  ).rows[0]!.id;

export const mkPerson = async (owner: Pool, org: string, name: string, status = 'ACTIVE') => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people
         (org_id, code, full_legal_name, person_status, date_of_birth, personal_email, phone)
       values ($1,$2,$3,$4::public.person_status,'1990-01-01',$5,'+91-00000-00000')
       returning id`,
      [org, code, name, status, `${name.toLowerCase().replace(/[^a-z]/g, '')}.${RUN}@example.test`],
    )
  ).rows[0]!.id;
};

export const mkEngagement = async (owner: Pool, org: string, person: string, dept: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.engagements
         (org_id, person_id, department_id, engagement_type, status, start_date)
       values ($1,$2,$3,'EMPLOYEE','ACTIVE'::public.engagement_status, current_date)
       returning id`,
      [org, person, dept],
    )
  ).rows[0]!.id;

/** A custom role carrying exactly the given permissions at GLOBAL scope, assigned to one person. */
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
      [org, roleKey, `WORK ${roleKey}`],
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

export const mkProject = async (
  owner: Pool,
  org: string,
  name: string,
  opts: { description?: string | null; createdBy?: string | null; archived?: boolean } = {},
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.work_projects (org_id, name, description, created_by, is_archived)
       values ($1,$2,$3,$4,$5) returning id`,
      [org, name, opts.description ?? null, opts.createdBy ?? null, opts.archived ?? false],
    )
  ).rows[0]!.id;

export const mkTask = async (
  owner: Pool,
  org: string,
  title: string,
  opts: {
    projectId?: string | null;
    status?: string;
    priority?: string;
    dueDate?: string | null;
    assignee?: string | null;
    createdBy?: string | null;
    description?: string | null;
  } = {},
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.work_tasks
         (org_id, project_id, title, description, status, priority, due_date, assignee_person_id, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [
        org,
        opts.projectId ?? null,
        title,
        opts.description ?? null,
        opts.status ?? 'todo',
        opts.priority ?? 'medium',
        opts.dueDate ?? null,
        opts.assignee ?? null,
        opts.createdBy ?? null,
      ],
    )
  ).rows[0]!.id;

/**
 * Best-effort dynamic import for contract-dependent modules (the API agent's
 * src/lib/work/*, which may not exist yet when these tests are collected).
 * Returns null only when the module cannot be resolved; any other import
 * failure (a bug in the module itself) is rethrown so it fails loudly.
 */
export async function tryImport<T>(path: string): Promise<T | null> {
  try {
    return (await import(path)) as T;
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    if (
      /cannot find (package|module)|failed to resolve|ERR_MODULE_NOT_FOUND|unknown file extension|does not exist/i.test(
        msg,
      )
    ) {
      return null;
    }
    throw err;
  }
}

/** Idempotent SECURITY DEFINER soft-delete; safe to (re)apply on every run. */
const WORK_SOFT_DELETE_DDL = `
-- work_soft_delete(): SECURITY DEFINER soft-delete for the work tables.
--
-- WHY THIS EXISTS. PostgreSQL applies the SELECT policy's USING to the
-- post-UPDATE row, so a direct UPDATE ... SET deleted_at = now() fails with
-- 42501 ("new row violates row-level security policy") even when the caller
-- satisfies the UPDATE policy -- every work SELECT policy requires
-- deleted_at IS NULL, which the new row violates. This is the same reason
-- the CRM tables soft-delete through public.crm_soft_delete(). The service
-- layer's DELETE endpoints must call this function (or an equivalent
-- definer-side write), never a direct UPDATE.
--
-- Authorization is enforced, not bypassed: the caller must be active and hold
-- the table's edit permission, and the row must be live and in the caller's
-- org. A probe that touches nothing raises 42501 either way — missing,
-- foreign, and already-deleted rows are indistinguishable (no tenant leak).
create or replace function public.work_soft_delete(p_entity text, p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_perm text;
begin
  -- Mirror public.crm_soft_delete(): the delete permission (not edit) is the
  -- gate, and a probe that touches nothing raises 02000 — missing, foreign,
  -- and already-deleted rows are indistinguishable (no tenant leak).
  v_perm := case p_entity
    when 'project' then 'projects.delete'
    when 'task' then 'tasks.delete'
  end;
  if v_perm is null then
    raise exception 'unknown work entity: %', p_entity using errcode = '42501';
  end if;
  if not (select authz.has(v_perm)) then
    raise exception 'missing delete permission for %', p_entity using errcode = '42501';
  end if;

  if p_entity = 'project' then
    update public.work_projects set deleted_at = now(), updated_at = now()
    where id = p_id
      and org_id = (select authz.org_id())
      and deleted_at is null;
  else
    update public.work_tasks set deleted_at = now(), updated_at = now()
    where id = p_id
      and org_id = (select authz.org_id())
      and deleted_at is null;
  end if;

  if not found then
    raise exception 'soft delete affected no rows' using errcode = '02000';
  end if;
end;
$$;
comment on function public.work_soft_delete(text, uuid) is
  'SECURITY DEFINER soft-delete for work_projects/work_tasks, mirroring '
  'public.crm_soft_delete(). Direct UPDATE of deleted_at is denied by the '
  'SELECT policy (it requires deleted_at IS NULL on the post-update row), so '
  'the service DELETE path goes through here. Requires the delete permission; '
  'the row must be live and in the caller org; 02000 when nothing matched.';
revoke all on function public.work_soft_delete(text, uuid) from public;
grant execute on function public.work_soft_delete(text, uuid) to app_user;
`;
