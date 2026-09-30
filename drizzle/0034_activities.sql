-- PRAVSHI OS — Phase 2 Track B: activities.
--
-- The interaction log: calls, emails, meetings and notes attached to any one
-- CRM record. Unlike companies/contacts/deals the link is POLYMORPHIC —
-- (entity_type, entity_id) names a company, a contact or a deal, and the plan
-- (§3) deliberately places NO cross-table foreign keys on it, because a single
-- FK column cannot reference three tables. The app layer probes the referenced
-- record for visibility before every write (assertCompanyVisible /
-- assertContactVisible / assertDealVisible in src/lib/crm/refs.ts): an invisible
-- reference — missing, deleted, or another tenant's — fails closed with the
-- NOT_FOUND concealment, exactly like the 0033 deal-reference probes.
--
-- Everything else follows the 0033 CRM Core conventions verbatim:
--   actor stamping (F3) — created_by/updated_by stamped, never trusted
--   owner reassignment (F1) — new owner must be within the caller's reach
--   audit triggers (F2) — audit_row_change() at HIGH, whole-row
--   the 4.2 RLS template — org-scoped, deleted_at-excluded, is_active()-gated,
--     scope_for() CASE over GLOBAL/DEPARTMENT/TEAM/PROJECT/SELF, then the
--     record-grant arm keyed on the 'activity' entity type
--   insert forces owner_person_id = authz.person_id() — a row can never be
--     created "for" someone else
--   no DELETE policy — activities are soft-deleted through UPDATE, and hard
--     deletion is app_owner's alone
--
-- Permission catalogue: activities.view/create/edit/delete (module 'crm'), plus
-- the relationships stream's four keys — both Track B migrations seed all eight
-- so seed_system_roles() stays complete regardless of apply order.

-- ═════════════════════════════════════════════════════════════════════════════════
-- activities
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  -- Polymorphic target: which CRM record this activity is logged against.
  -- NO foreign keys here by design (see header): one column cannot reference
  -- three tables, and the app-layer visibility probe is the enforcement point.
  entity_type text not null,
  entity_id uuid not null,

  type text not null,
  subject text not null,
  notes text,

  occurred_at timestamptz,
  due_at timestamptz,

  owner_person_id uuid not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.people (id),
  updated_by uuid references public.people (id),
  deleted_at timestamptz,

  constraint activities_subject_not_blank check (length(btrim(subject)) > 0),
  constraint activities_entity_type check (
    entity_type in ('company', 'contact', 'deal')
  ),
  constraint activities_type check (
    type in ('CALL', 'EMAIL', 'MEETING', 'NOTE')
  ),
  constraint activities_id_org_unique unique (id, org_id)
);

alter table public.activities
  add constraint activities_owner_same_org
  foreign key (owner_person_id, org_id) references public.people (id, org_id);

-- Timeline reads key on (entity_type, entity_id); owner reads on the owner;
-- due-date views on due_at. All exclude soft-deleted rows.
create index activities_org_idx on public.activities (org_id) where deleted_at is null;
create index activities_owner_idx
  on public.activities (org_id, owner_person_id) where deleted_at is null;
create index activities_entity_idx
  on public.activities (org_id, entity_type, entity_id) where deleted_at is null;
create index activities_due_idx
  on public.activities (org_id, due_at) where deleted_at is null and due_at is not null;

create trigger activities_set_updated_at
  before update on public.activities
  for each row execute function public.set_updated_at();

create trigger activities_stamp_actor
  before insert or update on public.activities
  for each row execute function public.stamp_crm_actor();

create trigger activities_enforce_owner_change
  before update on public.activities
  for each row execute function public.enforce_crm_owner_change('activities.edit');

create trigger activities_audit
  after insert or update or delete on public.activities
  for each row execute function public.audit_row_change('activity', 'HIGH', 'id');

