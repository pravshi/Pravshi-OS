-- PRAVSHI OS — Phase 8: Search & Notifications — notifications schema refinement.
--
-- PART 1 — notifications.type + event_id. Contract §16.4: real columns beat the
--   data->>'type' JSON convention — a type column enables indexed filtering and
--   unread-by-type counts; event_id enables idempotent redelivery dedupe
--   (unique partial index) without overloading data.
-- PART 2 — notification_preferences table (contract §16.5): per-user,
--   per-event-type, per-channel opt-outs. RLS ENABLED+FORCED, own-rows policies,
--   tenant guard triggers (the 0047 pattern).
-- PART 3 — permission catalogue seeds: notifications.view,
--   notifications.preferences.manage, notifications.send (contract §16.6).
--   resource/action are derived from the key with the 0008 substring pattern
--   (last dot separates), so the three columns cannot drift.
-- PART 4 — seed_system_roles() CREATE OR REPLACE: the 0045 body plus the
--   Phase 8 grants. New organizations are correct from here on; 0008/0033/
--   0034/0035/0037/0042/0044/0045 are never edited.
-- PART 5 — backfill for existing organizations: the 0045 defensive pattern
--   (disable role_permissions_enforce_protection only if the trigger exists,
--   insert, re-enable).
-- PART 6 — RLS refinement: the Phase 6 policies keyed notification access to
--   jobs.view/jobs.create (the only catalogue keys that existed then). They are
--   dropped and replaced with user-scoped policies on the dedicated
--   notifications.* permissions. The worker-plane write path
--   (notifications_insert(), SECURITY DEFINER) is preserved — Part 7 extends
--   it for the new columns without breaking the Phase 6 call shape.
-- PART 7 — notifications_insert() gains defaulted p_type/p_event_id params.
-- PART 8 — verification DO blocks (the 0047 pattern): fail closed.

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 1 — type + event_id columns on public.notifications
-- ═════════════════════════════════════════════════════════════════════════════════

alter table public.notifications add column type text;

--> statement-breakpoint

-- Backfill from the Phase 6 data->>'type' convention; rows that never carried
-- one become SYSTEM_ALERT. nullif treats '' as missing too.
update public.notifications
set type = coalesce(nullif(data ->> 'type', ''), 'SYSTEM_ALERT')
where type is null;

--> statement-breakpoint

alter table public.notifications alter column type set not null;

--> statement-breakpoint

-- Idempotency key for event redelivery. Nullable: only event-sourced writes
-- carry one; the unique partial index below enforces dedupe where present.
alter table public.notifications add column event_id text;

--> statement-breakpoint

create unique index notifications_org_event_unique
  on public.notifications (org_id, event_id)
  where event_id is not null;

--> statement-breakpoint

-- Unread-by-type counts for the bell badge / notification center tabs.
create index notifications_org_person_type_unread_idx
  on public.notifications (org_id, person_id, type)
  where read_at is null;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 2 — public.notification_preferences
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  person_id uuid not null references public.people (id),

  event_type text not null,
  channel text not null
    constraint notification_preferences_channel_check check (channel in ('in_app', 'email')),
  enabled boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notification_preferences_org_person_event_channel_unique
    unique (org_id, person_id, event_type, channel)
);

--> statement-breakpoint

create index notification_preferences_org_person_idx
  on public.notification_preferences (org_id, person_id);

--> statement-breakpoint

create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function public.set_updated_at();

--> statement-breakpoint

comment on table public.notification_preferences is
  'Per-user notification opt-outs: one row per (org, person, event_type, channel). '
  'Absence of a row means the default (enabled); a row with enabled=false silences '
  'that event on that channel. event_type ''*'' is the wildcard for all events.';

--> statement-breakpoint

-- ── RLS: ENABLED + FORCED, own-rows policies (the 0047 template) ───────────────

alter table public.notification_preferences enable row level security;
alter table public.notification_preferences force row level security;

create policy notification_preferences_owner_all on public.notification_preferences
  for all to app_owner using (true) with check (true);

--> statement-breakpoint

create policy notification_preferences_select on public.notification_preferences
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and person_id = (select authz.person_id())
    and (select authz.has('notifications.preferences.manage'))
  );

