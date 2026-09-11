-- PRAVSHI OS — Phase 1 Task 1.2: the tenancy root and the human identity record.
--
-- These are the first real business tables, which means tests/guards/rls-enabled.test.ts
-- stops passing vacuously against an empty schema and starts being a live gate.
--
-- ── ON THE POLICIES BELOW, AND WHAT THEY DELIBERATELY DO NOT YET SAY ──────────────
--
-- database.md §4.2 defines the standard policy shape in terms of authz helpers:
--   authz.org_id()          reads current_setting only   → created here
--   authz.person_id()       reads current_setting only   → created here
--   authz.aal()             reads current_setting only   → created here
--   authz.my_departments()  reads departments            → Task 1.4
--   authz.is_active()       reads engagements            → Task 1.5
--   authz.scope_for()/has() reads role_permissions       → Task 1.7
--
-- Only the three setting-readers can exist today; the rest read tables that do not
-- exist. Rather than duplicate their logic inline — which would leave two definitions
-- of the security model to keep in agreement — the policies here express only what is
-- provable now: tenant isolation, soft-delete exclusion, and SELF scope on people.
--
-- The direction of travel matters. A policy that starts SELF-only and is widened by
-- 1.7 once roles exist is safe at every intermediate commit. A policy that starts
-- org-wide "until roles arrive" is a hole that has to be remembered and closed.

create extension if not exists citext;

-- ── shared trigger helpers ────────────────────────────────────────────────────────
-- Not SECURITY DEFINER: triggers fire on their own authority, so these need no
-- elevated rights and are not granted to anyone.

create function public.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Maintains updated_at on write. The universal column convention, applied by trigger.';

-- Task 1.1 guaranteed the COUNTER never re-issues a value. That is not the same as the
-- stored code being immutable: without this, an UPDATE could point a person at a code
-- that already identifies someone else, and every historical reference to it silently
-- changes meaning. Enforced in the database because application validation is bypassable
-- by anything holding an UPDATE grant.
create function public.enforce_immutable_code() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.code is distinct from old.code then
    raise exception 'code is immutable and cannot be changed once assigned'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.enforce_immutable_code() is
  'Rejects any UPDATE that changes an assigned identity code.';

-- ── organizations — the tenancy root ──────────────────────────────────────────────
-- No org_id column: this table IS the organization, and `id` is what every other
-- tenant-scoped table points at.

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug citext not null,
  domain citext,
  logo_url text,
  timezone text not null default 'Asia/Kolkata',
  locale text not null default 'en-IN',
  status text not null default 'ACTIVE',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint organizations_name_not_blank check (length(btrim(name)) > 0),
  constraint organizations_slug_valid check (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  constraint organizations_status_valid check (status in ('ACTIVE', 'SUSPENDED', 'ARCHIVED'))
);

-- Partial uniqueness: a soft-deleted organization must not block reuse of its slug.
create unique index organizations_slug_unique
  on public.organizations (slug) where deleted_at is null;
create unique index organizations_domain_unique
  on public.organizations (domain) where domain is not null and deleted_at is null;

comment on table public.organizations is
  'Tenancy root. org_id on every other tenant-scoped table references this. No '
  'cross-organization UI exists in V1, but the boundary is enforced from day one.';

-- ── people — the human, independent of any login or engagement ────────────────────

