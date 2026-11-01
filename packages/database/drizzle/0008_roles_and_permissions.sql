-- PRAVSHI OS — Phase 1 Task 1.7: roles, permissions, role_permissions, person_roles.
--
-- ── WHAT THIS TASK IS, AND WHAT IT IS NOT ────────────────────────────────────────
--
-- It builds the CAPABILITY half of authorization: which roles exist, which capabilities
-- exist, which roles carry which capabilities, and who holds which roles. It does not
-- build the VISIBILITY half — which rows a capability reaches. That is scope resolution
-- (authz.scope_for) and record-level exceptions (record_grants), and it is Task 1.8.
--
-- The two halves are separable because blueprint section 7.4 separates them: step 4 asks
-- "does any role grant this permission" (403 if not), step 5 asks "does the scope cover
-- this row" (404 if not). authz.has() answers step 4 and nothing else. Every policy that
-- ships in this migration is deliberately still relationship-scoped, exactly as Tasks
-- 1.2-1.6a left them: roles exist, but they do not yet widen anybody view of anything.
--
-- ── WHY NOTHING HERE TRUSTS A ROLE NAME ──────────────────────────────────────────
--
-- Blueprint section 6.1: "No role name appears in business logic. Code asks
-- has('leads.edit'), never role === 'SALES'." That rule is why `roles` carries no
-- behaviour of its own and every check below is written against a PERMISSION key. The
-- single structural exception the architecture allows is the system/protected flag pair,
-- and even that is expressed as "the role carries roles.manage" rather than "the role is
-- called SUPER_ADMIN" — see public.role_is_protected() below.

-- ── access_scope ─────────────────────────────────────────────────────────────────
--
-- database.md section 4: role_permissions(role_id, permission_id, scope access_scope).
-- The scope lives on the GRANT, not on the role and not on the permission, which is what
-- lets one `leads.view` permission serve both Sales (SELF) and Sales Manager (DEPARTMENT)
-- without inventing two permissions.
--
-- Declared broadest-first ON PURPOSE. Blueprint 7.2: "Effective scope = the broadest
-- scope granted across all of my roles for that permission." Postgres orders enum values
-- by declaration order, so min(scope) is the broadest — which is the aggregate
-- authz.scope_for() will need in Task 1.8. Reordering these values would silently invert
-- that.
create type public.access_scope as enum ('GLOBAL', 'DEPARTMENT', 'TEAM', 'PROJECT', 'SELF');

comment on type public.access_scope is
  'How far a granted permission reaches. Declared broadest-first so min(scope) is the '
  'broadest grant, which is the semantics of effective scope in blueprint 7.2.';

-- ── roles ────────────────────────────────────────────────────────────────────────
--
-- database.md: roles(id, org_id, key, name, description, is_system, is_protected, status).
-- Org-scoped, because a role is a tenant configuration record: two organizations may both
-- have a SALES role and they are different rows with different grants.
--
--   is_system     seeded by migration; cannot be deleted (database.md section 4)
--   is_protected  only GLOBAL roles.manage may grant it (database.md section 4)
--
-- deleted_at is added by the universal convention in database.md section 1, as it was for
-- departments in Task 1.4, even though the section 4 sketch lists only status.
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  key text not null,
  name text not null,
  description text,

  is_system boolean not null default false,
  is_protected boolean not null default false,

  status text not null default 'ACTIVE',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint roles_key_format check (key ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  constraint roles_name_not_blank check (length(btrim(name)) > 0),
  constraint roles_status_valid check (status in ('ACTIVE', 'ARCHIVED')),
  constraint roles_id_org_unique unique (id, org_id)
);

-- A role key is a permanent identifier, so uniqueness is NOT partial: an archived or
-- soft-deleted role keeps its key reserved. Same reasoning as people.code and
-- departments.code.
create unique index roles_org_key_unique on public.roles (org_id, key);
create index roles_org_idx on public.roles (org_id);
create index roles_org_status_idx on public.roles (org_id, status) where deleted_at is null;

comment on table public.roles is
  'Roles are data, not code. is_system marks a seeded role that cannot be deleted; '
  'is_protected marks one that only a GLOBAL roles.manage holder may grant or change.';

-- ── permissions ──────────────────────────────────────────────────────────────────
--
-- database.md: permissions(id, key, resource, action, module, description, is_sensitive).
-- NO org_id, deliberately and per the authoritative schema: the catalogue is the same
-- vocabulary for every tenant. Adding org_id would make leads.view mean something
-- different in each organization, which is the failure the catalogue exists to prevent.
--
-- No deleted_at either. A permission is in the catalogue or it is not; a soft-deleted row
-- that policies still reference by key would leave "does this capability exist" with two
-- answers. Removal is a DELETE, and the foreign key from role_permissions blocks removing
-- one that is still granted.
create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  resource text not null,
  action text not null,
  module text not null,
  description text,
  is_sensitive boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint permissions_key_unique unique (key),
  constraint permissions_resource_format check (resource ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  constraint permissions_action_format check (action ~ '^[a-z][a-z0-9_]*$'),
  -- resource.action is the whole format rule (blueprint 7.1), so it is a constraint rather
  -- than a naming convention. The two parts cannot drift from the key.
  constraint permissions_key_matches_parts check (key = resource || '.' || action)
);

