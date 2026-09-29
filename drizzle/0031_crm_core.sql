-- PRAVSHI OS — Phase 2 CRM Core: companies, contacts, deals.
--
-- The first module tables that model the business rather than the organization itself.
-- Everything here follows the Phase 1 conventions rather than inventing new ones:
--
--   Task 1.4 composite-key strategy  every relationship carries this row's org_id into
--                                    the foreign key, so a company, contact, deal and
--                                    person must all agree with it and with each other.
--   Task 1.16 RLS template           org-scoped, deleted_at-excluded, is_active()-gated,
--                                    scope_for() CASE over GLOBAL/DEPARTMENT/TEAM/PROJECT/
--                                    SELF, then the record-grant arm. PROJECT is false
--                                    until project_members exists (Phase 4).
--   Task 1.11 audit triggers         audit_row_change() at HIGH, whole-row, on all
--                                    three tables — the compensating control the owner-
--                                    reassignment and soft-delete rules cite.
--   Security review (APPROVE WITH FIXES), all incorporated:
--     F1  enforce_crm_owner_change(): a BEFORE UPDATE trigger constrains the NEW
--         owner_person_id to the caller's reachable set (self / department / team /
--         GLOBAL per their <resource>.edit scope), closing owner-reassignment
--         laundering. Fires before FK checks, closing the user-enumeration oracle.
--     F2  audit triggers attached (the contract omitted them), HIGH severity.
--     F3  stamp_crm_actor(): created_by/updated_by are stamped, never trusted —
--         overwritten on INSERT, created_by immutable on UPDATE.
--     F4  pairwise FKs (contact_id, org_id) → contacts and (company_id, org_id) →
--         companies alongside the triple pairing FK, closing the MATCH SIMPLE NULL
--         bypass (a NULL column skips the check entirely).
--
-- ── WHERE THE OWNERSHIP SEMANTICS COME FROM ───────────────────────────────────────
--
-- The architect's contract makes owner_person_id NOT NULL and the key every scope branch
-- is evaluated against: DEPARTMENT checks the owner's live engagement department,
-- TEAM checks me-or-my-report for the owner, SELF checks owner = me. The INSERT rule is
-- deliberately stricter than any scope: a row's owner must be the acting person, so a
-- CRM record can never be created "for" someone else at the database level.
--
-- ── ON DELETE SET NULL, AND WHAT IT DOES TO org_id ───────────────────────────────
--
-- contacts.company_id is (company_id, org_id) → companies(id, org_id) ON DELETE SET
-- NULL. Postgres nulls EVERY column of a composite FK on the referenced delete, so
-- hard-deleting a company would try to null the contact's org_id too — and fail on the
-- NOT NULL. That is the fail-closed direction: a company with live contacts cannot be
-- hard-deleted out from under them. The nulling path the architect wants only survives
-- for contact-free deletions, and soft deletes (deleted_at) never fire FK actions at
-- all, which is the only deletion path app_user can reach — there is no DELETE policy.
--
-- ── deal ↔ contact ↔ company CONSISTENCY ──────────────────────────────────────────
--
-- deals pins its references with three FKs, because the three-column pairing FK
--   (contact_id, company_id, org_id) → contacts(id, company_id, org_id)
-- uses MATCH SIMPLE: a NULL in any column skips the check entirely. So:
--   (contact_id, org_id) → contacts(id, org_id)      pins a contact to the deal's org
--   (company_id, org_id) → companies(id, org_id)     pins a company to the deal's org
--   (contact_id, company_id, org_id) → contacts(...) pins the pairing itself —
--     a contact with a company must be referenced together with that same company.
-- A deal may still name neither (both nullable). None is DEFERRABLE.
--
-- ── deals_stamp_closed_at ─────────────────────────────────────────────────────────
--
-- A deal closes exactly once per lifecycle: the first time stage enters WON or LOST,
-- closed_at is stamped (unless the writer named one); reopening to an open stage
-- clears it, because a reopened deal is not closed. WON → LOST keeps the original
-- stamp — the close happened when it happened.

