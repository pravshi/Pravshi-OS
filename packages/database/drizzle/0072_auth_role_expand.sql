-- ═════════════════════════════════════════════════════════════════════════════
-- 0072_auth_role_expand — the authentication plane gets its own role (expand)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE GAP. Better Auth and every pre-authentication flow ran on app_user, the
-- web application's business role, and app_user therefore held direct SELECT /
-- INSERT / UPDATE / DELETE on the credential store: password hashes
-- (auth_accounts), sessions and their bearer tokens (auth_sessions), TOTP
-- secrets and backup codes (auth_two_factors), every login's email
-- (auth_users), verification values and the library's rate-limit state — none of
-- it under RLS — plus EXECUTE on the pre-login definers (password update with no
-- proof, reset minting, lockout clearing, email-to-organization lookup). SQL
-- running as app_user could take over any account. (Design:
-- audit-output/2026-10-14-auth-role-package-design.md, revision 2, WP-A1.)
--
-- THE BOUNDARY. A dedicated login role, app_auth, created by
-- scripts/db/roles.sql, holds the credential store and the pre-login functions;
-- the web application's auth module reaches the database through it alone
-- (DATABASE_URL_AUTH, src/lib/db/auth-pool.ts). 0073 then takes all of it away
-- from app_user. This migration only ADDS — the old application, on app_user,
-- keeps working until the new one is deployed (expand / contract).
--
--   PART 1  preconditions: app_auth exists, holds no dangerous attribute, and
--           shares no membership with any application role
--   PART 2  the credential store and the pre-login functions: granted to
--           app_auth (app_user keeps its grants until 0073)
--   PART 3  administrator actions proven by the administrator's own session:
--           authz.verified_session_actor() (internal), authz.admin_session_action()
--           and authz.admin_issue_credential_reset() — app_auth only. Neither
--           takes its caller's authority from app.person_id / app.org_id /
--           app.aal, which app_user can set itself.
--   PART 4  verification
--
-- app_auth gets no privilege on any business table and no RLS policy.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — preconditions
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_bad text;
begin
  if not exists (select 1 from pg_roles where rolname = 'app_auth') then
    raise exception 'role app_auth does not exist: run scripts/db/roles.sql as the branch owner first (it creates the role), set its password, then re-run the migrations';
  end if;

  if exists (
    select 1 from pg_roles
    where rolname = 'app_auth'
      and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or not rolcanlogin)
  ) then
    raise exception 'app_auth must be a plain login role (no SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB)';
  end if;

  -- app_auth is a member of no role, and no role is a member of it except the database owner,
  -- which is not an application role: PostgreSQL 16+ grants a non-superuser creator (Neon's
  -- branch owner, running scripts/db/roles.sql) ADMIN on the roles it creates — see 0070.
  select string_agg(m.rolname || ' -> ' || r.rolname, ', ') into v_bad
  from pg_auth_members am
  join pg_roles m on m.oid = am.member
  join pg_roles r on r.oid = am.roleid
  where m.rolname = 'app_auth'
     or (r.rolname = 'app_auth'
         and (am.member <> (select datdba from pg_database where datname = current_database())
              or m.rolname like 'app\_%'));
  if v_bad is not null then
    raise exception 'app_auth must share no role membership: %', v_bad;
  end if;
end;
$$;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — the credential store and the pre-login functions
-- ═════════════════════════════════════════════════════════════════════════════
-- Exactly the table privileges app_user holds today (0013 / 0014): narrowing them
-- is a separate step, taken only row by row when a test proves a privilege unused.
grant usage on schema auth, authz to app_auth;
grant select, insert, update         on auth.auth_users         to app_auth;
grant select, insert, update, delete on auth.auth_accounts      to app_auth;
grant select, insert, update, delete on auth.auth_sessions      to app_auth;
grant select, insert, update, delete on auth.auth_two_factors   to app_auth;
grant select, insert, update, delete on auth.auth_verifications to app_auth;
grant select, insert, update, delete on auth.auth_rate_limits   to app_auth;

