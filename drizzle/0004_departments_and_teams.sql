-- PRAVSHI OS — Phase 1 Task 1.4: departments, teams, team members, person departments.
--
-- ── THE ORGANIZATION-CONSISTENCY MECHANISM: COMPOSITE FOREIGN KEYS ────────────────
--
-- A person belongs to one organization. A department belongs to one organization. A
-- team belongs to a department. A membership joins a person to a team. Nothing in that
-- chain may cross an organization boundary.
--
-- Single-column foreign keys cannot express that: `team_members.person_id -> people.id`
-- and `team_members.team_id -> teams.id` are each individually valid while joining a
-- person in org A to a team in org B. Application validation can close the gap, but only
-- until someone writes the one INSERT that forgets.
--
-- The mechanism used here instead:
--
--   1. Every parent gets a redundant-looking `unique (id, org_id)`. Redundant against
--      the primary key, but it is what makes (id, org_id) a legal FK target.
--   2. Every child carries its own `org_id` and points at parents with a COMPOSITE key
--      that includes it: `(person_id, org_id) -> people (id, org_id)`.
--   3. Because the child has ONE org_id column shared by all of its composite FKs, both
--      parents must agree with it — and therefore with each other.
--
-- The child's org_id is not duplicated truth that can drift. It cannot hold a value that
-- disagrees with its parents, because the constraints reject the row. Postgres enforces
-- it on every path: application code, a psql session, a migration, a bulk load.

-- ── (id, org_id) targets on the Task 1.2 table ───────────────────────────────────
alter table public.people
  add constraint people_id_org_unique unique (id, org_id);

-- ── departments ──────────────────────────────────────────────────────────────────

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  code text not null,
  name text not null,
  parent_id uuid,
  head_person_id uuid,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint departments_code_format check (code ~ '^[A-Z][A-Z0-9_]{1,15}$'),
  constraint departments_name_not_blank check (length(btrim(name)) > 0),
  constraint departments_status_valid check (status in ('ACTIVE', 'ARCHIVED')),
  constraint departments_not_own_parent check (parent_id is null or parent_id <> id),
  constraint departments_id_org_unique unique (id, org_id)
);

-- A sub-department and its parent must be in the same organization, and so must the head.
alter table public.departments
  add constraint departments_parent_same_org
  foreign key (parent_id, org_id) references public.departments (id, org_id);

alter table public.departments
  add constraint departments_head_same_org
  foreign key (head_person_id, org_id) references public.people (id, org_id);

-- Codes identify a department permanently, so uniqueness is NOT partial: an archived or
-- soft-deleted department keeps its code reserved rather than freeing it for reuse.
create unique index departments_org_code_unique on public.departments (org_id, code);
create index departments_org_id_idx on public.departments (org_id);
create index departments_parent_idx on public.departments (parent_id) where parent_id is not null;
create index departments_org_status_idx on public.departments (org_id, status) where deleted_at is null;

comment on table public.departments is
  'Configurable organizational units with an optional parent. Archiving sets '
  'status=ARCHIVED rather than deleting, so historical records stay resolvable.';

-- ── teams ────────────────────────────────────────────────────────────────────────
-- The blueprint models a team as belonging to exactly one department. org_id is carried
-- so the composite key to departments can enforce that the team cannot be attached to
-- another organization's department.

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  department_id uuid not null,
  name text not null,
  lead_person_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint teams_name_not_blank check (length(btrim(name)) > 0),
  constraint teams_id_org_unique unique (id, org_id)
);

alter table public.teams
  add constraint teams_department_same_org
  foreign key (department_id, org_id) references public.departments (id, org_id);

alter table public.teams
  add constraint teams_lead_same_org
  foreign key (lead_person_id, org_id) references public.people (id, org_id);

-- Team names are not permanent identifiers, so a soft-deleted team frees its name.
create unique index teams_department_name_unique
  on public.teams (department_id, name) where deleted_at is null;
create index teams_org_id_idx on public.teams (org_id);
create index teams_department_idx on public.teams (department_id);

comment on table public.teams is 'A team belongs to exactly one department.';

-- ── team_members ─────────────────────────────────────────────────────────────────
-- Both composite keys share this row's org_id, so person and team must agree with it —
-- and therefore with each other. Cross-organization membership is unrepresentable.

create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  team_id uuid not null,
  person_id uuid not null,
  role_in_team text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint team_members_team_same_org
    foreign key (team_id, org_id) references public.teams (id, org_id),
  constraint team_members_person_same_org
    foreign key (person_id, org_id) references public.people (id, org_id)
);

-- Unique while ACTIVE only: someone may leave a team and rejoin it later, and both
-- periods should remain in the record.
create unique index team_members_active_unique
  on public.team_members (team_id, person_id) where deleted_at is null;
create index team_members_team_idx on public.team_members (team_id) where deleted_at is null;
create index team_members_person_idx on public.team_members (person_id) where deleted_at is null;
create index team_members_org_idx on public.team_members (org_id);

comment on table public.team_members is
  'Membership of a person in a team. Unique only while active, so rejoining is expressible.';

-- ── person_departments — secondary membership ────────────────────────────────────
-- The blueprint puts the PRIMARY department on the active engagement; this table carries
-- additional membership only (a developer who also sits in the AI team). It therefore
-- adds to organizational truth rather than duplicating it.