create type public.person_status as enum ('PROSPECT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

create table public.people (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  code text not null,

  -- FK to the Better Auth user table, which does not exist until Task 1.12; the column
  -- is specified by the blueprint and is NULL for anyone with no login (a candidate, an
  -- alumnus). The constraint is added by that task, not invented here.
  auth_user_id uuid,

  full_legal_name text not null,
  preferred_name text,
  work_email citext,
  personal_email citext,
  phone text,
  date_of_birth date,
  photo_url text,
  location text,
  timezone text,

  person_status public.person_status not null default 'PROSPECT',
  -- Sessions issued before this instant are dead. Bulk invalidation without a token
  -- epoch; consumed by Task 1.12.
  sessions_revoked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.people (id),
  updated_by uuid references public.people (id),
  deleted_at timestamptz,

  constraint people_code_format check (code ~ '^[A-Z]{2,8}-[0-9]{4}-[0-9]{4,}$'),
  constraint people_full_legal_name_not_blank check (length(btrim(full_legal_name)) > 0)
);

-- A code identifies a person permanently, including after soft delete, so this
-- uniqueness is NOT partial: a deleted person must never have their code reissued.
create unique index people_org_code_unique on public.people (org_id, code);
create unique index people_auth_user_unique
  on public.people (auth_user_id) where auth_user_id is not null;
create unique index people_org_work_email_unique
  on public.people (org_id, work_email) where work_email is not null and deleted_at is null;

-- FK and RLS-predicate columns, per the index convention.
create index people_org_id_idx on public.people (org_id);
create index people_org_status_idx on public.people (org_id, person_status) where deleted_at is null;

create trigger people_set_updated_at
  before update on public.people
  for each row execute function public.set_updated_at();

create trigger people_code_immutable
  before update on public.people
  for each row execute function public.enforce_immutable_code();

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

comment on table public.people is
  'A human PRAVSHI has a relationship with. Never deleted, only soft-deleted. '
  'Authorization attaches to engagements, never directly to a person.';

-- ── authz helpers: the setting-readers only ───────────────────────────────────────
--
-- stable security definer with an empty search_path, per database.md §4.1. These are
-- the only functions granted to app_user besides the Task 1.1 code generator.
--
-- current_setting(..., true) returns NULL when the setting is absent, which is exactly
-- what happens to a query running outside withAuthorizedDb(). Every policy treats NULL
-- as "no identity", so such a query returns zero rows rather than every row.

create function authz.person_id() returns uuid
language sql stable security definer set search_path = ''
as $$ select nullif(current_setting('app.person_id', true), '')::uuid $$;

create function authz.org_id() returns uuid
language sql stable security definer set search_path = ''
as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;

create function authz.aal() returns text
language sql stable security definer set search_path = ''
as $$ select nullif(current_setting('app.aal', true), '') $$;

comment on function authz.person_id() is 'Identity set by withAuthorizedDb(); NULL outside it.';
comment on function authz.org_id() is 'Organization set by withAuthorizedDb(); NULL outside it.';
comment on function authz.aal() is 'Authentication assurance level for step-up checks.';

revoke all on function authz.person_id() from public;
revoke all on function authz.org_id() from public;
revoke all on function authz.aal() from public;
grant execute on function authz.person_id() to app_user, app_admin;
grant execute on function authz.org_id() to app_user, app_admin;
grant execute on function authz.aal() to app_user, app_admin;

-- ── RLS ───────────────────────────────────────────────────────────────────────────

alter table public.organizations enable row level security;
alter table public.organizations force row level security;
alter table public.people enable row level security;
alter table public.people force row level security;

-- FORCE subjects the owner to its own policies, so migrations and seeds need this.
-- app_owner is a migration-only role and never serves application traffic.
create policy organizations_owner_all on public.organizations
  for all to app_owner using (true) with check (true);
create policy people_owner_all on public.people
  for all to app_owner using (true) with check (true);

-- The (select ...) wrapper makes Postgres evaluate the helper once per query as an
-- InitPlan rather than once per row — the difference between fast and unusable.
create policy organizations_select on public.organizations
  for select to app_user
  using (
    id = (select authz.org_id())
    and deleted_at is null
    and status = 'ACTIVE'
  );

-- SELF only. Widened by Task 1.7 to
--   case (select authz.scope_for('people.view')) ... end
-- once roles, permissions and scopes exist. No app_user policy for insert, update or
-- delete: provisioning arrives with the permission system, and until then writes are
-- denied by default rather than allowed and policed later.
create policy people_select_self on public.people
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and id = (select authz.person_id())
  );

-- scripts/db/roles.sql sets DEFAULT PRIVILEGES granting select/insert/update on new
-- public tables to app_user. SELECT is wanted here and is governed by the policies
-- above; the write grants are not, because nothing yet decides who may write.
revoke insert, update, delete on public.organizations from app_user, app_admin;
revoke insert, update, delete on public.people from app_user, app_admin;

-- ── close the Task 1.1 gap ────────────────────────────────────────────────────────
-- identity_counters.org_id was left unconstrained because organizations did not exist.
-- Safe to add now: the counter table is created by migration 0001 in the same run on a
-- fresh database, and no environment holding counter rows has been promoted anywhere.
alter table public.identity_counters
  add constraint identity_counters_org_id_fkey
  foreign key (org_id) references public.organizations (id);