-- ═════════════════════════════════════════════════════════════════════════════════
-- companies
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  name text not null,
  domain citext,
  industry text,
  size text,
  website text,
  phone text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country_code char(2) not null default 'IN',

  owner_person_id uuid not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.people (id),
  updated_by uuid references public.people (id),
  deleted_at timestamptz,

  constraint companies_name_not_blank check (length(btrim(name)) > 0),
  constraint companies_size check (
    size is null or size in ('STARTUP', 'SMB', 'MID_MARKET', 'ENTERPRISE')
  ),
  constraint companies_id_org_unique unique (id, org_id)
);

alter table public.companies
  add constraint companies_owner_same_org
  foreign key (owner_person_id, org_id) references public.people (id, org_id);

create index companies_org_idx on public.companies (org_id) where deleted_at is null;
create index companies_owner_idx
  on public.companies (org_id, owner_person_id) where deleted_at is null;
-- A soft-deleted company must not block reuse of its domain.
create unique index companies_org_domain_unique
  on public.companies (org_id, domain)
  where domain is not null and deleted_at is null;

create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

comment on table public.companies is
  'Customer and prospect organizations. owner_person_id is the single person every '
  'scope branch is evaluated against.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- contacts
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  company_id uuid,

  first_name text not null,
  last_name text,
  email citext,
  phone text,
  title text,
  department text,

  owner_person_id uuid not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.people (id),
  updated_by uuid references public.people (id),
  deleted_at timestamptz,

  constraint contacts_first_name_not_blank check (length(btrim(first_name)) > 0),
  constraint contacts_id_org_unique unique (id, org_id),
  -- The deal FK target: a deal names (contact_id, company_id, org_id) together.
  constraint contacts_id_company_org_unique unique (id, company_id, org_id)
);

alter table public.contacts
  add constraint contacts_owner_same_org
  foreign key (owner_person_id, org_id) references public.people (id, org_id);

-- See the header note: Postgres nulls every FK column, so a company with live contacts
-- cannot be hard-deleted out from under them — the NOT NULL on org_id makes that a
-- hard error, which is the fail-closed direction.
alter table public.contacts
  add constraint contacts_company_same_org
  foreign key (company_id, org_id) references public.companies (id, org_id)
  on delete set null;

create index contacts_org_idx on public.contacts (org_id) where deleted_at is null;
create index contacts_company_idx
  on public.contacts (org_id, company_id)
  where company_id is not null and deleted_at is null;
create index contacts_owner_idx
  on public.contacts (org_id, owner_person_id) where deleted_at is null;
-- A soft-deleted contact must not block reuse of their email.
create unique index contacts_org_email_unique
  on public.contacts (org_id, email)
  where email is not null and deleted_at is null;

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

comment on table public.contacts is
  'People at customer and prospect organizations. company_id is nullable: a contact may '
  'exist before any company is linked.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- deals
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  title text not null,
  company_id uuid,
  contact_id uuid,

  value numeric(19, 4),
  currency char(3) not null default 'INR',
  stage text not null default 'NEW',
  probability integer,
  expected_close_date date,
  closed_at timestamptz,

  owner_person_id uuid not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.people (id),
  updated_by uuid references public.people (id),
  deleted_at timestamptz,

  constraint deals_title_not_blank check (length(btrim(title)) > 0),
  constraint deals_stage check (
    stage in ('NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST')
  ),
  constraint deals_value_non_negative check (value is null or value >= 0),
  constraint deals_probability check (
    probability is null or (probability >= 0 and probability <= 100)
  ),
  constraint deals_id_org_unique unique (id, org_id)
);

alter table public.deals
  add constraint deals_owner_same_org
  foreign key (owner_person_id, org_id) references public.people (id, org_id);

