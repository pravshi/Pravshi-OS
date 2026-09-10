-- PRAVSHI OS — Phase 1 Task 1.9: record grants, the record-level exception.
--
-- Blueprint 7.3: record_grants "covers 'give this one developer access to this one client
-- project until 31 March'. Time-boxed by default, audited on grant and revoke, and expiry
-- is enforced in the SQL predicate itself — not by a cron job that might not run."
--
-- ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────────
--
-- It is not a second authorization system, and nothing here touches the first one.
-- scope_for() and has() are unchanged: a record grant does not widen a scope, does not
-- create or alter a role, and cannot make scope_for() return a value it did not return
-- before. The two are combined by the CALLER, in the standard policy shape of
-- database.md 4.2:
--
--   ( case (select authz.scope_for('leads.view')) ... end
--     or (select authz.has_record_grant('lead', id, 'leads.view')) )
--
-- The `or` is the whole relationship. Scope answers "which rows of this kind may I see";
-- a record grant answers "may I see this one row as well". A grant therefore reaches
-- exactly one record for exactly one person, and there is no value of any column that
-- makes it reach two.
--
-- ── WHY IT STILL REQUIRES A LIVE ENGAGEMENT ──────────────────────────────────────
--
-- An exception to scope is not an exception to being employed. Blueprint 7.4 puts "is the
-- engagement ACTIVE and the org ACTIVE" at step 2 and record-level questions at step 5, so
-- a grant held by someone who has been offboarded answers false — the same rule that makes
-- offboarding mean anything at all.

create table public.record_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  -- ── THE TARGET, AND WHY IT IS (text, uuid) ──────────────────────────────────
  --
  -- database.md section 4 specifies entity_type and entity_id, and 4.2 calls the helper as
  -- authz.has_record_grant('lead', id, 'leads.view'). It does not specify the vocabulary,
  -- so the smallest safe representation is chosen and pinned here:
  --
  --   * SINGULAR, lower_snake_case, naming the entity rather than its table: 'lead',
  --     'project', 'client', 'document'. The 4.2 example uses 'lead' against the `leads`
  --     table, so the value is the entity name, not the relation name.
  --   * FORMAT-CONSTRAINED by the CHECK below, so it cannot hold arbitrary text.
  --   * NEVER CONCATENATED INTO SQL. The value is compared with = against a parameter, in
  --     a function with no dynamic SQL and no EXECUTE. It is data on both sides of the
  --     comparison, so it cannot become a statement.
  --   * FAILS CLOSED ON A TYPO. A grant naming 'leadz' matches no policy call and reaches
  --     nothing. A misspelt entity type is a dead grant, never a wide one.
  --
  -- No foreign key, deliberately: `leads`, `projects` and `documents` arrive in Phases 3-5.
  -- A polymorphic FK cannot be expressed in Postgres anyway, and the alternatives — a
  -- nullable column per future table, or a trigger doing dynamic lookups — would both be
  -- worse than a constrained pair. The composite keys below still pin the tenant, which is
  -- the integrity that actually matters here.
  entity_type text not null,
  entity_id uuid not null,

  -- The subject: exactly one person, never a role, a team or a department.
  person_id uuid not null,

  -- The capability, by foreign key rather than by key text, so a grant naming a permission
  -- outside the approved catalogue cannot be written at all.
  permission_id uuid not null references public.permissions (id),

  granted_by uuid not null,
  reason text,

  -- granted_at IS the creation timestamp; a separate created_at would be a second answer
  -- to the same question. Same treatment as person_roles in Task 1.7.
  granted_at timestamptz not null default now(),
  expires_at timestamptz,

  -- revoked_at, not deleted_at, and that is the authoritative schema rather than a
  -- preference: a revoked grant is a decision that was made and then withdrawn, which is
  -- exactly what an access review needs to see. person_roles carries no tombstone because
  -- its primary key forbids one; here the uuid key permits it and the audit case wants it.
  revoked_at timestamptz,

  updated_at timestamptz not null default now(),

  constraint record_grants_entity_type_format
    check (entity_type ~ '^[a-z][a-z0-9_]{1,62}$'),
  constraint record_grants_expiry_after_grant
    check (expires_at is null or expires_at > granted_at),
  constraint record_grants_revoked_not_before_grant
    check (revoked_at is null or revoked_at >= granted_at),
  constraint record_grants_reason_not_blank
    check (reason is null or length(btrim(reason)) > 0),

  -- The Task 1.4 composite-key strategy. Two org-bearing parents — the subject and the
  -- grantor — both keyed through this row's single org_id, so both must agree with it and
  -- therefore with each other. A grant cannot join a person in one organization to a
  -- grantor in another, and cannot be created in an organization neither belongs to.
  constraint record_grants_person_same_org
    foreign key (person_id, org_id) references public.people (id, org_id),
  constraint record_grants_granted_by_same_org
    foreign key (granted_by, org_id) references public.people (id, org_id)
);

