-- PRAVSHI OS — Phase 6: automation job system (durable job queue + scheduler).
--
-- Two tables: jobs is the durable queue backing the worker claim loop
-- (SKIP LOCKED on jobs_claim_idx); schedules holds cron-like workflow
-- schedules that the scheduler tick turns into jobs with dedup keys.
-- workflow_execution_steps gains step_key for step-level idempotency,
-- plus the two new unique indexes.
--
-- Conventions carried over from 0044:
--   Task 1.4 composite-key strategy   jobs and schedules carry
--                                      UNIQUE (org_id, id) so the tenant is
--                                      pinned on every row, exactly like
--                                      workflows/workflow_executions/
--                                      workflow_execution_steps in 0044.
--   Task 1.16 RLS template            org-scoped, is_active()-gated. Each
--                                      policy gates on authz.has('<key>')
--                                      (the permission at any scope) instead
--                                      of an owner-based scope CASE.
--   Org-guard triggers                BEFORE triggers reject a foreign-org
--                                      reference with 42501 before any FK
--                                      check runs — the
--                                      deals_pipeline_org_guard() pattern
--                                      from 0037 carried through 0044.
--   Permission seeding                catalogue keys as explicit literals
--                                      (never substring-derived), matrix
--                                      rows appended to a recreated
--                                      seed_system_roles(), backfill for
--                                      existing orgs with the protection
--                                      trigger disabled/re-enabled, and a
--                                      verification block that fails the
--                                      migration rather than leaving a
--                                      half-seeded authorization model.
--
-- DELIBERATE DEVIATIONS FROM THE §2 DDL, and why:
--   * jobs_org_dedup_uidx is a partial UNIQUE INDEX on (org_id, dedup_key)
--     WHERE dedup_key IS NOT NULL: NULL dedup keys must not collide.
--   * §2.4 writes authz.has_permission('<key>'); no such function exists —
--     the authorization function is authz.has(text) (0009, used throughout
--     0033/0042/0044). The policies use authz.has('jobs.*').
--   * The UPDATE policy gates on authz.has('jobs.retry') OR
--     authz.has('jobs.cancel'): §2.4 says "(for retry/cancel paths)" and
--     the API contract gates cancel on jobs.cancel, so both paths must be
--     admitted. Every role holding jobs.cancel also holds jobs.retry in
--     this seed, but the OR keeps the policy correct if the matrix ever
--     diverges.
--   * schedules UPDATE gates on authz.has('jobs.create'): the API contract
--     (§4.2) gates schedule update on jobs.create, not on the job
--     retry/cancel keys. "Same pattern for schedules" is read as
--     SELECT/INSERT/UPDATE keyed to the operation-relevant jobs.* keys.
--   * jobs_org_guard: jobs.org_id is a direct FK to organizations(id), so
--     there is no cross-org FK hole to close (unlike workflow_id /
--     execution_id in 0044). The trigger is defense-in-depth: it rejects a
--     NULL or dangling org_id with the same 42501 tenant-isolation error
--     code the other guards raise.
--   * The wes_execution_step_idx_uidx build is the empty-table assertion:
--     workflow_execution_steps is new in Phase 5 (0044); if duplicates of
--     (execution_id, step_index) exist the index build fails loudly and the
--     migration fails rather than silently dropping rows.
--   * No DELETE policy on jobs or schedules: jobs move through the status
--     machine ('cancelled' terminal) and schedules deactivate via is_active;
--     history purges go through a retention cleanup job, not app_user.

-- ═════════════════════════════════════════════════════════════════════════════════
-- jobs — the durable queue
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- One row per unit of background work. Workers claim with SELECT ...
-- FOR UPDATE SKIP LOCKED WHERE status='pending' AND next_run_at <= now()
-- ORDER BY priority DESC, next_run_at ASC (jobs_claim_idx exists to serve
-- exactly that). dedup_key gives enqueue-time idempotency per org.
-- Status transitions are enforced by the queue service, not by CHECK —
-- the terminal set here only constrains the vocabulary.

