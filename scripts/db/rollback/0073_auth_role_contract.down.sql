-- ═════════════════════════════════════════════════════════════════════════════
-- EMERGENCY ROLLBACK of 0073_auth_role_contract — REOPENS THE SECURITY GAP
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Use only when 0073 is applied and the application that authenticates through
-- app_auth (DATABASE_URL_AUTH) cannot be deployed or restored, and sign-in must
-- work again on the OLD application, which authenticates as app_user. Prefer
-- rolling forward: deploy the new application.
--
-- What it does: gives app_user back exactly what 0073 took — the six Better Auth
-- tables (the grants of 0013/0014), USAGE on schema auth, and EXECUTE on the
-- pre-login functions. After it runs, SQL executed as app_user can again read
-- password hashes, session tokens and TOTP secrets and set any password: the
-- state WP-A1 exists to end. Record why it was run, and re-apply the contract
-- (re-running 0073's statements by hand) as soon as the new application is live.
--
-- What it does NOT do: it leaves app_auth and everything 0072 created in place
-- (app_auth holds no data), and it does not touch the drizzle migration journal —
-- 0073 stays recorded as applied, so the runner will not re-apply it; re-applying
-- is a deliberate operator step.
--
-- Run as the branch owner (app_owner), in one transaction:
--   psql "$DATABASE_URL_MIGRATE" -v ON_ERROR_STOP=1 -1 -f scripts/db/rollback/0073_auth_role_contract.down.sql
-- Never against production without the founder's explicit approval for this step.
-- ═════════════════════════════════════════════════════════════════════════════

grant usage on schema auth to app_user;
grant select, insert, update         on auth.auth_users         to app_user;
grant select, insert, update, delete on auth.auth_accounts      to app_user;
grant select, insert, update, delete on auth.auth_sessions      to app_user;
grant select, insert, update, delete on auth.auth_two_factors   to app_user;
grant select, insert, update, delete on auth.auth_verifications to app_user;
grant select, insert, update, delete on auth.auth_rate_limits   to app_user;

grant execute on function authz.check_rate_limit(text, integer, integer)                      to app_user;
grant execute on function authz.request_password_reset(text, text)                             to app_user;
grant execute on function authz.consume_password_reset(text)                                   to app_user;
grant execute on function authz.update_credential_password(uuid, text)                         to app_user;
grant execute on function authz.record_password_reset_audit(uuid, inet, text)                  to app_user;
grant execute on function public.enqueue_password_reset_email(uuid, text, text)                to app_user;
grant execute on function authz.check_login_lockout(text)                                      to app_user;
grant execute on function authz.record_login_failure(text, inet, text)                         to app_user;
grant execute on function authz.clear_login_lockout(text)                                      to app_user;
grant execute on function authz.mfa_enrollment_required(uuid)                                 to app_user;
grant execute on function authz.login_person_active(uuid)                                      to app_user;
grant execute on function authz.stamp_sessions_revoked(uuid)                                   to app_user;
grant execute on function public.resolve_login_org(public.citext)                              to app_user;
grant execute on function public.record_login_event(uuid, text, public.citext, uuid, inet, text, jsonb) to app_user;
grant execute on function public.resolve_auth_identity(uuid, timestamptz)                      to app_user;
grant execute on function public.invitation_preview(text)                                      to app_user;
grant execute on function public.accept_invitation(text, text, text)                           to app_user;
grant execute on function public.bootstrap_setup_pending()                                     to app_user;
grant execute on function public.bootstrap_setup_token_is_valid(bytea)                         to app_user;
grant execute on function public.complete_bootstrap_setup(bytea, text)                         to app_user;
