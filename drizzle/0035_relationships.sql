-- PRAVSHI OS — Phase 2 Track B: relationships (migration 0035).
--
-- Explicit join tables with real composite org FKs — NOT polymorphic. They model the
-- business graph between the CRM core records (migration 0033: companies, contacts):
--
--   company_contacts  contact <-> company associations (role, primary contact flag)
--   company_links     company <-> company (PARENT / SUBSIDIARY / PARTNER)
--   contact_links     contact <-> contact (COLLEAGUE / REFERRAL / OTHER)
--
-- Conventions carried over from 0033 (followed exactly, no new patterns):
--
--   Task 1.4 composite-key strategy  every relationship carries this row's org_id into
--                                    the foreign key, so a company, contact and person
--                                    must all agree with it and with each other.
--   Task 1.16 RLS template           org-scoped, deleted_at-excluded, is_active()-gated,
--                                    scope_for() CASE over GLOBAL/DEPARTMENT/TEAM/PROJECT/
--                                    SELF, then the record-grant arm.
--   F1 enforce_crm_owner_change()    NEW owner constrained to the caller's reachable
--                                    set under '<entity>.edit', fired BEFORE FK
--                                    checks, closing the user-enumeration oracle.
--   F3 stamp_crm_actor()             created_by/updated_by stamped, never trusted;
--                                    created_by immutable on UPDATE.
--   audit_row_change()               attached on every table, HIGH severity, whole-row —
--                                    the compensating control for owner reassignment
--                                    and soft-deletes.
--
-- Uniqueness semantics (live rows only — a soft-deleted row never blocks reuse):
--   company_contacts: one live association per (company, contact) pair;
--                     at most one primary contact per company, and at most one
--                     primary company per contact (primary = the flagship contact of
--                     a company / the flagship company of a contact).
--   company_links:    one live (from_company, to_company, link_type) tuple.
--   contact_links:    one live (from_contact, to_contact, link_type) tuple.
-- Self-links are rejected by CHECK (the zod refine in the API is the backstop).

-- ═════════════════════════════════════════════════════════════════════════════════
-- company_contacts — contact <-> company associations
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.company_contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  company_id uuid not null,
  contact_id uuid not null,

  role text,
  is_primary boolean not null default false,

  owner_person_id uuid not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.people (id),
  updated_by uuid references public.people (id),
  deleted_at timestamptz,

  constraint company_contacts_id_org_unique unique (id, org_id)
);

alter table public.company_contacts
  add constraint company_contacts_company_same_org
  foreign key (company_id, org_id) references public.companies (id, org_id);

alter table public.company_contacts
  add constraint company_contacts_contact_same_org
  foreign key (contact_id, org_id) references public.contacts (id, org_id);

alter table public.company_contacts
  add constraint company_contacts_owner_same_org
  foreign key (owner_person_id, org_id) references public.people (id, org_id);

-- One live association per pair: re-linking a soft-deleted pair creates a fresh row.
create unique index company_contacts_pair_unique
  on public.company_contacts (company_id, contact_id)
  where deleted_at is null;

-- At most one primary contact per company (live rows only).
create unique index company_contacts_primary_company_unique
  on public.company_contacts (company_id)
  where is_primary and deleted_at is null;

-- At most one primary company per contact (live rows only).
create unique index company_contacts_primary_contact_unique
  on public.company_contacts (contact_id)
  where is_primary and deleted_at is null;

create index company_contacts_org_idx
  on public.company_contacts (org_id) where deleted_at is null;
create index company_contacts_company_idx
  on public.company_contacts (org_id, company_id) where deleted_at is null;
create index company_contacts_contact_idx
  on public.company_contacts (org_id, contact_id) where deleted_at is null;
create index company_contacts_owner_idx
  on public.company_contacts (org_id, owner_person_id) where deleted_at is null;

create trigger company_contacts_set_updated_at
  before update on public.company_contacts
  for each row execute function public.set_updated_at();