comment on table public.activities is
  'Interaction log: calls, emails, meetings and notes attached to one company, '
  'contact or deal via the polymorphic (entity_type, entity_id) link. The link '
  'carries no foreign key by design; the app layer probes the referenced '
  'record for visibility before every write.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- RLS
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The 0033 4.2 template, keyed on activities.view / activities.edit and the
-- 'activity' record-grant entity type. Same two deliberate properties as 0033:
-- no unconditional self-visibility, and INSERT forces owner = actor. No DELETE
-- policy: activities are soft-deleted through UPDATE.

alter table public.activities enable row level security;
alter table public.activities force row level security;

create policy activities_owner_all on public.activities
  for all to app_owner using (true) with check (true);

create policy activities_select on public.activities
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      case (select authz.scope_for('activities.view'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (select authz.in_my_departments(public.activities.owner_person_id))
        when 'TEAM' then owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(public.activities.owner_person_id))
        when 'PROJECT' then false
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
      or (select authz.has_record_grant('activity', public.activities.id, 'activities.view'))
    )
  );

create policy activities_insert on public.activities
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('activities.create'))
    and owner_person_id = (select authz.person_id())
  );

create policy activities_update on public.activities
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      case (select authz.scope_for('activities.edit'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (select authz.in_my_departments(public.activities.owner_person_id))
        when 'TEAM' then owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(public.activities.owner_person_id))
        when 'PROJECT' then false
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
      or (select authz.has_record_grant('activity', public.activities.id, 'activities.edit'))
    )
  )
  with check (
    org_id = (select authz.org_id())
  );

-- The DELETE half of the for-all contract is revoked explicitly: nothing here
-- may be hard-deleted by the runtime roles.
revoke delete on public.activities from app_user, app_admin;

