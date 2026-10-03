-- PRAVSHI OS — Phase 4: work management.
--
-- Three tables: work_projects groups work, project_members records who is on
-- a project and at which level (role_in_project: manager/member), and
-- work_tasks holds the tasks themselves. A task belongs to at most one
-- project (project_id may be NULL for ungrouped/backlog tasks) and may be
-- assigned to one person. Tasks nest through parent_task_id: a subtask
-- inherits its parent's org and project, cascades when the parent is
-- hard-deleted, and can never be its own parent. work_projects optionally
-- links to the CRM deal it delivers (deal_id) — the Deal → Project → Tasks
-- flow future automation builds on.
--
-- Both work_projects and work_tasks soft-delete through deleted_at; the
-- runtime soft-delete path is crm_soft_delete() (0034/0037), extended here
-- with the two new mappings. project_members is append-mostly membership
-- state: it hard-deletes through its DELETE policy (managers only) and
-- cascades when its project is hard-deleted. A project soft-delete does NOT
-- cascade — tasks keep pointing at the archived project so history is
-- preserved (their project_id nulls only on hard delete, ON DELETE SET NULL).
--
-- Conventions carried over from 0033/0037:
--   Task 1.4 composite-key strategy   work_projects and project_members carry
--                                      UNIQUE (org_id, id) so children can pin
--                                      the parent's org. work_tasks references
--                                      its project and project_members
--                                      references its project and person by the
--                                      single-column FKs the contract
--                                      specifies — exactly like
--                                      deals.pipeline_id in 0037 — and the
--                                      tenant-isolation guarantee comes from
--                                      BEFORE triggers that reject a foreign-
--                                      org reference with 42501
--                                      (work_tasks_project_org_guard(),
--                                      work_tasks_assignee_org_guard(),
--                                      work_tasks_parent_org_guard(),
--                                      project_members_project_org_guard(),
--                                      project_members_person_org_guard(),
--                                      work_projects_deal_org_guard()).
--   Task 1.16 RLS template            org-scoped, deleted_at-excluded (where
--                                      the table has one), is_active()-gated.
--                                      These tables carry no owner_person_id,
--                                      so — like the pipelines tables — each
--                                      policy gates on authz.has('<key>') (the
--                                      permission at any scope) instead of an
--                                      owner-based scope CASE. project_members
--                                      adds a self-membership arm: a member
--                                      can see the membership rows of projects
--                                      they belong to even without
--                                      projects.view, and a project-level
--                                      manager can manage that project's
--                                      members without the global
--                                      projects.manage_members key. No new
--                                      authz helpers — plain EXISTS
--                                      subqueries, per the 0037 pattern.
--   Task 1.11 audit triggers          audit_row_change() at HIGH, whole-row,
--                                      on all three tables: task assignment,
--                                      project membership and project changes
--                                      are access-affecting, like the 0033 CRM
--                                      records.
--   No DELETE policy                  on work_projects and project_members'
--                                      hard-delete is manager-gated (see
--                                      below). work_projects soft-deletes
--                                      through crm_soft_delete() only.
--
-- DELIBERATE DEVIATIONS FROM THE 0033 TEMPLATE, and why:
--   * stamp_crm_actor() / enforce_crm_owner_change() are NOT attached. The
--     0033 functions require created_by/updated_by and owner_person_id
--     columns; work records carry a nullable created_by for attribution
--     (NULL for migrations/seeds — the 0033 "no synthetic actor" rule) and
--     assignment lives on assignee_person_id / project_members, not
--     ownership, so the owner machinery does not apply.
--   * created_by has NO foreign key to people. A deleted person row must not
--     block reads of the work they created, and the "no synthetic actor"
--     rule means migration writes would otherwise need a real person row.
--     assignee_person_id and project_members.person_id DO FK people(id):
--     assignment and membership are live relationships the app resolves,
--     and the org guards pin them to the row's org.
--   * work_tasks carries the one exception to the no-DELETE-policy rule: a
--     restrictive DELETE policy lets a task's creator hard-delete their own
--     task (created_by = authz.person_id()) and lets ADMIN delete through
--     the tasks.delete key. The security review requires creator delete;
--     the audit trigger still records every hard delete. work_projects
--     keeps no DELETE policy (ADMIN deletes through crm_soft_delete()
--     with the projects.delete key).
--   * No new permission-catalogue keys. The legacy projects.* / tasks.*
--     keys (seeded in 0008) are exactly this surface. The catalogue
--     previously granted tasks.create, tasks.delete, tasks.comment and
--     projects.delete to ZERO roles — this migration seeds the deliberate
--     grants (see "Permission grants" below). tasks.comment stays ungranted
--     (fail closed) until the comments feature lands.
--   * seed_system_roles() is recreated with the Phase 4 matrix rows, exactly
--     as 0037 did for the pipeline keys: the function in 0037 is the base,
--     never edited in place. Existing organizations are backfilled with the
--     same 16 grants per org (protection trigger disabled/re-enabled, the
--     0010/0033/0034/0037 pattern), and a verification block fails the
--     migration if any grant is missing.
--   * parent_task_id is a self-referencing FK with ON DELETE CASCADE:
--     deleting a parent hard-deletes its whole subtree. The no-self-parent
--     CHECK blocks the depth-1 cycle and the parent guard walks the
--     ancestor chain to reject deeper cycles (23514), so application tree
--     traversal always terminates. deal_id on work_projects is the CRM
--     seam: guarded to the project's org, SET NULL on deal hard-delete so
--     project history survives the deal. A partial unique index enforces
--     one live project per deal at the DB level (soft-deleted projects
--     free their deal).
--   * No seed data and no backfill of work rows: there is no legacy
--     work-management data to migrate, and default projects are a product
--     decision the application makes per org at runtime.
--
-- Permission grants (migration 0042) — the deliberate model:
--   MANAGER            projects.view/create/edit, tasks.view/create/edit at
--                      DEPARTMENT. (The 0008 matrix seeded MANAGER nothing at
--                      all; line management needs project/task operations.)
--   ADMIN              projects.delete, tasks.create, tasks.delete at GLOBAL.
--                      (ADMIN already held the other project/task keys.)
--   tasks.create       rides with tasks.view at each role's existing scope
--                      (SALES_MANAGER/PROJECT_MANAGER DEPARTMENT, DEVELOPER/
--                      VIBECODER PROJECT, SALES/INTERN/EMPLOYEE SELF), so no
--                      role gains task visibility it did not already hold.
--                      Roles that never held tasks.view (HR_*, FINANCE,
--                      MARKETING) gain nothing — a conservative reading of
--                      "all authenticated non-guest roles".
--   SUPER_ADMIN        holds every key through the whole-catalogue cross join,
--                      for future orgs (function) and existing orgs (the keys
--                      predate this migration, so the original cross join
--                      already granted them).
--   tasks.delete       is NOT seeded to non-admin roles: creators delete
--                      through the work_tasks DELETE RLS policy, not a grant.

