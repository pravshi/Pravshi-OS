-- PRAVSHI OS — Phase 1 Task 1.19: administrative role assignment.
--
-- WHY THIS FUNCTION EXISTS
--
-- app_user holds no INSERT or DELETE on public.person_roles at all (migration 0008
-- revoked them), and FORCE RLS would deny the writes anyway. The admin UI must still
-- let a roles manager change someone's assignments — promotions, demotions and
-- offboarding-role-removal are ordinary administration, not edge cases. So this one
-- SECURITY DEFINER function performs the replacement. It is not a generic
-- grant_role(): it replaces the WHOLE assignment set for one person in the actor's
-- organization, it cannot touch another org, and every row it writes still passes
-- through the protected-role trigger (migration 0008), which judges the ACTING
-- identity's live roles.manage at GLOBAL scope. The trigger is the enforcement; this
-- function only solves the RLS problem. A bug here cannot escalate anyone to a
-- protected role, because the trigger fires regardless of which database role opened
-- the connection.
--
-- THE CALLER'S PART
--
-- The TypeScript service authorizes roles.manage at GLOBAL scope BEFORE calling, via
-- requirePermission(). Belt and suspenders: the function re-checks
-- may_manage_protected_roles() when the new set contains a protected role, so a
-- confused-deputy call without the permission fails inside the database too.
--
-- LAST-HOLDER RAIL
--
-- Removing the final live holder of roles.manage would lock every administrator out
-- of role management (the genesis exception requires a non-runtime database role).
-- The function refuses a replacement set that leaves the organization with no live
-- holder, unless the person being edited IS that holder keeping it.

create function public.set_person_roles(p_person_id uuid, p_role_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
  v_role_id uuid;
  v_remaining_holders integer;
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  if v_org_id is null or v_actor is null then
    raise exception 'set_person_roles requires an authorized transaction'
      using errcode = '42501';
  end if;

  -- The person must be a live member of the actor's organization. No cross-org edits.
  if not exists (
    select 1 from public.people p
    where p.id = p_person_id
      and p.org_id = v_org_id
      and p.deleted_at is null
  ) then
    raise exception 'person not found in this organization'
      using errcode = 'P0001';
  end if;

  -- Every role must be a live role of the actor's organization.
  if exists (
    select 1
    from unnest(p_role_ids) as rid
    where not exists (
      select 1 from public.roles r
      where r.id = rid
        and r.org_id = v_org_id
        and r.deleted_at is null
        and r.status = 'ACTIVE'
    )
  ) then
    raise exception 'one or more roles are invalid or archived'
      using errcode = 'P0001';
  end if;

  -- Protected roles in the new set require the actor to hold roles.manage at GLOBAL
  -- with a live engagement — re-checked here so the database never trusts the caller.
  if exists (
    select 1 from unnest(p_role_ids) as rid
    where public.role_is_protected(rid)
  ) and not public.may_manage_protected_roles(v_org_id) then
    raise exception 'assigning a protected role requires roles.manage at GLOBAL scope in this organization'
      using errcode = '42501';
  end if;

  -- Last-holder rail: the replacement must not strand the organization with no live
  -- roles.manage holder, unless the edited person keeps holding it themselves.
  select count(*) into v_remaining_holders
  from public.person_roles pr
  join public.roles r on r.id = pr.role_id and r.org_id = pr.org_id
  join public.role_permissions rp on rp.role_id = r.id
  join public.permissions p on p.id = rp.permission_id
  where pr.org_id = v_org_id
    and pr.person_id <> p_person_id
    and (pr.expires_at is null or pr.expires_at > now())
    and r.deleted_at is null
    and r.status = 'ACTIVE'
    and p.key = 'roles.manage';

  if v_remaining_holders = 0
     and not exists (
       select 1 from unnest(p_role_ids) as rid
       join public.role_permissions rp on rp.role_id = rid
       join public.permissions p on p.id = rp.permission_id
       where p.key = 'roles.manage'
     ) then
    raise exception 'this change would remove the last roles.manage holder in the organization'
      using errcode = 'P0001';
  end if;

  -- Replace the set. The protected-role trigger validates each DELETE and INSERT
  -- against the actor's live permission; the person_roles_audit trigger records them.
  delete from public.person_roles
  where person_id = p_person_id
    and org_id = v_org_id;

  for v_role_id in select unnest(p_role_ids) loop
    insert into public.person_roles (person_id, role_id, org_id, granted_by)
    values (p_person_id, v_role_id, v_org_id, v_actor);
  end loop;
end;
$$;

comment on function public.set_person_roles(uuid, uuid[]) is
  'Administrative role replacement for one person in the actor''s org. The caller '
  'authorizes roles.manage at GLOBAL; the protected-role trigger re-validates every '
  'row against the actor''s live permission. Refuses to strand the org without a '
  'roles.manage holder.';

revoke all on function public.set_person_roles(uuid, uuid[]) from public;
grant execute on function public.set_person_roles(uuid, uuid[]) to app_user;