-- ── indexes ──────────────────────────────────────────────────────────────────────
--
-- The first is database.md section 8, verbatim, and it is the authorization lookup:
-- has_record_grant() always knows the person and the target, and the partial predicate
-- keeps revoked rows out of the index entirely rather than filtering them per probe.
-- permission_id is deliberately NOT in it — the doc does not put it there, and by the time
-- the three leading columns have matched, a person has at most a handful of grants on one
-- record to check the permission against.
create index record_grants_person_entity_idx
  on public.record_grants (person_id, entity_type, entity_id) where revoked_at is null;

-- The remaining three are the "every FK is indexed" rule of database.md section 1, and
-- each is also a question somebody will ask: which grants exist for this permission
-- (access review), what has this person granted (grantor audit), and the tenant scan.
create index record_grants_permission_idx on public.record_grants (permission_id);
create index record_grants_granted_by_idx on public.record_grants (granted_by);
create index record_grants_org_idx on public.record_grants (org_id);

comment on table public.record_grants is
  'Record-level exceptions to scope: one permission, one person, one record, time-boxed. '
  'Never widens a role, a scope or an organization; combined with scope_for() by an OR in '
  'the calling policy.';
comment on column public.record_grants.entity_type is
  'Singular lower_snake_case entity name, e.g. lead, project, document. Compared only as a '
  'parameter, never concatenated into SQL. An unrecognised value reaches nothing.';

create trigger record_grants_set_updated_at
  before update on public.record_grants
  for each row execute function public.set_updated_at();

-- ── grantor and target integrity ─────────────────────────────────────────────────
--
-- The composite keys already prove the grantor is a real person in the same organization.
-- What they cannot prove is that the grantor is the person who actually did it. Migration
-- 0006 established the rule for engagement_events: the actor comes from the transaction
-- identity, never from a column the caller supplies. The same rule applies here, because a
-- grant whose granted_by can be set freely is an audit trail that can be written to name
-- somebody else.
--
-- WHEN THERE IS NO IDENTITY the insert is permitted, and that path is reachable only by
-- app_owner: app_user holds no write privilege on this table at all (see the bottom of
-- this file), so the provisioning route cannot be reached from the application. This is
-- the same shape as the genesis branch in Task 1.7 and is documented here for the same
-- reason — it is a deliberate, bounded exception rather than an oversight.
--
-- ON UPDATE the identifying columns are frozen. Revoking a grant, or moving its expiry, is
-- a change to a decision that was made; repointing its person, permission or target would
-- turn one approved decision into a different one that nobody approved. Only expires_at,
-- revoked_at and reason may change.
create function public.enforce_record_grant_integrity() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    v_actor := authz.person_id();
    if v_actor is not null then
      if new.granted_by is distinct from v_actor then
        raise exception
          'a record grant is attributed to the acting identity; granted_by cannot name another person'
          using errcode = '42501';
      end if;
      if authz.org_id() is distinct from new.org_id then
        raise exception 'a record grant cannot be created in another organization'
          using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.person_id is distinct from old.person_id
     or new.permission_id is distinct from old.permission_id
     or new.entity_type is distinct from old.entity_type
     or new.entity_id is distinct from old.entity_id
     or new.granted_by is distinct from old.granted_by
     or new.granted_at is distinct from old.granted_at then
    raise exception
      'a record grant identifies one person, one permission and one record; those columns are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.enforce_record_grant_integrity() is
  'granted_by must be the acting identity, and the columns that say who may reach what are '
  'immutable once written. Only expires_at, revoked_at and reason may change.';