create table public.jobs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id),
  type          text not null
    check (type in ('workflow_run', 'scheduled_trigger', 'retry',
                    'webhook', 'cleanup', 'notification', 'email')),
  status        text not null default 'pending'
    check (status in ('pending', 'claimed', 'running', 'succeeded',
                      'failed', 'dead_letter', 'cancelled')),
  priority      int not null default 0,
  payload       jsonb not null default '{}'::jsonb,
  attempts      int not null default 0,
  max_attempts  int not null default 5,
  next_run_at   timestamptz not null default now(),
  claimed_by    text,
  claimed_at    timestamptz,
  heartbeat_at  timestamptz,
  dedup_key     text,
  error_code    text,
  error_message text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint jobs_org_id_unique unique (org_id, id)
);

--> statement-breakpoint
create unique index jobs_org_dedup_uidx on public.jobs (org_id, dedup_key)
  where dedup_key is not null;

--> statement-breakpoint
create index jobs_claim_idx on public.jobs (status, next_run_at, priority desc)
  where status = 'pending';

--> statement-breakpoint
create index jobs_org_status_idx on public.jobs (org_id, status, created_at desc);

-- ═════════════════════════════════════════════════════════════════════════════════
-- schedules — cron-like workflow schedules
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The scheduler tick scans schedules_due_idx for due active schedules and
-- enqueues one 'scheduled_trigger' job per schedule with a windowed dedup
-- key. Cron/timezone are validated by zod at the API boundary.

create table public.schedules (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id),
  workflow_id   uuid not null references public.workflows(id) on delete cascade,
  name          text not null,
  cron          text not null,
  timezone      text not null default 'UTC',
  is_active     boolean not null default true,
  last_run_at   timestamptz,
  next_run_at   timestamptz,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint schedules_org_id_unique unique (org_id, id)
);

--> statement-breakpoint
create index schedules_due_idx on public.schedules (is_active, next_run_at)
  where is_active = true;

-- ═════════════════════════════════════════════════════════════════════════════════
-- workflow_execution_steps — step-level idempotency
-- ═════════════════════════════════════════════════════════════════════════════════

alter table public.workflow_execution_steps add column step_key text;

--> statement-breakpoint
create unique index wes_execution_step_key_uidx
  on public.workflow_execution_steps (execution_id, step_key)
  where step_key is not null;

--> statement-breakpoint
create unique index wes_execution_step_idx_uidx
  on public.workflow_execution_steps (execution_id, step_index);

-- ═════════════════════════════════════════════════════════════════════════════════
-- Row-level security — the 0042/0044 template
-- ═════════════════════════════════════════════════════════════════════════════════

alter table public.jobs enable row level security;
alter table public.jobs force row level security;

alter table public.schedules enable row level security;
alter table public.schedules force row level security;

create policy jobs_owner_all on public.jobs
  for all to app_owner using (true) with check (true);

create policy schedules_owner_all on public.schedules
  for all to app_owner using (true) with check (true);

-- ── jobs ─────────────────────────────────────────────────────────────────────

drop policy if exists jobs_select on public.jobs;
create policy jobs_select on public.jobs
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('jobs.view'))
  );

--> statement-breakpoint
drop policy if exists jobs_insert on public.jobs;
create policy jobs_insert on public.jobs
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('jobs.create'))
  );

--> statement-breakpoint
drop policy if exists jobs_update on public.jobs;
create policy jobs_update on public.jobs
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and ((select authz.has('jobs.retry')) or (select authz.has('jobs.cancel')))
  )
  with check (
    org_id = (select authz.org_id())
  );

-- No DELETE policy on jobs: the status machine owns row lifecycle
-- (terminal 'cancelled'); retention purges run through a cleanup job.

-- ── schedules ────────────────────────────────────────────────────────────────

drop policy if exists schedules_select on public.schedules;
create policy schedules_select on public.schedules
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('jobs.view'))
  );