--> statement-breakpoint

create policy notification_preferences_insert on public.notification_preferences
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and person_id = (select authz.person_id())
    and (select authz.has('notifications.preferences.manage'))
  );

--> statement-breakpoint

-- No DELETE policy: a preference is disabled by setting enabled=false, never
-- removed — the audit trail of what a user muted is itself useful.
create policy notification_preferences_update on public.notification_preferences
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and person_id = (select authz.person_id())
    and (select authz.has('notifications.preferences.manage'))
  )
  with check (
    org_id = (select authz.org_id())
    and person_id = (select authz.person_id())
  );

--> statement-breakpoint

-- ── tenant guards: the 0047 notifications_org_guard / person_org_guard pattern ─

create or replace function public.notification_preferences_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    raise exception 'notification_preferences.org_id must not be null'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.organizations o where o.id = new.org_id) then
    raise exception 'notification_preferences.org_id does not reference a valid organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.notification_preferences_org_guard() is
  'BEFORE INSERT/UPDATE on notification_preferences: org_id must reference a '
  'valid organization. Defense-in-depth behind the FK; raises 42501.';

revoke all on function public.notification_preferences_org_guard() from public;

drop trigger if exists notification_preferences_org_guard on public.notification_preferences;
create trigger notification_preferences_org_guard
  before insert or update on public.notification_preferences
  for each row execute function public.notification_preferences_org_guard();

--> statement-breakpoint

create or replace function public.notification_preferences_person_org_guard() returns trigger
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
    raise exception 'notification_preferences.person_id must belong to the preference''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.notification_preferences_person_org_guard() is
  'BEFORE INSERT/UPDATE on notification_preferences: person_id must belong to '
  'the row''s org_id. Closes the cross-org preference hole; raises 42501.';

revoke all on function public.notification_preferences_person_org_guard() from public;

drop trigger if exists notification_preferences_person_org_guard on public.notification_preferences;
create trigger notification_preferences_person_org_guard
  before insert or update on public.notification_preferences
  for each row execute function public.notification_preferences_person_org_guard();

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 3 — permission catalogue seeds (contract §16.6)
-- ═════════════════════════════════════════════════════════════════════════════════

-- resource/action derive from the key with the 0008 substring pattern (the
-- last dot separates, so notifications.preferences.manage splits into
-- resource notifications.preferences + action manage) — the three columns
-- cannot disagree, enforced by permissions_key_matches_parts.
insert into public.permissions (key, resource, action, module, description, is_sensitive)
select
  c.key,
  substring(c.key from '^(.*)\.[^.]+$'),
  substring(c.key from '\.([^.]+)$'),
  c.module,
  c.description,
  c.is_sensitive