create trigger record_grants_enforce_integrity
  before insert or update on public.record_grants
  for each row execute function public.enforce_record_grant_integrity();

revoke all on function public.enforce_record_grant_integrity() from public;

-- ── authz.has_record_grant() ─────────────────────────────────────────────────────
--
-- Deferred by Task 1.3 because it needs this table. The signature is database.md 4.1,
-- positionally: (entity_type text, entity_id uuid, p text). Parameters carry p_ prefixes
-- because a plain SQL function resolves a parameter name before a column of the same name,
-- and `entity_type = entity_type` would silently compare the parameter with itself.
--
-- Every condition the task requires, and where each one is enforced:
--
--   valid identity, not soft-deleted, person ACTIVE   authz.person_id() returns NULL
--   organization derived, not caller-supplied         authz.org_id() derives from person
--   organization ACTIVE and not soft-deleted          authz.is_active()
--   engagement ACTIVE and not soft-deleted            authz.is_active()
--   grant in that same organization                   rg.org_id = authz.org_id()
--   grant for that exact person                       rg.person_id = authz.person_id()
--   grant for that exact permission                   p.key = p_permission
--   grant for that exact record                       entity_type and entity_id
--   not revoked                                       rg.revoked_at is null
--   not expired, evaluated now                        expires_at is null or > now()
--
-- It RETURNS FALSE rather than raising, for every one of those. An authorization denial is
-- an ordinary answer, not an error: a policy that raised would turn "you may not see this
-- row" into a failed request, and would leak the existence of the row while doing it.
create function authz.has_record_grant(p_entity_type text, p_entity_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.record_grants rg
    join public.permissions p on p.id = rg.permission_id
    where rg.person_id = authz.person_id()
      and rg.org_id = authz.org_id()
      and rg.entity_type = p_entity_type
      and rg.entity_id = p_entity_id
      and p.key = p_permission
      and rg.revoked_at is null
      -- Expiry in the predicate, as blueprint 7.3 requires. Nothing is scheduled, nothing
      -- can fail to run, and there is no window in which an expired grant still answers.
      and (rg.expires_at is null or rg.expires_at > now())
  )
  and authz.is_active()
$$;

comment on function authz.has_record_grant(text, uuid, text) is
  'Whether the authenticated person holds a live record-level exception for this exact '
  'permission on this exact record, with a live engagement. Never widens a scope; returns '
  'false rather than raising for every form of denial.';

revoke all on function authz.has_record_grant(text, uuid, text) from public;
grant execute on function authz.has_record_grant(text, uuid, text) to app_user, app_admin;

-- ── RLS ──────────────────────────────────────────────────────────────────────────

alter table public.record_grants enable row level security;
alter table public.record_grants force row level security;

create policy record_grants_owner_all on public.record_grants
  for all to app_owner using (true) with check (true);

-- SELF only. A person may see the exceptions granted to them, including expired and
-- revoked ones — being able to see the record that says your temporary access ended is the
-- same argument engagement_events makes in Task 1.6.
--
-- Nobody sees anybody else's, including the grantor and including an administrator. Seeing
-- the organization's grants is a reporting surface, and record_grants.view is deliberately
-- NOT in the catalogue: it is deferred until such a surface is actually designed. Widening
-- this policy is that task's business, not this one's.
create policy record_grants_select_self on public.record_grants
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and person_id = (select authz.person_id())
  );