-- ═════════════════════════════════════════════════════════════════════════════════
-- work_projects
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.work_projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  name text not null,
  description text,
  is_archived boolean not null default false,

  -- Optional link to the CRM deal this project delivers (Deal → Project →
  -- Tasks flow). Single-column FK; the org match is enforced by
  -- work_projects_deal_org_guard(). A deal hard-delete nulls the link.
  deal_id uuid references public.deals (id) on delete set null,

  -- Attribution only, nullable for migrations/seeds — the 0033 "no synthetic
  -- actor" rule. Deliberately NOT a FK to people: deleting a person must not
  -- block reads of the projects they created.
  created_by uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint work_projects_name_not_blank check (length(btrim(name)) > 0),
  -- Referenced positionally by anything that pins (org_id, id).
  constraint work_projects_org_id_unique unique (org_id, id)
);

-- Project names are unique per org among live projects, mirroring the
-- pipelines convention: soft-deleted rows are excluded so a deleted name can
-- be reused.
create unique index work_projects_name_unique_per_org
  on public.work_projects (org_id, name)
  where deleted_at is null;

create index work_projects_org_idx
  on public.work_projects (org_id)
  where deleted_at is null;

create index work_projects_deal_idx
  on public.work_projects (org_id, deal_id)
  where deleted_at is null;

-- One deal backs at most one live project: the DB-level backstop for the
-- Deal → Project → Tasks flow (the API checks this too, but the index is
-- the guarantee). Soft-deleted rows are excluded so a deleted project
-- frees its deal for a replacement project.
create unique index work_projects_deal_id_unique
  on public.work_projects (deal_id)
  where deal_id is not null and deleted_at is null;

create trigger work_projects_set_updated_at
  before update on public.work_projects
  for each row execute function public.set_updated_at();

comment on table public.work_projects is
  'Work projects: org-level containers for tasks. Soft-deleted through '
  'crm_soft_delete(); archiving is the separate is_archived flag.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- project_members
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.project_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  -- Single-column FKs by contract; the org match is enforced by the
  -- project_members_*_org_guard() triggers below (the 0037 pattern).
  project_id uuid not null references public.work_projects (id) on delete cascade,
  person_id uuid not null references public.people (id),

  -- Named role_in_project (not role): the API writes this column, and it
  -- defaults to 'member' so API inserts that omit it never hit 23502.
  role_in_project text not null default 'member',

  -- Who added the member; nullable for migrations/seeds — the 0033 "no
  -- synthetic actor" rule. Deliberately NOT a FK to people (see created_by
  -- on work_projects).
  added_by uuid,
  added_at timestamptz not null default now(),

  constraint project_members_role_in_project check (role_in_project in ('manager', 'member')),
  constraint project_members_project_person_unique unique (project_id, person_id),
  -- Referenced positionally by anything that pins (org_id, id).
  constraint project_members_org_id_unique unique (org_id, id)
);

create index project_members_org_idx
  on public.project_members (org_id);

create index project_members_project_idx
  on public.project_members (project_id);

create index project_members_person_idx
  on public.project_members (person_id);

comment on table public.project_members is
  'Project membership: who is on a project and at which level. Managers can '
  'manage members; members can view. Hard-deleted through the manager-gated '
  'DELETE policy; cascades on project hard-delete.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- work_tasks
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.work_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  -- NULL = ungrouped backlog task. Single-column FK by contract; the org
  -- match is enforced by work_tasks_project_org_guard() below.
  project_id uuid references public.work_projects (id) on delete set null,

  title text not null,
  description text,

  status text not null default 'todo',
  priority text not null default 'medium',

  due_date date,

  -- Live assignment relationship: the person's org must match the task's
  -- org (work_tasks_assignee_org_guard()).
  assignee_person_id uuid references public.people (id),

  -- Subtask link: self-FK, subtasks cascade when the parent is hard-deleted.
  -- A subtask inherits its parent's org and project
  -- (work_tasks_parent_org_guard()); a task can never be its own parent.
  parent_task_id uuid references public.work_tasks (id) on delete cascade,

  -- Attribution only, nullable for migrations/seeds — the 0033 "no synthetic
  -- actor" rule. Deliberately NOT a FK to people (see work_projects).
  -- Doubles as the creator arm of the DELETE policy.
  created_by uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint work_tasks_title_not_blank check (length(btrim(title)) > 0),
  constraint work_tasks_status check (
    status in ('todo', 'in_progress', 'done')
  ),
  constraint work_tasks_priority check (
    priority in ('low', 'medium', 'high', 'urgent')
  ),
  constraint work_tasks_no_self_parent check (
    parent_task_id is null or parent_task_id != id
  ),
  constraint work_tasks_org_id_unique unique (org_id, id)
);

create index work_tasks_org_idx
  on public.work_tasks (org_id)
  where deleted_at is null;

create index work_tasks_project_idx
  on public.work_tasks (project_id)
  where deleted_at is null;

create index work_tasks_assignee_idx
  on public.work_tasks (assignee_person_id)
  where deleted_at is null;

create index work_tasks_parent_idx
  on public.work_tasks (parent_task_id)
  where deleted_at is null;

create index work_tasks_due_date_idx
  on public.work_tasks (org_id, due_date)
  where deleted_at is null;

create trigger work_tasks_set_updated_at
  before update on public.work_tasks
  for each row execute function public.set_updated_at();

comment on table public.work_tasks is
  'Work tasks: optionally grouped under a project, optionally assigned to a '
  'person, optionally nested under a parent task (subtasks inherit the '
  'parent''s org and project; cycles rejected). Soft-deleted through '
  'crm_soft_delete(); a project hard-delete nulls project_id '
  '(ON DELETE SET NULL), a parent hard-delete cascades to subtasks. '
  'Creators may hard-delete their own tasks through the DELETE policy; '
  'ADMIN through tasks.delete.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- RLS
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The 0037 template adapted for work records: org-scoped,
-- deleted_at-excluded (where the table has one), is_active()-gated, keyed
-- on the legacy projects.* and tasks.* permission catalogue (see the header
-- — no new keys). project_members adds a self-membership arm so members can
-- see their projects' rosters and project-level managers can manage them
-- without holding the global projects.manage_members key.

alter table public.work_projects enable row level security;
alter table public.work_projects force row level security;

alter table public.project_members enable row level security;
alter table public.project_members force row level security;

alter table public.work_tasks enable row level security;
alter table public.work_tasks force row level security;

create policy work_projects_owner_all on public.work_projects
  for all to app_owner using (true) with check (true);

