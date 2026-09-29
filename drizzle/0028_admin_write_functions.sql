-- PRAVSHI OS — Phase 1 RBAC UI: administrative write functions.
--
-- WHY THESE FUNCTIONS EXIST
--
-- app_user holds no INSERT/UPDATE/DELETE on public.role_permissions,
-- public.departments, public.teams, or public.team_members (migrations 0004 and
-- 0008 revoked them), and FORCE RLS would deny the writes anyway. The admin UI
-- must still let a roles manager edit permission grants and a teams manager
-- restructure teams — ordinary administration, not edge cases. So these narrow
-- SECURITY DEFINER functions perform the writes. They are not generic mutators:
-- each replaces a well-defined set inside the actor's organization, and every
-- row still passes through the existing triggers (protected-role enforcement on
-- role_permissions, audit triggers, immutable-code enforcement on departments).
-- A bug here cannot escalate anyone, because the triggers fire regardless of
-- which database role opened the connection.
--
-- THE CALLER'S PART
--
-- The TypeScript service authorizes the matching *.manage permission at an
-- appropriate scope BEFORE calling, via requirePermission(). Belt and
-- suspenders: set_role_permissions re-checks may_manage_protected_roles() when
-- the role is protected or a grant confers roles.manage/permissions.manage, so
-- a confused-deputy call without the permission fails inside the database too.
-- (The role_permissions_enforce_protection trigger already performs this check
-- on every row; the explicit check here produces a clearer error before any
-- row is touched.)
--
-- DEPARTMENTS NOTE
--
-- src/lib/admin/departments.ts previously issued INSERT/UPDATE directly as
-- app_user, which the 0004 revokes deny — department creation and archiving
-- were broken at runtime. create_department()/archive_department() repair that
-- path through the same narrow-function pattern used everywhere else here.

-- ── set_role_permissions ─────────────────────────────────────────────────────
--
-- Replaces the WHOLE permission-grant set for one role in the actor's
-- organization. p_grants is a JSONB array of {"permission": "<key>",
-- "scope": "<access_scope>"}.
--
-- LAST-HOLDER RAIL
--
-- Removing roles.manage from the last role that confers it would lock every
-- administrator out of role management (the genesis exception requires a
-- non-runtime database role). The function refuses a replacement set that
-- leaves the organization with no live roles.manage holder.

