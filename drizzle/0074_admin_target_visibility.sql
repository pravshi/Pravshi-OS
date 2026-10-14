-- ═════════════════════════════════════════════════════════════════════════════
-- 0074_admin_target_visibility — the administrator definers see only whom the
-- administrator may see (WP-A1 audit H1 / M1)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Before 0072 both administrator operations found their target on app_user, under
-- RLS, as the administrator (src/lib/admin/credential-reset.ts and
-- src/lib/admin/sessions.ts at 1c38f9b):
--
--   select ... from public.people p
--   where p.id = <target> and p.org_id = <org> and p.deleted_at is null
--
-- That query was filtered by people_select (0017), so a target outside the
-- administrator's people.view reach was "Person not found." — on top of users.edit
-- (credential reset) or GLOBAL sessions.revoke (session actions).
--
-- 0072 moved both operations into SECURITY DEFINER functions owned by app_owner.
-- Their target lookup reads public.people as the owner, whose policy
-- (people_owner_all) is `using (true)`. The people.view restriction silently fell
-- away and only the organization filter was left: an administrator holding
-- users.edit and people.view at DEPARTMENT scope could mint a reset — and receive the
-- link — for anyone in the organization (audit H1), and list or revoke the sessions of
-- anyone in it (audit M1).
--
-- THE FIX restores the pre-0072 contract exactly: the target must be visible to the
-- verified administrator under people_select. It does not loosen or replace any
-- existing check — session proof, is_active, users.edit / GLOBAL sessions.revoke, the
-- MFA rule, the organization boundary and ADR-001 all stay where they are.
--
-- WHY A HELPER RESTATES THE POLICY RATHER THAN CONSULTING IT. A policy cannot be
-- called, and a definer cannot switch to app_user to have it applied (SET ROLE is
-- refused inside a SECURITY DEFINER function). So authz.person_visible() restates
-- people_select's USING clause for one person id, built from the same helpers in the
-- same order — the engagement_events pattern of 0017. tests/db/app-auth-role.test.ts
-- asserts that the helper and the policy agree row for row, for every scope, a record
-- grant, an inactive administrator and a forged identity, so the restatement cannot
-- drift unnoticed.
--
-- WHY IT IS SAFE TO EVALUATE IN THE DEFINERS. people_select and its helpers read the
-- identity from app.person_id / app.org_id / app.aal. The definers overwrite all three
-- from the presented session token (authz.verified_session_actor) before anything else
-- is asked, so the helper answers for the proven administrator and never for anything
-- the caller set.
--
-- REFUSALS ARE UNCHANGED IN SHAPE. An invisible target is refused exactly like a
-- missing or foreign one — 42501 'person not found', before the login, protected-role
-- or session checks run — so the definers offer no oracle for people outside the
-- administrator's reach. Nothing is written: no reset, no session change, no audit
-- entry (as before 0072, where an unseen target was 'Person not found.' with no audit).
--
-- MIGRATION SAFETY. Forward-only and narrowing: CREATE OR REPLACE keeps both
-- functions' signatures, owner and ACLs (app_auth only); the helper gets no EXECUTE
-- grant at all. The emergency rollback of 0073
-- (scripts/db/rollback/0073_auth_role_contract.down.sql) neither touches nor depends
-- on these functions and stays valid after this migration. There is deliberately no
-- down script: undoing this would reopen H1.
--
--   PART 1  authz.person_visible()
--   PART 2  authz.admin_session_action()          — target lookup gains the rule
--   PART 3  authz.admin_issue_credential_reset()  — target lookup gains the rule
--   PART 4  verification
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — authz.person_visible(person): people_select, for one person
-- ═════════════════════════════════════════════════════════════════════════════
-- Mirrors 0017's people_select USING clause term for term:
--   org_id = authz.org_id() and deleted_at is null and (
--     id = authz.person_id()                                   -- SELF, unconditional
--     or (authz.is_active() and (
--           case authz.scope_for('people.view') GLOBAL / DEPARTMENT / TEAM / else false
--           or authz.has_record_grant('person', id, 'people.view'))))
-- authz.org_id() is NULL when app.org_id disagrees with the person's own row, so a
-- mismatched tenant claim sees nobody. A NULL argument is false.
create function authz.person_visible(p_person uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person is not null
     and exists (
       select 1
       from public.people p
       where p.id = p_person
         and p.org_id = (select authz.org_id())
         and p.deleted_at is null
         and (
           p.id = (select authz.person_id())
           or (
             (select authz.is_active())
             and (
               case (select authz.scope_for('people.view'))
                 when 'GLOBAL' then true
                 when 'DEPARTMENT' then (select authz.in_my_departments(p.id))
                 when 'TEAM' then (select authz.reports_to_me(p.id))
                 when 'PROJECT' then false
                 when 'SELF' then false
                 else false
               end
               or (select authz.has_record_grant('person', p.id, 'people.view'))
             )
           )
         )
     )
$$;

comment on function authz.person_visible(uuid) is
  'Internal (no EXECUTE grant): whether people_select (0017) would show the given person to the '
  'identity currently set — the people.view scope, a person record grant, or the person themselves. '
  'Used by the 0072 administrator definers after they fix the identity from the session token.';

revoke all on function authz.person_visible(uuid) from public;
-- No EXECUTE grant: the only callers are the administrator definers below, which run as
-- the owner. Granting it would expose a people.view membership oracle.

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — authz.admin_session_action: the target must be visible
-- ═════════════════════════════════════════════════════════════════════════════
-- Identical to 0072 except step 4, which now also requires authz.person_visible().
create or replace function authz.admin_session_action(
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

  -- 4. The target: in the administrator's organization AND visible to them under
  -- people_select (0074) — the lookup app_user made under RLS before 0072. Missing,
  -- foreign and out-of-reach are the same answer.
  select p.auth_user_id into v_target_login
  from public.people p
  where p.id = p_target_person_id
    and p.org_id = v_org
    and p.deleted_at is null
    and authz.person_visible(p.id);
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
  'app_auth only (0072, 0074): list / revoke one / revoke all sessions of a same-organization '
  'person visible to the administrator under people_select, for an administrator proven by their '
  'own session token (GLOBAL sessions.revoke, MFA rule); revocation and its audit entry are one '
  'transaction. Never returns or echoes a token.';

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — authz.admin_issue_credential_reset: the target must be visible
-- ═════════════════════════════════════════════════════════════════════════════
-- Identical to 0072 except the target lookup, which now also requires
-- authz.person_visible().
create or replace function authz.admin_issue_credential_reset(
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

  -- The target: in the administrator's organization AND visible to them under
  -- people_select (0074) — the lookup app_user made under RLS before 0072. Missing,
  -- foreign and out-of-reach are the same answer, decided before the protected-role
  -- rule, so nothing (not even a DENIED entry) is written for a person out of reach.
  select p.auth_user_id into v_target_login
  from public.people p
  where p.id = p_target_person_id
    and p.org_id = v_org
    and p.deleted_at is null
    and authz.person_visible(p.id);
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
  'app_auth only (0072, 0074): mint a password reset for a same-organization person visible to the '
  'administrator under people_select, for an administrator proven by their own session token '
  '(users.edit, MFA rule, ADR-001 protected-role rule). Returns DENIED after auditing an ADR-001 '
  'refusal.';

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — verification
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_problems text;
begin
  with fns(sig) as (
    values
      ('authz.person_visible(uuid)'),
      ('authz.admin_session_action(text,uuid,text,uuid,uuid,inet,text)'),
      ('authz.admin_issue_credential_reset(text,uuid,text,uuid,inet,text)')
  ),
  facts as (
    select f.sig, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner_name,
           p.prosrc, p.oid
    from fns f
    join pg_proc p on p.oid = to_regprocedure(f.sig)
  ),
  problems as (
    select sig || ': missing' as problem
    from fns where to_regprocedure(sig) is null
    union all
    select sig || ': not SECURITY DEFINER' from facts where not prosecdef
    union all
    select sig || ': search_path is not pinned empty'
    from facts where proconfig is null or not ('search_path=""' = any (proconfig))
    union all
    select sig || ': owned by ' || owner_name || ', not app_owner'
    from facts where owner_name <> 'app_owner'
    union all
    -- the two definers must consult the rule in their target lookup
    select sig || ': target lookup does not apply authz.person_visible'
    from facts
    where sig <> 'authz.person_visible(uuid)'
      and position('authz.person_visible(p.id)' in prosrc) = 0
    union all
    -- the helper: EXECUTE for nobody (the owner aside)
    select 'authz.person_visible(uuid): executable by ' || r.rolname
    from facts f
    cross join (select rolname from pg_roles
                where rolname in ('app_user', 'app_auth', 'app_worker', 'app_admin')) r
    where f.sig = 'authz.person_visible(uuid)'
      and has_function_privilege(r.rolname, f.oid, 'EXECUTE')
    union all
    select 'authz.person_visible(uuid): executable by PUBLIC'
    from facts f
    where f.sig = 'authz.person_visible(uuid)'
      and exists (select 1 from aclexplode(coalesce(
                    (select proacl from pg_proc where oid = f.oid),
                    acldefault('f', (select proowner from pg_proc where oid = f.oid)))) a
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE')
    union all
    -- the definers stay app_auth-only (CREATE OR REPLACE keeps the ACL; prove it)
    select f.sig || ': executable by ' || r.rolname
    from facts f
    cross join (select rolname from pg_roles
                where rolname in ('app_user', 'app_worker', 'app_admin')) r
    where f.sig <> 'authz.person_visible(uuid)'
      and has_function_privilege(r.rolname, f.oid, 'EXECUTE')
    union all
    select f.sig || ': not executable by app_auth'
    from facts f
    where f.sig <> 'authz.person_visible(uuid)'
      and not has_function_privilege('app_auth', f.oid, 'EXECUTE')
  )
  select string_agg(problem, '; ' order by problem) into v_problems from problems;

  if v_problems is not null then
    raise exception '0074 verification failed: %', v_problems;
  end if;
end;
$$;