create policy project_members_owner_all on public.project_members
  for all to app_owner using (true) with check (true);

create policy work_tasks_owner_all on public.work_tasks
  for all to app_owner using (true) with check (true);

-- ── work_projects ──────────────────────────────────────────────────────────────

drop policy if exists work_projects_select on public.work_projects;
create policy work_projects_select on public.work_projects
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('projects.view'))
  );

drop policy if exists work_projects_insert on public.work_projects;
create policy work_projects_insert on public.work_projects
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('projects.create'))
  );

drop policy if exists work_projects_update on public.work_projects;
create policy work_projects_update on public.work_projects
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('projects.edit'))
  )
  with check (
    org_id = (select authz.org_id())
  );

-- No DELETE policy on work_projects: projects delete through
-- crm_soft_delete() only (projects.delete key, ADMIN/SUPER_ADMIN).

-- ── project_members ────────────────────────────────────────────────────────────
--
-- Members can view: a user sees membership rows for projects in their org
-- where they hold projects.view or are themselves a member. Managers can
-- manage members: INSERT/UPDATE/DELETE require the global
-- projects.manage_members key or the project-level 'manager' role on that
-- project.

drop policy if exists project_members_select on public.project_members;
create policy project_members_select on public.project_members
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (
      (select authz.has('projects.view'))
      or exists (
        select 1
        from public.project_members m
        where m.project_id = project_members.project_id
          and m.person_id = (select authz.person_id())
      )
    )
  );

drop policy if exists project_members_insert on public.project_members;
create policy project_members_insert on public.project_members
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (
      (select authz.has('projects.manage_members'))
      or exists (
        select 1
        from public.project_members m
        where m.project_id = project_members.project_id
          and m.person_id = (select authz.person_id())
          and m.role_in_project = 'manager'
      )
    )
  );

drop policy if exists project_members_update on public.project_members;
create policy project_members_update on public.project_members
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (
      (select authz.has('projects.manage_members'))
      or exists (
        select 1
        from public.project_members m
        where m.project_id = project_members.project_id
          and m.person_id = (select authz.person_id())
          and m.role_in_project = 'manager'
      )
    )
  )
  with check (
    org_id = (select authz.org_id())
  );

drop policy if exists project_members_delete on public.project_members;
create policy project_members_delete on public.project_members
  for delete to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (
      (select authz.has('projects.manage_members'))
      or exists (
        select 1
        from public.project_members m
        where m.project_id = project_members.project_id
          and m.person_id = (select authz.person_id())
          and m.role_in_project = 'manager'
      )
    )
  );

-- ── work_tasks ─────────────────────────────────────────────────────────────────

drop policy if exists work_tasks_select on public.work_tasks;
create policy work_tasks_select on public.work_tasks
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('tasks.view'))
  );

drop policy if exists work_tasks_insert on public.work_tasks;
create policy work_tasks_insert on public.work_tasks
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('tasks.create'))
  );

drop policy if exists work_tasks_update on public.work_tasks;
create policy work_tasks_update on public.work_tasks
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('tasks.edit'))
  )
  with check (
    org_id = (select authz.org_id())
  );

-- The one exception to the no-DELETE-policy convention (see the header):
-- a task's creator may hard-delete their own live task, and ADMIN may
-- delete through the tasks.delete key. The audit trigger records it.
drop policy if exists work_tasks_delete on public.work_tasks;
create policy work_tasks_delete on public.work_tasks
  for delete to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      (select authz.has('tasks.delete'))
      or created_by = (select authz.person_id())
    )
  );

-- The DELETE half of the for-all contract is revoked explicitly on the
-- tables with no DELETE policy: work_projects may never be hard-deleted by
-- the runtime roles (soft-delete through crm_soft_delete()); work_tasks
-- hard-delete is governed by the policy above, and project_members by its
-- manager-gated policy.
revoke delete on public.work_projects
  from app_user, app_admin;

-- ═════════════════════════════════════════════════════════════════════════════════
-- work_tasks_project_org_guard() — the task's project must be its org's
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- project_id is a single-column FK, so without this a task could reference
-- another org's project. The trigger closes that tenant-isolation hole with
-- 42501 before any FK check runs — the deals_pipeline_org_guard() pattern.

create or replace function public.work_tasks_project_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_org uuid;
begin
  if new.project_id is not null then
    select p.org_id into v_project_org
    from public.work_projects p
    where p.id = new.project_id;
    if v_project_org is distinct from new.org_id then
      raise exception 'project_id must belong to the task''s organization'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.work_tasks_project_org_guard() is
  'BEFORE INSERT/UPDATE on work_tasks: project_id must belong to NEW.org_id. '
  'Closes the cross-org reference hole the single-column FK leaves open; '
  'raises 42501.';

revoke all on function public.work_tasks_project_org_guard() from public;

drop trigger if exists work_tasks_project_org_guard on public.work_tasks;
create trigger work_tasks_project_org_guard
  before insert or update on public.work_tasks
  for each row execute function public.work_tasks_project_org_guard();

-- ═════════════════════════════════════════════════════════════════════════════════
-- work_tasks_assignee_org_guard() — the task's assignee must be its org's
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Same 42501 pattern: an assignee from another org is rejected before the FK
-- check runs.

create or replace function public.work_tasks_assignee_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_org uuid;
begin
  if new.assignee_person_id is not null then
    select p.org_id into v_person_org
    from public.people p
    where p.id = new.assignee_person_id;
    if v_person_org is distinct from new.org_id then
      raise exception 'assignee_person_id must belong to the task''s organization'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.work_tasks_assignee_org_guard() is
  'BEFORE INSERT/UPDATE on work_tasks: assignee_person_id must belong to '
  'NEW.org_id. Raises 42501.';

revoke all on function public.work_tasks_assignee_org_guard() from public;

drop trigger if exists work_tasks_assignee_org_guard on public.work_tasks;
create trigger work_tasks_assignee_org_guard
  before insert or update on public.work_tasks
  for each row execute function public.work_tasks_assignee_org_guard();

-- ═════════════════════════════════════════════════════════════════════════════════
-- work_tasks_parent_org_guard() — a subtask inherits its parent's org and project
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The parent must belong to the task's org (42501). Project inheritance: when
-- the parent is grouped under a project, the subtask must carry the same
-- project_id — a subtask can never escape its parent's project. (When the
-- parent itself is ungrouped, the child may be grouped independently.)

create or replace function public.work_tasks_parent_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_org uuid;
  v_parent_project uuid;
  v_ancestor uuid;
  v_depth int := 0;