create index permissions_module_idx on public.permissions (module);
create index permissions_resource_idx on public.permissions (resource);

comment on table public.permissions is
  'The capability catalogue: resource.action, seeded by migration and shared by every '
  'organization. Modules add rows here; they never add authorization logic.';

-- ── role_permissions ─────────────────────────────────────────────────────────────
--
-- database.md: primary key(role_id, permission_id), with the scope on the join.
--
-- NO org_id, and that is not an oversight. The composite-FK strategy from Task 1.4 exists
-- to stop a child joining two parents in different organizations; here there is exactly
-- ONE org-bearing parent (roles), because permissions are global. There is no second
-- organization for the row to disagree with, so an org_id column would be duplicated
-- truth with nothing to check it against. database.md section 1 puts org_id on tenant
-- tables, and this is a join between a tenant row and a catalogue row.
create table public.role_permissions (
  role_id uuid not null references public.roles (id),
  permission_id uuid not null references public.permissions (id),
  scope public.access_scope not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (role_id, permission_id)
);

-- The primary key already serves role -> permissions. This is the other direction:
-- "which roles grant leads.view", which is how an access review reads.
create index role_permissions_permission_idx on public.role_permissions (permission_id);

comment on table public.role_permissions is
  'What a role can do, and how far. One row per (role, permission); the scope lives here '
  'so a single permission serves both a member and their manager.';

-- ── person_roles ─────────────────────────────────────────────────────────────────
--
-- database.md: person_roles(person_id, role_id, granted_by, granted_at, expires_at,
-- primary key(person_id, role_id)).
--
-- org_id IS carried here, because this table has TWO org-bearing parents — the person and
-- the role — and single-column keys would happily join a person in org A to a role in
-- org B. Both composite keys share this row org_id, so both parents must agree with it
-- and therefore with each other. Cross-organization role assignment is unrepresentable,
-- not merely rejected by application code.
--
-- No deleted_at: the authoritative primary key is (person_id, role_id), which a
-- soft-deleted duplicate would immediately violate. Revocation is a DELETE, and the audit
-- trail for it is audit_logs (Task 1.10) rather than a tombstone column that would give
-- "does this person hold this role" a second, ambiguous answer.
create table public.person_roles (
  person_id uuid not null,
  role_id uuid not null,
  org_id uuid not null references public.organizations (id),

  granted_by uuid,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,

  updated_at timestamptz not null default now(),

  primary key (person_id, role_id),

  constraint person_roles_expiry_after_grant check (expires_at is null or expires_at > granted_at),

  constraint person_roles_person_same_org
    foreign key (person_id, org_id) references public.people (id, org_id),
  constraint person_roles_role_same_org
    foreign key (role_id, org_id) references public.roles (id, org_id),
  constraint person_roles_granted_by_same_org
    foreign key (granted_by, org_id) references public.people (id, org_id)
);

-- database.md section 8 names `create index on person_roles (person_id)` explicitly; it is
-- the hot path, since every authorization question starts from the current person.
create index person_roles_person_idx on public.person_roles (person_id);
create index person_roles_role_idx on public.person_roles (role_id);
create index person_roles_org_idx on public.person_roles (org_id);
create index person_roles_expiry_idx on public.person_roles (expires_at) where expires_at is not null;

comment on table public.person_roles is
  'Role assignment. Authorization comes only from here — never from person_status, never '
  'from engagement_type, and never from a permission attached directly to a person.';

create trigger roles_set_updated_at
  before update on public.roles
  for each row execute function public.set_updated_at();
create trigger permissions_set_updated_at
  before update on public.permissions
  for each row execute function public.set_updated_at();
create trigger role_permissions_set_updated_at
  before update on public.role_permissions
  for each row execute function public.set_updated_at();
create trigger person_roles_set_updated_at
  before update on public.person_roles
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════════
-- THE PROTECTED-ROLE RULE (blueprint 6.2, threat T-03)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- "A role carrying roles.manage or permissions.manage may only be granted or revoked by
--  someone who already holds that permission at GLOBAL scope. HR cannot escalate anyone
--  to SUPER_ADMIN, and cannot modify a SUPER_ADMIN account. Enforced in SQL, not in the
--  UI."
--
-- ── WHY TRIGGERS, AND NOT AN RLS POLICY ──────────────────────────────────────────
--
-- An RLS write policy would only constrain roles that RLS applies to, and it would be
-- silently absent for anyone holding a direct write grant. Triggers fire on every path
-- and for every role, including app_owner. Combined with the privilege revocation at the
-- bottom of this file, there are two independent barriers between the runtime role and a
-- self-granted administrative role:
--
--   1. app_user holds no INSERT, UPDATE or DELETE on any of these four tables at all.
--   2. Even a connection that DOES hold the grant is rejected by these triggers unless
--      the identity in the transaction context holds roles.manage at GLOBAL scope.
--
-- Barrier 2 is what makes the rule real rather than a privilege accident: an actor is
-- judged by the permission it holds, never by which database role opened the connection.
--
-- ── WHY NO GENERIC ROLE-MANAGEMENT FUNCTION ──────────────────────────────────────
--
-- Nothing here is a SECURITY DEFINER function that PERFORMS a grant. These functions only
-- ever answer a question or raise an exception; none of them writes. A definer-rights
-- grant_role(person, role) would hand app_user exactly the capability this task exists to
-- withhold, whatever checks it contained today.

