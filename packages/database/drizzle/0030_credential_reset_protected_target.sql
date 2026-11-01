-- PRAVSHI OS — credential-reset protected-role target guard (security fix).
--
-- THE HOLE. adminResetCredential() authorized the CALLER (users.edit) but never
-- examined the TARGET. If users.edit were ever granted to a non-SUPER_ADMIN role, that
-- holder could reset any SUPER_ADMIN's credential — a latent account takeover.
-- The approved policy (ADR-001): refuse resets on protected-role holders for callers
-- who may not manage protected roles.
--
-- WHY A NEW FUNCTION INSTEAD OF A JOIN IN THE APPLICATION. The application connects
-- as app_user, whose RLS view of the roles tables is deliberately self-only
-- (migration 0008: roles_select_mine, role_permissions_select_mine,
-- person_roles_select_self). A join written in the application would see none of the
-- target's assignments and conclude "not protected" — failing OPEN, exactly the
-- failure the SECURITY DEFINER role_is_protected() exists to prevent (0008: "a caller
-- who could see no grants would conclude 'not protected', which fails OPEN. Running
-- as the owner removes that possibility entirely"). This function answers the
-- question as the owner, through role_is_protected(), so the application reads the
-- truth rather than its own RLS-restricted view.
--
-- POSTURE. Schema-pinned (set search_path = ''), revoked from PUBLIC, granted to
-- app_user only — the same posture as set_person_roles() (0021), the other
-- app-callable definer function that stands in front of a protected-role decision.
-- It answers one fact and makes no decision: the caller-side half of the policy
-- ("may this actor manage protected roles") stays in the application as
-- authz.scope_for('roles.manage') = 'GLOBAL', the app-side rendering of branch 1 of
-- may_manage_protected_roles(). The genesis branch of that function (an org with no
-- holder at all) is unreachable from the application by construction.

create function public.person_holds_protected_role(p_person_id uuid, p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.person_roles pr
    join public.roles r on r.id = pr.role_id and r.org_id = pr.org_id
    where pr.person_id = p_person_id
      and pr.org_id = p_org_id
      and (pr.expires_at is null or pr.expires_at > now())
      and r.deleted_at is null
      and r.status = 'ACTIVE'
      -- role_is_protected(): the explicit is_protected flag OR the derived
      -- protection — a role carrying roles.manage / permissions.manage. Protection
      -- follows the capability, so an unflagged role cannot become an escape hatch.
      and public.role_is_protected(r.id)
  )
$$;

comment on function public.person_holds_protected_role(uuid, uuid) is
  'True when the person holds any live protected role in the given organization. '
  'SECURITY DEFINER so the application reads the truth rather than its own '
  'RLS-restricted view of the role tables. Used by the admin credential-reset guard.';

revoke all on function public.person_holds_protected_role(uuid, uuid) from public;
grant execute on function public.person_holds_protected_role(uuid, uuid) to app_user;