from (values
  ('notifications.view',               'notifications', false, 'View own notifications'),
  ('notifications.preferences.manage', 'notifications', false, 'Manage own notification preferences'),
  ('notifications.send',               'notifications', false, 'Send notifications (admin broadcast)')
) as c(key, module, is_sensitive, description)
on conflict (key) do nothing;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 4 — seed_system_roles() CREATE OR REPLACE (0045 body + Phase 8 grants)
-- ═════════════════════════════════════════════════════════════════════════════════

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
    ('EMPLOYEE','tasks.create','SELF'),
    -- Phase 8 (0052): notification permissions. notifications.view lets every
    -- employee role read its own notifications (SUPER_ADMIN/ADMIN at GLOBAL,
    -- everyone else SELF); notifications.preferences.manage is the universal
    -- self-service preference permission (SELF for every role — SUPER_ADMIN
    -- keeps the GLOBAL it already holds from the whole-catalogue cross join
    -- above via on-conflict-do-nothing, mirroring the policies.acknowledge
    -- precedent); notifications.send is the admin-broadcast capability
    -- (GLOBAL for SUPER_ADMIN/ADMIN only).
    ('SUPER_ADMIN','notifications.view','GLOBAL'),
    ('ADMIN','notifications.view','GLOBAL'),
    ('HR_ADMIN','notifications.view','SELF'),
    ('HR_MANAGER','notifications.view','SELF'),
    ('MANAGER','notifications.view','SELF'),
    ('SALES_MANAGER','notifications.view','SELF'),
    ('SALES','notifications.view','SELF'),
    ('PROJECT_MANAGER','notifications.view','SELF'),
    ('DEVELOPER','notifications.view','SELF'),
    ('VIBECODER','notifications.view','SELF'),
    ('INTERN','notifications.view','SELF'),
    ('FINANCE','notifications.view','SELF'),
    ('EMPLOYEE','notifications.view','SELF'),
    ('SUPER_ADMIN','notifications.preferences.manage','SELF'),
    ('ADMIN','notifications.preferences.manage','SELF'),
    ('HR_ADMIN','notifications.preferences.manage','SELF'),
    ('HR_MANAGER','notifications.preferences.manage','SELF'),
    ('MANAGER','notifications.preferences.manage','SELF'),
    ('SALES_MANAGER','notifications.preferences.manage','SELF'),
    ('SALES','notifications.preferences.manage','SELF'),
    ('PROJECT_MANAGER','notifications.preferences.manage','SELF'),
    ('DEVELOPER','notifications.preferences.manage','SELF'),
    ('VIBECODER','notifications.preferences.manage','SELF'),
    ('INTERN','notifications.preferences.manage','SELF'),
    ('FINANCE','notifications.preferences.manage','SELF'),
    ('EMPLOYEE','notifications.preferences.manage','SELF'),
    ('SUPER_ADMIN','notifications.send','GLOBAL'),
    ('ADMIN','notifications.send','GLOBAL')
  ) as m(role_key, permission_key, scope)
  join public.roles r on r.org_id = p_org_id and r.key = m.role_key
  join public.permissions p on p.key = m.permission_key
  on conflict do nothing;
end;
$$;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 5 — backfill: existing organizations (the 0045 defensive pattern)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The protection trigger guards runtime changes to the authorization model,
-- which a migration is not, so it is disabled for the insert and re-enabled
-- immediately after. SUPER_ADMIN already holds all three keys at GLOBAL from
-- the whole-catalogue cross join in seed_system_roles() (the keys are new in
-- this migration, so orgs seeded before it got them then); the explicit rows
-- below hit on-conflict-do-nothing for SUPER_ADMIN and insert for the rest.

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
  ('SUPER_ADMIN','notifications.view','GLOBAL'),
  ('ADMIN','notifications.view','GLOBAL'),
  ('HR_ADMIN','notifications.view','SELF'),
  ('HR_MANAGER','notifications.view','SELF'),
  ('MANAGER','notifications.view','SELF'),
  ('SALES_MANAGER','notifications.view','SELF'),
  ('SALES','notifications.view','SELF'),
  ('PROJECT_MANAGER','notifications.view','SELF'),
  ('DEVELOPER','notifications.view','SELF'),
  ('VIBECODER','notifications.view','SELF'),
  ('INTERN','notifications.view','SELF'),
  ('FINANCE','notifications.view','SELF'),
  ('EMPLOYEE','notifications.view','SELF'),
  ('SUPER_ADMIN','notifications.preferences.manage','SELF'),
  ('ADMIN','notifications.preferences.manage','SELF'),
  ('HR_ADMIN','notifications.preferences.manage','SELF'),
  ('HR_MANAGER','notifications.preferences.manage','SELF'),
  ('MANAGER','notifications.preferences.manage','SELF'),
  ('SALES_MANAGER','notifications.preferences.manage','SELF'),
  ('SALES','notifications.preferences.manage','SELF'),
  ('PROJECT_MANAGER','notifications.preferences.manage','SELF'),
  ('DEVELOPER','notifications.preferences.manage','SELF'),
  ('VIBECODER','notifications.preferences.manage','SELF'),
  ('INTERN','notifications.preferences.manage','SELF'),
  ('FINANCE','notifications.preferences.manage','SELF'),
  ('EMPLOYEE','notifications.preferences.manage','SELF'),
  ('SUPER_ADMIN','notifications.send','GLOBAL'),
  ('ADMIN','notifications.send','GLOBAL')
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
-- PART 6 — RLS refinement for public.notifications (contract §16.6)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The 0047 policies keyed notification access to jobs.view/jobs.create — the
-- only catalogue keys that existed in Phase 6. Phase 8 introduces dedicated
-- notifications.* permissions, so the old policies are dropped and replaced:
--   SELECT — own rows, gated on notifications.view (authz.has() also enforces
--             is_active, so the suspended-user fail-closed rule is preserved).
--   INSERT — admin broadcast path, gated on notifications.send; the recipient
--             must still be in-org (person_org guard trigger). The worker plane
--             never uses this policy: it writes through notifications_insert().
--   UPDATE — read-marking own rows only; the WITH CHECK pins person_id so a
--             user cannot reassign a notification to someone else.
-- No DELETE policy (unchanged): retention purges run through a cleanup job.