grant execute on function authz.check_rate_limit(text, integer, integer)                      to app_auth;
grant execute on function authz.request_password_reset(text, text)                             to app_auth;
grant execute on function authz.consume_password_reset(text)                                   to app_auth;
grant execute on function authz.update_credential_password(uuid, text)                         to app_auth;
grant execute on function authz.record_password_reset_audit(uuid, inet, text)                  to app_auth;
grant execute on function public.enqueue_password_reset_email(uuid, text, text)                to app_auth;
grant execute on function authz.check_login_lockout(text)                                      to app_auth;
grant execute on function authz.record_login_failure(text, inet, text)                         to app_auth;
grant execute on function authz.clear_login_lockout(text)                                      to app_auth;
grant execute on function authz.mfa_enrollment_required(uuid)                                 to app_auth;
grant execute on function authz.login_person_active(uuid)                                      to app_auth;
grant execute on function authz.stamp_sessions_revoked(uuid)                                   to app_auth;
grant execute on function public.resolve_login_org(public.citext)                              to app_auth;
grant execute on function public.record_login_event(uuid, text, public.citext, uuid, inet, text, jsonb) to app_auth;
grant execute on function public.resolve_auth_identity(uuid, timestamptz)                      to app_auth;
grant execute on function public.invitation_preview(text)                                      to app_auth;
grant execute on function public.accept_invitation(text, text, text)                           to app_auth;
grant execute on function public.bootstrap_setup_pending()                                     to app_auth;
grant execute on function public.bootstrap_setup_token_is_valid(bytea)                         to app_auth;
grant execute on function public.complete_bootstrap_setup(bytea, text)                         to app_auth;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — administrator actions proven by the administrator's own session
-- ═════════════════════════════════════════════════════════════════════════════
-- authz.verified_session_actor(token): the one place a bearer session token becomes an
-- identity. Internal: EXECUTE for nobody — only the definers below, which run as the
-- owner, call it. The token is the 32-character value Better Auth stores as-is in
-- auth.auth_sessions.token and returns to the server from getSession(); once 0073 is
-- applied only app_auth can read that table, so app_user can neither read a token nor
-- supply one, and no setting it writes is consulted.
create function authz.verified_session_actor(p_session_token text)
returns table (person_id uuid, org_id uuid, aal text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_session_token is null or length(p_session_token) = 0 then
    return;
  end if;
  -- resolve_auth_identity()'s rules (0020/0023), applied to the session itself:
  -- live session, live ACTIVE person, session newer than any revocation stamp.
  return query
  select p.id, p.org_id, s.aal
  from auth.auth_sessions s
  join public.people p on p.auth_user_id = s.user_id
  where s.token = p_session_token
    and s.expires_at > now()
    and p.deleted_at is null
    and p.person_status = 'ACTIVE'
    and (p.sessions_revoked_at is null or s.created_at > p.sessions_revoked_at);
end;
$$;

comment on function authz.verified_session_actor(text) is
  'Internal (no EXECUTE grant): the person, organization and assurance level of a live session '
  'token. Used by the 0072 administrator definers instead of app.person_id / app.org_id / app.aal.';

revoke all on function authz.verified_session_actor(text) from public;

--> statement-breakpoint

-- authz.admin_session_action(token, person, action, session?, request metadata):
-- list / revoke one / revoke all of a same-organization person's sessions, for an
-- administrator proven by their own session token.
create function authz.admin_session_action(
  p_actor_session_token text,
  p_target_person_id uuid,
  p_action text,
  p_session_id uuid default null,
  p_request_id uuid default null,
  p_actor_ip inet default null,
  p_user_agent text default null
)
returns table (
  session_id uuid,
  created_at timestamptz,
  expires_at timestamptz,
  ip_address text,
  user_agent text,
  affected integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_aal text;
  v_target_login uuid;
  v_n integer;
begin
  if p_action is null or p_action not in ('list', 'revoke_one', 'revoke_all') then
    raise exception 'admin_session_action: unknown action' using errcode = '22023';
  end if;
  if p_action = 'revoke_one' and p_session_id is null then
    raise exception 'admin_session_action: revoke_one needs a session id' using errcode = '22023';
  end if;

  -- 1-2. The administrator is whoever the presented session belongs to. Never a
  -- parameter, never a setting; the message never repeats the token.
  select a.person_id, a.org_id, a.aal into v_actor, v_org, v_aal
  from authz.verified_session_actor(p_actor_session_token) a;
  if v_actor is null then
    raise exception 'admin_session_action: no live administrator session' using errcode = '28000';
  end if;

  -- 3. Fix the identity to the verified values — anything the caller set is
  -- discarded — then ask the ordinary helpers about it.
  perform set_config('app.person_id', v_actor::text, true),
          set_config('app.org_id', v_org::text, true),
          set_config('app.aal', coalesce(v_aal, 'aal1'), true);

  if not (select authz.is_active())
     or (select authz.scope_for('sessions.revoke')) is distinct from 'GLOBAL' then
    raise exception 'admin_session_action: not permitted' using errcode = '42501';
  end if;
  -- The MFA rule of requirePermission(): whoever holds a sensitive permission at
  -- GLOBAL scope needs a verified second factor on this very session.
  if exists (select 1 from public.permissions p
              where p.is_sensitive and authz.scope_for(p.key) = 'GLOBAL')
     and (select authz.aal()) <> 'aal2' then
    raise exception 'admin_session_action: a verified second factor is required' using errcode = '42501';
  end if;

  -- 4. The target, in the administrator's organization only. Missing and foreign
  -- are the same answer.
  select p.auth_user_id into v_target_login
  from public.people p
  where p.id = p_target_person_id
    and p.org_id = v_org
    and p.deleted_at is null;
  if not found then
    raise exception 'admin_session_action: person not found' using errcode = '42501';
  end if;
  if v_target_login is null then
    raise exception 'admin_session_action: this person has no login' using errcode = '22023';
  end if;

  -- 5. The action. A listing never carries the token.
  if p_action = 'list' then
    return query
    select s.id, s.created_at, s.expires_at, s.ip_address, s.user_agent, null::integer
    from auth.auth_sessions s
    where s.user_id = v_target_login
      and s.expires_at > now()
    order by s.created_at desc;
    return;
  end if;

  if p_action = 'revoke_one' then
    delete from auth.auth_sessions s
    where s.id = p_session_id
      and s.user_id = v_target_login;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      raise exception 'admin_session_action: session not found' using errcode = '22023';
    end if;
  else
    delete from auth.auth_sessions s where s.user_id = v_target_login;
    get diagnostics v_n = row_count;
    -- The stamp updates public.people, whose row-level audit trigger records a change
    -- whenever an actor is present — a second, redundant entry for this one action. It
    -- has always run actor-less; keep it so, then restore the actor for the entry below.
    perform set_config('app.person_id', '', true);
    perform authz.stamp_sessions_revoked(v_target_login);
    perform set_config('app.person_id', v_actor::text, true);
  end if;

  -- 6. The audit entry, in the same transaction as the deletion.
  perform public.write_audit_log(
    p_action := case p_action when 'revoke_one' then 'session.revoked' else 'session.revoked_all' end,
    p_entity_type := 'person',
    p_result := 'SUCCESS'::public.audit_result,
    p_entity_id := p_target_person_id,
    p_severity := 'HIGH',
    p_metadata := jsonb_build_object(
                    'scope', case p_action when 'revoke_one' then 'one' else 'all' end,
                    'sessions_revoked', v_n)
                  || case when p_action = 'revoke_one'
                          then jsonb_build_object('session_id', p_session_id)
                          else '{}'::jsonb end,
    p_request_id := p_request_id,
    p_actor_ip := p_actor_ip,
    p_user_agent := p_user_agent
  );

  return query select null::uuid, null::timestamptz, null::timestamptz, null::text, null::text, v_n;
end;
$$;

comment on function authz.admin_session_action(text, uuid, text, uuid, uuid, inet, text) is
  'app_auth only (0072): list / revoke one / revoke all sessions of a same-organization person '
  'for an administrator proven by their own session token (GLOBAL sessions.revoke, MFA rule); '
  'revocation and its audit entry are one transaction. Never returns or echoes a token.';

revoke all on function authz.admin_session_action(text, uuid, text, uuid, uuid, inet, text) from public;
grant execute on function authz.admin_session_action(text, uuid, text, uuid, uuid, inet, text) to app_auth;

--> statement-breakpoint

-- authz.admin_issue_credential_reset(token, person, token hash, request metadata):
-- an administrator-initiated password reset, for an administrator proven by their own
-- session. The rules are the ones the application applied before (users.edit, the
-- MFA rule, ADR-001: a protected-role holder only by an administrator holding
-- roles.manage at GLOBAL scope) — now decided here. A refusal under ADR-001 writes its
-- DENIED audit entry and RETURNS 'DENIED' rather than raising, so the evidence commits.
-- The success entry (which records whether the email went out) stays with the
-- application, after the send, exactly as before.
create function authz.admin_issue_credential_reset(
  p_actor_session_token text,
  p_target_person_id uuid,
  p_token_hash text,
  p_request_id uuid default null,
  p_actor_ip inet default null,
  p_user_agent text default null
)
returns table (outcome text, reset_id uuid, login_email text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_aal text;
  v_target_login uuid;
  v_email text;
  v_reset uuid;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'admin_issue_credential_reset: token hash must be a sha-256 hex digest' using errcode = '22023';
  end if;

  select a.person_id, a.org_id, a.aal into v_actor, v_org, v_aal
  from authz.verified_session_actor(p_actor_session_token) a;
  if v_actor is null then
    raise exception 'admin_issue_credential_reset: no live administrator session' using errcode = '28000';
  end if;

  perform set_config('app.person_id', v_actor::text, true),
          set_config('app.org_id', v_org::text, true),
          set_config('app.aal', coalesce(v_aal, 'aal1'), true);

  if not (select authz.is_active()) or not (select authz.has('users.edit')) then
    raise exception 'admin_issue_credential_reset: not permitted' using errcode = '42501';
  end if;
  if exists (select 1 from public.permissions p
              where p.is_sensitive and authz.scope_for(p.key) = 'GLOBAL')
     and (select authz.aal()) <> 'aal2' then
    raise exception 'admin_issue_credential_reset: a verified second factor is required' using errcode = '42501';
  end if;

  select p.auth_user_id into v_target_login
  from public.people p
  where p.id = p_target_person_id
    and p.org_id = v_org
    and p.deleted_at is null;
  if not found then
    raise exception 'admin_issue_credential_reset: person not found' using errcode = '42501';
  end if;
  if v_target_login is null then
    raise exception 'admin_issue_credential_reset: this person has no login' using errcode = '22023';
  end if;

  -- ADR-001. The target side is answered by the owner (role_is_protected), so it cannot
  -- fail open on app_user's self-only view of role assignments.
  if public.person_holds_protected_role(p_target_person_id, v_org)
     and coalesce((select authz.scope_for('roles.manage')) = 'GLOBAL', false) = false then
    perform public.write_audit_log(
      p_action := 'admin.credential_reset',
      p_entity_type := 'person',
      p_result := 'DENIED'::public.audit_result,
      p_entity_id := p_target_person_id,
      p_severity := 'HIGH',
      p_metadata := jsonb_build_object('reason', 'PROTECTED_ROLE_TARGET'),
      p_request_id := p_request_id,
      p_actor_ip := p_actor_ip,
      p_user_agent := p_user_agent
    );
    return query select 'DENIED'::text, null::uuid, null::text;
    return;
  end if;

  -- The credential lives on the login, so the login's own email addresses the reset —
  -- and request_password_reset() (0024) mints it: digest only, single use, one hour,
  -- prior unused tokens retired.
  select u.email::text into v_email from auth.auth_users u where u.id = v_target_login;
  v_reset := authz.request_password_reset(v_email, p_token_hash);
  if v_reset is null then
    raise exception 'admin_issue_credential_reset: could not issue a reset for this login' using errcode = '22023';
  end if;

  return query select 'ISSUED'::text, v_reset, v_email;
end;
$$;

comment on function authz.admin_issue_credential_reset(text, uuid, text, uuid, inet, text) is
  'app_auth only (0072): mint a password reset for a same-organization person, for an '
  'administrator proven by their own session token (users.edit, MFA rule, ADR-001 protected-role '
  'rule). Returns DENIED after auditing an ADR-001 refusal.';

revoke all on function authz.admin_issue_credential_reset(text, uuid, text, uuid, inet, text) from public;
grant execute on function authz.admin_issue_credential_reset(text, uuid, text, uuid, inet, text) to app_auth;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — verification
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
      ('public.complete_bootstrap_setup(bytea,text)')
  ),
  admin_fns(sig) as (
    values
      ('authz.admin_session_action(text,uuid,text,uuid,uuid,inet,text)'),
      ('authz.admin_issue_credential_reset(text,uuid,text,uuid,inet,text)')
  ),
  store(tbl, privs) as (
    values
      ('auth.auth_users', array['select','insert','update']),
      ('auth.auth_accounts', array['select','insert','update','delete']),
      ('auth.auth_sessions', array['select','insert','update','delete']),
      ('auth.auth_two_factors', array['select','insert','update','delete']),
      ('auth.auth_verifications', array['select','insert','update','delete']),
      ('auth.auth_rate_limits', array['select','insert','update','delete'])
  )
  select string_agg(problem, '; ') into v_problems
  from (
    select p.sig || ' is missing or not executable by app_auth' as problem
    from prelogin p
    where to_regprocedure(p.sig) is null
       or not has_function_privilege('app_auth', p.sig, 'execute')
    union all
    select s.tbl || ' lacks ' || priv || ' for app_auth'
    from store s, unnest(s.privs) priv
    where not has_table_privilege('app_auth', s.tbl, priv)
    union all
    select 'app_auth lacks usage on schema ' || n
    from unnest(array['auth', 'authz']) n
    where not has_schema_privilege('app_auth', n, 'usage')
    union all
    select a.sig || ' is missing' from admin_fns a where to_regprocedure(a.sig) is null
    union all
    select a.sig || ' is executable by ' || r
    from admin_fns a, unnest(array['app_user', 'app_admin', 'app_worker']) r
    where to_regprocedure(a.sig) is not null
      and has_function_privilege(r, a.sig, 'execute')
    union all
    select a.sig || ' is not executable by app_auth'
    from admin_fns a
    where to_regprocedure(a.sig) is not null
      and not has_function_privilege('app_auth', a.sig, 'execute')
    union all
    select x.sig || ' is executable by PUBLIC'
    from (select sig from admin_fns union all select 'authz.verified_session_actor(text)') x
    join pg_proc p on p.oid = to_regprocedure(x.sig),
         aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 0 and a.privilege_type = 'EXECUTE'
    union all
    select 'authz.verified_session_actor(text) is executable by ' || r
    from unnest(array['app_user', 'app_admin', 'app_worker', 'app_auth']) r
    where has_function_privilege(r, 'authz.verified_session_actor(text)', 'execute')
    union all
    select x.sig || ' is not a SECURITY DEFINER with an empty search_path owned by app_owner'
    from (select sig from admin_fns union all select 'authz.verified_session_actor(text)') x
    join pg_proc p on p.oid = to_regprocedure(x.sig)
    where not p.prosecdef
       or not (coalesce(p.proconfig, '{}') @> array['search_path=""'])
       or pg_get_userbyid(p.proowner) <> 'app_owner'
    union all
    -- The administrator definers take the actor from the verified session, and read no
    -- identity setting before overwriting it.
    select a.sig || ' does not derive its actor from the verified session'
    from admin_fns a
    join pg_proc p on p.oid = to_regprocedure(a.sig)
    where strpos(p.prosrc, 'from authz.verified_session_actor(p_actor_session_token) a') = 0
       or strpos(p.prosrc, 'current_setting(') > 0
    union all
    select 'app_auth holds ' || priv || ' on ' || c.oid::regclass::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace,
         unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) priv
    where n.nspname in ('public', 'authz')
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_table_privilege('app_auth', c.oid, priv)
    union all
    select 'a policy names app_auth: ' || tablename
    from pg_policies where 'app_auth' = any(roles)
  ) problems;

  if v_problems is not null then
    raise exception '0072 app_auth expand incomplete: %', v_problems;
  end if;
end;
$$;