create trigger company_contacts_stamp_actor
  before insert or update on public.company_contacts
  for each row execute function public.stamp_crm_actor();

create trigger company_contacts_enforce_owner_change
  before update on public.company_contacts
  for each row execute function public.enforce_crm_owner_change('relationships.edit');

create trigger company_contacts_audit
  after insert or update or delete on public.company_contacts
  for each row execute function public.audit_row_change('company_contact', 'HIGH', 'id');

comment on table public.company_contacts is
  'Associations between contacts and companies: role (e.g. Decision Maker) and the '
  'primary flag. Soft delete only.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- company_links — company <-> company
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.company_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  from_company_id uuid not null,
  to_company_id uuid not null,

  link_type text not null,

  owner_person_id uuid not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.people (id),
  updated_by uuid references public.people (id),
  deleted_at timestamptz,

  constraint company_links_no_self check (from_company_id <> to_company_id),
  constraint company_links_type check (link_type in ('PARENT', 'SUBSIDIARY', 'PARTNER')),
  constraint company_links_id_org_unique unique (id, org_id)
);

alter table public.company_links
  add constraint company_links_from_company_same_org
  foreign key (from_company_id, org_id) references public.companies (id, org_id);

alter table public.company_links
  add constraint company_links_to_company_same_org
  foreign key (to_company_id, org_id) references public.companies (id, org_id);

alter table public.company_links
  add constraint company_links_owner_same_org
  foreign key (owner_person_id, org_id) references public.people (id, org_id);

create unique index company_links_pair_unique
  on public.company_links (from_company_id, to_company_id, link_type)
  where deleted_at is null;

create index company_links_org_idx
  on public.company_links (org_id) where deleted_at is null;
create index company_links_from_idx
  on public.company_links (org_id, from_company_id) where deleted_at is null;
create index company_links_to_idx
  on public.company_links (org_id, to_company_id) where deleted_at is null;
create index company_links_owner_idx
  on public.company_links (org_id, owner_person_id) where deleted_at is null;

create trigger company_links_set_updated_at
  before update on public.company_links
  for each row execute function public.set_updated_at();

create trigger company_links_stamp_actor
  before insert or update on public.company_links
  for each row execute function public.stamp_crm_actor();

create trigger company_links_enforce_owner_change
  before update on public.company_links
  for each row execute function public.enforce_crm_owner_change('relationships.edit');

create trigger company_links_audit
  after insert or update or delete on public.company_links
  for each row execute function public.audit_row_change('company_link', 'HIGH', 'id');

comment on table public.company_links is
  'Company-to-company links: PARENT (from_company is the parent of to_company), '
  'SUBSIDIARY, PARTNER. Soft delete only.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- contact_links — contact <-> contact
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.contact_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  from_contact_id uuid not null,
  to_contact_id uuid not null,

  link_type text not null,

  owner_person_id uuid not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.people (id),
  updated_by uuid references public.people (id),
  deleted_at timestamptz,

  constraint contact_links_no_self check (from_contact_id <> to_contact_id),
  constraint contact_links_type check (link_type in ('COLLEAGUE', 'REFERRAL', 'OTHER')),
  constraint contact_links_id_org_unique unique (id, org_id)
);

alter table public.contact_links
  add constraint contact_links_from_contact_same_org
  foreign key (from_contact_id, org_id) references public.contacts (id, org_id);

alter table public.contact_links
  add constraint contact_links_to_contact_same_org
  foreign key (to_contact_id, org_id) references public.contacts (id, org_id);

alter table public.contact_links
  add constraint contact_links_owner_same_org
  foreign key (owner_person_id, org_id) references public.people (id, org_id);

create unique index contact_links_pair_unique
  on public.contact_links (from_contact_id, to_contact_id, link_type)
  where deleted_at is null;

create index contact_links_org_idx
  on public.contact_links (org_id) where deleted_at is null;
create index contact_links_from_idx
  on public.contact_links (org_id, from_contact_id) where deleted_at is null;