create function public.set_role_permissions(p_role_id uuid, p_grants jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
  v_grant jsonb;
  v_permission_id uuid;
  v_scope text;
  v_remaining_holders integer;
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  if v_org_id is null or v_actor is null then
    raise exception 'set_role_permissions requires an authorized transaction'
      using errcode = '42501';
  end if;

  -- The role must be a live role of the actor's organization. No cross-org edits.
  if not exists (
    select 1 from public.roles r
    where r.id = p_role_id
      and r.org_id = v_org_id
      and r.deleted_at is null
      and r.status = 'ACTIVE'
  ) then
    raise exception 'role not found in this organization'
      using errcode = 'P0001';
  end if;

  if p_grants is null or jsonb_typeof(p_grants) <> 'array' then
    raise exception 'grants must be a JSON array'
      using errcode = 'P0001';
  end if;

  -- Protected roles, or grants conferring role management, require the actor to
  -- hold roles.manage at GLOBAL — re-checked here so the database never trusts
  -- the caller. The row trigger re-validates every write regardless.
  if public.role_is_protected(p_role_id)
     or exists (
       select 1 from jsonb_array_elements(p_grants) g
       where g->>'permission' in ('roles.manage', 'permissions.manage')
     ) then
    if not public.may_manage_protected_roles(v_org_id) then
      raise exception 'changing this role requires roles.manage at GLOBAL scope in this organization'
        using errcode = '42501';
    end if;
  end if;

  -- Validate every grant before touching a row: the permission key must exist in
  -- the catalogue and the scope must be a real access_scope value.
  for v_grant in select * from jsonb_array_elements(p_grants) loop
    select p.id into v_permission_id
    from public.permissions p
    where p.key = v_grant->>'permission';
    if v_permission_id is null then
      raise exception 'unknown permission: %', v_grant->>'permission'
        using errcode = 'P0001';
    end if;
    v_scope := v_grant->>'scope';
    if v_scope is null then
      raise exception 'grant for % is missing a scope', v_grant->>'permission'
        using errcode = 'P0001';
    end if;
    begin
      perform v_scope::public.access_scope;
    exception when invalid_text_representation then
      raise exception 'invalid scope: %', v_scope
        using errcode = 'P0001';
    end;
  end loop;

  -- Last-holder rail: the replacement must not strand the organization with no
  -- live roles.manage holder. A holder is a live person whose live roles confer
  -- roles.manage; the edited role's own future grants count, every other role's
  -- current grants count.
  select count(*) into v_remaining_holders
  from (
    select distinct pr.person_id
    from public.person_roles pr
    join public.roles r on r.id = pr.role_id and r.org_id = pr.org_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where pr.org_id = v_org_id
      and (pr.expires_at is null or pr.expires_at > now())
      and r.deleted_at is null
      and r.status = 'ACTIVE'
      and r.id <> p_role_id
      and p.key = 'roles.manage'
    union
    select pr.person_id
    from public.person_roles pr
    join jsonb_array_elements(p_grants) g on g->>'permission' = 'roles.manage'
    where pr.org_id = v_org_id
      and pr.role_id = p_role_id
      and (pr.expires_at is null or pr.expires_at > now())
  ) holders;

  if v_remaining_holders = 0 then
    raise exception 'this change would remove the last roles.manage holder in the organization'
      using errcode = 'P0001';
  end if;

  -- Replace the set. The protection trigger validates each DELETE and INSERT
  -- against the actor's live permission; the audit trigger records them.
  delete from public.role_permissions where role_id = p_role_id;

  for v_grant in select * from jsonb_array_elements(p_grants) loop
    select p.id into v_permission_id
    from public.permissions p
    where p.key = v_grant->>'permission';
    insert into public.role_permissions (role_id, permission_id, scope)
    values (p_role_id, v_permission_id, (v_grant->>'scope')::public.access_scope);
  end loop;
end;
$$;

comment on function public.set_role_permissions(uuid, jsonb) is
  'Administrative permission-grant replacement for one role in the actor''s org. '
  'The caller authorizes roles.manage; protected roles and role-management grants '
  'additionally require roles.manage at GLOBAL, re-checked here and by the row '
  'trigger. Refuses to strand the org without a roles.manage holder.';

revoke all on function public.set_role_permissions(uuid, jsonb) from public;
grant execute on function public.set_role_permissions(uuid, jsonb) to app_user;

-- ── create_department / archive_department ────────────────────────────────────
--
-- Repairs the departments admin path: app_user cannot INSERT/UPDATE departments
-- directly (migration 0004 revoked it), so these functions perform the writes.
-- The caller authorizes departments.manage via requirePermission().

create function public.create_department(p_code text, p_name text, p_parent_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
  v_id uuid;
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  if v_org_id is null or v_actor is null then
    raise exception 'create_department requires an authorized transaction'
      using errcode = '42501';
  end if;

  if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{1,15}$' then
    raise exception 'department code must match ^[A-Z][A-Z0-9_]{1,15}$'
      using errcode = 'P0001';
  end if;

  if p_name is null or length(btrim(p_name)) = 0 then
    raise exception 'department name is required'
      using errcode = 'P0001';
  end if;

  if p_parent_id is not null and not exists (
    select 1 from public.departments d
    where d.id = p_parent_id
      and d.org_id = v_org_id
      and d.deleted_at is null
  ) then
    raise exception 'parent department not found in this organization'
      using errcode = 'P0001';
  end if;

  insert into public.departments (org_id, code, name, parent_id)
  values (v_org_id, p_code, p_name, p_parent_id)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_department(text, text, uuid) is
  'Administrative department creation in the actor''s org. The caller authorizes '
  'departments.manage.';

revoke all on function public.create_department(text, text, uuid) from public;
grant execute on function public.create_department(text, text, uuid) to app_user;

create function public.archive_department(p_department_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  if v_org_id is null or v_actor is null then
    raise exception 'archive_department requires an authorized transaction'
      using errcode = '42501';
  end if;

  update public.departments
  set status = 'ARCHIVED', updated_at = now()
  where id = p_department_id
    and org_id = v_org_id
    and deleted_at is null
    and status = 'ACTIVE';

  if not found then
    raise exception 'department not found or already archived'
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function public.archive_department(uuid) is
  'Administrative department archival in the actor''s org. The caller authorizes '
  'departments.manage.';

revoke all on function public.archive_department(uuid) from public;
grant execute on function public.archive_department(uuid) to app_user;

-- ── Teams ─────────────────────────────────────────────────────────────────────
--
-- Teams belong to exactly one department (migration 0004); membership joins
-- people to teams with the composite-FK org guard. app_user cannot write these
-- tables directly, so the functions below perform the writes. The caller
-- authorizes teams.manage via requirePermission().

create function public.create_team(p_department_id uuid, p_name text, p_lead_person_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
  v_id uuid;
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  if v_org_id is null or v_actor is null then
    raise exception 'create_team requires an authorized transaction'
      using errcode = '42501';
  end if;

  if p_name is null or length(btrim(p_name)) = 0 then
    raise exception 'team name is required'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.departments d
    where d.id = p_department_id
      and d.org_id = v_org_id
      and d.deleted_at is null
      and d.status = 'ACTIVE'
  ) then
    raise exception 'department not found in this organization'
      using errcode = 'P0001';
  end if;

  if p_lead_person_id is not null and not exists (
    select 1 from public.people p
    where p.id = p_lead_person_id
      and p.org_id = v_org_id
      and p.deleted_at is null
  ) then
    raise exception 'team lead not found in this organization'
      using errcode = 'P0001';
  end if;

  insert into public.teams (org_id, department_id, name, lead_person_id)
  values (v_org_id, p_department_id, p_name, p_lead_person_id)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_team(uuid, text, uuid) is
  'Administrative team creation in the actor''s org, inside one of its active '
  'departments. The caller authorizes teams.manage.';

revoke all on function public.create_team(uuid, text, uuid) from public;
grant execute on function public.create_team(uuid, text, uuid) to app_user;

create function public.update_team(p_team_id uuid, p_name text, p_lead_person_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  if v_org_id is null or v_actor is null then
    raise exception 'update_team requires an authorized transaction'
      using errcode = '42501';
  end if;

  if p_name is null or length(btrim(p_name)) = 0 then
    raise exception 'team name is required'
      using errcode = 'P0001';
  end if;

  if p_lead_person_id is not null and not exists (
    select 1 from public.people p
    where p.id = p_lead_person_id
      and p.org_id = v_org_id
      and p.deleted_at is null
  ) then
    raise exception 'team lead not found in this organization'
      using errcode = 'P0001';
  end if;

  update public.teams
  set name = p_name,
      lead_person_id = p_lead_person_id,
      updated_at = now()
  where id = p_team_id
    and org_id = v_org_id
    and deleted_at is null;

  if not found then
    raise exception 'team not found in this organization'
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function public.update_team(uuid, text, uuid) is
  'Administrative team rename / lead change in the actor''s org. The caller '
  'authorizes teams.manage.';

revoke all on function public.update_team(uuid, text, uuid) from public;
grant execute on function public.update_team(uuid, text, uuid) to app_user;

create function public.archive_team(p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  if v_org_id is null or v_actor is null then
    raise exception 'archive_team requires an authorized transaction'
      using errcode = '42501';
  end if;

  -- Soft-delete the team and end its active memberships in the same statement
  -- set, so no orphaned membership outlives its team.
  update public.team_members
  set deleted_at = now(), updated_at = now()
  where team_id = p_team_id
    and org_id = v_org_id
    and deleted_at is null;

  update public.teams
  set deleted_at = now(), updated_at = now()
  where id = p_team_id
    and org_id = v_org_id
    and deleted_at is null;

  if not found then
    raise exception 'team not found in this organization'
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function public.archive_team(uuid) is
  'Administrative team archival in the actor''s org; ends active memberships too. '
  'The caller authorizes teams.manage.';

revoke all on function public.archive_team(uuid) from public;
grant execute on function public.archive_team(uuid) to app_user;

-- ── set_team_members ───────────────────────────────────────────────────────────
--
-- Replaces the WHOLE active membership set for one team in the actor's
-- organization: members in the new set stay (or are re-added), everyone else is
-- soft-deleted. Every person must be a live member of the actor's organization;
-- cross-org membership is unrepresentable.

create function public.set_team_members(p_team_id uuid, p_person_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  if v_org_id is null or v_actor is null then
    raise exception 'set_team_members requires an authorized transaction'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.teams t
    where t.id = p_team_id
      and t.org_id = v_org_id
      and t.deleted_at is null
  ) then
    raise exception 'team not found in this organization'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1 from unnest(p_person_ids) as pid
    where not exists (
      select 1 from public.people p
      where p.id = pid
        and p.org_id = v_org_id
        and p.deleted_at is null
    )
  ) then
    raise exception 'one or more people are not members of this organization'
      using errcode = 'P0001';
  end if;

  -- End memberships that are not in the new set.
  update public.team_members
  set deleted_at = now(), updated_at = now()
  where team_id = p_team_id
    and org_id = v_org_id
    and deleted_at is null
    and not (person_id = any (p_person_ids));

  -- Rejoiners: reactivate their most recent tombstoned membership instead of
  -- inserting a duplicate row.
  update public.team_members tm
  set deleted_at = null, updated_at = now()
  from (
    select distinct on (person_id) id
    from public.team_members
    where team_id = p_team_id
      and org_id = v_org_id
      and person_id = any (p_person_ids)
      and deleted_at is not null
    order by person_id, deleted_at desc
  ) rejoin
  where tm.id = rejoin.id;

  -- Brand-new members: insert rows for people with no active membership.
  insert into public.team_members (org_id, team_id, person_id)
  select v_org_id, p_team_id, pid
  from unnest(p_person_ids) as pid
  where not exists (
    select 1 from public.team_members tm2
    where tm2.team_id = p_team_id
      and tm2.person_id = pid
      and tm2.deleted_at is null
  );
end;
$$;

comment on function public.set_team_members(uuid, uuid[]) is
  'Administrative membership replacement for one team in the actor''s org. The '
  'caller authorizes teams.manage.';

revoke all on function public.set_team_members(uuid, uuid[]) from public;
grant execute on function public.set_team_members(uuid, uuid[]) to app_user;