begin
  if new.parent_task_id is not null then
    select t.org_id, t.project_id into v_parent_org, v_parent_project
    from public.work_tasks t
    where t.id = new.parent_task_id;
    if v_parent_org is distinct from new.org_id then
      raise exception 'parent_task_id must belong to the task''s organization'
        using errcode = '42501';
    end if;
    if v_parent_project is not null
       and v_parent_project is distinct from new.project_id then
      raise exception 'subtask must belong to the same project as its parent task'
        using errcode = '42501';
    end if;
    -- Cycle guard: the new row must not appear in its own ancestor chain,
    -- otherwise application tree traversal never terminates. The depth cap
    -- bounds the walk even if a cycle somehow predates this trigger.
    v_ancestor := new.parent_task_id;
    while v_ancestor is not null loop
      if v_ancestor = new.id then
        raise exception 'task cannot be an ancestor of itself (cycle detected)'
          using errcode = '23514';
      end if;
      v_depth := v_depth + 1;
      if v_depth > 100 then
        raise exception 'task ancestor chain exceeds 100 levels'
          using errcode = '23514';
      end if;
      select t.parent_task_id into v_ancestor
      from public.work_tasks t
      where t.id = v_ancestor;
    end loop;
  end if;
  return new;
end;
$$;

comment on function public.work_tasks_parent_org_guard() is
  'BEFORE INSERT/UPDATE on work_tasks: parent_task_id must belong to '
  'NEW.org_id, and when the parent is grouped the subtask must carry the '
  'same project_id. Walks the ancestor chain to reject cycles (23514). '
  'Raises 42501 on org/project violations.';

revoke all on function public.work_tasks_parent_org_guard() from public;

drop trigger if exists work_tasks_parent_org_guard on public.work_tasks;
create trigger work_tasks_parent_org_guard
  before insert or update on public.work_tasks
  for each row execute function public.work_tasks_parent_org_guard();

-- ═════════════════════════════════════════════════════════════════════════════════
-- project_members_project_org_guard() — the membership's project must be its org's
-- ═════════════════════════════════════════════════════════════════════════════════

create or replace function public.project_members_project_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_org uuid;
begin
  select p.org_id into v_project_org
  from public.work_projects p
  where p.id = new.project_id;
  if v_project_org is distinct from new.org_id then
    raise exception 'project_id must belong to the membership''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.project_members_project_org_guard() is
  'BEFORE INSERT/UPDATE on project_members: project_id must belong to '
  'NEW.org_id. Raises 42501.';

revoke all on function public.project_members_project_org_guard() from public;

drop trigger if exists project_members_project_org_guard on public.project_members;
create trigger project_members_project_org_guard
  before insert or update on public.project_members
  for each row execute function public.project_members_project_org_guard();

-- ═════════════════════════════════════════════════════════════════════════════════
-- project_members_person_org_guard() — the member must belong to the org
-- ═════════════════════════════════════════════════════════════════════════════════

create or replace function public.project_members_person_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_org uuid;
begin
  select p.org_id into v_person_org
  from public.people p
  where p.id = new.person_id;
  if v_person_org is distinct from new.org_id then
    raise exception 'person_id must belong to the membership''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.project_members_person_org_guard() is
  'BEFORE INSERT/UPDATE on project_members: person_id must belong to '
  'NEW.org_id. Raises 42501.';

revoke all on function public.project_members_person_org_guard() from public;

drop trigger if exists project_members_person_org_guard on public.project_members;
create trigger project_members_person_org_guard
  before insert or update on public.project_members
  for each row execute function public.project_members_person_org_guard();

-- ═════════════════════════════════════════════════════════════════════════════════
-- work_projects_deal_org_guard() — the project's deal must be its org's
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- deal_id is a single-column FK, so without this a project could reference
-- another org's deal. The trigger closes that tenant-isolation hole with
-- 42501 before any FK check runs — the deals_pipeline_org_guard() pattern.

create or replace function public.work_projects_deal_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal_org uuid;
begin
  if new.deal_id is not null then
    select d.org_id into v_deal_org
    from public.deals d
    where d.id = new.deal_id;
    if v_deal_org is distinct from new.org_id then
      raise exception 'deal_id must belong to the project''s organization'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.work_projects_deal_org_guard() is
  'BEFORE INSERT/UPDATE on work_projects: deal_id must belong to NEW.org_id. '
  'Closes the cross-org reference hole the single-column FK leaves open; '
  'raises 42501.';

revoke all on function public.work_projects_deal_org_guard() from public;

drop trigger if exists work_projects_deal_org_guard on public.work_projects;
create trigger work_projects_deal_org_guard
  before insert or update on public.work_projects
  for each row execute function public.work_projects_deal_org_guard();

-- ═════════════════════════════════════════════════════════════════════════════════
-- audit — HIGH, whole-row (Task 1.11)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The same compensating control 0033 attached to the CRM records: task
-- assignment, project membership and project changes are access-affecting.

drop trigger if exists work_projects_audit on public.work_projects;
create trigger work_projects_audit
  after insert or update or delete on public.work_projects
  for each row execute function public.audit_row_change('work_project', 'HIGH', 'id');

drop trigger if exists project_members_audit on public.project_members;
create trigger project_members_audit
  after insert or update or delete on public.project_members
  for each row execute function public.audit_row_change('project_member', 'HIGH', 'id');

drop trigger if exists work_tasks_audit on public.work_tasks;
create trigger work_tasks_audit
  after insert or update or delete on public.work_tasks
  for each row execute function public.audit_row_change('work_task', 'HIGH', 'id');

-- ═════════════════════════════════════════════════════════════════════════════════
-- crm_soft_delete(): the runtime soft-delete path gains work records
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The 0037 function, unchanged except for the new allowlist mappings:
-- 'work_project' → work_projects, 'work_task' → work_tasks, plus the 'task'
-- → work_tasks alias the work-tasks API DELETE endpoint calls.
-- Migration 0037 itself is never edited; it is already applied. The M1
-- in-function delete-permission probe covers the new entities:
-- projects.delete / tasks.delete are catalogue keys now seeded to ADMIN at
-- GLOBAL (and held by SUPER_ADMIN through the cross join), so the probe
-- resolves there and fail-closes everywhere else.