alter table public.deals
  add constraint deals_company_same_org
  foreign key (company_id, org_id) references public.companies (id, org_id);

-- The triple FK uses MATCH SIMPLE (the Postgres default): if any referencing column is
-- NULL the constraint passes unchecked, so it alone cannot pin a contact to the deal's
-- org when company_id is NULL, nor check company_id at all when contact_id is NULL.
-- The pairwise FKs below close those holes; the triple then only enforces the
-- pairing (a non-null contact must belong to the deal's company). None is DEFERRABLE.
alter table public.deals
  add constraint deals_contact_same_org
  foreign key (contact_id, org_id) references public.contacts (id, org_id);

alter table public.deals
  add constraint deals_contact_company_pair
  foreign key (contact_id, company_id, org_id)
  references public.contacts (id, company_id, org_id);

create index deals_org_idx on public.deals (org_id) where deleted_at is null;
create index deals_company_idx
  on public.deals (org_id, company_id)
  where company_id is not null and deleted_at is null;
create index deals_contact_idx
  on public.deals (org_id, contact_id)
  where contact_id is not null and deleted_at is null;
create index deals_owner_idx
  on public.deals (org_id, owner_person_id) where deleted_at is null;
create index deals_org_stage_idx
  on public.deals (org_id, stage) where deleted_at is null;

create trigger deals_set_updated_at
  before update on public.deals
  for each row execute function public.set_updated_at();

comment on table public.deals is
  'Sales pipeline deals. stage is the pipeline position; closed_at is stamped by '
  'deals_stamp_closed_at, not written by hand.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- actor stamping — created_by / updated_by are stamped, never trusted (F3)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- No actor-stamping trigger existed in Phase 1 (verified by the security review), so
-- without this, callers could write arbitrary created_by/updated_by and forge the
-- attribution the audit trail depends on. On INSERT the trigger OVERWRITES whatever
-- the caller supplied — a forged created_by does not survive. On UPDATE, created_by
-- is immutable (changing it raises 42501) and updated_by is restamped to the actor.
--
-- NULL identity (a migration, a seed) stamps NULL, and the AFTER audit trigger skips
-- actorless writes — the same "no synthetic actor" rule as audit_row_change().
create function public.stamp_crm_actor() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := authz.person_id();  -- overwrite, never trust
    new.updated_by := authz.person_id();
    return new;
  end if;
  if new.created_by is distinct from old.created_by then
    raise exception 'created_by is immutable' using errcode = '42501';
  end if;
  new.updated_by := authz.person_id();
  return new;
end;
$$;

comment on function public.stamp_crm_actor() is
  'BEFORE INSERT/UPDATE on the CRM tables: overwrites created_by/updated_by from '
  'authz.person_id() on insert, forbids created_by changes on update, restamps '
  'updated_by. Attribution is stamped, never caller-supplied.';

revoke all on function public.stamp_crm_actor() from public;

create trigger companies_stamp_actor
  before insert or update on public.companies
  for each row execute function public.stamp_crm_actor();

create trigger contacts_stamp_actor
  before insert or update on public.contacts
  for each row execute function public.stamp_crm_actor();

create trigger deals_stamp_actor
  before insert or update on public.deals
  for each row execute function public.stamp_crm_actor();

-- ═════════════════════════════════════════════════════════════════════════════════
-- owner reassignment — the new owner must be within the caller's reach (F1)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The UPDATE WITH CHECK pins org_id, but that alone let an edit-holder hand a row to
-- ANY person in the org — laundering SELF-scope visibility onto someone who was never
-- granted it (the new owner passes the `SELF → owner = me` arms for view AND edit),
-- planting rows on victims, or silently moving rows out of colleagues' departments.
--
-- So the NEW owner is constrained to the caller's reachable set: themselves, someone
-- in their department/team per their edit scope, or (for GLOBAL holders) anyone. Only
-- the new owner is checked — the old row was already authorized by USING — which keeps
-- the blessed self-reassignment (a record-grant holder taking a row for themselves)
-- working. The trigger fires BEFORE constraint checks, so a 42501 here also closes the
-- FK-violation user-enumeration oracle for non-GLOBAL holders.
create function authz.crm_owner_reachable(p_permission text, p_person uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person is not null
    and (
      p_person = authz.person_id()
      or (
        authz.is_active()
        and case (select authz.scope_for(p_permission))
              when 'GLOBAL' then true
              when 'DEPARTMENT' then (select authz.in_my_departments(p_person))
              when 'TEAM' then (select authz.reports_to_me(p_person))
              else false
            end
      )
    )
$$;

comment on function authz.crm_owner_reachable(text, uuid) is
  'Whether the given person is someone the caller may hand a CRM row to under the '
  'named <resource>.edit permission: themselves, or someone in their department/team '
  'scope, or anyone for GLOBAL holders. Fail-closed on no identity or no scope.';

revoke all on function authz.crm_owner_reachable(text, uuid) from public;
grant execute on function authz.crm_owner_reachable(text, uuid) to app_user, app_admin;

create function public.enforce_crm_owner_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- TG_ARGV[0]: the '<resource>.edit' permission key for this table.
  -- Only the NEW owner is checked: the old row was already authorized by USING.
  -- Checking only the new owner keeps the blessed record-grant self-reassignment working.
  if new.owner_person_id is distinct from old.owner_person_id
     and not authz.crm_owner_reachable(tg_argv[0], new.owner_person_id) then
    raise exception 'owner_person_id may only move to someone within your % scope', tg_argv[0]
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.enforce_crm_owner_change() is
  'BEFORE UPDATE on the CRM tables: the new owner_person_id must be within the '
  'caller''s reachable set for the table''s <resource>.edit permission (TG_ARGV[0]). '
  'Raises 42501 before FK checks, closing the user-enumeration oracle.';

revoke all on function public.enforce_crm_owner_change() from public;

create trigger companies_enforce_owner_change
  before update on public.companies
  for each row execute function public.enforce_crm_owner_change('companies.edit');

create trigger contacts_enforce_owner_change
  before update on public.contacts
  for each row execute function public.enforce_crm_owner_change('contacts.edit');

create trigger deals_enforce_owner_change
  before update on public.deals
  for each row execute function public.enforce_crm_owner_change('deals.edit');

-- ═════════════════════════════════════════════════════════════════════════════════
-- deals_stamp_closed_at — the close of a deal, stamped once per lifecycle
-- ═════════════════════════════════════════════════════════════════════════════════

create function public.deals_stamp_closed_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.stage in ('WON', 'LOST') and NEW.closed_at is null then
      NEW.closed_at := now();
    end if;
  elsif TG_OP = 'UPDATE' then
    if NEW.stage in ('WON', 'LOST')
       and OLD.stage not in ('WON', 'LOST')
       and NEW.closed_at is null then
      NEW.closed_at := now();
    elsif NEW.stage not in ('WON', 'LOST')
          and OLD.stage in ('WON', 'LOST') then
      NEW.closed_at := null;
    end if;
  end if;
  return NEW;
end;
$$;

comment on function public.deals_stamp_closed_at() is
  'BEFORE INSERT/UPDATE on deals: stamps closed_at the first time stage enters WON or '
  'LOST, keeps the original stamp across WON↔LOST, and clears it when the deal reopens. '
  'A writer-supplied closed_at is always respected.';

revoke all on function public.deals_stamp_closed_at() from public;

create trigger deals_stamp_closed_at
  before insert or update on public.deals
  for each row execute function public.deals_stamp_closed_at();

-- ═════════════════════════════════════════════════════════════════════════════════
-- audit — HIGH, whole-row (F2)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The contract cited audit as the compensating control for owner reassignment and
-- soft-deletes — but never attached the triggers. Attached here, AFTER INSERT OR
-- UPDATE OR DELETE, at HIGH severity: owner reassignment changes who can SEE a record,
-- which is access-affecting, like the role changes Task 1.11 marks HIGH.
--
-- Whole-row capture, no allow-list: audit_logs is GLOBAL-readable only by holders of
-- audit_logs.view, and the matrix already gives ADMIN people.export at GLOBAL, so no
-- new PII exposure class is created — while the forensic value of a complete row
-- image on the highest-risk writable tables is kept. (If the founder wants less, the
-- 4th argument to audit_row_change() takes an allow-list per table.)
create trigger companies_audit
  after insert or update or delete on public.companies
  for each row execute function public.audit_row_change('company', 'HIGH', 'id');

create trigger contacts_audit
  after insert or update or delete on public.contacts
  for each row execute function public.audit_row_change('contact', 'HIGH', 'id');

create trigger deals_audit
  after insert or update or delete on public.deals
  for each row execute function public.audit_row_change('deal', 'HIGH', 'id');

-- ═════════════════════════════════════════════════════════════════════════════════
-- RLS
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The 4.2 template, keyed on each table's <entity>.view / <entity>.edit permission and
-- its record-grant entity type. Two deliberate properties, both from the contract:
--
--   1. There is no unconditional self-visibility. Seeing even your own CRM record is
--      access (is_active() and a scope arm), not identity — unlike people/engagements,
--      where hiding yourself would hide the fact that you were offboarded.
--   2. INSERT forces owner_person_id = authz.person_id(). A CRM row can never be
--      created "for" someone else: ownership is a fact of creation, not a field to
--      assign.
--
-- No DELETE policy on any of the three: CRM records are soft-deleted through UPDATE,
-- and hard deletion is app_owner's alone.

alter table public.companies enable row level security;
alter table public.companies force row level security;

alter table public.contacts enable row level security;
alter table public.contacts force row level security;

alter table public.deals enable row level security;
alter table public.deals force row level security;

create policy companies_owner_all on public.companies
  for all to app_owner using (true) with check (true);

create policy contacts_owner_all on public.contacts
  for all to app_owner using (true) with check (true);

create policy deals_owner_all on public.deals
  for all to app_owner using (true) with check (true);

-- ── companies ────────────────────────────────────────────────────────────────────

create policy companies_select on public.companies
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      case (select authz.scope_for('companies.view'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (select authz.in_my_departments(public.companies.owner_person_id))
        when 'TEAM' then owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(public.companies.owner_person_id))
        when 'PROJECT' then false
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
      or (select authz.has_record_grant('company', public.companies.id, 'companies.view'))
    )
  );

create policy companies_insert on public.companies
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('companies.create'))
    and owner_person_id = (select authz.person_id())
  );