create index contact_links_to_idx
  on public.contact_links (org_id, to_contact_id) where deleted_at is null;
create index contact_links_owner_idx
  on public.contact_links (org_id, owner_person_id) where deleted_at is null;

create trigger contact_links_set_updated_at
  before update on public.contact_links
  for each row execute function public.set_updated_at();

create trigger contact_links_stamp_actor
  before insert or update on public.contact_links
  for each row execute function public.stamp_crm_actor();

create trigger contact_links_enforce_owner_change
  before update on public.contact_links
  for each row execute function public.enforce_crm_owner_change('relationships.edit');

create trigger contact_links_audit
  after insert or update or delete on public.contact_links
  for each row execute function public.audit_row_change('contact_link', 'HIGH', 'id');

comment on table public.contact_links is
  'Contact-to-contact links: COLLEAGUE, REFERRAL, OTHER. Soft delete only.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- RLS
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The 4.2 template copied per table from 0033, keyed on relationships.view /
-- relationships.edit and the per-table record-grant entity type:
--
--   company_contacts -> 'company_contact'   company_links -> 'company_link'
--   contact_links    -> 'contact_link'
--
-- Same deliberate properties as 0033: no unconditional self-visibility; INSERT
-- forces owner_person_id = authz.person_id(); NO DELETE policy — associations are
-- soft-deleted through UPDATE, and hard deletion is app_owner's alone.

alter table public.company_contacts enable row level security;
alter table public.company_contacts force row level security;

alter table public.company_links enable row level security;
alter table public.company_links force row level security;

alter table public.contact_links enable row level security;
alter table public.contact_links force row level security;

create policy company_contacts_owner_all on public.company_contacts
  for all to app_owner using (true) with check (true);

create policy company_links_owner_all on public.company_links
  for all to app_owner using (true) with check (true);

create policy contact_links_owner_all on public.contact_links
  for all to app_owner using (true) with check (true);

-- ── company_contacts ─────────────────────────────────────────────────────────────

create policy company_contacts_select on public.company_contacts
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      case (select authz.scope_for('relationships.view'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (select authz.in_my_departments(public.company_contacts.owner_person_id))
        when 'TEAM' then owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(public.company_contacts.owner_person_id))
        when 'PROJECT' then false
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
      or (select authz.has_record_grant('company_contact', public.company_contacts.id, 'relationships.view'))
    )
  );

create policy company_contacts_insert on public.company_contacts
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('relationships.create'))
    and owner_person_id = (select authz.person_id())
  );

create policy company_contacts_update on public.company_contacts
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      case (select authz.scope_for('relationships.edit'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (select authz.in_my_departments(public.company_contacts.owner_person_id))
        when 'TEAM' then owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(public.company_contacts.owner_person_id))
        when 'PROJECT' then false
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
      or (select authz.has_record_grant('company_contact', public.company_contacts.id, 'relationships.edit'))
    )
  )
  with check (
    org_id = (select authz.org_id())
  );

-- ── company_links ────────────────────────────────────────────────────────────────

create policy company_links_select on public.company_links
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      case (select authz.scope_for('relationships.view'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (select authz.in_my_departments(public.company_links.owner_person_id))
        when 'TEAM' then owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(public.company_links.owner_person_id))
        when 'PROJECT' then false
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
      or (select authz.has_record_grant('company_link', public.company_links.id, 'relationships.view'))
    )
  );

create policy company_links_insert on public.company_links
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('relationships.create'))
    and owner_person_id = (select authz.person_id())
  );

create policy company_links_update on public.company_links
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      case (select authz.scope_for('relationships.edit'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (select authz.in_my_departments(public.company_links.owner_person_id))
        when 'TEAM' then owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(public.company_links.owner_person_id))
        when 'PROJECT' then false
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
      or (select authz.has_record_grant('company_link', public.company_links.id, 'relationships.edit'))
    )
  )
  with check (
    org_id = (select authz.org_id())
  );

-- ── contact_links ────────────────────────────────────────────────────────────────

