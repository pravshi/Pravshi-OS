-- ── 0029: login-events self read ───────────────────────────────────────────────
--
-- Personal login history on /me/security. Migration 0018 deliberately gave
-- login_events no SELF visibility — "a person must not be able to check whether
-- their own failed logins were noticed." That was the right default for a table
-- whose rows are mostly written pre-authentication, but the /me/security
-- self-service surface needs the opposite: showing a person their OWN recent
-- sign-in activity is the standard breach-detection affordance (Google's
-- "recent security activity" pattern), and it shows them nothing about anyone
-- else.
--
-- The policy is narrow by construction:
--
--   * SELECT only, app_user only. No INSERT/UPDATE/DELETE — the append-only
--     trigger from 0018 stays the only write story.
--   * Rows are matched by login identity, not by person-supplied email:
--     login_events.auth_user_id must equal the auth_user_id of the person named
--     by the transaction (authz.person_id()). A caller cannot widen this by
--     naming another person, because the person comes from the transaction, not
--     a parameter.
--   * Gated on authz.is_active(): suspended and offboarded people see nothing.
--
-- Rows with a null auth_user_id (unresolvable pre-auth attempts) stay invisible
-- to everyone but the GLOBAL audit audience and direct database access.

create policy login_events_select_self on public.login_events
  for select to app_user
  using (
    auth_user_id = (
      select p.auth_user_id
      from public.people p
      where p.id = (select authz.person_id())
    )
    and (select authz.is_active())
  );

comment on policy login_events_select_self on public.login_events is
  'Self-service read: a person sees only their own login_events rows, matched '
  'by login identity from the transaction. Failed logins included — this is the '
  'breach-detection affordance, not an enumeration surface.';