-- scripts/db/roles.sql grants select, insert and update on every new table in public to
-- app_user by default privilege. A write grant here would let the runtime role issue itself
-- an exception to its own scope, which is the entire attack this table has to survive.
revoke insert, update, delete on public.record_grants from app_user, app_admin;

-- ── record_grants.manage — the capability that will authorize issuing one ────────
--
-- Nothing in this migration consults this permission: the database protects the table by
-- privilege, and Task 1.15's requirePermission() is what will consult it. It exists now
-- because without a catalogue key there is nothing for that check to name, and inventing
-- one at the point of use is how permission catalogues rot.
--
-- Classified sensitive alongside roles.manage and permissions.manage. It is the same kind
-- of authority — the ability to hand out access outside the normal model — and it belongs
-- in the same module. It is NOT added to the blueprint 6.2 protection-conferring set:
-- section 6.2 names roles.manage and permissions.manage specifically, holding this one
-- cannot escalate anybody to role management, and widening that set would change the
-- protected-role rule rather than extend the catalogue.
--
-- record_grants.view is deliberately absent. There is no reporting surface yet, and a
-- permission that nothing consults is a permission somebody eventually grants by accident.

insert into public.permissions (key, resource, action, module, description, is_sensitive)
values (
  'record_grants.manage',
  'record_grants',
  'manage',
  'roles_permissions',
  'Issue and revoke record-level access exceptions. Holding it does not grant the access itself, only the authority to grant it to somebody else',
  true
);

-- ── seeding it to SUPER_ADMIN, in organizations that already exist ───────────────
--
-- Organizations created from here on need nothing: seed_system_roles() cross-joins the
-- whole catalogue into SUPER_ADMIN at GLOBAL, so a new permission is picked up by every
-- tenant created after this migration with no change to that function.
--
-- Organizations that already exist are the awkward case, and this is the pattern every
-- future module-permission migration will have to copy, so it is written out rather than
-- improvised. SUPER_ADMIN is a protected role, so role_permissions_enforce_protection
-- refuses any change to its grants unless the acting identity holds roles.manage at GLOBAL
-- scope. A migration has no acting identity: that trigger's genesis branch only permits the
-- write while an organization has no roles.manage holder at all, which stops being true the
-- moment Task 1.14 bootstraps the first SUPER_ADMIN. Without the disable below, this
-- migration would apply cleanly today against an empty database and fail against a real
-- one — the worst possible failure mode.
--
-- The disable is therefore deliberate, and it is bounded three ways:
--
--   * ALTER TABLE takes ACCESS EXCLUSIVE, so no other session can write to
--     role_permissions while the trigger is off. There is no window for anyone else.
--   * Both statements are inside the migration's transaction, so a failure between them
--     rolls the disable back with everything else. The trigger cannot be left off.
--   * It requires table ownership. app_user owns nothing and holds no DDL privilege, so
--     this is not a route the runtime role can take.
--
-- The rule itself is untouched. It constrains actors changing an authorization model at
-- runtime, which is exactly what a migration is not.
alter table public.role_permissions disable trigger role_permissions_enforce_protection;

insert into public.role_permissions (role_id, permission_id, scope)
select r.id, p.id, 'GLOBAL'::public.access_scope
from public.roles r
cross join public.permissions p
where r.key = 'SUPER_ADMIN'
  and p.key = 'record_grants.manage'
on conflict do nothing;

alter table public.role_permissions enable trigger role_permissions_enforce_protection;

comment on schema authz is
  'Authorization helper functions. Every RLS policy is written in terms of these. '
  'Implemented: person_id, org_id, is_active_person, is_active, aal, my_departments, has, '
  'scope_for, has_record_grant. Remaining: reports_to_me, is_project_member.';
