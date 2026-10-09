-- PRAVSHI OS — Phase 10: Integrations Platform — permission catalogue tranche.
--
-- PART 1 — permission catalogue seeds: integrations.view, integrations.manage
--   (contract §4.2). resource/action are derived from the key with the 0008
--   substring pattern (last dot separates), so the three columns cannot
--   drift: integrations.view → integrations/view;
--   integrations.manage → integrations/manage.
--   LEGACY ROW: 0008 already seeded integrations.manage as an ungranted
--   blueprint row under module 'settings' ("Configure integrations"), so the
--   catalogue grows by ONE new key here (126 → 127), not two. PART 1 is
--   therefore an upsert, not insert-or-nothing: on conflict it re-homes the
--   legacy row to module 'integrations' with the §4.2 description. 0008's
--   insert derived resource/action with the same substring expressions, so
--   the legacy row's resource/action already equal the derived values
--   ('integrations'/'manage') and need no update.
-- PART 2 — seed_system_roles() CREATE OR REPLACE: the 0055 body plus the
--   §4.2 grants appended to the grants VALUES list. New organizations are
--   correct from here on; 0008/0033/.../0055 are never edited.
-- PART 3 — backfill for existing organizations: the 0045 defensive pattern
--   (disable role_permissions_enforce_protection only if the trigger exists,
--   insert, re-enable), so existing orgs converge with new ones.
-- PART 4 — verification DO blocks (the 0047 pattern): fail closed if either
--   key is missing or any §4.2 grant (role, key, scope) is absent in any
--   organization.

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 1 — permission catalogue seeds (contract §4.2)
-- ═════════════════════════════════════════════════════════════════════════════════

-- Upsert, not insert-or-nothing: integrations.manage already exists on every
-- database that has run 0008 (module 'settings', granted to no role). The
-- conflict branch re-homes that legacy row — module and description move to
-- the integrations module; is_sensitive is false on both seeds and is set
-- anyway so the row converges exactly. resource/action are derived
-- identically in 0008 and here, so they cannot differ and are not updated.
insert into public.permissions (key, resource, action, module, description, is_sensitive)
select
  c.key,
  substring(c.key from '^(.*)\.[^.]+$'),
  substring(c.key from '\.([^.]+)$'),
  c.module,
  c.description,
  c.is_sensitive
from (values
  ('integrations.view',  'integrations', false, 'View organization integrations'),
  ('integrations.manage','integrations', false, 'Manage organization integrations')
) as c(key, module, is_sensitive, description)
on conflict (key) do update set
  module = excluded.module,
  description = excluded.description,
  is_sensitive = excluded.is_sensitive;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 2 — seed_system_roles() CREATE OR REPLACE (0055 body + Phase 10 grants)
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
    ('ADMIN','notifications.send','GLOBAL'),
    -- Phase 9 (0055): AI Foundation permissions (contract §2.2). ai.use goes
    -- to every role holding CRM or work record access, at the scope of that
    -- role's widest record-view grant; it never widens record access — the
    -- entity permission + RLS decide every record. HR_ADMIN / HR_MANAGER hold
    -- no CRM/work record access and MARKETING holds nothing, so none of them
    -- are granted. ai.usage.view / ai.usage.manage are SUPER_ADMIN + ADMIN at
    -- GLOBAL only (the notifications.send precedent); SUPER_ADMIN's rows also
    -- arrive via the whole-catalogue cross join above.
    ('SUPER_ADMIN','ai.use','GLOBAL'),
    ('ADMIN','ai.use','GLOBAL'),
    ('SALES_MANAGER','ai.use','DEPARTMENT'),
    ('SALES','ai.use','SELF'),
    ('PROJECT_MANAGER','ai.use','DEPARTMENT'),
    ('MANAGER','ai.use','DEPARTMENT'),
    ('DEVELOPER','ai.use','PROJECT'),
    ('VIBECODER','ai.use','PROJECT'),
    ('INTERN','ai.use','SELF'),
    ('EMPLOYEE','ai.use','SELF'),
    ('FINANCE','ai.use','SELF'),
    ('SUPER_ADMIN','ai.usage.view','GLOBAL'),
    ('ADMIN','ai.usage.view','GLOBAL'),
    ('SUPER_ADMIN','ai.usage.manage','GLOBAL'),
    ('ADMIN','ai.usage.manage','GLOBAL'),
    -- Phase 10 (0057): Integrations Platform permissions (contract §4.2).
    -- Connections hold org-wide credentials, so — unlike ai.use — there is
    -- no broad integrations.use grant: view and manage are SUPER_ADMIN +
    -- ADMIN at GLOBAL only (the ai.usage.* / notifications.send admin
    -- precedent). SUPER_ADMIN's rows also arrive via the whole-catalogue
    -- cross join above.
    ('SUPER_ADMIN','integrations.view','GLOBAL'),
    ('ADMIN','integrations.view','GLOBAL'),
    ('SUPER_ADMIN','integrations.manage','GLOBAL'),
    ('ADMIN','integrations.manage','GLOBAL')
  ) as m(role_key, permission_key, scope)
  join public.roles r on r.org_id = p_org_id and r.key = m.role_key
  join public.permissions p on p.key = m.permission_key
  on conflict do nothing;