-- ═════════════════════════════════════════════════════════════════════════════════
-- crm_soft_delete(): the runtime soft-delete path for every CRM table
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS FUNCTION EXISTS. PostgreSQL evaluates the SELECT policy's USING
-- against the POST-update row. Every CRM table's SELECT policy requires
-- `deleted_at is null`, so a plain `UPDATE ... SET deleted_at = now()` fails
-- with 42501 ("new row violates row-level security policy") even when the
-- caller satisfies the UPDATE policy completely — the new row no longer
-- satisfies the SELECT policy. This was verified empirically (minimal repro:
-- SELECT policy `USING (deleted_at is null)`, UPDATE policy
-- `USING (deleted_at is null) WITH CHECK (true)`, no triggers, no RETURNING —
-- still 42501). It breaks deleteCompany/deleteContact/deleteDeal from 0033
-- and would break every Track B delete the same way.
--
-- The function is SECURITY DEFINER so the write bypasses that check.
-- Authorization is NOT bypassed: the service layer (src/lib/crm/soft-delete.ts)
-- first proves edit rights with a no-op UPDATE as app_user — which enforces
-- the table's real UPDATE policy (org, liveness, is_active, edit scope) and
-- takes a row lock — then calls this function in the same transaction.
-- Defense in depth inside the function: the entity allowlist below (no
-- arbitrary tables), the row must belong to the caller's org —
-- authz.org_id() reads the caller's transaction settings even under SECURITY
-- DEFINER — and the row must be live (deleted_at is null).
create function public.crm_soft_delete(p_entity text, p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
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
  end;
  if v_table is null then
    raise exception 'unknown soft-delete entity: %', p_entity using errcode = '42501';
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
-- permission catalogue — the activities keys (and the sibling stream's)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- All eight Track B keys land here so seed_system_roles() stays complete
-- regardless of whether this migration or the relationships one applies first.
-- The relationships migration does the same; on conflict do nothing keeps both
-- idempotent.

insert into public.permissions (key, resource, action, module, description, is_sensitive)
select
  c.key,
  substring(c.key from '^(.*)\.[^.]+$'),
  substring(c.key from '\.([^.]+)$'),
  c.module,
  c.description,
  c.is_sensitive
from (values
  -- Activities (this stream)
  ('activities.view',   'crm', false, 'See activities'),
  ('activities.create', 'crm', false, 'Log an activity'),
  ('activities.edit',   'crm', false, 'Change an activity'),
  ('activities.delete', 'crm', false, 'Delete an activity'),
  -- Relationships (sibling stream — seeded here too, same reason as above)
  ('relationships.view',   'crm', false, 'See relationships'),
  ('relationships.create', 'crm', false, 'Create a relationship'),
  ('relationships.edit',   'crm', false, 'Change a relationship'),
  ('relationships.delete', 'crm', false, 'Delete a relationship')
) as c(key, module, is_sensitive, description)
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════════
-- Role-grant matrix fix — the Track B keys reach the standard roles
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The 0033 comment applies verbatim: the catalogue seeds above are not enough on
-- their own — seed_system_roles() grants from a hardcoded VALUES matrix, so the
-- function body below is the 0033 body with the Track B rows added (ADMIN at
-- GLOBAL, SALES_MANAGER at DEPARTMENT, SALES at SELF on view/create/edit —
-- mirroring the leads.* SELF column: no delete). Migration 0033 itself is never
-- edited; it is already applied.

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
    ('SALES','relationships.edit','SELF')
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
-- — the same pattern migration 0010 (and 0033) used.
--
-- SUPER_ADMIN already holds every catalogue key at GLOBAL through the cross join
-- in seed_system_roles(), but organizations created before the relationships
-- migration are only correct if the eight new keys are backfilled explicitly:
-- SUPER_ADMIN 8 + ADMIN 8 + SALES_MANAGER 8 + SALES 6 = 30 grants.
-- Only the eight new keys' grants are inserted here — no legacy cleanup, no
-- re-seeding of existing grants (on conflict do nothing).

alter table public.role_permissions disable trigger role_permissions_enforce_protection;

insert into public.role_permissions (role_id, permission_id, scope)
select r.id, p.id, m.scope::public.access_scope
from public.roles r
cross join public.permissions p
join (values
  ('SUPER_ADMIN','activities.view','GLOBAL'),('SUPER_ADMIN','activities.create','GLOBAL'),
  ('SUPER_ADMIN','activities.edit','GLOBAL'),('SUPER_ADMIN','activities.delete','GLOBAL'),
  ('SUPER_ADMIN','relationships.view','GLOBAL'),('SUPER_ADMIN','relationships.create','GLOBAL'),
  ('SUPER_ADMIN','relationships.edit','GLOBAL'),('SUPER_ADMIN','relationships.delete','GLOBAL'),
  ('ADMIN','activities.view','GLOBAL'),('ADMIN','activities.create','GLOBAL'),
  ('ADMIN','activities.edit','GLOBAL'),('ADMIN','activities.delete','GLOBAL'),
  ('ADMIN','relationships.view','GLOBAL'),('ADMIN','relationships.create','GLOBAL'),
  ('ADMIN','relationships.edit','GLOBAL'),('ADMIN','relationships.delete','GLOBAL'),
  ('SALES_MANAGER','activities.view','DEPARTMENT'),('SALES_MANAGER','activities.create','DEPARTMENT'),
  ('SALES_MANAGER','activities.edit','DEPARTMENT'),('SALES_MANAGER','activities.delete','DEPARTMENT'),
  ('SALES_MANAGER','relationships.view','DEPARTMENT'),('SALES_MANAGER','relationships.create','DEPARTMENT'),
  ('SALES_MANAGER','relationships.edit','DEPARTMENT'),('SALES_MANAGER','relationships.delete','DEPARTMENT'),
  ('SALES','activities.view','SELF'),('SALES','activities.create','SELF'),
  ('SALES','activities.edit','SELF'),
  ('SALES','relationships.view','SELF'),('SALES','relationships.create','SELF'),
  ('SALES','relationships.edit','SELF')
) as m(role_key, permission_key, scope)
  on r.key = m.role_key and p.key = m.permission_key
on conflict do nothing;

alter table public.role_permissions enable trigger role_permissions_enforce_protection;