create or replace function public.crm_soft_delete(p_entity text, p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_perm text;
  v_n bigint;
begin
  v_table := case p_entity
    when 'company' then 'companies'
    when 'contact' then 'contacts'
    when 'deal' then 'deals'
    when 'activity' then 'activities'
    when 'company_contact' then 'company_contacts'
    when 'company_link' then 'company_links'
    when 'contact_link' then 'contact_links'
    when 'pipeline' then 'pipelines'
    when 'work_project' then 'work_projects'
    when 'work_task' then 'work_tasks'
    -- API alias: the work-tasks DELETE endpoint calls crm_soft_delete('task').
    when 'task' then 'work_tasks'
  end;
  v_perm := case p_entity
    when 'company' then 'companies.delete'
    when 'contact' then 'contacts.delete'
    when 'deal' then 'deals.delete'
    when 'activity' then 'activities.delete'
    when 'company_contact' then 'company_contacts.delete'
    when 'company_link' then 'company_links.delete'
    when 'contact_link' then 'contact_links.delete'
    when 'pipeline' then 'pipelines.delete'
    when 'work_project' then 'projects.delete'
    when 'work_task' then 'tasks.delete'
    when 'task' then 'tasks.delete'
  end;
  if v_table is null then
    raise exception 'unknown soft-delete entity: %', p_entity using errcode = '42501';
  end if;
  -- M1: fail closed unless the caller holds the delete permission. This is
  -- defense-in-depth: the service layer already probes edit rights, but a
  -- SECURITY DEFINER function granted to app_user must not rely on callers
  -- to enforce the permission.
  if not (select authz.has(v_perm)) then
    raise exception 'missing delete permission for %', p_entity using errcode = '42501';
  end if;
  -- Phase 4: a pipeline with live deals cannot be soft-deleted. The caller must
  -- move or close the deals first. The guard is scoped to the caller's org so
  -- a foreign pipeline still raises 02000 (no tenant leak) via the probe below.
  if p_entity = 'pipeline' then
    if exists (
      select 1 from public.deals d
      where d.pipeline_id = p_id
        and d.org_id = (select authz.org_id())
        and d.deleted_at is null
    ) then
      raise exception 'pipeline has live deals' using errcode = '42501';
    end if;
  end if;
  execute format(
    'update public.%I set deleted_at = now(), updated_at = now() '
    'where id = $1 and org_id = authz.org_id() and deleted_at is null',
    v_table
  ) using p_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    -- The service already proved edit rights on this row in this transaction;
    -- reaching here means the row vanished or left the caller's org.
    raise exception 'soft delete affected no rows' using errcode = '02000';
  end if;
end;
$$;

revoke all on function public.crm_soft_delete(text, uuid) from public;
grant execute on function public.crm_soft_delete(text, uuid) to app_user;

-- ═════════════════════════════════════════════════════════════════════════════════
-- Permission grants — the work-management keys reach the matrix
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The 0008 catalogue seeded tasks.create, tasks.delete, tasks.comment and
-- projects.delete but granted them to ZERO roles. The grants below are the
-- deliberate model documented in the header. seed_system_roles() is recreated
-- with the 0037 body plus the Phase 4 rows (0037's pattern: the earlier
-- migration is never edited), so organizations created from here on get the
-- grants; the backfill below covers organizations that already exist.

create or replace function public.seed_system_roles(p_org_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.roles (org_id, key, name, description, is_system, is_protected)
  values
    -- is_protected is true for SUPER_ADMIN alone, and it is not a judgement about
    -- seniority: it is the mechanical consequence of blueprint 6.2, which defines a
    -- protected role as one carrying roles.manage or permissions.manage. The matrix
    -- grants those to SUPER_ADMIN and to nobody else.
    (p_org_id, 'SUPER_ADMIN',     'Super Administrator', 'Full access, including role and permission management and security settings', true, true),
    (p_org_id, 'ADMIN',           'Administrator',       'Operational administration. Deliberately NOT a superset of HR: no identity documents, no compensation', true, false),
    (p_org_id, 'HR_ADMIN',        'HR Administrator',    'Full people, HR and hiring administration. No sales pipeline and no audit log', true, false),
    (p_org_id, 'HR_MANAGER',      'HR Manager',          'People and HR administration within their own departments', true, false),
    (p_org_id, 'MANAGER',         'Manager',             'Line management. No permissions are seeded: the architecture defines no matrix column for this role', true, false),
    (p_org_id, 'SALES_MANAGER',   'Sales Manager',       'Sales and delivery leadership across their departments', true, false),
    (p_org_id, 'SALES',           'Sales',               'Own leads, own clients, own tasks', true, false),
    (p_org_id, 'PROJECT_MANAGER', 'Project Manager',     'Projects, tasks and delivery within their departments', true, false),
    (p_org_id, 'DEVELOPER',       'Developer',           'The projects they are assigned to, and their own profile', true, false),
    (p_org_id, 'VIBECODER',       'Vibecoder',           'The projects they are assigned to, and nothing wider', true, false),
    (p_org_id, 'FINANCE',         'Finance',             'Commercial and compensation data. A separate boundary from HR, not a subset of it', true, false),
    (p_org_id, 'MARKETING',       'Marketing',           'No permissions are seeded: the architecture defines no matrix column for this role', true, false),
    (p_org_id, 'INTERN',          'Intern',              'Self and assigned projects only. The legal classification lives on the engagement, never here', true, false),
    (p_org_id, 'EMPLOYEE',        'Employee',            'The baseline every active engagement receives. Self-service only', true, false)
  on conflict do nothing;

  -- SUPER_ADMIN: the whole catalogue at GLOBAL, minus the one permission V1 does not
  -- implement.
  insert into public.role_permissions (role_id, permission_id, scope)
  select r.id, p.id, 'GLOBAL'::public.access_scope
  from public.roles r
  cross join public.permissions p
  where r.org_id = p_org_id
    and r.key = 'SUPER_ADMIN'
    and p.key <> 'users.impersonate'
  on conflict do nothing;

  insert into public.role_permissions (role_id, permission_id, scope)
  select r.id, p.id, m.scope::public.access_scope
  from (values
    -- ADMIN
    ('ADMIN','users.view','GLOBAL'),('ADMIN','users.create','GLOBAL'),
    ('ADMIN','users.suspend','GLOBAL'),('ADMIN','sessions.revoke','GLOBAL'),
    ('ADMIN','departments.manage','GLOBAL'),
    ('ADMIN','people.view','GLOBAL'),('ADMIN','people.edit','GLOBAL'),('ADMIN','people.export','GLOBAL'),
    ('ADMIN','engagements.transition','GLOBAL'),
    ('ADMIN','candidates.view','GLOBAL'),('ADMIN','offers.approve','GLOBAL'),
    ('ADMIN','onboarding.manage','GLOBAL'),('ADMIN','offboarding.initiate','GLOBAL'),
    ('ADMIN','projects.view','GLOBAL'),('ADMIN','projects.create','GLOBAL'),
    ('ADMIN','projects.edit','GLOBAL'),('ADMIN','projects.manage_members','GLOBAL'),
    ('ADMIN','tasks.view','GLOBAL'),('ADMIN','tasks.edit','GLOBAL'),('ADMIN','tasks.assign','GLOBAL'),
    ('ADMIN','documents.view','GLOBAL'),('ADMIN','documents.upload','GLOBAL'),('ADMIN','documents.download','GLOBAL'),
    ('ADMIN','policies.manage','GLOBAL'),('ADMIN','policies.acknowledge','SELF'),
    ('ADMIN','policies.view_compliance','GLOBAL'),
    ('ADMIN','reports.view','GLOBAL'),('ADMIN','audit_logs.view','GLOBAL'),('ADMIN','settings.manage','GLOBAL'),

    -- HR_ADMIN
    ('HR_ADMIN','users.view','GLOBAL'),('HR_ADMIN','users.create','GLOBAL'),
    ('HR_ADMIN','users.suspend','DEPARTMENT'),('HR_ADMIN','sessions.revoke','DEPARTMENT'),
    ('HR_ADMIN','departments.manage','GLOBAL'),
    ('HR_ADMIN','people.view','GLOBAL'),('HR_ADMIN','people.edit','GLOBAL'),('HR_ADMIN','people.export','GLOBAL'),
    ('HR_ADMIN','hr.sensitive.view','GLOBAL'),('HR_ADMIN','compensation.view','GLOBAL'),
    ('HR_ADMIN','engagements.transition','GLOBAL'),
    ('HR_ADMIN','candidates.view','GLOBAL'),('HR_ADMIN','scorecards.view_all','GLOBAL'),
    ('HR_ADMIN','offers.approve','GLOBAL'),
    ('HR_ADMIN','onboarding.manage','GLOBAL'),('HR_ADMIN','offboarding.initiate','GLOBAL'),
    ('HR_ADMIN','documents.view','GLOBAL'),('HR_ADMIN','documents.upload','GLOBAL'),
    ('HR_ADMIN','documents.download','GLOBAL'),('HR_ADMIN','documents.verify','GLOBAL'),
    ('HR_ADMIN','policies.manage','GLOBAL'),('HR_ADMIN','policies.acknowledge','SELF'),
    ('HR_ADMIN','policies.view_compliance','GLOBAL'),('HR_ADMIN','reports.view','GLOBAL'),

    -- HR_MANAGER
    ('HR_MANAGER','users.view','DEPARTMENT'),
    ('HR_MANAGER','people.view','DEPARTMENT'),('HR_MANAGER','people.edit','DEPARTMENT'),
    ('HR_MANAGER','hr.sensitive.view','DEPARTMENT'),
    ('HR_MANAGER','engagements.transition','DEPARTMENT'),
    ('HR_MANAGER','candidates.view','GLOBAL'),('HR_MANAGER','scorecards.view_all','GLOBAL'),
    ('HR_MANAGER','onboarding.manage','DEPARTMENT'),('HR_MANAGER','offboarding.initiate','DEPARTMENT'),
    ('HR_MANAGER','documents.view','DEPARTMENT'),('HR_MANAGER','documents.upload','DEPARTMENT'),
    ('HR_MANAGER','documents.download','DEPARTMENT'),('HR_MANAGER','documents.verify','DEPARTMENT'),
    ('HR_MANAGER','policies.acknowledge','SELF'),('HR_MANAGER','policies.view_compliance','DEPARTMENT'),
    ('HR_MANAGER','reports.view','DEPARTMENT'),

    -- SALES_MANAGER
    ('SALES_MANAGER','people.view','DEPARTMENT'),
    ('SALES_MANAGER','candidates.view','DEPARTMENT'),('SALES_MANAGER','scorecards.view_all','DEPARTMENT'),
    ('SALES_MANAGER','onboarding.manage','DEPARTMENT'),('SALES_MANAGER','offboarding.initiate','DEPARTMENT'),
    ('SALES_MANAGER','projects.view','DEPARTMENT'),('SALES_MANAGER','projects.create','DEPARTMENT'),
    ('SALES_MANAGER','projects.edit','DEPARTMENT'),('SALES_MANAGER','projects.manage_members','DEPARTMENT'),
    ('SALES_MANAGER','tasks.view','DEPARTMENT'),('SALES_MANAGER','tasks.edit','DEPARTMENT'),
    ('SALES_MANAGER','tasks.assign','DEPARTMENT'),
    ('SALES_MANAGER','documents.view','DEPARTMENT'),('SALES_MANAGER','documents.upload','DEPARTMENT'),
    ('SALES_MANAGER','documents.download','DEPARTMENT'),
    ('SALES_MANAGER','policies.acknowledge','SELF'),('SALES_MANAGER','policies.view_compliance','DEPARTMENT'),
    ('SALES_MANAGER','reports.view','DEPARTMENT'),

    -- SALES. tasks.view / tasks.edit are the matrix S+P cells; see the note above.
    ('SALES','people.view','SELF'),('SALES','people.edit','SELF'),
    ('SALES','projects.view','SELF'),
    ('SALES','tasks.view','SELF'),('SALES','tasks.edit','SELF'),
    ('SALES','documents.view','SELF'),('SALES','documents.upload','SELF'),('SALES','documents.download','SELF'),
    ('SALES','policies.acknowledge','SELF'),('SALES','reports.view','SELF'),

    -- PROJECT_MANAGER
    ('PROJECT_MANAGER','people.view','DEPARTMENT'),
    ('PROJECT_MANAGER','candidates.view','DEPARTMENT'),('PROJECT_MANAGER','scorecards.view_all','DEPARTMENT'),
    ('PROJECT_MANAGER','onboarding.manage','DEPARTMENT'),('PROJECT_MANAGER','offboarding.initiate','DEPARTMENT'),
    ('PROJECT_MANAGER','clients.view','DEPARTMENT'),('PROJECT_MANAGER','clients.edit','DEPARTMENT'),
    ('PROJECT_MANAGER','projects.view','DEPARTMENT'),('PROJECT_MANAGER','projects.create','DEPARTMENT'),
    ('PROJECT_MANAGER','projects.edit','DEPARTMENT'),('PROJECT_MANAGER','projects.manage_members','DEPARTMENT'),
    ('PROJECT_MANAGER','tasks.view','DEPARTMENT'),('PROJECT_MANAGER','tasks.edit','DEPARTMENT'),
    ('PROJECT_MANAGER','tasks.assign','DEPARTMENT'),
    ('PROJECT_MANAGER','documents.view','DEPARTMENT'),('PROJECT_MANAGER','documents.upload','DEPARTMENT'),
    ('PROJECT_MANAGER','documents.download','DEPARTMENT'),
    ('PROJECT_MANAGER','policies.acknowledge','SELF'),('PROJECT_MANAGER','policies.view_compliance','DEPARTMENT'),
    ('PROJECT_MANAGER','reports.view','DEPARTMENT'),

    -- DEVELOPER
    ('DEVELOPER','people.view','SELF'),('DEVELOPER','people.edit','SELF'),
    ('DEVELOPER','clients.view','PROJECT'),
    ('DEVELOPER','projects.view','PROJECT'),('DEVELOPER','projects.edit','PROJECT'),
    ('DEVELOPER','tasks.view','PROJECT'),('DEVELOPER','tasks.edit','PROJECT'),('DEVELOPER','tasks.assign','PROJECT'),
    ('DEVELOPER','documents.view','SELF'),('DEVELOPER','documents.upload','SELF'),('DEVELOPER','documents.download','SELF'),
    ('DEVELOPER','policies.acknowledge','SELF'),('DEVELOPER','reports.view','PROJECT'),

    -- VIBECODER
    ('VIBECODER','people.view','SELF'),('VIBECODER','people.edit','SELF'),
    ('VIBECODER','clients.view','PROJECT'),('VIBECODER','projects.view','PROJECT'),
    ('VIBECODER','tasks.view','PROJECT'),('VIBECODER','tasks.edit','PROJECT'),
    ('VIBECODER','documents.view','SELF'),('VIBECODER','documents.upload','SELF'),('VIBECODER','documents.download','SELF'),
    ('VIBECODER','policies.acknowledge','SELF'),

    -- INTERN
    ('INTERN','people.view','SELF'),('INTERN','people.edit','SELF'),
    ('INTERN','hr.sensitive.view','SELF'),
    ('INTERN','clients.view','PROJECT'),('INTERN','projects.view','PROJECT'),
    ('INTERN','tasks.view','SELF'),('INTERN','tasks.edit','SELF'),
    ('INTERN','documents.view','SELF'),('INTERN','documents.upload','SELF'),('INTERN','documents.download','SELF'),
    ('INTERN','policies.acknowledge','SELF'),

    -- FINANCE
    ('FINANCE','people.view','SELF'),('FINANCE','people.edit','SELF'),
    ('FINANCE','compensation.view','GLOBAL'),
    ('FINANCE','clients.view','GLOBAL'),('FINANCE','projects.view','GLOBAL'),
    ('FINANCE','documents.view','GLOBAL'),('FINANCE','documents.upload','GLOBAL'),('FINANCE','documents.download','GLOBAL'),
    ('FINANCE','policies.acknowledge','SELF'),('FINANCE','reports.view','GLOBAL'),

    -- EMPLOYEE
    ('EMPLOYEE','people.view','SELF'),('EMPLOYEE','people.edit','SELF'),
    ('EMPLOYEE','hr.sensitive.view','SELF'),('EMPLOYEE','compensation.view','SELF'),
    ('EMPLOYEE','tasks.view','SELF'),('EMPLOYEE','tasks.edit','SELF'),
    ('EMPLOYEE','documents.view','SELF'),('EMPLOYEE','documents.upload','SELF'),('EMPLOYEE','documents.download','SELF'),
    ('EMPLOYEE','policies.acknowledge','SELF'),

    -- ── Phase 2 CRM Core (migration 0033): the crm module replaces the legacy
    -- sales vocabulary. ADMIN/SALES_MANAGER/SALES get the new keys at the same
    -- scopes the matrix already uses for leads.* / clients.*.
    -- ADMIN
    ('ADMIN','companies.view','GLOBAL'),('ADMIN','companies.create','GLOBAL'),
    ('ADMIN','companies.edit','GLOBAL'),('ADMIN','companies.delete','GLOBAL'),
    ('ADMIN','contacts.view','GLOBAL'),('ADMIN','contacts.create','GLOBAL'),
    ('ADMIN','contacts.edit','GLOBAL'),('ADMIN','contacts.delete','GLOBAL'),
    ('ADMIN','contacts.export','GLOBAL'),
    ('ADMIN','deals.view','GLOBAL'),('ADMIN','deals.create','GLOBAL'),
    ('ADMIN','deals.edit','GLOBAL'),('ADMIN','deals.delete','GLOBAL'),
    ('ADMIN','deals.export','GLOBAL'),
    -- SALES_MANAGER
    ('SALES_MANAGER','companies.view','DEPARTMENT'),('SALES_MANAGER','companies.create','DEPARTMENT'),
    ('SALES_MANAGER','companies.edit','DEPARTMENT'),('SALES_MANAGER','companies.delete','DEPARTMENT'),
    ('SALES_MANAGER','contacts.view','DEPARTMENT'),('SALES_MANAGER','contacts.create','DEPARTMENT'),
    ('SALES_MANAGER','contacts.edit','DEPARTMENT'),('SALES_MANAGER','contacts.delete','DEPARTMENT'),
    ('SALES_MANAGER','contacts.export','DEPARTMENT'),
    ('SALES_MANAGER','deals.view','DEPARTMENT'),('SALES_MANAGER','deals.create','DEPARTMENT'),
    ('SALES_MANAGER','deals.edit','DEPARTMENT'),('SALES_MANAGER','deals.delete','DEPARTMENT'),
    ('SALES_MANAGER','deals.export','DEPARTMENT'),
    -- SALES (SELF on view/create/edit only — mirrors the leads.* SELF column:
    -- no delete, no export, no assign)
    ('SALES','companies.view','SELF'),('SALES','companies.create','SELF'),
    ('SALES','companies.edit','SELF'),
    ('SALES','contacts.view','SELF'),('SALES','contacts.create','SELF'),
    ('SALES','contacts.edit','SELF'),
    ('SALES','deals.view','SELF'),('SALES','deals.create','SELF'),
    ('SALES','deals.edit','SELF'),
    -- ── Track B: activities + relationships (migration 0034). The catalogue keys are
    -- seeded above; the matrix below grants them at the same scopes as the CRM
    -- Core rows: ADMIN at GLOBAL, SALES_MANAGER at DEPARTMENT, SALES at SELF on
    -- view/create/edit only (mirroring the leads.* SELF column: no delete).
    -- ADMIN
    ('ADMIN','activities.view','GLOBAL'),('ADMIN','activities.create','GLOBAL'),
    ('ADMIN','activities.edit','GLOBAL'),('ADMIN','activities.delete','GLOBAL'),
    ('ADMIN','relationships.view','GLOBAL'),('ADMIN','relationships.create','GLOBAL'),
    ('ADMIN','relationships.edit','GLOBAL'),('ADMIN','relationships.delete','GLOBAL'),
    -- SALES_MANAGER
    ('SALES_MANAGER','activities.view','DEPARTMENT'),('SALES_MANAGER','activities.create','DEPARTMENT'),
    ('SALES_MANAGER','activities.edit','DEPARTMENT'),('SALES_MANAGER','activities.delete','DEPARTMENT'),
    ('SALES_MANAGER','relationships.view','DEPARTMENT'),('SALES_MANAGER','relationships.create','DEPARTMENT'),
    ('SALES_MANAGER','relationships.edit','DEPARTMENT'),('SALES_MANAGER','relationships.delete','DEPARTMENT'),
    -- SALES (SELF on view/create/edit only — mirrors the leads.* SELF column)
    ('SALES','activities.view','SELF'),('SALES','activities.create','SELF'),
    ('SALES','activities.edit','SELF'),
    ('SALES','relationships.view','SELF'),('SALES','relationships.create','SELF'),
    ('SALES','relationships.edit','SELF'),
    -- ── Phase 3 sales pipeline (migration 0037): pipeline configuration is an
    -- admin surface. ADMIN holds the five keys at GLOBAL; SUPER_ADMIN gets them
    -- through the whole-catalogue cross join above. No other role is granted
    -- pipeline keys.
    -- ADMIN
    ('ADMIN','pipelines.view','GLOBAL'),('ADMIN','pipelines.create','GLOBAL'),
    ('ADMIN','pipelines.edit','GLOBAL'),('ADMIN','pipelines.delete','GLOBAL'),
    ('ADMIN','pipeline_stages.manage','GLOBAL'),
    -- ── Phase 4 work management (migration 0042): the work tables are an
    -- operational surface, not an admin surface like pipelines. MANAGER gains
    -- the project and task keys at DEPARTMENT (line management — the 0008
    -- matrix seeded MANAGER no permissions at all); ADMIN gains
    -- projects.delete and tasks.delete at GLOBAL; tasks.create rides with
    -- tasks.view at each role's existing scope, so no role gains task
    -- visibility it did not already hold. tasks.delete is deliberately NOT
    -- seeded to non-admin roles: creators delete through the work_tasks
    -- DELETE RLS policy, not through a seed grant. tasks.comment stays
    -- ungranted (fail closed) until the comments feature lands.
    -- MANAGER
    ('MANAGER','projects.view','DEPARTMENT'),('MANAGER','projects.create','DEPARTMENT'),
    ('MANAGER','projects.edit','DEPARTMENT'),
    ('MANAGER','tasks.view','DEPARTMENT'),('MANAGER','tasks.create','DEPARTMENT'),
    ('MANAGER','tasks.edit','DEPARTMENT'),
    -- ADMIN
    ('ADMIN','projects.delete','GLOBAL'),
    ('ADMIN','tasks.create','GLOBAL'),('ADMIN','tasks.delete','GLOBAL'),
    -- tasks.create rides alongside tasks.view at each role's existing scope
    ('SALES_MANAGER','tasks.create','DEPARTMENT'),
    ('PROJECT_MANAGER','tasks.create','DEPARTMENT'),
    ('DEVELOPER','tasks.create','PROJECT'),
    ('VIBECODER','tasks.create','PROJECT'),
    ('INTERN','tasks.create','SELF'),
    ('SALES','tasks.create','SELF'),
    ('EMPLOYEE','tasks.create','SELF')
  ) as m(role_key, permission_key, scope)
  join public.roles r on r.org_id = p_org_id and r.key = m.role_key
  join public.permissions p on p.key = m.permission_key
  on conflict do nothing;
end;
$$;

-- ── Backfill: existing organizations ──────────────────────────────────────────
--
-- The protection trigger guards runtime changes to the authorization model, which
-- a migration is not, so it is disabled for the insert and re-enabled immediately
-- — the same pattern migrations 0010, 0033, 0034 and 0037 used.
--
-- 16 grants per org (MANAGER 6 + ADMIN 3 + tasks.create 7), all at the scopes
-- in the matrix. Only the new pairs are inserted — no legacy cleanup,
-- no re-seeding of existing grants (on conflict do nothing).
-- SUPER_ADMIN needs no backfill: the keys predate this migration, so the
-- original whole-catalogue cross join already granted them.

do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgname = 'role_permissions_enforce_protection'
      and tgrelid = 'public.role_permissions'::regclass
  ) then
    alter table public.role_permissions disable trigger role_permissions_enforce_protection;
  end if;
end
$$;

insert into public.role_permissions (role_id, permission_id, scope)
select r.id, p.id, m.scope::public.access_scope
from public.roles r
cross join public.permissions p
join (values
  ('MANAGER','projects.view','DEPARTMENT'),('MANAGER','projects.create','DEPARTMENT'),
  ('MANAGER','projects.edit','DEPARTMENT'),
  ('MANAGER','tasks.view','DEPARTMENT'),('MANAGER','tasks.create','DEPARTMENT'),
  ('MANAGER','tasks.edit','DEPARTMENT'),
  ('ADMIN','projects.delete','GLOBAL'),
  ('ADMIN','tasks.create','GLOBAL'),('ADMIN','tasks.delete','GLOBAL'),
  ('SALES_MANAGER','tasks.create','DEPARTMENT'),
  ('PROJECT_MANAGER','tasks.create','DEPARTMENT'),
  ('DEVELOPER','tasks.create','PROJECT'),
  ('VIBECODER','tasks.create','PROJECT'),
  ('INTERN','tasks.create','SELF'),
  ('SALES','tasks.create','SELF'),
  ('EMPLOYEE','tasks.create','SELF')
) as m(role_key, permission_key, scope)
  on r.key = m.role_key and p.key = m.permission_key
on conflict do nothing;

do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgname = 'role_permissions_enforce_protection'
      and tgrelid = 'public.role_permissions'::regclass
  ) then
    alter table public.role_permissions enable trigger role_permissions_enforce_protection;
  end if;