--> statement-breakpoint
drop policy if exists schedules_insert on public.schedules;
create policy schedules_insert on public.schedules
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('jobs.create'))
  );

--> statement-breakpoint
drop policy if exists schedules_update on public.schedules;
create policy schedules_update on public.schedules
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('jobs.create'))
  )
  with check (
    org_id = (select authz.org_id())
  );

-- No DELETE policy on schedules: deactivation is is_active=false;
-- workflow deletion cascades through the FK.

-- ═════════════════════════════════════════════════════════════════════════════════
-- jobs_org_guard() — the job's org must be a real organization
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- org_id is a direct FK to organizations(id), so the FK itself rejects a
-- dangling org_id. This trigger is defense-in-depth: it rejects a NULL or
-- dangling org_id with the same 42501 tenant-isolation error code the
-- cross-org guards raise, before any FK check runs.

create or replace function public.jobs_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    raise exception 'jobs.org_id must not be null'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.organizations o where o.id = new.org_id) then
    raise exception 'jobs.org_id does not reference a valid organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.jobs_org_guard() is
  'BEFORE INSERT/UPDATE on jobs: org_id must reference a valid organization. '
  'Defense-in-depth behind the FK; raises 42501.';

revoke all on function public.jobs_org_guard() from public;

drop trigger if exists jobs_org_guard on public.jobs;
create trigger jobs_org_guard
  before insert or update on public.jobs
  for each row execute function public.jobs_org_guard();

--> statement-breakpoint
-- ═════════════════════════════════════════════════════════════════════════════════
-- schedules_workflow_org_guard() — the schedule's workflow must be its org's
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- workflow_id is a single-column FK, so without this a schedule could
-- reference another org's workflow. The trigger closes that tenant-isolation
-- hole with 42501 before any FK check runs — the deals_pipeline_org_guard()
-- pattern.

create or replace function public.schedules_workflow_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workflow_org uuid;
begin
  select w.org_id into v_workflow_org
  from public.workflows w
  where w.id = new.workflow_id;
  if v_workflow_org is distinct from new.org_id then
    raise exception 'workflow_id must belong to the schedule''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.schedules_workflow_org_guard() is
  'BEFORE INSERT/UPDATE on schedules: workflow_id must belong to NEW.org_id. '
  'Closes the cross-org reference hole the single-column FK leaves open; '
  'raises 42501.';

revoke all on function public.schedules_workflow_org_guard() from public;

drop trigger if exists schedules_workflow_org_guard on public.schedules;
create trigger schedules_workflow_org_guard
  before insert or update on public.schedules
  for each row execute function public.schedules_workflow_org_guard();

--> statement-breakpoint
-- ═════════════════════════════════════════════════════════════════════════════════
-- Permission catalogue — the jobs keys
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Five keys, module 'jobs', all is_sensitive=false. Reads ride on
-- jobs.view; enqueueing and schedule management need jobs.create; job
-- recovery (retry / cancel) needs jobs.retry / jobs.cancel; jobs.delete
-- is the admin-path purge key.
--
-- DELIBERATE DEVIATION from the 0008/0037 seed shape (same as 0044):
-- resource and action are written as explicit literals instead of being
-- derived with substring(key from '...\\....'). The derived form depends on
-- the session's standard_conforming_strings for its backslash escaping; the
-- literal form is correct under either setting, and the
-- permissions_key_matches_parts CHECK constraint still proves
-- key = resource || '.' || action on every row.