drop policy if exists notifications_select on public.notifications;
drop policy if exists notifications_insert on public.notifications;
drop policy if exists notifications_update on public.notifications;

--> statement-breakpoint

create policy notifications_select on public.notifications
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and person_id = (select authz.person_id())
    and (select authz.has('notifications.view'))
  );

--> statement-breakpoint

create policy notifications_insert on public.notifications
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.has('notifications.send'))
  );

--> statement-breakpoint

create policy notifications_update on public.notifications
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and person_id = (select authz.person_id())
    and (select authz.has('notifications.view'))
  )
  with check (
    org_id = (select authz.org_id())
    and person_id = (select authz.person_id())
  );

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 7 — notifications_insert(): type/event_id aware, backward compatible
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- type is NOT NULL from Part 1, so the Phase 6 5-argument function would fail
-- on every worker-plane write. The replacement keeps the exact Phase 6 call
-- shape working (p_type/p_event_id are defaulted) while letting new callers
-- pass the event type and idempotency key explicitly. Old signature is
-- dropped first: CREATE OR REPLACE with a different parameter list would
-- create an overload, leaving the broken 5-arg function behind.

drop function if exists public.notifications_insert(uuid, uuid, text, text, jsonb);

create or replace function public.notifications_insert(
  p_org_id uuid,
  p_person_id uuid,
  p_title text,
  p_message text,
  p_data jsonb,
  p_type text default 'SYSTEM_ALERT',
  p_event_id text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.notifications (org_id, person_id, title, message, data, type, event_id)
  values (p_org_id, p_person_id, p_title, p_message, coalesce(p_data, '{}'::jsonb), p_type, p_event_id)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.notifications_insert(uuid, uuid, text, text, jsonb, text, text) is
  'SECURITY DEFINER: the notification job handler''s write path. Phase 8 adds '
  'the type column (NOT NULL) and the event_id idempotency key; both arrive as '
  'defaulted parameters so the Phase 6 5-argument call shape keeps working. '
  'org_id comes from the job row and the person_org guard trigger enforces the '
  'recipient''s org.';

revoke all on function public.notifications_insert(uuid, uuid, text, text, jsonb, text, text) from public;
grant execute on function public.notifications_insert(uuid, uuid, text, text, jsonb, text, text) to app_user;

--> statement-breakpoint

-- The handler runs on the worker plane as the nil-UUID system actor. A direct
-- SELECT from public.people under that identity is correctly invisible under
-- people_select: the system actor is not the recipient and has no people.view
-- scope. This bounded SECURITY DEFINER check answers only whether the named
-- recipient is a non-deleted person in the job row's organization, following
-- the person_holds_protected_role() precedent (0030). It exposes no person row
-- or profile field. The person_org guard trigger remains the insert-time
-- backstop if this check and the write ever race.
create or replace function public.notifications_recipient_exists(
  p_org_id uuid,
  p_person_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.people p
    where p.id = p_person_id
      and p.org_id = p_org_id
      and p.deleted_at is null
  )
$$;

comment on function public.notifications_recipient_exists(uuid, uuid) is
  'True when the named person is a non-deleted member of the given organization. '
  'SECURITY DEFINER because the notification worker''s system actor cannot see '
  'the recipient through people_select RLS. Returns one boolean and no person data.';

revoke all on function public.notifications_recipient_exists(uuid, uuid) from public;
grant execute on function public.notifications_recipient_exists(uuid, uuid) to app_user;

--> statement-breakpoint

-- createNotification runs under the CREATOR's identity, but the preference
-- rows belong to the RECIPIENT and notification_preferences_select is
-- own-rows only — so a creator can never see whether the recipient muted an
-- event, and the preference gate silently falls back to "enabled" for every
-- cross-user notification (proven in Phase 8 DB verification). This bounded
-- SECURITY DEFINER check answers the one bit the gate needs for an exact
-- (org, person, event_type, channel) tuple, with the service's resolution
-- semantics: a specific row wins, then the '*' wildcard row, then the
-- opt-out default (enabled). It exposes no other preference rows.
create or replace function public.notification_channel_enabled(
  p_org_id uuid,
  p_person_id uuid,
  p_event_type text,
  p_channel text
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select np.enabled
       from public.notification_preferences np
      where np.org_id = p_org_id
        and np.person_id = p_person_id
        and np.event_type = p_event_type
        and np.channel = p_channel),
    (select np.enabled
       from public.notification_preferences np
      where np.org_id = p_org_id
        and np.person_id = p_person_id
        and np.event_type = '*'
        and np.channel = p_channel),
    true
  )