-- ── is this role protected? ──────────────────────────────────────────────────────
--
-- Two sources, and the second is the load-bearing one:
--
--   1. the explicit is_protected flag (database.md section 4)
--   2. the role actually carries roles.manage or permissions.manage (blueprint 6.2)
--
-- Deriving from the grants as well as the flag closes the obvious hole: adding
-- roles.manage to an ordinary unflagged role would otherwise create an escalation path
-- that the flag never noticed. Protection follows the capability, not the label.
--
-- SECURITY DEFINER because it must read the truth. The invoking role sees these tables
-- through FORCE RLS; a caller who could see no grants would conclude "not protected",
-- which fails OPEN. Running as the owner removes that possibility entirely.
create function public.role_is_protected(p_role_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select r.is_protected from public.roles r where r.id = p_role_id), false)
      or exists (
        select 1
        from public.role_permissions rp
        join public.permissions p on p.id = rp.permission_id
        where rp.role_id = p_role_id
          and p.key in ('roles.manage', 'permissions.manage')
      )
$$;

comment on function public.role_is_protected(uuid) is
  'True when a role is flagged protected OR carries roles.manage / permissions.manage. '
  'Protection follows the capability so an unflagged role cannot become an escape hatch.';

-- ── may the current actor manage protected roles here? ───────────────────────────
--
-- The rule, in one place, used by all three triggers below.
--
-- BRANCH 1 — the rule proper. The actor holds roles.manage at GLOBAL scope in THIS
-- organization, through a live (unexpired) assignment of an active role, and their
-- engagement is live. Access is derived from the engagement (blueprint 6, 7.4 step 2), so
-- a suspended or offboarded administrator cannot grant anything, which is exactly what
-- makes offboarding meaningful.
--
-- BRANCH 2 — genesis, and the reason it is safe. A new organization has no roles.manage
-- holder, so branch 1 can never be satisfied and the first administrator could never be
-- created. The exception is therefore: an organization with NO holder at all may receive
-- its first protected grant, and only from a database role that is not the application
-- runtime role. Three properties make this closed rather than open:
--
--   * It evaporates permanently the moment one holder exists. It cannot be re-opened by
--     anyone lacking the permission, because emptying the holder set is itself a
--     protected revocation governed by branch 1.
--   * session_user, not current_user: inside SECURITY DEFINER current_user is the owner,
--     so it would say app_owner for every caller. session_user is the role that actually
--     authenticated, and app_user cannot change it (it holds no membership in any other
--     role, and SET ROLE does not alter session_user).
--   * app_user holds no write grant on person_roles or roles regardless, so this branch is
--     not reachable from the application at all.
--
-- This is also the break-glass path of blueprint section 29 / threat T-20, and the SQL
-- form of the bootstrap rule "refuses to run if any SUPER_ADMIN exists" — the same
-- condition, enforced by the database instead of by a script that might be edited.
create function public.may_manage_protected_roles(p_org_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with holders as (
    select pr.person_id
    from public.person_roles pr
    join public.roles r on r.id = pr.role_id and r.org_id = pr.org_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where pr.org_id = p_org_id
      and (pr.expires_at is null or pr.expires_at > now())
      and r.deleted_at is null
      and r.status = 'ACTIVE'
      and p.key = 'roles.manage'
      and rp.scope = 'GLOBAL'
  )
  select (
      exists (select 1 from holders h where h.person_id = authz.person_id())
      and authz.is_active()
    )
    or (
      not exists (select 1 from holders)
      and session_user <> 'app_user'
    )
$$;

comment on function public.may_manage_protected_roles(uuid) is
  'The blueprint 6.2 test: the acting identity holds roles.manage at GLOBAL scope in this '
  'organization with a live engagement. The only exception is an organization with no '
  'holder at all, which may receive its first one from a non-runtime database role.';

-- Neither helper is callable by the application. They answer questions the triggers ask;
-- they are not an API.
revoke all on function public.role_is_protected(uuid) from public;
revoke all on function public.may_manage_protected_roles(uuid) from public;

-- ── person_roles: assignment and revocation ──────────────────────────────────────
--
-- Both ends of an UPDATE are checked. Repointing an existing assignment at a different
-- role is a revocation of the old role and a grant of the new one; checking only the new
-- value would let a protected assignment be quietly removed. Repointing person_id is the
-- same argument from the other side, and is caught because the row as a whole is
-- re-examined.
create function public.enforce_protected_role_assignment() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('INSERT', 'UPDATE')
     and public.role_is_protected(new.role_id)
     and not public.may_manage_protected_roles(new.org_id) then
    raise exception
      'granting a protected role requires roles.manage at GLOBAL scope in this organization'
      using errcode = '42501';
  end if;

  if tg_op in ('UPDATE', 'DELETE')
     and public.role_is_protected(old.role_id)
     and not public.may_manage_protected_roles(old.org_id) then
    raise exception
      'revoking a protected role requires roles.manage at GLOBAL scope in this organization'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function public.enforce_protected_role_assignment() is
  'Blueprint 6.2 on person_roles: no protected role is granted or revoked except by a '
  'GLOBAL roles.manage holder. Both the old and the new role of an UPDATE are checked.';

create trigger person_roles_enforce_protection
  before insert or update or delete on public.person_roles
  for each row execute function public.enforce_protected_role_assignment();

-- ── roles: creation, modification, deletion ──────────────────────────────────────
--
-- Four separate rules, and each one closes a specific way round the others:
--
--   key is immutable            renaming a role would change what every audit entry and
--                               every seed reference means after the fact
--   org_id is immutable         a role cannot be moved to another tenant, taking its
--                               assignments and grants with it
--   is_system is immutable      database.md says a system role cannot be deleted; if the
--                               flag could be cleared, "cannot be deleted" would mean
--                               "cannot be deleted until you clear the flag"
--   protected roles are locked  creating one, changing one, or clearing its is_protected
--                               flag all require GLOBAL roles.manage. This is what makes
--                               "cannot remove protection" true: clearing the flag is an
--                               UPDATE of a row that is still protected at the moment the
--                               trigger runs.
create function public.enforce_protected_role_mutation() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.key is distinct from old.key then
      raise exception 'a role key is immutable and cannot be changed once assigned'
        using errcode = '23514';
    end if;
    if new.org_id is distinct from old.org_id then
      raise exception 'a role cannot be moved to another organization'
        using errcode = '23514';
    end if;
    if new.is_system is distinct from old.is_system then
      raise exception 'is_system is immutable: a system role cannot be reclassified'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'DELETE' and old.is_system then
    raise exception 'a system role cannot be deleted'
      using errcode = '42501';
  end if;

  -- The state BEFORE the statement. Protection is judged on the existing row, so an
  -- attempt to clear is_protected is measured against the row that still has it.
  if tg_op in ('UPDATE', 'DELETE')
     and public.role_is_protected(old.id)
     and not public.may_manage_protected_roles(old.org_id) then
    raise exception
      'modifying a protected role requires roles.manage at GLOBAL scope in this organization'
      using errcode = '42501';
  end if;

  -- The state AFTER. Creating a protected role, or protecting an existing one, is itself
  -- a privileged act: otherwise anyone could mint a role, protect it, and then be the only
  -- one able to touch it.
  if tg_op in ('INSERT', 'UPDATE')
     and new.is_protected
     and not public.may_manage_protected_roles(new.org_id) then
    raise exception
      'creating or protecting a protected role requires roles.manage at GLOBAL scope'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function public.enforce_protected_role_mutation() is
  'Blueprint 6.2 on roles, plus the immutability of key, org_id and is_system, plus the '
  'database.md rule that a system role cannot be deleted.';

create trigger roles_enforce_protection
  before insert or update or delete on public.roles
  for each row execute function public.enforce_protected_role_mutation();

-- ── role_permissions: what a role may carry ──────────────────────────────────────
--
-- The rule has two halves, and the second is the one that closes the loophole:
--
--   1. the role is already protected            -> its grants may only be edited by a
--                                                  GLOBAL roles.manage holder
--   2. the permission being granted or revoked
--      is roles.manage or permissions.manage    -> granting it to ANY role is an act of
--                                                  role management, checked before the
--                                                  role becomes protected by receiving it
--
-- Without half 2, the sequence "create an ordinary role, grant it roles.manage, assign it
-- to myself" would walk straight past a rule that only ever looked at already-protected
-- roles. The permission confers the protection, so the grant of that permission is the
-- moment to check.
create function public.enforce_protected_role_permission() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role_id uuid;
  v_permission_id uuid;
  v_org_id uuid;
  v_confers boolean;
begin
  v_role_id := coalesce(new.role_id, old.role_id);
  v_permission_id := coalesce(new.permission_id, old.permission_id);

  select r.org_id into v_org_id from public.roles r where r.id = v_role_id;

  select exists (
    select 1 from public.permissions p
    where p.id = v_permission_id and p.key in ('roles.manage', 'permissions.manage')
  ) into v_confers;

  if (v_confers or public.role_is_protected(v_role_id))
     and not public.may_manage_protected_roles(v_org_id) then
    raise exception
      'changing the permissions of a protected role, or granting role management, requires roles.manage at GLOBAL scope'
      using errcode = '42501';
  end if;

  -- An UPDATE that repoints the row at a different role or permission is checked from
  -- both ends, for the same reason as person_roles.
  if tg_op = 'UPDATE'
     and (new.role_id is distinct from old.role_id
          or new.permission_id is distinct from old.permission_id) then
    select r.org_id into v_org_id from public.roles r where r.id = old.role_id;
    select exists (
      select 1 from public.permissions p
      where p.id = old.permission_id and p.key in ('roles.manage', 'permissions.manage')
    ) into v_confers;
    if (v_confers or public.role_is_protected(old.role_id))
       and not public.may_manage_protected_roles(v_org_id) then
      raise exception
        'moving a grant off a protected role requires roles.manage at GLOBAL scope'
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function public.enforce_protected_role_permission() is
  'Blueprint 6.2 on role_permissions. Also treats granting roles.manage or '
  'permissions.manage to ANY role as an act of role management, which is the loophole '
  'that a flag-only check would leave open.';

create trigger role_permissions_enforce_protection
  before insert or update or delete on public.role_permissions
  for each row execute function public.enforce_protected_role_permission();

-- ── permissions: the catalogue identifier is the security boundary ───────────────
--
-- Every policy in the system will name a permission by its KEY. If a key could be edited,
-- renaming people.view to roles.manage would hand its holders role management without a
-- single grant changing. So the key — and with it resource and action, which the CHECK
-- ties to it — is immutable.
--
-- The rest of the row is not frozen. database.md describes the catalogue as something
-- modules extend, and freezing description, module or is_sensitive would make ordinary
-- documentation edits a migration. Only app_owner can write here in any case.
create function public.enforce_permission_identity() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.key in ('roles.manage', 'permissions.manage') then
      raise exception 'the permission % underpins the protected-role rule and cannot be removed', old.key
        using errcode = '42501';
    end if;
    return old;
  end if;

  if new.key is distinct from old.key then
    raise exception 'a permission key is immutable: rename is indistinguishable from privilege transfer'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.enforce_permission_identity() is
  'A permission key is immutable, and the two permissions the protected-role rule is '
  'written in terms of cannot be deleted from the catalogue.';

create trigger permissions_enforce_identity
  before update or delete on public.permissions
  for each row execute function public.enforce_permission_identity();

-- A trigger function cannot be called usefully outside a trigger, but the default EXECUTE
-- grant to PUBLIC is still a grant, and "no SECURITY DEFINER function is reachable by the
-- application" is easier to assert than to reason about case by case.
revoke all on function public.enforce_protected_role_assignment() from public;
revoke all on function public.enforce_protected_role_mutation() from public;
revoke all on function public.enforce_protected_role_permission() from public;
revoke all on function public.enforce_permission_identity() from public;

-- ═════════════════════════════════════════════════════════════════════════════════
-- THE PERMISSION CATALOGUE (security.md section 1)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Seeded verbatim from the V1 catalogue. resource and action are DERIVED from the key
-- rather than typed twice, so the three columns cannot disagree — the last dot separates
-- them, which is what makes hr.sensitive.view split into (hr.sensitive, view).
--
-- TWO DELIBERATE OMISSIONS, both recorded here so they are decisions rather than gaps:
--
--   openings.*  security.md writes the Hiring module entry as a wildcard, not as keys.
--               Expanding a wildcard into four or five invented permission rows is exactly
--               the "large arbitrary catalogue" the design warns against, and the section 2
--               matrix has no openings row to grant them from. Hiring is Phase 6; the keys
--               land with the tables that need them.
--
--   is_sensitive is set only where the architecture says so: the Sensitive HR and
--               Financial boundaries of database.md section 7, the configuration boundary
--               (roles.manage / permissions.manage), the audit boundary (threat T-12), the
--               bulk-export threat T-11, and users.impersonate, which security.md flags
--               explicitly. It is not a guess about what feels private.
--
-- users.impersonate IS seeded, because security.md asks for it to be visible precisely so
-- it is never added casually. It is granted to nobody at all, including SUPER_ADMIN.

insert into public.permissions (key, resource, action, module, description, is_sensitive)
select
  c.key,
  substring(c.key from '^(.*)\.[^.]+$'),
  substring(c.key from '\.([^.]+)$'),
  c.module,
  c.description,
  c.is_sensitive
from (values
  -- Users & access
  ('users.view',              'users_access',      false, 'See user accounts and their access state'),
  ('users.create',            'users_access',      false, 'Create a user account for a person'),
  ('users.edit',              'users_access',      false, 'Change a user account'),
  ('users.suspend',           'users_access',      false, 'Suspend a user account, ending its access'),
  ('users.delete',            'users_access',      false, 'Delete a user account'),
  ('users.impersonate',       'users_access',      true,  'NOT IMPLEMENTED IN V1. Listed so it is never added casually: support impersonation is an audit and consent question, not a convenience feature'),
  ('sessions.revoke',         'users_access',      false, 'Revoke active sessions, ending access immediately'),
  -- Roles & permissions
  ('roles.view',              'roles_permissions', false, 'See roles and what they grant'),
  ('roles.manage',            'roles_permissions', true,  'Create, change and assign roles. Holding this at GLOBAL scope is what the protected-role rule tests for'),
  ('permissions.view',        'roles_permissions', false, 'See the permission catalogue'),
  ('permissions.manage',      'roles_permissions', true,  'Change the permission catalogue'),
  -- Org structure
  ('departments.view',        'org_structure',     false, 'See departments'),
  ('departments.manage',      'org_structure',     false, 'Create, change and archive departments'),
  ('teams.view',              'org_structure',     false, 'See teams'),
  ('teams.manage',            'org_structure',     false, 'Create, change and archive teams'),
  -- People
  ('people.view',             'people',            false, 'See people records'),
  ('people.create',           'people',            false, 'Add a person'),
  ('people.edit',             'people',            false, 'Change a person record'),
  ('people.archive',          'people',            false, 'Archive a person record'),
  ('people.export',           'people',            true,  'Export people data in bulk (threat T-11)'),
  -- Sensitive HR
  ('hr.sensitive.view',       'hr_sensitive',      true,  'See date of birth, emergency contacts and identity documents'),
  ('hr.sensitive.edit',       'hr_sensitive',      true,  'Change date of birth, emergency contacts and identity documents'),
  -- Compensation
  ('compensation.view',       'compensation',      true,  'See compensation'),
  ('compensation.edit',       'compensation',      true,  'Change compensation'),
  -- Engagements
  ('engagements.view',        'engagements',       false, 'See engagements'),
  ('engagements.create',      'engagements',       false, 'Create an engagement'),
  ('engagements.edit',        'engagements',       false, 'Change an engagement'),
  ('engagements.transition',  'engagements',       false, 'Move an engagement through its lifecycle'),
  -- Hiring
  ('candidates.view',         'hiring',            false, 'See candidates and their CVs'),
  ('candidates.create',       'hiring',            false, 'Add a candidate'),
  ('candidates.edit',         'hiring',            false, 'Change a candidate record'),
  ('interviews.view',         'hiring',            false, 'See interviews'),
  ('interviews.schedule',     'hiring',            false, 'Schedule an interview'),
  ('scorecards.create',       'hiring',            false, 'Submit an interview scorecard'),
  ('scorecards.view_all',     'hiring',            false, 'See every scorecard, not only your own'),
  ('offers.create',           'hiring',            false, 'Draft an offer'),
  ('offers.approve',          'hiring',            false, 'Approve an offer'),
  -- Onboarding
  ('onboarding.view',         'onboarding',        false, 'See onboarding progress'),
  ('onboarding.manage',       'onboarding',        false, 'Run onboarding: templates, instances and assignment'),
  ('onboarding.complete_task','onboarding',        false, 'Complete an onboarding task assigned to you'),
  -- Offboarding
  ('offboarding.view',        'offboarding',       false, 'See offboarding progress'),
  ('offboarding.initiate',    'offboarding',       false, 'Start an offboarding'),
  ('offboarding.manage',      'offboarding',       false, 'Run offboarding to completion'),
  -- Sales
  ('leads.view',              'sales',             false, 'See leads'),
  ('leads.create',            'sales',             false, 'Create a lead'),
  ('leads.edit',              'sales',             false, 'Change a lead'),
  ('leads.delete',            'sales',             false, 'Delete a lead'),
  ('leads.assign',            'sales',             false, 'Assign a lead to someone'),
  ('leads.export',            'sales',             true,  'Export leads in bulk (threat T-11)'),
  ('clients.view',            'sales',             false, 'See clients'),
  ('clients.create',          'sales',             false, 'Add a client'),
  ('clients.edit',            'sales',             false, 'Change a client'),
  ('clients.delete',          'sales',             false, 'Delete a client'),
  ('pipeline.manage',         'sales',             false, 'Configure the sales pipeline'),
  -- Projects
  ('projects.view',           'projects',          false, 'See projects'),
  ('projects.create',         'projects',          false, 'Create a project'),
  ('projects.edit',           'projects',          false, 'Change a project'),
  ('projects.delete',         'projects',          false, 'Delete a project'),
  ('projects.manage_members', 'projects',          false, 'Add and remove project members'),
  -- Tasks
  ('tasks.view',              'tasks',             false, 'See tasks'),
  ('tasks.create',            'tasks',             false, 'Create a task'),
  ('tasks.edit',              'tasks',             false, 'Change a task'),
  ('tasks.assign',            'tasks',             false, 'Assign a task to someone'),
  ('tasks.delete',            'tasks',             false, 'Delete a task'),
  ('tasks.comment',           'tasks',             false, 'Comment on a task'),
  -- Documents
  ('documents.view',          'documents',         false, 'See document metadata'),
  ('documents.upload',        'documents',         false, 'Upload a document'),
  ('documents.download',      'documents',         false, 'Download document bytes'),
  ('documents.verify',        'documents',         false, 'Mark a document as verified'),
  ('documents.delete',        'documents',         false, 'Delete a document'),
  -- Policies
  ('policies.view',           'policies',          false, 'Read policies'),
  ('policies.manage',         'policies',          false, 'Publish and change policies'),
  ('policies.acknowledge',    'policies',          false, 'Acknowledge a policy on your own behalf'),
  ('policies.view_compliance','policies',          false, 'See who has acknowledged which policy'),
  -- Reports
  ('reports.view',            'reports',           false, 'See reports'),
  ('reports.export',          'reports',           true,  'Export report data in bulk (threat T-11)'),
  -- Audit
  ('audit_logs.view',         'audit',             true,  'Read the audit log'),
  ('audit_logs.export',       'audit',             true,  'Export the audit log'),
  -- Settings
  ('settings.view',           'settings',          false, 'See settings'),
  ('settings.manage',         'settings',          false, 'Change operational settings. Security settings remain SUPER_ADMIN only (security.md section 2, footnote 8)'),
  ('integrations.manage',     'settings',          false, 'Configure integrations')
) as c(key, module, is_sensitive, description);

-- ═════════════════════════════════════════════════════════════════════════════════
-- SYSTEM ROLES (blueprint 6.1) AND THEIR GRANTS (security.md section 2)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Roles are per-organization, so "seeding the system roles" is not a one-off INSERT: it is
-- something that has to be true of every organization that exists now and every one
-- created later. It is therefore a function plus an AFTER INSERT trigger on organizations,
-- rather than a list of rows in this file. Without that, "every tenant has a SUPER_ADMIN
-- role and FINANCE is separate from HR" would be a convention someone has to remember,
-- and the protected-role rule would have nothing to anchor to in a new tenant.
--
-- NOBODY IS ASSIGNED ANYTHING. This creates role definitions and their grants. Assigning
-- the first SUPER_ADMIN to a human being is the bootstrap of Task 1.14.
--
-- ── THE MATRIX IS COPIED, NOT INTERPRETED ────────────────────────────────────────
--
-- Every (role, permission, scope) triple below is a cell of the security.md section 2
-- matrix. Where the matrix has a dash, there is no row here — no permission by default,
-- and no invented hierarchy. In particular:
--
--   * ADMIN receives no hr.sensitive.* and no compensation.*. "ADMIN is not a superset of
--     HR" is a fact of the seed, not a policy written elsewhere.
--   * HR_ADMIN and HR_MANAGER receive no leads.* and no audit_logs.view.
--   * FINANCE receives compensation.view and the commercial views, and nothing from HR.
--   * INTERN and VIBECODER receive nothing above PROJECT scope.
--   * MANAGER and MARKETING appear in the blueprint 6.1 role list but have no column in
--     the matrix, so they are seeded as roles with no grants rather than guessed at.
--
-- ── TWO PLACES WHERE THE SOURCES NEEDED A DECISION ───────────────────────────────
--
--   SUPER_ADMIN receives GLOBAL on the whole catalogue rather than only on the 43 rows the
--   matrix happens to list. The matrix shows G for SUPER_ADMIN in every row without
--   exception and the section 3 visibility matrix says Full for every domain; a
--   SUPER_ADMIN unable to view an engagement would be an artefact of which rows the table
--   chose to print. users.impersonate is the single exclusion, per security.md.
--
--   The matrix gives SALES "S+P" for tasks.view and tasks.edit. The authoritative primary
--   key (role_id, permission_id) permits ONE scope per grant, so a union of two scopes is
--   not expressible. The NARROWER half (SELF) is seeded, because the failure mode of
--   guessing wrong must be too little access rather than too much. Widening it is a
--   founder decision and a one-row change.

create function public.seed_system_roles(p_org_id uuid) returns void
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
    ('ADMIN','leads.view','GLOBAL'),('ADMIN','leads.create','GLOBAL'),('ADMIN','leads.edit','GLOBAL'),
    ('ADMIN','leads.delete','GLOBAL'),('ADMIN','leads.assign','GLOBAL'),('ADMIN','leads.export','GLOBAL'),
    ('ADMIN','clients.view','GLOBAL'),('ADMIN','clients.edit','GLOBAL'),
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
    ('SALES_MANAGER','leads.view','DEPARTMENT'),('SALES_MANAGER','leads.create','DEPARTMENT'),
    ('SALES_MANAGER','leads.edit','DEPARTMENT'),('SALES_MANAGER','leads.delete','DEPARTMENT'),
    ('SALES_MANAGER','leads.assign','DEPARTMENT'),('SALES_MANAGER','leads.export','DEPARTMENT'),
    ('SALES_MANAGER','clients.view','DEPARTMENT'),('SALES_MANAGER','clients.edit','DEPARTMENT'),
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
    ('SALES','leads.view','SELF'),('SALES','leads.create','SELF'),('SALES','leads.edit','SELF'),
    ('SALES','clients.view','SELF'),('SALES','clients.edit','SELF'),
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
    ('EMPLOYEE','policies.acknowledge','SELF')
  ) as m(role_key, permission_key, scope)
  join public.roles r on r.org_id = p_org_id and r.key = m.role_key
  join public.permissions p on p.key = m.permission_key
  on conflict do nothing;