create policy companies_update on public.companies
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      case (select authz.scope_for('companies.edit'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (select authz.in_my_departments(public.companies.owner_person_id))
        when 'TEAM' then owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(public.companies.owner_person_id))
        when 'PROJECT' then false
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
      or (select authz.has_record_grant('company', public.companies.id, 'companies.edit'))
    )
  )
  with check (
    org_id = (select authz.org_id())
  );

-- ── contacts ─────────────────────────────────────────────────────────────────────

create policy contacts_select on public.contacts
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      case (select authz.scope_for('contacts.view'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (select authz.in_my_departments(public.contacts.owner_person_id))
        when 'TEAM' then owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(public.contacts.owner_person_id))
        when 'PROJECT' then false
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
      or (select authz.has_record_grant('contact', public.contacts.id, 'contacts.view'))
    )
  );

create policy contacts_insert on public.contacts
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('contacts.create'))
    and owner_person_id = (select authz.person_id())
  );

create policy contacts_update on public.contacts
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      case (select authz.scope_for('contacts.edit'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (select authz.in_my_departments(public.contacts.owner_person_id))
        when 'TEAM' then owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(public.contacts.owner_person_id))
        when 'PROJECT' then false
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
      or (select authz.has_record_grant('contact', public.contacts.id, 'contacts.edit'))
    )
  )
  with check (
    org_id = (select authz.org_id())
  );