$$;

comment on function public.notification_channel_enabled(uuid, uuid, text, text) is
  'Effective enabled flag for one (org, person, event_type, channel) preference: '
  'specific row, then ''*'' wildcard row, then default true. SECURITY DEFINER '
  'because preference rows are own-rows under RLS while the delivery gate runs '
  'under the notification creator''s identity. Returns one boolean only.';

revoke all on function public.notification_channel_enabled(uuid, uuid, text, text) from public;
grant execute on function public.notification_channel_enabled(uuid, uuid, text, text) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 8 — verification: fail the migration rather than leave a half-built schema
-- ═════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_problems text;
  v_missing_grants text;
begin
  select string_agg(p, '; ') into v_problems
  from (values
    ('notifications.type column missing',
      exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'notifications'
                and column_name = 'type')),
    ('notifications.type is nullable',
      coalesce((select is_nullable = 'NO' from information_schema.columns
                where table_schema = 'public' and table_name = 'notifications'
                  and column_name = 'type'), false)),
    ('notifications.event_id column missing',
      exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'notifications'
                and column_name = 'event_id')),
    ('notifications.event_id is not nullable',
      coalesce((select is_nullable = 'YES' from information_schema.columns
                where table_schema = 'public' and table_name = 'notifications'
                  and column_name = 'event_id'), false)),
    ('notifications_org_event_unique missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'notifications_org_event_unique')),
    ('notifications_org_person_type_unread_idx missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'notifications_org_person_type_unread_idx')),
    ('notification_preferences table missing',
      exists (select 1 from pg_tables
              where schemaname = 'public' and tablename = 'notification_preferences')),
    ('notification_preferences RLS not forced',
      coalesce((select relrowsecurity and relforcerowsecurity from pg_class
                where relname = 'notification_preferences'), false)),
    ('notification_preferences unique constraint missing',
      exists (select 1 from pg_constraint
              where conname = 'notification_preferences_org_person_event_channel_unique')),
    ('notification_preferences channel check missing',
      exists (select 1 from pg_constraint
              where conname = 'notification_preferences_channel_check')),
    ('notifications.view permission missing',
      exists (select 1 from public.permissions where key = 'notifications.view')),
    ('notifications.preferences.manage permission missing',
      exists (select 1 from public.permissions where key = 'notifications.preferences.manage')),
    ('notifications.send permission missing',
      exists (select 1 from public.permissions where key = 'notifications.send')),
    ('notifications permission key/resource/action drift',
      not exists (select 1 from public.permissions
                  where key like 'notifications.%'
                    and key <> resource || '.' || action)),
    ('notifications_select policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'notifications'
                and policyname = 'notifications_select')),
    ('notifications_insert policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'notifications'
                and policyname = 'notifications_insert')),
    ('notifications_update policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'notifications'
                and policyname = 'notifications_update')),
    ('notification_preferences_select policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'notification_preferences'
                and policyname = 'notification_preferences_select')),
    ('notification_preferences_insert policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'notification_preferences'
                and policyname = 'notification_preferences_insert')),
    ('notification_preferences_update policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'notification_preferences'
                and policyname = 'notification_preferences_update')),
    ('stale jobs.* reference in a notifications policy',
      not exists (select 1 from pg_policies
                  where schemaname = 'public'
                    and tablename in ('notifications', 'notification_preferences')
                    and (qual like '%jobs.view%' or qual like '%jobs.create%'
                         or with_check like '%jobs.view%' or with_check like '%jobs.create%'))),
    ('notifications_insert not the 7-arg security-definer',
      coalesce((select p.prosecdef from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'notifications_insert'
                  and p.pronargs = 7), false)),
    ('notifications_insert not executable by app_user',
      exists (select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'notifications_insert'
                and has_function_privilege('app_user', p.oid, 'EXECUTE'))),
    ('notifications_recipient_exists missing',
      exists (select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'notifications_recipient_exists'
                and p.pronargs = 2)),
    ('notifications_recipient_exists not security-definer',
      coalesce((select p.prosecdef from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'notifications_recipient_exists'
                  and p.pronargs = 2), false)),
    ('notifications_recipient_exists not executable by app_user',
      exists (select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'notifications_recipient_exists'
                and has_function_privilege('app_user', p.oid, 'EXECUTE'))),
    ('notification_channel_enabled missing',
      exists (select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'notification_channel_enabled'
                and p.pronargs = 4)),
    ('notification_channel_enabled not security-definer',
      coalesce((select p.prosecdef from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'notification_channel_enabled'
                  and p.pronargs = 4), false)),
    ('notification_channel_enabled not executable by app_user',
      exists (select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'notification_channel_enabled'
                and has_function_privilege('app_user', p.oid, 'EXECUTE'))),
    ('notification_preferences guard triggers missing',
      exists (select 1 from pg_trigger where tgname = 'notification_preferences_org_guard')
      and exists (select 1 from pg_trigger where tgname = 'notification_preferences_person_org_guard'))
  ) as checks(p, ok)
  where not ok;

  -- Every organization must hold all 28 Phase 8 notification grants
  -- (13 x view, 13 x preferences.manage, 2 x send).
  select string_agg(distinct o.slug || '/' || m.role_key || '/' || m.permission_key, ', ')
    into v_missing_grants
  from public.organizations o
  cross join (values
    ('SUPER_ADMIN','notifications.view'),('ADMIN','notifications.view'),
    ('HR_ADMIN','notifications.view'),('HR_MANAGER','notifications.view'),
    ('MANAGER','notifications.view'),('SALES_MANAGER','notifications.view'),
    ('SALES','notifications.view'),('PROJECT_MANAGER','notifications.view'),
    ('DEVELOPER','notifications.view'),('VIBECODER','notifications.view'),
    ('INTERN','notifications.view'),('FINANCE','notifications.view'),
    ('EMPLOYEE','notifications.view'),
    ('SUPER_ADMIN','notifications.preferences.manage'),('ADMIN','notifications.preferences.manage'),
    ('HR_ADMIN','notifications.preferences.manage'),('HR_MANAGER','notifications.preferences.manage'),
    ('MANAGER','notifications.preferences.manage'),('SALES_MANAGER','notifications.preferences.manage'),
    ('SALES','notifications.preferences.manage'),('PROJECT_MANAGER','notifications.preferences.manage'),
    ('DEVELOPER','notifications.preferences.manage'),('VIBECODER','notifications.preferences.manage'),
    ('INTERN','notifications.preferences.manage'),('FINANCE','notifications.preferences.manage'),
    ('EMPLOYEE','notifications.preferences.manage'),
    ('SUPER_ADMIN','notifications.send'),('ADMIN','notifications.send')
  ) as m(role_key, permission_key)
  where not exists (
    select 1
    from public.roles r
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where r.org_id = o.id
      and r.key = m.role_key
      and p.key = m.permission_key
  );

  if v_missing_grants is not null then
    v_problems := coalesce(v_problems || '; ', '') || 'missing notification grants: ' || v_missing_grants;
  end if;

  if v_problems is not null then
    raise exception 'notifications Phase 8 migration verification failed: %', v_problems;
  end if;
end;
$$;