insert into public.permissions (key, resource, action, module, description, is_sensitive)
values
  ('jobs.view',   'jobs', 'view',   'jobs', 'See the job queue, job history and dead-letter entries', false),
  ('jobs.create', 'jobs', 'create', 'jobs', 'Enqueue manual jobs and create automation schedules',    false),
  ('jobs.retry',  'jobs', 'retry',  'jobs', 'Retry failed and dead-letter jobs',                      false),
  ('jobs.cancel', 'jobs', 'cancel', 'jobs', 'Cancel pending, claimed or running jobs',                false),
  ('jobs.delete', 'jobs', 'delete', 'jobs', 'Purge job history (admin path only)',                    false)
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════════
-- Permission grants — the jobs keys reach the matrix
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- workflows.delete follows the 0008 projects.delete precedent: ADMIN holds it
-- at GLOBAL, SUPER_ADMIN through the cross join, no other role. jobs.delete
-- follows the same precedent. ADMIN holds the five jobs keys at GLOBAL;
-- PROJECT_MANAGER holds view/create/retry/cancel at DEPARTMENT (queue
-- operations are an operational surface inside their departments, like
-- workflows in 0044). seed_system_roles() is recreated with the 0044 body
-- plus the Phase 6 rows (0044's pattern: the earlier migration is never
-- edited), so organizations created from here on get the grants; the
-- backfill below covers organizations that already exist.

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
    -- ADMIN (Phase 5): the full workflow sextet at GLOBAL. workflows.delete
    -- is granted to ADMIN alone outside the SUPER_ADMIN cross join.
    ('ADMIN','workflows.view','GLOBAL'),('ADMIN','workflows.create','GLOBAL'),
    ('ADMIN','workflows.edit','GLOBAL'),('ADMIN','workflows.delete','GLOBAL'),
    ('ADMIN','workflows.activate','GLOBAL'),('ADMIN','workflows.execute','GLOBAL'),
    -- ADMIN (Phase 6): the full jobs quintet at GLOBAL. jobs.delete is
    -- granted to ADMIN alone outside the SUPER_ADMIN cross join — the
    -- 0008 projects.delete / 0044 workflows.delete precedent.
    ('ADMIN','jobs.view','GLOBAL'),('ADMIN','jobs.create','GLOBAL'),
    ('ADMIN','jobs.retry','GLOBAL'),('ADMIN','jobs.cancel','GLOBAL'),
    ('ADMIN','jobs.delete','GLOBAL'),

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
    -- PROJECT_MANAGER (Phase 5): build and run automations inside their
    -- departments. No workflows.delete — deletion stays on the admin path.
    ('PROJECT_MANAGER','workflows.view','DEPARTMENT'),
    ('PROJECT_MANAGER','workflows.create','DEPARTMENT'),
    ('PROJECT_MANAGER','workflows.edit','DEPARTMENT'),
    ('PROJECT_MANAGER','workflows.activate','DEPARTMENT'),
    ('PROJECT_MANAGER','workflows.execute','DEPARTMENT'),
    -- PROJECT_MANAGER (Phase 6): operate the job queue inside their
    -- departments. No jobs.delete — purges stay on the admin path.
    ('PROJECT_MANAGER','jobs.view','DEPARTMENT'),
    ('PROJECT_MANAGER','jobs.create','DEPARTMENT'),
    ('PROJECT_MANAGER','jobs.retry','DEPARTMENT'),
    ('PROJECT_MANAGER','jobs.cancel','DEPARTMENT'),

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
    ('MANAGER','policies.acknowledge','SELF'),
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
--> statement-breakpoint
-- ── Backfill: existing organizations ──────────────────────────────────────────
--
-- The protection trigger guards runtime changes to the authorization model, which
-- a migration is not, so it is disabled for the insert and re-enabled immediately
-- — the same pattern migrations 0010, 0033, 0034, 0037, 0042 and 0044 used.
--
-- 14 grants per org (SUPER_ADMIN 5 + ADMIN 5 + PROJECT_MANAGER 4), all at the scopes
-- in the matrix. Only the new pairs are inserted — no legacy cleanup,
-- no re-seeding of existing grants (on conflict do nothing).
-- SUPER_ADMIN is backfilled explicitly because the five catalogue keys are new in
-- this migration: the original whole-catalogue cross join granted only the keys
-- that existed when each org was seeded.

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