end
$$;

-- ── Verification ──────────────────────────────────────────────────────────────
--
-- Fail the migration rather than leave a half-seeded authorization model: all
-- 16 role/key pairs must be granted on every organization's system roles.
-- (Future orgs are covered by the recreated seed_system_roles() above; this
-- checks the orgs that already exist.)

do $$
declare
  v_missing_grants int;
begin
  select count(*) into v_missing_grants
  from public.roles r
  cross join (values
    ('MANAGER','projects.view'),('MANAGER','projects.create'),
    ('MANAGER','projects.edit'),
    ('MANAGER','tasks.view'),('MANAGER','tasks.create'),('MANAGER','tasks.edit'),
    ('ADMIN','projects.delete'),
    ('ADMIN','tasks.create'),('ADMIN','tasks.delete'),
    ('SALES_MANAGER','tasks.create'),
    ('PROJECT_MANAGER','tasks.create'),
    ('DEVELOPER','tasks.create'),
    ('VIBECODER','tasks.create'),
    ('INTERN','tasks.create'),
    ('SALES','tasks.create'),
    ('EMPLOYEE','tasks.create')
  ) as k(role_key, key)
  where r.is_system
    and r.key = k.role_key
    and not exists (
      select 1
      from public.role_permissions rp
      join public.permissions p on p.id = rp.permission_id
      where rp.role_id = r.id
        and p.key = k.key
    );
  if v_missing_grants > 0 then
    raise exception 'work-management role grants incomplete: % role/key pairs missing',
      v_missing_grants;
  end if;
end
$$;
