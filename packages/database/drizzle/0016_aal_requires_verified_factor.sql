-- PRAVSHI OS — Phase 1 Task 1.15: authz.aal() requires a verified second factor.
--
-- Task 1.13 made aal2 a fact about a SESSION and taught authz.aal() to refuse a claim of aal2
-- for anybody without a second factor, by reading auth.auth_users.two_factor_enabled. Under
-- Better Auth's own flows that flag and a verified factor travel together: enabling is refused
-- while a verified factor exists, and disabling clears the flag and deletes the row in the same
-- request.
--
-- The flag is still only a flag. A factor row removed out of band — by hand, by a future code
-- path, by a partial restore — leaves two_factor_enabled true with nothing behind it, and a
-- session claiming aal2 would keep it. Task 1.15 makes aal2 MANDATORY for privileged people, so
-- this level now gates real access, and the claim has to be checked against the factor itself.
--
-- ── THE RULE ─────────────────────────────────────────────────────────────────────
--
-- A claim of aal2 is honoured only when the person
--
--   * resolves through authz.person_id()   exists, not soft-deleted, ACTIVE
--   * has a login with two_factor_enabled  enrolment, as in Task 1.13
--   * whose factor row is verified         the part this migration adds
--
-- Anything else — no factor, an unverified one, a deleted one, a flag with no row behind it — is
-- aal1.
--
-- ── WHAT DOES NOT CHANGE ─────────────────────────────────────────────────────────
--
--   * The claim still comes only from the session row stamped at creation; the application
--     copies it into app.aal and nothing a client sends can set it.
--   * The claim can only ever be refused, never widened.
--   * The floor is 'aal1', never NULL, so no caller has a third state to mishandle.
--   * This remains the only authz helper that reads the auth schema.
--   * No table, policy or grant changes, and the authz helper set stays at ten.

create or replace function authz.aal() returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when nullif(current_setting('app.aal', true), '') = 'aal2'
     and exists (
       select 1
       from public.people p
       join auth.auth_users u on u.id = p.auth_user_id
       join auth.auth_two_factors f on f.user_id = u.id
       where p.id = authz.person_id()
         and u.two_factor_enabled
         and f.verified
     )
    then 'aal2'
    else 'aal1'
  end
$$;

comment on function authz.aal() is
  'Authentication assurance for this transaction. Returns aal2 only when the application claims '
  'it AND the person holds a login with two_factor_enabled AND a verified second-factor row; '
  'aal1 otherwise, including with no identity. A forged or stale claim can never widen access.';

-- CREATE OR REPLACE preserves grants; the pair is repeated so the migration is correct whatever
-- state it runs against.
revoke all on function authz.aal() from public;
grant execute on function authz.aal() to app_user, app_admin;
