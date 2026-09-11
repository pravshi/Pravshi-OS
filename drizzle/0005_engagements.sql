-- PRAVSHI OS — Phase 1 Task 1.5: engagements, and the access state that depends on them.
--
-- ── WHICH LIFECYCLE LIVES HERE, AND WHICH DOES NOT ───────────────────────────────
--
-- The full employee and intern journeys include CANDIDATE, OFFER, APPLICATION,
-- SCREENING, INTERVIEW, SELECTED, AGREEMENT, DOCUMENTS, MID_REVIEW and FINAL_REVIEW.
-- None of those are engagement statuses. database.md assigns `engagements` exactly seven:
--
--   PRE_ONBOARDING · ONBOARDING · ACTIVE · NOTICE_PERIOD · SUSPENDED · OFFBOARDING · ARCHIVED
--
-- An engagement is a PERIOD OF WORKING HERE. Everything before it is recruitment, which
-- is a separate module (Phase 6) about a person who may never become engaged at all;
-- everything about how an internship ended is `internships.outcome` and `exit_type`.
-- Folding recruitment into this enum would mean a CANDIDATE row sitting in the table that
-- grants organizational access, distinguished from a real engagement only by a status
-- value — precisely the collapse the person/engagement split exists to prevent.

create type public.engagement_type as enum (
  'EMPLOYEE', 'INTERN', 'TRAINEE', 'CONTRACTOR', 'CONSULTANT', 'PART_TIME', 'TEMPORARY'
);

create type public.engagement_status as enum (
  'PRE_ONBOARDING', 'ONBOARDING', 'ACTIVE', 'NOTICE_PERIOD', 'SUSPENDED', 'OFFBOARDING', 'ARCHIVED'
);

create type public.employment_mode as enum ('ONSITE', 'REMOTE', 'HYBRID');

create type public.exit_type as enum ('RESIGNED', 'COMPLETED', 'TERMINATED', 'CONVERTED');

create table public.engagements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  person_id uuid not null,

  engagement_type public.engagement_type not null,
  status public.engagement_status not null default 'PRE_ONBOARDING',

  department_id uuid not null,
  team_id uuid,
  manager_person_id uuid,

  job_title text,
  work_location text,
  employment_mode public.employment_mode,

  start_date date not null,
  expected_end_date date,
  actual_end_date date,

  exit_reason text,
  exit_type public.exit_type,

  is_primary boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.people (id),
  updated_by uuid references public.people (id),
  deleted_at timestamptz,

  constraint engagements_not_own_manager check (manager_person_id is null or manager_person_id <> person_id),
  constraint engagements_end_after_start check (actual_end_date is null or actual_end_date >= start_date),
  constraint engagements_expected_after_start check (expected_end_date is null or expected_end_date >= start_date),
  constraint engagements_id_org_unique unique (id, org_id)
);

-- ── organization consistency: the Task 1.4 composite-key strategy ────────────────
-- Every relationship carries this row's org_id into the foreign key, so person,
-- department, team and manager must all agree with it and therefore with each other.
-- A person cannot be engaged in an organization other than their own, and cannot be
-- placed in another organization's department or report to another organization's staff.

alter table public.engagements
  add constraint engagements_person_same_org
  foreign key (person_id, org_id) references public.people (id, org_id);

alter table public.engagements
  add constraint engagements_department_same_org
  foreign key (department_id, org_id) references public.departments (id, org_id);

alter table public.engagements
  add constraint engagements_team_same_org
  foreign key (team_id, org_id) references public.teams (id, org_id);

-- A manager is any person in the same organization. No role requirement: roles do not
-- exist yet, and management is a reporting fact rather than a permission.
alter table public.engagements
  add constraint engagements_manager_same_org
  foreign key (manager_person_id, org_id) references public.people (id, org_id);