create table public.person_departments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  person_id uuid not null,
  department_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint person_departments_person_same_org
    foreign key (person_id, org_id) references public.people (id, org_id),
  constraint person_departments_department_same_org
    foreign key (department_id, org_id) references public.departments (id, org_id)
);

create unique index person_departments_active_unique
  on public.person_departments (person_id, department_id) where deleted_at is null;
create index person_departments_person_idx
  on public.person_departments (person_id) where deleted_at is null;
create index person_departments_department_idx
  on public.person_departments (department_id) where deleted_at is null;
create index person_departments_org_idx on public.person_departments (org_id);

comment on table public.person_departments is
  'Secondary department membership. The primary department comes from the active '
  'engagement (Task 1.5); this table is additive.';

-- ── triggers ─────────────────────────────────────────────────────────────────────

create trigger departments_set_updated_at
  before update on public.departments
  for each row execute function public.set_updated_at();
create trigger teams_set_updated_at
  before update on public.teams
  for each row execute function public.set_updated_at();
create trigger team_members_set_updated_at
  before update on public.team_members
  for each row execute function public.set_updated_at();
create trigger person_departments_set_updated_at
  before update on public.person_departments
  for each row execute function public.set_updated_at();

-- A department code is a permanent identifier, so it gets the same protection as a
-- person code.
create trigger departments_code_immutable
  before update on public.departments
  for each row execute function public.enforce_immutable_code();

-- ── authz.my_departments() ───────────────────────────────────────────────────────
--
-- Returns the departments the authenticated person belongs to, as uuid[].
--
-- PARTIAL BY NECESSITY, AND SAID SO OUT LOUD: database.md defines this as "primary +
-- secondary". The primary department lives on the active engagement, and `engagements`
-- does not exist until Task 1.5. This returns the SECONDARY memberships only. That is
-- narrower than the final behaviour, never broader, so a policy written against it today
-- cannot over-grant once 1.5 widens it.
--
-- It does not return every department when identity is absent: authz.person_id() yields
-- NULL, the WHERE matches nothing, and the result is an empty array.
create function authz.my_departments() returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct pd.department_id), '{}'::uuid[])
  from public.person_departments pd
  join public.departments d
    on d.id = pd.department_id
   and d.org_id = pd.org_id
  where pd.person_id = authz.person_id()
    and pd.org_id = authz.org_id()
    and pd.deleted_at is null
    and d.deleted_at is null
    and d.status = 'ACTIVE'
$$;

comment on function authz.my_departments() is
  'Departments of the authenticated person, as uuid[]. Secondary membership only until '
  'Task 1.5 adds the primary department from the active engagement. Empty without identity.';

revoke all on function authz.my_departments() from public;
grant execute on function authz.my_departments() to app_user, app_admin;

-- ── RLS ──────────────────────────────────────────────────────────────────────────

alter table public.departments enable row level security;
alter table public.departments force row level security;
alter table public.teams enable row level security;
alter table public.teams force row level security;
alter table public.team_members enable row level security;
alter table public.team_members force row level security;
alter table public.person_departments enable row level security;
alter table public.person_departments force row level security;

-- FORCE subjects the owner to its own policies; migrations and the SECURITY DEFINER
-- helpers run as app_owner and need these.
create policy departments_owner_all on public.departments
  for all to app_owner using (true) with check (true);
create policy teams_owner_all on public.teams
  for all to app_owner using (true) with check (true);
create policy team_members_owner_all on public.team_members
  for all to app_owner using (true) with check (true);
create policy person_departments_owner_all on public.person_departments
  for all to app_owner using (true) with check (true);

-- Relationship-based visibility, not organization-wide. There is still no permission
-- system, so nothing here may answer "may this person see the whole directory" — that
-- is scope_for('departments.view') in Task 1.7. Until then a person sees the structures
-- they are actually attached to, which is provable from the tables that exist.

create policy departments_select_mine on public.departments
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and status = 'ACTIVE'
    -- NOTE: database.md 4.2 writes this as `= any ((select authz.my_departments()))`,
    -- which Postgres parses as ANY(subquery) and rejects with
    -- "operator does not exist: uuid = uuid[]". The ::uuid[] cast makes it the array
    -- form while keeping the (select ...) InitPlan wrapper the template calls for.
    and id = any ((select authz.my_departments())::uuid[])
  );

create policy teams_select_member on public.teams
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and exists (
      select 1 from public.team_members tm
      where tm.team_id = public.teams.id
        and tm.person_id = (select authz.person_id())
        and tm.deleted_at is null
    )
  );

create policy team_members_select_self on public.team_members
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and person_id = (select authz.person_id())
  );

create policy person_departments_select_self on public.person_departments
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and person_id = (select authz.person_id())
  );

-- scripts/db/roles.sql grants select/insert/update on every new public table to app_user
-- by default privilege. SELECT is wanted and is governed by the policies above; the write
-- grants are not, because nothing yet decides who may restructure an organization.
revoke insert, update, delete on public.departments from app_user, app_admin;
revoke insert, update, delete on public.teams from app_user, app_admin;
revoke insert, update, delete on public.team_members from app_user, app_admin;
revoke insert, update, delete on public.person_departments from app_user, app_admin;