--> statement-breakpoint
insert into public.role_permissions (role_id, permission_id, scope)
select r.id, p.id, m.scope::public.access_scope
from public.roles r
cross join public.permissions p
join (values
  ('SUPER_ADMIN','jobs.view','GLOBAL'),('SUPER_ADMIN','jobs.create','GLOBAL'),
  ('SUPER_ADMIN','jobs.retry','GLOBAL'),('SUPER_ADMIN','jobs.cancel','GLOBAL'),
  ('SUPER_ADMIN','jobs.delete','GLOBAL'),
  ('ADMIN','jobs.view','GLOBAL'),('ADMIN','jobs.create','GLOBAL'),
  ('ADMIN','jobs.retry','GLOBAL'),('ADMIN','jobs.cancel','GLOBAL'),
  ('ADMIN','jobs.delete','GLOBAL'),
  ('PROJECT_MANAGER','jobs.view','DEPARTMENT'),
  ('PROJECT_MANAGER','jobs.create','DEPARTMENT'),
  ('PROJECT_MANAGER','jobs.retry','DEPARTMENT'),
  ('PROJECT_MANAGER','jobs.cancel','DEPARTMENT')
) as m(role_key, permission_key, scope)
  on r.key = m.role_key and p.key = m.permission_key
on conflict do nothing;

--> statement-breakpoint
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

--> statement-breakpoint
-- ═════════════════════════════════════════════════════════════════════════════════
-- jobs_claim_next() — the worker-plane claim privilege path (contract §3.2)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The claim loop runs on the worker plane: there is no per-request identity,
-- so a worker cannot satisfy the org-scoped RLS policies with authz.org_id().
-- This SECURITY DEFINER function is the ONLY cross-org claim path: RLS is
-- FORCED on public.jobs, so an app_user session cannot claim through plain
-- SQL — it can only call this function, which performs exactly one claim:
-- the highest-priority due pending job (the jobs_claim_idx scan order).
--
-- Deliberately takes NO org_id argument: the worker learns the org from the
-- claimed row (actor authority rule, contract §3.6 — org_id comes from the
-- job row, never from a caller-supplied value). p_types NULL claims any
-- type; otherwise the worker filters by the types it handles. Returns the
-- claimed jobs row, or NULL when no claimable job exists.
--
-- Follows the Phase 5 workflow_record_execution() pattern from 0044:
--   language plpgsql security definer set search_path = '',
--   every relation schema-qualified (public.jobs), revoke all from PUBLIC,
--   grant EXECUTE to app_user only.

drop function if exists public.jobs_claim_next(text, text[]);

create or replace function public.jobs_claim_next(
  p_worker_id text,
  p_types text[]
) returns public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
begin
  with candidate as (
    select id
    from public.jobs
    where status = 'pending'
      and next_run_at <= now()
      and (p_types is null or type = any(p_types))
    order by priority desc, next_run_at asc
    limit 1
    for update skip locked
  )
  update public.jobs j
  set status = 'claimed',
      claimed_by = p_worker_id,
      claimed_at = now(),
      heartbeat_at = now(),
      updated_at = now()
  from candidate c
  where j.id = c.id
  returning j.* into v_job;
  return v_job;
end;
$$;

comment on function public.jobs_claim_next(text, text[]) is
  'SECURITY DEFINER: worker-plane claim path. Claims the highest-priority due '
  'pending job (optional type filter; NULL p_types claims any type) and returns '
  'the row with status=''claimed'' stamped with the worker id. Returns NULL when '
  'no claimable job exists. Takes no org_id: the worker learns org from the '
  'claimed row. RLS is FORCED on public.jobs, so this function is the only '
  'claim path.';

revoke all on function public.jobs_claim_next(text, text[]) from public;
grant execute on function public.jobs_claim_next(text, text[]) to app_user;

--> statement-breakpoint
-- ═════════════════════════════════════════════════════════════════════════════════
-- Verification
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Fail the migration rather than leave a half-seeded authorization model: all
-- five catalogue keys must exist, and every org's SUPER_ADMIN and ADMIN system
-- roles must hold all five grants while PROJECT_MANAGER holds the four
-- non-delete keys. (Future orgs are covered by the recreated
-- seed_system_roles() above; this checks the orgs that already exist.)
--
-- Also asserts the migration's own DDL: both tables exist with RLS enabled
-- and FORCED, all three required indexes exist, step_key was added, the
-- two new unique indexes on workflow_execution_steps exist, and the
-- worker-plane claim function exists as SECURITY DEFINER with EXECUTE
-- granted to app_user only (never to PUBLIC).