-- ── deals ────────────────────────────────────────────────────────────────────────

create policy deals_select on public.deals
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      case (select authz.scope_for('deals.view'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (select authz.in_my_departments(public.deals.owner_person_id))
        when 'TEAM' then owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(public.deals.owner_person_id))
        when 'PROJECT' then false
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
      or (select authz.has_record_grant('deal', public.deals.id, 'deals.view'))
    )
  );

create policy deals_insert on public.deals
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('deals.create'))
    and owner_person_id = (select authz.person_id())
  );

create policy deals_update on public.deals
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (
      case (select authz.scope_for('deals.edit'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (select authz.in_my_departments(public.deals.owner_person_id))
        when 'TEAM' then owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(public.deals.owner_person_id))
        when 'PROJECT' then false
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
      or (select authz.has_record_grant('deal', public.deals.id, 'deals.edit'))
    )
  )
  with check (
    org_id = (select authz.org_id())
  );

-- Default privileges already gave app_user select/insert/update on new tables; the
-- DELETE half of the for-all contract is revoked explicitly because nothing here
-- may be hard-deleted by the runtime roles.
revoke delete on public.companies, public.contacts, public.deals from app_user, app_admin;

-- ═════════════════════════════════════════════════════════════════════════════════
-- permission catalogue — the crm module
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Eleven keys, resource/action derived from the key exactly as the Task 1.7 seed does.
-- The export pair is sensitive (threat T-11, bulk export): the catalogue marks the
-- boundary; the application enforces it.