end;
$$;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 3 — backfill: existing organizations (the 0045 defensive pattern)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The protection trigger guards runtime changes to the authorization model,
-- which a migration is not, so it is disabled for the insert and re-enabled
-- immediately after. SUPER_ADMIN holds both keys at GLOBAL from the
-- whole-catalogue cross join in seed_system_roles() for NEW orgs; existing
-- orgs were seeded before these keys existed, so their SUPER_ADMIN rows are
-- inserted here and hit on-conflict-do-nothing only where already present.

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
  ('SUPER_ADMIN','integrations.view','GLOBAL'),
  ('ADMIN','integrations.view','GLOBAL'),
  ('SUPER_ADMIN','integrations.manage','GLOBAL'),
  ('ADMIN','integrations.manage','GLOBAL')
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
-- PART 4 — verification: fail the migration rather than leave a half-seeded matrix
-- ═════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_problems text;
  v_missing_grants text;
begin
  select string_agg(p, '; ') into v_problems
  from (values
    ('integrations.view permission missing',
      exists (select 1 from public.permissions where key = 'integrations.view')),
    ('integrations.manage permission missing',
      exists (select 1 from public.permissions where key = 'integrations.manage')),
    ('integrations permission key/resource/action drift',
      not exists (select 1 from public.permissions
                  where key like 'integrations.%'
                    and key <> resource || '.' || action)),
    ('integrations permission module/sensitivity drift',
      not exists (select 1 from public.permissions
                  where key in ('integrations.view', 'integrations.manage')
                    and (module <> 'integrations' or is_sensitive)))
  ) as checks(p, ok)
  where not ok;

  -- Every organization must hold all 4 Phase 10 grants at the §4.2 scopes
  -- (2 x integrations.view, 2 x integrations.manage).
  select string_agg(distinct o.slug || '/' || m.role_key || '/' || m.permission_key || '/' || m.scope, ', ')
    into v_missing_grants
  from public.organizations o
  cross join (values
    ('SUPER_ADMIN','integrations.view','GLOBAL'),
    ('ADMIN','integrations.view','GLOBAL'),
    ('SUPER_ADMIN','integrations.manage','GLOBAL'),
    ('ADMIN','integrations.manage','GLOBAL')
  ) as m(role_key, permission_key, scope)
  where not exists (
    select 1
    from public.roles r
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where r.org_id = o.id
      and r.key = m.role_key
      and p.key = m.permission_key
      and rp.scope::text = m.scope
  );

  if v_missing_grants is not null then
    v_problems := coalesce(v_problems || '; ', '') || 'missing integrations grants: ' || v_missing_grants;
  end if;

  if v_problems is not null then
    raise exception 'integrations permissions migration verification failed: %', v_problems;
  end if;
end;
$$;
