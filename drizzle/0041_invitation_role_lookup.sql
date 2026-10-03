-- PRAVSHI OS — P0-3: invitation-time role existence lookup.
--
-- WHY SECURITY DEFINER, AND WHY IT IS SAFE
--
-- The roles select policy (roles_select_mine, migration 0017) shows a person
-- only the roles they hold. The invitation service runs inside the INVITER's
-- authorized transaction, so a raw `select ... from public.roles` under RLS
-- returns zero rows for any invitable role the inviter does not personally
-- hold — an administrator inviting a new hire into the EMPLOYEE role they don't
-- hold would get a spurious ROLE_NOT_FOUND and the invitation could never be
-- issued. The invitation_grant_check() design (migration 0019) explicitly
-- intends any non-protected role to be invitable by anyone who may create
-- users; the lookup was the part that didn't match.
--
-- This function is the narrow read path, following the set_person_roles
-- pattern (migration 0021): it runs as the table owner so the existence check
-- can see past RLS, but it can only return the ids of LIVE (non-deleted,
-- ACTIVE) roles belonging to the organization named in the call. It reveals
-- nothing about other organizations, archived roles, or role contents — just
-- existence, which the inviter needs to validate the invitation before issuing
-- it. The protected-role gate stays where it belongs: invitation_grant_check()
-- judges the ACTING identity's live roles.manage at GLOBAL scope at creation,
-- and the person_roles trigger re-checks the inviter at grant time during
-- acceptance. A bug here cannot grant a protected role, because granting is a
-- separate write path with its own enforcement.

create function public.invitation_role_lookup(p_role_ids uuid[], p_org_id uuid)
returns table (id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id
  from public.roles r
  where r.org_id = p_org_id
    and r.id = any (p_role_ids)
    and r.deleted_at is null
    and r.status = 'ACTIVE';
$$;

comment on function public.invitation_role_lookup(uuid[], uuid) is
  'Narrow existence check for invitation creation: the ids of live roles of the '
  'given organization. Runs as the owner to see past roles_select_mine RLS — '
  'the inviter can invite roles they do not hold. Protected-role enforcement '
  'stays in invitation_grant_check(); it is not this function''s job.';

revoke all on function public.invitation_role_lookup(uuid[], uuid) from public;
grant execute on function public.invitation_role_lookup(uuid[], uuid) to app_user;