create policy contact_links_select on public.contact_links
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      case (select authz.scope_for('relationships.view'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (select authz.in_my_departments(public.contact_links.owner_person_id))
        when 'TEAM' then owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(public.contact_links.owner_person_id))
        when 'PROJECT' then false
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
      or (select authz.has_record_grant('contact_link', public.contact_links.id, 'relationships.view'))
    )
  );

create policy contact_links_insert on public.contact_links
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('relationships.create'))
    and owner_person_id = (select authz.person_id())
  );

create policy contact_links_update on public.contact_links
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      case (select authz.scope_for('relationships.edit'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (select authz.in_my_departments(public.contact_links.owner_person_id))
        when 'TEAM' then owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(public.contact_links.owner_person_id))
        when 'PROJECT' then false
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
      or (select authz.has_record_grant('contact_link', public.contact_links.id, 'relationships.edit'))
    )
  )
  with check (
    org_id = (select authz.org_id())
  );

-- Default privileges already gave app_user select/insert/update on new tables; the
-- DELETE half is revoked explicitly because nothing here may be hard-deleted by the
-- runtime roles.
revoke delete on public.company_contacts, public.company_links, public.contact_links
  from app_user, app_admin;

-- ═════════════════════════════════════════════════════════════════════════════════
-- permission catalogue — the Track B crm keys
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- All 8 Track B keys, seeded by BOTH the relationships and the activities
-- migrations so seed_system_roles stays complete regardless of apply order.
-- (This stream seeds relationships.*, its sibling seeds activities.* — either
-- migration alone makes the catalogue whole.)

insert into public.permissions (key, resource, action, module, description, is_sensitive)
select
  c.key,
  substring(c.key from '^(.*)\.[^.]+$'),
  substring(c.key from '\.([^.]+)$'),
  c.module,
  c.description,
  c.is_sensitive