end;
$$;

comment on function public.seed_system_roles(uuid) is
  'Creates the blueprint 6.1 system roles for one organization and grants them the '
  'security.md section 2 matrix. Assigns them to nobody: that is the Task 1.14 bootstrap.';

-- Not an API. It writes, so it is granted to no one at all; only its owner can call it,
-- and the only caller is the trigger below.
revoke all on function public.seed_system_roles(uuid) from public;

create function public.organizations_seed_system_roles() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.seed_system_roles(new.id);
  return null;
end;
$$;

comment on function public.organizations_seed_system_roles() is
  'Every organization gets the system roles at creation, so no tenant can exist without '
  'the role definitions the protected-role rule is anchored to.';

create trigger organizations_seed_system_roles
  after insert on public.organizations
  for each row execute function public.organizations_seed_system_roles();

revoke all on function public.organizations_seed_system_roles() from public;

-- Organizations created before this migration get the same treatment.
do $$
declare
  o record;
begin
  for o in select id from public.organizations loop
    perform public.seed_system_roles(o.id);
  end loop;
end $$;

-- ── authz.has() ──────────────────────────────────────────────────────────────────
--
-- Deferred by Task 1.3 because it needs all four tables above. database.md defines it as
-- "scope_for(p) is not null", and role_permissions.scope is NOT NULL, so a grant existing
-- and scope_for returning non-null are the same statement. That is what makes has()
-- implementable now, in full, with scope resolution still ahead: it is a question about
-- MEMBERSHIP, and membership is complete.
--
-- WHAT IT DOES NOT ANSWER, and must never be used as though it does: which rows the
-- permission reaches. has('leads.view') is true for a salesperson and for the sales
-- director; it says nothing about whose leads either may read. A policy that uses has()
-- alone in place of a scope test grants GLOBAL access to everyone holding the permission.
-- The standard policy shape in database.md 4.2 branches on scope_for() for exactly this
-- reason, and Task 1.8 supplies it.
--
-- It is narrower than pure catalogue membership in one respect, deliberately: the
-- engagement must be live. Blueprint 7.4 puts "is the engagement ACTIVE" at step 2 and the
-- permission question at step 4, so a permission answer that ignored step 2 would be
-- answering out of order. A suspended administrator holds their assignment and none of its
-- power. scope_for() must carry the same condition in Task 1.8 for the documented identity
-- has(p) = scope_for(p) is not null to keep holding.
create function authz.has(p_permission text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.person_roles pr
    join public.roles r on r.id = pr.role_id and r.org_id = pr.org_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where pr.person_id = authz.person_id()
      and pr.org_id = authz.org_id()
      and (pr.expires_at is null or pr.expires_at > now())
      and r.deleted_at is null
      and r.status = 'ACTIVE'
      and p.key = p_permission
  )
  and authz.is_active()