-- ── one primary active engagement per person ─────────────────────────────────────
--
-- Verbatim from database.md. Keyed on person_id alone rather than (org_id, person_id):
-- a person belongs to exactly one organization, so person_id is already the stricter
-- key, and adding org_id would weaken it to "one per person per organization".
--
-- The predicate covers the four statuses that represent a live engagement, so someone
-- serving notice still blocks a second primary engagement. ARCHIVED, SUSPENDED and
-- OFFBOARDING rows do not, which is what lets a re-hire coexist with their history.
create unique index one_primary_active_engagement
  on public.engagements (person_id)
  where status in ('PRE_ONBOARDING', 'ONBOARDING', 'ACTIVE', 'NOTICE_PERIOD')
    and is_primary
    and deleted_at is null;

create index engagements_org_idx on public.engagements (org_id);
create index engagements_person_idx on public.engagements (person_id) where deleted_at is null;
create index engagements_department_idx on public.engagements (department_id) where deleted_at is null;
create index engagements_team_idx on public.engagements (team_id) where team_id is not null and deleted_at is null;
-- reports_to_me() (Task 1.6+) walks the manager chain; this is the index it will need.
create index engagements_manager_idx
  on public.engagements (manager_person_id) where manager_person_id is not null and deleted_at is null;
create index engagements_org_status_idx on public.engagements (org_id, status) where deleted_at is null;

create trigger engagements_set_updated_at
  before update on public.engagements
  for each row execute function public.set_updated_at();

comment on table public.engagements is
  'A period of working with PRAVSHI. Access is granted by an ACTIVE engagement, never by '
  'the existence of a person. Recruitment states live in the recruitment module, not here.';

-- ── authz.is_active() ────────────────────────────────────────────────────────────
--
-- Deferred by Task 1.3 because it cannot be answered without this table. database.md:
-- "engagement status is ACTIVE, read FROM THE TABLE, on every query". Blueprint 7.4
-- step 2: "Is the engagement ACTIVE and the org ACTIVE?" — both halves are checked here.
--
-- Read from the table on EVERY call, never from a claim. That is the whole point: when an
-- engagement is suspended or offboarded, the next query reflects it. There is no token to
-- expire and no cache to invalidate.
--
-- Deliberately distinct from authz.is_active_person(), which answers only whether the
-- identity is usable. A person can be ACTIVE while their engagement is OFFBOARDING; the
-- person keeps their record and loses their access, which is the entire reason the two
-- statuses exist separately.
--
-- NOTE ON NOTICE_PERIOD: the authoritative text says ACTIVE, so someone serving notice
-- returns false here even though they still block a second primary engagement above. The
-- two rules answer different questions and the asymmetry is intentional, but whether
-- people on notice should keep access is a founder decision, not a technical one.
create function authz.is_active() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.engagements e
    join public.organizations o on o.id = e.org_id
    where e.person_id = authz.person_id()
      and e.org_id = authz.org_id()
      and e.status = 'ACTIVE'
      and e.deleted_at is null
      and o.status = 'ACTIVE'
      and o.deleted_at is null
  )
$$;

comment on function authz.is_active() is
  'True only when the authenticated person has an ACTIVE engagement in an ACTIVE '
  'organization, read from the tables on every call. Fails closed on no identity, no '
  'engagement, a suspended/offboarded/archived engagement, or a suspended organization.';

revoke all on function authz.is_active() from public;
grant execute on function authz.is_active() to app_user, app_admin;

-- ── RLS ──────────────────────────────────────────────────────────────────────────

alter table public.engagements enable row level security;
alter table public.engagements force row level security;

create policy engagements_owner_all on public.engagements
  for all to app_owner using (true) with check (true);

-- SELF only, matching the posture of every table so far. Deliberately NOT gated on
-- is_active(): a person whose engagement has ended must still be able to see the record
-- that says so, and gating self-visibility on the very state being read would be circular.
-- Manager and department visibility is scope_for('engagements.view') in Task 1.7.
create policy engagements_select_self on public.engagements
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and person_id = (select authz.person_id())
  );

-- The roles.sql default privilege grants select/insert/update on new public tables to
-- app_user. SELECT is wanted and policy-governed; the writes are not, because nothing yet
-- decides who may hire, suspend or offboard anyone.
revoke insert, update, delete on public.engagements from app_user, app_admin;
