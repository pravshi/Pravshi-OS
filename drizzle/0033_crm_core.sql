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
-- No EXECUTE grant: the only in-DB caller is enforce_crm_owner_change(), which is
-- SECURITY DEFINER and needs none. Granting it would expose a scope-membership
-- oracle (probing arbitrary (permission, person) pairs).

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

    and deleted_at is null    and (select authz.is_active())
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

    and deleted_at is null    and (select authz.is_active())
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

    and deleted_at is null    and (select authz.is_active())
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
-- Fourteen keys, resource/action derived from the key exactly as the Task 1.7 seed does.
-- The export pair is sensitive (threat T-11, bulk export): the catalogue marks the
-- boundary; the application enforces it. The delete trio follows the catalogue
-- convention (dedicated .delete keys exist for users, leads, clients, projects,
-- tasks, documents): "can edit but cannot delete" must be expressible.

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
  ('companies.delete', 'crm', false, 'Delete a company'),
  -- Contacts
  ('contacts.view',    'crm', false, 'See contacts'),
  ('contacts.create',  'crm', false, 'Create a contact'),
  ('contacts.edit',    'crm', false, 'Change a contact'),
  ('contacts.delete',  'crm', false, 'Delete a contact'),
  ('contacts.export',  'crm', true,  'Export contacts in bulk (threat T-11)'),
  -- Deals
  ('deals.view',       'crm', false, 'See deals'),
  ('deals.create',     'crm', false, 'Create a deal'),
  ('deals.edit',       'crm', false, 'Change a deal'),
  ('deals.delete',     'crm', false, 'Delete a deal'),
  ('deals.export',     'crm', true,  'Export deals in bulk (threat T-11)')
) as c(key, module, is_sensitive, description)
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════════
-- Role-grant matrix fix — the crm keys reach the standard roles
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The catalogue seeds above are not enough on their own: seed_system_roles()
-- (migration 0008) grants non-SUPER_ADMIN roles from a hardcoded VALUES matrix,
-- not from a catalogue cross-join, so ADMIN/SALES_MANAGER/SALES would hold the
-- legacy leads.*/clients.* keys (which authorize nothing — no policy references
-- them) and none of the new crm keys. Two halves, both needed:
--
--   1. CREATE OR REPLACE seed_system_roles(): the matrix gains the crm rows for
--      ADMIN (GLOBAL), SALES_MANAGER (DEPARTMENT) and SALES (SELF on
--      view/create/edit — mirroring the leads.* SELF column: no delete, no
--      export). Every organization created from here on is correct.
--   2. Backfill below: organizations that already exist get the same grants.
--
-- The legacy leads.* rows are removed from the matrix entirely (the CRM module
-- replaces the legacy sales vocabulary). The clients.* rows are removed for the
-- CRM roles (ADMIN, SALES_MANAGER, SALES) — the non-CRM roles (PROJECT_MANAGER,
-- DEVELOPER, VIBECODER, INTERN, FINANCE) keep their clients.* grants, which belong
-- to the project-management domain, not CRM. The backfill below deletes the
-- corresponding dangling grants from existing organizations.
-- Migration 0008 itself is never edited — it is already applied.

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
    ('SALES','deals.edit','SELF')
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

alter table public.role_permissions disable trigger role_permissions_enforce_protection;

insert into public.role_permissions (role_id, permission_id, scope)
select r.id, p.id, m.scope::public.access_scope
from public.roles r
cross join public.permissions p
join (values
  ('SUPER_ADMIN','companies.view','GLOBAL'),('SUPER_ADMIN','companies.create','GLOBAL'),
  ('SUPER_ADMIN','companies.edit','GLOBAL'),('SUPER_ADMIN','companies.delete','GLOBAL'),
  ('SUPER_ADMIN','contacts.view','GLOBAL'),('SUPER_ADMIN','contacts.create','GLOBAL'),
  ('SUPER_ADMIN','contacts.edit','GLOBAL'),('SUPER_ADMIN','contacts.delete','GLOBAL'),
  ('SUPER_ADMIN','contacts.export','GLOBAL'),
  ('SUPER_ADMIN','deals.view','GLOBAL'),('SUPER_ADMIN','deals.create','GLOBAL'),
  ('SUPER_ADMIN','deals.edit','GLOBAL'),('SUPER_ADMIN','deals.delete','GLOBAL'),
  ('SUPER_ADMIN','deals.export','GLOBAL'),
  ('ADMIN','companies.view','GLOBAL'),('ADMIN','companies.create','GLOBAL'),
  ('ADMIN','companies.edit','GLOBAL'),('ADMIN','companies.delete','GLOBAL'),
  ('ADMIN','contacts.view','GLOBAL'),('ADMIN','contacts.create','GLOBAL'),
  ('ADMIN','contacts.edit','GLOBAL'),('ADMIN','contacts.delete','GLOBAL'),
  ('ADMIN','contacts.export','GLOBAL'),
  ('ADMIN','deals.view','GLOBAL'),('ADMIN','deals.create','GLOBAL'),
  ('ADMIN','deals.edit','GLOBAL'),('ADMIN','deals.delete','GLOBAL'),
  ('ADMIN','deals.export','GLOBAL'),
  ('SALES_MANAGER','companies.view','DEPARTMENT'),('SALES_MANAGER','companies.create','DEPARTMENT'),
  ('SALES_MANAGER','companies.edit','DEPARTMENT'),('SALES_MANAGER','companies.delete','DEPARTMENT'),
  ('SALES_MANAGER','contacts.view','DEPARTMENT'),('SALES_MANAGER','contacts.create','DEPARTMENT'),
  ('SALES_MANAGER','contacts.edit','DEPARTMENT'),('SALES_MANAGER','contacts.delete','DEPARTMENT'),
  ('SALES_MANAGER','contacts.export','DEPARTMENT'),
  ('SALES_MANAGER','deals.view','DEPARTMENT'),('SALES_MANAGER','deals.create','DEPARTMENT'),
  ('SALES_MANAGER','deals.edit','DEPARTMENT'),('SALES_MANAGER','deals.delete','DEPARTMENT'),
  ('SALES_MANAGER','deals.export','DEPARTMENT'),
  ('SALES','companies.view','SELF'),('SALES','companies.create','SELF'),
  ('SALES','companies.edit','SELF'),
  ('SALES','contacts.view','SELF'),('SALES','contacts.create','SELF'),
  ('SALES','contacts.edit','SELF'),
  ('SALES','deals.view','SELF'),('SALES','deals.create','SELF'),
  ('SALES','deals.edit','SELF')
) as m(role_key, permission_key, scope)
  on r.key = m.role_key and p.key = m.permission_key
on conflict do nothing;

-- ── Legacy grant cleanup: remove dangling leads.* / clients.* ────────────────
--
-- The CRM module replaces the legacy sales vocabulary. Delete the dangling
-- grants from existing organizations:
--   * all leads.* grants (no leads table exists; fully replaced by CRM)
--   * clients.* grants for the CRM roles (ADMIN, SALES_MANAGER, SALES)
-- The non-CRM roles keep their clients.* grants (project-management domain).

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and (
    p.key like 'leads.%'
    or (
      p.key like 'clients.%'
      and r.key in ('ADMIN', 'SALES_MANAGER', 'SALES')
    )
  );

alter table public.role_permissions enable trigger role_permissions_enforce_protection;
