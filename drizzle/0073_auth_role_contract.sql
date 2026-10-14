-- ═════════════════════════════════════════════════════════════════════════════
-- 0073_auth_role_contract — app_user leaves the authentication plane (contract)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 0072 gave app_auth the credential store and the pre-login functions; the
-- application's auth module now reaches the database through app_auth alone
-- (DATABASE_URL_AUTH). This migration takes all of it away from app_user, the
-- web application's business role:
--
--   * every privilege on the six Better Auth tables, and USAGE on schema auth —
--     password hashes, sessions and their tokens, TOTP secrets and backup codes,
--     login emails, verification values and rate-limit state are no longer
--     reachable from a business connection;
--   * EXECUTE on the pre-login functions — the password update, reset minting
--     and consumption, lockout reads and clears, rate-limit buckets, login events,
--     email-to-organization lookup, session identity resolution, invitation
--     acceptance and bootstrap completion.
--
-- What app_user KEEPS is its business role: RLS-governed tables, the business
-- definers, and authz.aal() — a definer it calls on every request, which reads the
-- two-factor tables as the owner.
--
-- WHAT THIS DOES NOT CLOSE (T-22 part 1, design D6): app_user can still set
-- app.person_id / app.org_id / app.aal itself and read business data as a person
-- whose id it knows. The administrator definers of 0072 do not depend on those
-- settings; the business definers still do.
--
-- DEPLOYMENT ORDER. Apply only once the application that uses DATABASE_URL_AUTH is
-- deployed. Applied under the OLD application (auth on app_user), sign-in and every
-- session check fail closed with 42501 — nobody can sign in, nothing is exposed —
-- until the new application is deployed or the emergency rollback
-- (scripts/db/rollback/0073_auth_role_contract.down.sql) is run.
--
--   PART 1  revoke
--   PART 2  verification of the final matrix
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — revoke
-- ═════════════════════════════════════════════════════════════════════════════
revoke all on auth.auth_users, auth.auth_accounts, auth.auth_sessions, auth.auth_two_factors,
              auth.auth_verifications, auth.auth_rate_limits
  from app_user;
revoke usage on schema auth from app_user;

