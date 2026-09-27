-- PRAVSHI OS — Phase 1 Task 1.18: login-event org resolution.
--
-- The login routes run pre-authentication and must attribute LOGIN_SUCCESS /
-- LOGIN_FAILURE / MFA_* events to an organization so the audit audience can see them
-- under RLS. Resolving email -> org is a single bounded question, so it is a single
-- STABLE SECURITY DEFINER function granted to app_user — not a general read of
-- public.people, which the pre-auth path must never have.

create function public.resolve_login_org(p_email public.citext)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  -- The same address can exist in two orgs only by administrative accident; prefer the
  -- person who actually holds a login, then the oldest row. A login event attributed
  -- to the wrong org is a misfiled security signal, so the preference is explicit.
  select p.org_id
  from public.people p
  where p.work_email = p_email
    and p.deleted_at is null
  order by (p.auth_user_id is null), p.created_at
  limit 1;
$$;

comment on function public.resolve_login_org(public.citext) is
  'Pre-authentication helper for the login routes: resolves an attempted email to the '
  'organization that should see the resulting login event. Returns NULL when the email '
  'resolves to nobody. Granted to app_user; the only public.people read the pre-auth '
  'path is allowed.';

revoke all on function public.resolve_login_org(public.citext) from public;
grant execute on function public.resolve_login_org(public.citext) to app_user;