do $$
declare
  v_missing_keys int;
  v_missing_grants int;
  v_ddl_problems text;
begin
  select count(*) into v_missing_keys
  from (values
    ('jobs.view'),
    ('jobs.create'),
    ('jobs.retry'),
    ('jobs.cancel'),
    ('jobs.delete')
  ) as k(key)
  where not exists (
    select 1 from public.permissions p where p.key = k.key
  );
  if v_missing_keys > 0 then
    raise exception 'jobs permission catalogue incomplete: % of 5 keys missing',
      v_missing_keys;
  end if;

  select count(*) into v_missing_grants
  from public.roles r
  cross join (values
    ('SUPER_ADMIN','jobs.view'),('SUPER_ADMIN','jobs.create'),
    ('SUPER_ADMIN','jobs.retry'),('SUPER_ADMIN','jobs.cancel'),
    ('SUPER_ADMIN','jobs.delete'),
    ('ADMIN','jobs.view'),('ADMIN','jobs.create'),
    ('ADMIN','jobs.retry'),('ADMIN','jobs.cancel'),
    ('ADMIN','jobs.delete'),
    ('PROJECT_MANAGER','jobs.view'),('PROJECT_MANAGER','jobs.create'),
    ('PROJECT_MANAGER','jobs.retry'),('PROJECT_MANAGER','jobs.cancel')
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
    raise exception 'jobs role grants incomplete: % role/key pairs missing',
      v_missing_grants;
  end if;

  select string_agg(problem, '; ') into v_ddl_problems
  from (values
    ('jobs table missing',
      (select count(*) from pg_tables where schemaname = 'public' and tablename = 'jobs') = 1),
    ('schedules table missing',
      (select count(*) from pg_tables where schemaname = 'public' and tablename = 'schedules') = 1),
    ('jobs RLS not forced',
      coalesce((select relrowsecurity and relforcerowsecurity from pg_class where relname = 'jobs'), false)),
    ('schedules RLS not forced',
      coalesce((select relrowsecurity and relforcerowsecurity from pg_class where relname = 'schedules'), false)),
    ('jobs_org_dedup_uidx missing',
      exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'jobs_org_dedup_uidx')),
    ('jobs_claim_idx missing',
      exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'jobs_claim_idx')),
    ('jobs_org_status_idx missing',
      exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'jobs_org_status_idx')),
    ('schedules_due_idx missing',
      exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'schedules_due_idx')),
    ('workflow_execution_steps.step_key missing',
      exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'workflow_execution_steps'
                and column_name = 'step_key')),
    ('wes_execution_step_key_uidx missing',
      exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'wes_execution_step_key_uidx')),
    ('wes_execution_step_idx_uidx missing',
      exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'wes_execution_step_idx_uidx')),
    ('jobs_claim_next function missing',
      exists (select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'jobs_claim_next')),
    ('jobs_claim_next not security definer',
      coalesce((select p.prosecdef from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'jobs_claim_next'), false)),
    ('jobs_claim_next not executable by app_user',
      coalesce((select has_function_privilege('app_user', p.oid, 'EXECUTE') from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'jobs_claim_next'), false)),
    ('jobs_claim_next executable by PUBLIC',
      not exists (
        select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(p.proacl) a
        where n.nspname = 'public' and p.proname = 'jobs_claim_next'
          and a.grantee = 0 and a.privilege_type = 'EXECUTE'
      ))
  ) as checks(problem, ok)
  where not ok;
  if v_ddl_problems is not null then
    raise exception 'jobs migration DDL verification failed: %', v_ddl_problems;
  end if;
end
$$;