revoke execute on function authz.check_rate_limit(text, integer, integer)                      from app_user;
revoke execute on function authz.request_password_reset(text, text)                             from app_user;
revoke execute on function authz.consume_password_reset(text)                                   from app_user;
revoke execute on function authz.update_credential_password(uuid, text)                         from app_user;
revoke execute on function authz.record_password_reset_audit(uuid, inet, text)                  from app_user;
revoke execute on function public.enqueue_password_reset_email(uuid, text, text)                from app_user;
revoke execute on function authz.check_login_lockout(text)                                      from app_user;
revoke execute on function authz.record_login_failure(text, inet, text)                         from app_user;
revoke execute on function authz.clear_login_lockout(text)                                      from app_user;
revoke execute on function authz.mfa_enrollment_required(uuid)                                 from app_user;
revoke execute on function authz.login_person_active(uuid)                                      from app_user;
revoke execute on function authz.stamp_sessions_revoked(uuid)                                   from app_user;
revoke execute on function public.resolve_login_org(public.citext)                              from app_user;
revoke execute on function public.record_login_event(uuid, text, public.citext, uuid, inet, text, jsonb) from app_user;
revoke execute on function public.resolve_auth_identity(uuid, timestamptz)                      from app_user;
revoke execute on function public.invitation_preview(text)                                      from app_user;
revoke execute on function public.accept_invitation(text, text, text)                           from app_user;
revoke execute on function public.bootstrap_setup_pending()                                     from app_user;
revoke execute on function public.bootstrap_setup_token_is_valid(bytea)                         from app_user;
revoke execute on function public.complete_bootstrap_setup(bytea, text)                         from app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — verification
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_problems text;
begin
  with prelogin(sig) as (
    values
      ('authz.check_rate_limit(text,integer,integer)'),
      ('authz.request_password_reset(text,text)'),
      ('authz.consume_password_reset(text)'),
      ('authz.update_credential_password(uuid,text)'),
      ('authz.record_password_reset_audit(uuid,inet,text)'),
      ('public.enqueue_password_reset_email(uuid,text,text)'),
      ('authz.check_login_lockout(text)'),
      ('authz.record_login_failure(text,inet,text)'),
      ('authz.clear_login_lockout(text)'),
      ('authz.mfa_enrollment_required(uuid)'),
      ('authz.login_person_active(uuid)'),
      ('authz.stamp_sessions_revoked(uuid)'),
      ('public.resolve_login_org(public.citext)'),
      ('public.record_login_event(uuid,text,public.citext,uuid,inet,text,jsonb)'),
      ('public.resolve_auth_identity(uuid,timestamptz)'),
      ('public.invitation_preview(text)'),
      ('public.accept_invitation(text,text,text)'),
      ('public.bootstrap_setup_pending()'),
      ('public.bootstrap_setup_token_is_valid(bytea)'),
      ('public.complete_bootstrap_setup(bytea,text)'),
      ('authz.admin_session_action(text,uuid,text,uuid,uuid,inet,text)'),
      ('authz.admin_issue_credential_reset(text,uuid,text,uuid,inet,text)')
  )
  select string_agg(problem, '; ') into v_problems
  from (
    -- app_user: nothing in the auth schema.
    select 'app_user holds ' || priv || ' on ' || c.oid::regclass::text as problem
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace,
         unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) priv
    where n.nspname = 'auth'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_table_privilege('app_user', c.oid, priv)
    union all
    select 'app_user holds USAGE on schema auth'
    where has_schema_privilege('app_user', 'auth', 'usage')
    union all
    -- The pre-login and administrator functions: app_auth's, nobody else's.
    select p.sig || ' is missing or not executable by app_auth'
    from prelogin p
    where to_regprocedure(p.sig) is null
       or not has_function_privilege('app_auth', p.sig, 'execute')
    union all
    select p.sig || ' is executable by ' || r
    from prelogin p, unnest(array['app_user', 'app_worker']) r
    where to_regprocedure(p.sig) is not null
      and has_function_privilege(r, p.sig, 'execute')
    union all
    select p.sig || ' is executable by PUBLIC'
    from prelogin p
    join pg_proc f on f.oid = to_regprocedure(p.sig),
         aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
    where a.grantee = 0 and a.privilege_type = 'EXECUTE'
    union all
    -- app_admin keeps only what it had: none of these (bootstrap_organization is its own).
    select p.sig || ' is executable by app_admin'
    from prelogin p
    where to_regprocedure(p.sig) is not null
      and has_function_privilege('app_admin', p.sig, 'execute')
    union all
    -- The business plane keeps authz.aal().
    select 'authz.aal() is no longer executable by app_user'
    where not has_function_privilege('app_user', 'authz.aal()', 'execute')
    union all
    -- app_auth: no business table, no worker function, no membership.
    select 'app_auth holds ' || priv || ' on ' || c.oid::regclass::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace,
         unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) priv
    where n.nspname in ('public', 'authz')
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_table_privilege('app_auth', c.oid, priv)
    union all
    select 'app_auth can execute the worker function ' || w
    from unnest(array['public.jobs_claim_next(text,text[])', 'public.run_data_retention(integer)',
                      'public.jobs_run_cleanup(uuid,text)']) w
    where to_regprocedure(w) is not null and has_function_privilege('app_auth', w, 'execute')
    union all
    select 'app_auth shares a role membership'
    where exists (
      select 1 from pg_auth_members am
      join pg_roles m on m.oid = am.member join pg_roles r on r.oid = am.roleid
      where 'app_auth' in (m.rolname, r.rolname))
    union all
    select 'app_worker holds a privilege in the auth schema'
    where has_schema_privilege('app_worker', 'auth', 'usage')
  ) problems;

  if v_problems is not null then
    raise exception '0073 app_auth contract incomplete: %', v_problems;
  end if;
end;
$$;