insert into public.permissions (key, resource, action, module, description, is_sensitive)
select
  c.key,
  substring(c.key from '^(.*)\.[^.]+$'),
  substring(c.key from '\.([^.]+)$'),
  c.module,
  c.description,
  c.is_sensitive
from (values
  -- Companies
  ('companies.view',   'crm', false, 'See companies'),
  ('companies.create', 'crm', false, 'Create a company'),
  ('companies.edit',   'crm', false, 'Change a company'),
  -- Contacts
  ('contacts.view',    'crm', false, 'See contacts'),
  ('contacts.create',  'crm', false, 'Create a contact'),
  ('contacts.edit',    'crm', false, 'Change a contact'),
  ('contacts.export',  'crm', true,  'Export contacts in bulk (threat T-11)'),
  -- Deals
  ('deals.view',       'crm', false, 'See deals'),
  ('deals.create',     'crm', false, 'Create a deal'),
  ('deals.edit',       'crm', false, 'Change a deal'),
  ('deals.export',     'crm', true,  'Export deals in bulk (threat T-11)')
) as c(key, module, is_sensitive, description)
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════════
-- SUPER_ADMIN backfill — GLOBAL on the new keys for existing organizations
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Organizations created from here on need nothing: seed_system_roles() cross-joins the
-- whole catalogue, so the new keys arrive automatically. This is only for orgs that
-- already exist. The protection trigger guards runtime changes to the authorization
-- model, which a migration is not, so it is disabled for the insert and re-enabled
-- immediately — the same pattern migration 0010 used for record_grants.manage.

alter table public.role_permissions disable trigger role_permissions_enforce_protection;

insert into public.role_permissions (role_id, permission_id, scope)
select r.id, p.id, 'GLOBAL'::public.access_scope
from public.roles r
cross join public.permissions p
where r.key = 'SUPER_ADMIN'
  and p.key in (
    'companies.view', 'companies.create', 'companies.edit',
    'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.export',
    'deals.view', 'deals.create', 'deals.edit', 'deals.export'
  )
on conflict do nothing;

alter table public.role_permissions enable trigger role_permissions_enforce_protection;