from (values
  -- Relationships
  ('relationships.view',   'crm', false, 'See CRM relationship links'),
  ('relationships.create', 'crm', false, 'Link CRM records'),
  ('relationships.edit',   'crm', false, 'Change CRM relationship links'),
  ('relationships.delete', 'crm', false, 'Unlink CRM records'),
  -- Activities (sibling stream's keys; both migrations seed all 8)
  ('activities.view',      'crm', false, 'See CRM activity records'),
  ('activities.create',    'crm', false, 'Log CRM activities'),
  ('activities.edit',      'crm', false, 'Change CRM activity records'),
  ('activities.delete',    'crm', false, 'Delete CRM activity records')
) as c(key, module, is_sensitive, description)
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════════
-- Role-grant matrix fix — the Track B crm keys reach the standard roles
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The catalogue seeds above are not enough on their own: seed_system_roles()
-- (migration 0008) grants non-SUPER_ADMIN roles from a hardcoded VALUES matrix.
-- Two halves, both needed:
--
--   1. CREATE OR REPLACE seed_system_roles(): the function body below is copied
--      VERBATIM from migration 0033; the Track B section adds the relationships.*
--      and activities.* rows for ADMIN (GLOBAL), SALES_MANAGER (DEPARTMENT) and
--      SALES (SELF on view/create/edit — no delete). Migration 0033 itself is
--      never edited — it is already applied.
--   2. Backfill below: organizations that already exist get the same grants for
--      the 8 new keys only (SUPER_ADMIN also gets the 8 at GLOBAL, like 0033).

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

    -- ── Phase 2 Track B: relationships + activities (migration 0035) ─────────
    -- Seeded by BOTH the relationships and activities migrations so the matrix is
    -- complete regardless of apply order. ADMIN at GLOBAL, SALES_MANAGER at
    -- DEPARTMENT, SALES at SELF (view/create/edit — no delete, mirroring the
    -- CRM Core SELF column).
    -- ADMIN
    ('ADMIN','relationships.view','GLOBAL'),('ADMIN','relationships.create','GLOBAL'),
    ('ADMIN','relationships.edit','GLOBAL'),('ADMIN','relationships.delete','GLOBAL'),
    ('ADMIN','activities.view','GLOBAL'),('ADMIN','activities.create','GLOBAL'),
    ('ADMIN','activities.edit','GLOBAL'),('ADMIN','activities.delete','GLOBAL'),
    -- SALES_MANAGER
    ('SALES_MANAGER','relationships.view','DEPARTMENT'),('SALES_MANAGER','relationships.create','DEPARTMENT'),
    ('SALES_MANAGER','relationships.edit','DEPARTMENT'),('SALES_MANAGER','relationships.delete','DEPARTMENT'),
    ('SALES_MANAGER','activities.view','DEPARTMENT'),('SALES_MANAGER','activities.create','DEPARTMENT'),
    ('SALES_MANAGER','activities.edit','DEPARTMENT'),('SALES_MANAGER','activities.delete','DEPARTMENT'),
    -- SALES (SELF on view/create/edit only — no delete)
    ('SALES','relationships.view','SELF'),('SALES','relationships.create','SELF'),
    ('SALES','relationships.edit','SELF'),
    ('SALES','activities.view','SELF'),('SALES','activities.create','SELF'),
    ('SALES','activities.edit','SELF')
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
-- — the same pattern migration 0010 used for record_grants.manage.

-- ── Backfill: existing organizations ──────────────────────────────────────────
--
-- Only the 8 new Track B keys are backfilled (SUPER_ADMIN gets all 8 at GLOBAL,
-- ADMIN all 8 at GLOBAL, SALES_MANAGER all 8 at DEPARTMENT, SALES 6 at SELF).
-- The protection trigger is disabled and re-enabled exactly like migration 0033.

alter table public.role_permissions disable trigger role_permissions_enforce_protection;

insert into public.role_permissions (role_id, permission_id, scope)
select r.id, p.id, m.scope::public.access_scope
from public.roles r
cross join public.permissions p
join (values
  ('SUPER_ADMIN','relationships.view','GLOBAL'),('SUPER_ADMIN','relationships.create','GLOBAL'),
  ('SUPER_ADMIN','relationships.edit','GLOBAL'),('SUPER_ADMIN','relationships.delete','GLOBAL'),
  ('SUPER_ADMIN','activities.view','GLOBAL'),('SUPER_ADMIN','activities.create','GLOBAL'),
  ('SUPER_ADMIN','activities.edit','GLOBAL'),('SUPER_ADMIN','activities.delete','GLOBAL'),
  ('ADMIN','relationships.view','GLOBAL'),('ADMIN','relationships.create','GLOBAL'),
  ('ADMIN','relationships.edit','GLOBAL'),('ADMIN','relationships.delete','GLOBAL'),
  ('ADMIN','activities.view','GLOBAL'),('ADMIN','activities.create','GLOBAL'),
  ('ADMIN','activities.edit','GLOBAL'),('ADMIN','activities.delete','GLOBAL'),
  ('SALES_MANAGER','relationships.view','DEPARTMENT'),('SALES_MANAGER','relationships.create','DEPARTMENT'),
  ('SALES_MANAGER','relationships.edit','DEPARTMENT'),('SALES_MANAGER','relationships.delete','DEPARTMENT'),
  ('SALES_MANAGER','activities.view','DEPARTMENT'),('SALES_MANAGER','activities.create','DEPARTMENT'),
  ('SALES_MANAGER','activities.edit','DEPARTMENT'),('SALES_MANAGER','activities.delete','DEPARTMENT'),
  ('SALES','relationships.view','SELF'),('SALES','relationships.create','SELF'),
  ('SALES','relationships.edit','SELF'),
  ('SALES','activities.view','SELF'),('SALES','activities.create','SELF'),
  ('SALES','activities.edit','SELF')
) as m(role_key, permission_key, scope)
  on r.key = m.role_key and p.key = m.permission_key
on conflict do nothing;

alter table public.role_permissions enable trigger role_permissions_enforce_protection;

-- End of migration 0035.