$$;

comment on function authz.has(text) is
  'Does the authenticated person hold this permission through any live role assignment, '
  'with a live engagement. A capability question only: it never says which rows the '
  'permission reaches. Scope is authz.scope_for(), Task 1.8.';

revoke all on function authz.has(text) from public;
grant execute on function authz.has(text) to app_user, app_admin;

-- ── RLS ──────────────────────────────────────────────────────────────────────────

alter table public.roles enable row level security;
alter table public.roles force row level security;
alter table public.permissions enable row level security;
alter table public.permissions force row level security;
alter table public.role_permissions enable row level security;
alter table public.role_permissions force row level security;
alter table public.person_roles enable row level security;
alter table public.person_roles force row level security;

-- FORCE subjects the owner to its own policies, and migrations, the seed function and the
-- SECURITY DEFINER helpers all run as app_owner.
create policy roles_owner_all on public.roles
  for all to app_owner using (true) with check (true);
create policy permissions_owner_all on public.permissions
  for all to app_owner using (true) with check (true);
create policy role_permissions_owner_all on public.role_permissions
  for all to app_owner using (true) with check (true);
create policy person_roles_owner_all on public.person_roles
  for all to app_owner using (true) with check (true);

-- Now that roles exist, the temptation is to let them widen what app_user can see. They do
-- not, and this is the point in the build where that restraint matters most: without
-- scope_for(), any policy phrased as "a role grants visibility" could only mean GLOBAL,
-- which is the org-wide hole that Tasks 1.2 to 1.6a deliberately avoided opening. Each
-- policy below still answers only from a relationship the tables can prove.

