-- PRAVSHI OS — Phase 1: /setup page server guard.
--
-- The /setup page is the frontend half of the bootstrap flow from 0015: it reads the
-- #token=… fragment the operator's script printed and posts the owner's first password
-- to /api/bootstrap/complete. The page must not be reachable once there is nothing left
-- to set up — neither before the operator runs the script (no token can be valid) nor
-- after the token is consumed or expired — and that decision has to be made on the
-- server, not trusted to the client.
--
-- app_user holds no privilege on bootstrap_state or bootstrap_setup_token (0015 revokes
-- the roles.sql defaults outright), so the page asks through this narrow SECURITY
-- DEFINER function instead, the same arrangement as bootstrap_setup_token_is_valid().
--
-- What it answers: exactly one bit — whether a live, unconsumed setup token exists
-- right now. It names no person, no organization, no digest, and it cannot be used as
-- an oracle for anything else: the /setup page itself only exists to be visited while
-- a token is live, and it redirects to /login otherwise.

create function public.bootstrap_setup_pending()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.bootstrap_state)
     and exists (
       select 1
       from public.bootstrap_setup_token t
       where t.consumed_at is null
         and t.expires_at > now()
     )
$$;

comment on function public.bootstrap_setup_pending() is
  'Whether the one-time bootstrap setup is still pending: the database was bootstrapped '
  'and the setup token is live, unconsumed and unexpired. The /setup page''s server guard; '
  'EXECUTE: app_user only.';

revoke all on function public.bootstrap_setup_pending() from public;
grant execute on function public.bootstrap_setup_pending() to app_user;