-- A person sees the roles they themselves hold. Not the organization role catalogue —
-- that is roles.view, and it needs a scope.
create policy roles_select_mine on public.roles
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and exists (
      select 1 from public.person_roles pr
      where pr.role_id = public.roles.id
        and pr.person_id = (select authz.person_id())
        and (pr.expires_at is null or pr.expires_at > now())
    )
  );

-- A person sees the catalogue entry for a capability they actually hold — the row that
-- explains what a button they can press is called. has() is exactly the right question
-- here, and this is the one place where a capability check IS the visibility rule, because
-- the row being protected is the capability itself and it has no owner and no scope.
create policy permissions_select_granted on public.permissions
  for select to app_user
  using (authz.has(public.permissions.key));

-- A person sees what their own roles grant, which is how an interface renders "here is
-- what you can do". Not what other roles grant.
create policy role_permissions_select_mine on public.role_permissions
  for select to app_user
  using (
    exists (
      select 1
      from public.person_roles pr
      join public.roles r on r.id = pr.role_id and r.org_id = pr.org_id
      where pr.role_id = public.role_permissions.role_id
        and pr.person_id = (select authz.person_id())
        and pr.org_id = (select authz.org_id())
        and (pr.expires_at is null or pr.expires_at > now())
        and r.deleted_at is null
    )
  );

-- A person sees their own assignments. Seeing who else holds which role is roles.view.
create policy person_roles_select_self on public.person_roles
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and person_id = (select authz.person_id())
  );

-- scripts/db/roles.sql grants select, insert and update on every new table in public to
-- app_user by default privilege. On these four tables a write grant would be a grant to
-- edit the authorization system itself, so all three write privileges go — leaving the
-- protected-role triggers as the second barrier rather than the only one.
revoke insert, update, delete on public.roles from app_user, app_admin;
revoke insert, update, delete on public.permissions from app_user, app_admin;
revoke insert, update, delete on public.role_permissions from app_user, app_admin;
revoke insert, update, delete on public.person_roles from app_user, app_admin;
