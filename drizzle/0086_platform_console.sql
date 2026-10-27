-- ═════════════════════════════════════════════════════════════════════════════
-- 0086_platform_console — what the platform console reads that 0083/0084 did not offer
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ADR-008 P-1. The console's administrator page lists the platform administrators. 0083 can
-- invite and revoke them but had no read function, and app_platform holds no table privilege,
-- so the list is one more definer: holders of platform.admins.manage only; no login id, no
-- token, no credential — the administrator's id, email, name, status, timestamps and
-- permissions.
--
-- A refused listing is audited under its own name: platform.record_failure (0083) gains
-- 'platform.admin.list' in its allow-list (review F-CONSOLE-2).
--
-- The acting administrator is bound to a live session (security review S-CONSOLE-1):
-- platform.current_admin() (0083) trusted the administrator id and aal the caller set. It now
-- also requires app.platform_session_id to name an aal2 session of that administrator's own
-- login, with app.platform_session_token_sha256 the SHA-256 of its bearer token, unexpired and
-- within the 12-hour / 30-minute limits, checked in SQL.
-- CREATE OR REPLACE keeps both functions' grants.
--
-- Platform administrators' sessions everywhere (S-CONSOLE-3, -6): a revoked administrator's
-- login never receives a session (login_may_sign_in, asked by the session-creation hook), and
-- an administrator's session past the platform limits is ended on Better Auth's own routes too
-- (end_stale_admin_session, asked by the auth hook). Both are app_auth's.
--
-- The first administrator's recipient is fixed while setup is pending (S-CONSOLE-10): a
-- trigger refuses any change of that person's work email until setup completes.
--
-- Invitations are idempotent (F-CONSOLE-11): invite_admin_once and its request table, and an
-- invitation that was never used can be re-issued from the console (reissue_admin_setup).
-- ═════════════════════════════════════════════════════════════════════════════

create function platform.list_admins()
returns table (
  admin_id uuid,
  email text,
  full_name text,
  status text,
  created_at timestamptz,
  created_by uuid,
  revoked_at timestamptz,
  has_login boolean,
  permissions text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform platform.require_permission('platform.admins.manage');
  return query
  select a.id, a.email::text, a.full_name, a.status, a.created_at, a.created_by, a.revoked_at,
         a.auth_user_id is not null,
         coalesce((select array_agg(ap.permission_key order by ap.permission_key)
                   from platform.admin_permissions ap where ap.admin_id = a.id), '{}')
  from platform.admins a
  order by a.created_at, a.id;
end;
$$;

comment on function platform.list_admins() is
  'The platform administrators, for holders of platform.admins.manage (0086): no login id, '
  'token or credential.';

revoke all on function platform.list_admins() from public;
grant execute on function platform.list_admins() to app_platform;

create or replace function platform.record_failure(
  p_action text,
  p_result text,
  p_reason_code text,
  p_target_org_id uuid,
  p_request_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := platform.current_admin();
begin
  if v_actor is null then
    raise exception 'platform: no authenticated platform administrator' using errcode = '42501';
  end if;
  if p_result not in ('DENIED', 'ERROR') then
    raise exception 'platform: record_failure records DENIED or ERROR only' using errcode = '22023';
  end if;
  -- Only the platform's own operations: a failure entry cannot invent an action.
  if p_action not in (
    'platform.admin.invite', 'platform.admin.revoke',
    'platform.organization.provision', 'platform.organization.admin_setup_reissue',
    'platform.organization.suspend', 'platform.organization.reactivate',
    'platform.organization.list', 'platform.audit.list', 'platform.admin.list',
    'platform.admin.setup_reissue') then
    raise exception 'platform: unknown platform operation' using errcode = '22023';
  end if;
  perform platform.write_audit('platform_admin', v_actor, p_action, p_result, p_reason_code,
    p_target_org_id, null, null, p_request_id, null, '{}'::jsonb);
end;
$$;

create or replace function platform.current_admin() returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_raw text := current_setting('app.platform_admin_id', true);
  v_session text := current_setting('app.platform_session_id', true);
  v_token_sha256 text := current_setting('app.platform_session_token_sha256', true);
  v_id uuid;
begin
  if session_user <> 'app_platform'::name then
    return null;
  end if;
  if coalesce(current_setting('app.platform_aal', true), '') <> 'aal2' then
    return null;
  end if;
  if v_raw is null or v_raw !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_id := v_raw::uuid;
  -- 0086 (S-CONSOLE-1): the claim is bound to a live session in the database, not only to the
  -- settings. app.platform_session_id must name a session of THIS administrator's own login,
  -- and app.platform_session_token_sha256 must be the SHA-256 of that session's bearer token
  -- (an id alone is not a credential: Better Auth shows session ids to the browser). The
  -- session was created with a second factor (aal2), is unexpired, and is within the
  -- platform's 12-hour absolute and 30-minute idle limits. The app_platform credential alone,
  -- or with a session id, acts as nobody.
  if v_session is null or v_session !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  if v_token_sha256 is null or v_token_sha256 !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  if not exists (
    select 1
    from platform.admins a
    join auth.auth_sessions s on s.user_id = a.auth_user_id
    where a.id = v_id and s.id = v_session::uuid and s.aal = 'aal2'
      and encode(sha256(convert_to(s.token, 'UTF8')), 'hex') = v_token_sha256
      and s.expires_at > now()
      and s.created_at > now() - interval '12 hours'
      and s.updated_at > now() - interval '30 minutes'
  ) then
    return null;
  end if;
  -- The aal2 claim is cross-checked, as authz.aal() does for tenants (0014/0016): it counts
  -- only for a login that has an enrolled, enabled second factor.
  if not exists (
    select 1
    from platform.admins a
    join auth.auth_users u on u.id = a.auth_user_id
    where a.id = v_id and a.status = 'ACTIVE' and u.two_factor_enabled
      and exists (select 1 from auth.auth_two_factors f where f.user_id = u.id)
  ) then
    return null;
  end if;
  return v_id;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Sessions of platform administrators everywhere, not only on platform paths (S-CONSOLE-3, -6)
-- ═════════════════════════════════════════════════════════════════════════════
-- Asked by the authentication plane (app_auth) before Better Auth creates a session: a login
-- that belongs to a REVOKED platform administrator never receives one again, from any path.
create function platform.login_may_sign_in(p_auth_user_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1 from platform.admins a
    where a.auth_user_id = p_auth_user_id and a.status = 'REVOKED'
  )
$$;

comment on function platform.login_may_sign_in(uuid) is
  'False for the login of a REVOKED platform administrator (0086): the session-creation hook '
  'refuses it. EXECUTE: app_auth.';

-- Asked by the authentication plane on every Better Auth request that carries a session: a
-- platform administrator's session past the platform's limits — 12 hours from creation, 30
-- minutes without platform activity — or of an administrator no longer ACTIVE or pending, is
-- ended (deleted) before Better Auth reads it, so its self-service endpoints apply the same
-- policy as the console. A tenant user's session is never touched. True when one was ended.
create function platform.end_stale_admin_session(p_token text) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_token is null or length(p_token) = 0 then
    return false;
  end if;
  select s.id into v_id
  from auth.auth_sessions s
  join platform.admins a on a.auth_user_id = s.user_id
  where s.token = p_token
    and (a.status not in ('ACTIVE', 'PENDING_ENROLMENT')
         or s.created_at <= now() - interval '12 hours'
         or s.updated_at <= now() - interval '30 minutes');
  if v_id is null then
    return false;
  end if;
  delete from auth.auth_sessions s where s.id = v_id;
  return true;
end;
$$;

comment on function platform.end_stale_admin_session(text) is
  'Ends a platform administrator''s session past the platform limits (12 h, 30 min idle) or of '
  'an administrator no longer ACTIVE/pending (0086). Tenant sessions are never touched. '
  'EXECUTE: app_auth.';

-- ═════════════════════════════════════════════════════════════════════════════
-- The first administrator's recipient is fixed while their setup is pending (S-CONSOLE-10)
-- ═════════════════════════════════════════════════════════════════════════════
-- The setup link creates a login for the person's work email. While that setup is pending, the
-- email cannot be changed by anyone — so a re-issued link always reaches the same recipient,
-- and nobody can redirect it to an address they control.
create function platform.first_admin_recipient_fixed() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.work_email is distinct from old.work_email
     and exists (select 1 from platform.org_admin_setup s
                 where s.person_id = old.id and s.consumed_at is null) then
    raise exception 'the first administrator''s email is fixed until their setup is completed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger people_first_admin_recipient_fixed
  before update of work_email on public.people
  for each row execute function platform.first_admin_recipient_fixed();

-- ═════════════════════════════════════════════════════════════════════════════
-- Invitations are idempotent; a never-used invitation can be re-issued (F-CONSOLE-11)
-- ═════════════════════════════════════════════════════════════════════════════
create table platform.admin_invite_requests (
  idempotency_key text primary key,
  params_digest text not null,
  actor_admin_id uuid not null references platform.admins (id),
  invited_admin_id uuid not null references platform.admins (id),
  created_at timestamptz not null default clock_timestamp(),
  constraint admin_invite_requests_key_format check (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  constraint admin_invite_requests_digest_format check (params_digest ~ '^[0-9a-f]{64}$')
);
alter table platform.admin_invite_requests enable row level security;
alter table platform.admin_invite_requests force row level security;
create policy admin_invite_requests_owner_all on platform.admin_invite_requests
  for all to app_owner using (true) with check (true);
revoke all on platform.admin_invite_requests
  from public, app_user, app_worker, app_auth, app_admin, app_platform;

-- invite_admin (0083) behind an idempotency key: the same key and parameters answer the first
-- result (replayed, no new link); the same key with other parameters is refused (23505).
create function platform.invite_admin_once(
  p_idempotency_key text,
  p_email text,
  p_full_name text,
  p_permissions text[],
  p_setup_token_hash bytea,
  p_request_id uuid
)
returns table (invited_admin_id uuid, setup_expires_at timestamptz, replayed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := platform.require_permission('platform.admins.manage');
  v_digest text;
  v_prior platform.admin_invite_requests%rowtype;
  v_admin uuid;
  v_expires timestamptz;
begin
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,128}$' then
    raise exception 'platform: an idempotency key of 8-128 characters [A-Za-z0-9_-] is required'
      using errcode = '22023';
  end if;
  v_digest := encode(sha256(convert_to(jsonb_build_array(
      lower(p_email), btrim(p_full_name),
      (select coalesce(jsonb_agg(k order by k), '[]'::jsonb)
       from (select distinct unnest(coalesce(p_permissions, '{}'::text[])) k) d))::text, 'UTF8')), 'hex');

  perform pg_advisory_xact_lock(hashtext('platform.invite:' || p_idempotency_key));
  select * into v_prior from platform.admin_invite_requests r where r.idempotency_key = p_idempotency_key;
  if found then
    if v_prior.params_digest <> v_digest or v_prior.actor_admin_id <> v_actor then
      raise exception 'platform: this idempotency key was used with different parameters'
        using errcode = '23505';
    end if;
    return query select v_prior.invited_admin_id, null::timestamptz, true;
    return;
  end if;

  select i.invited_admin_id, i.setup_expires_at into v_admin, v_expires
  from platform.invite_admin(p_email, p_full_name, p_permissions, p_setup_token_hash, p_request_id) i;
  insert into platform.admin_invite_requests (idempotency_key, params_digest, actor_admin_id, invited_admin_id)
  values (p_idempotency_key, v_digest, v_actor, v_admin);
  return query select v_admin, v_expires, false;
end;
$$;

-- A new link for an invited administrator who has never set up a login (the first link was
-- lost or expired). The recipient is the invitation's; the previous link stops working. An
-- administrator who has a login — set up, or in recovery — is the operator's (break glass).
create function platform.reissue_admin_setup(p_admin_id uuid, p_setup_token_hash bytea, p_request_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := platform.require_permission('platform.admins.manage');
  v_admin platform.admins%rowtype;
  v_issued_at timestamptz := clock_timestamp();
begin
  perform platform.check_setup_token_hash(p_setup_token_hash);
  select * into v_admin from platform.admins a where a.id = p_admin_id for update;
  if not found then
    raise exception 'platform: no such administrator' using errcode = 'P0002';
  end if;
  if v_admin.status <> 'PENDING_ENROLMENT' or v_admin.auth_user_id is not null then
    raise exception 'platform: only an invitation that was never used can be re-issued here'
      using errcode = '55000';
  end if;

  insert into platform.setup_tokens (admin_id, token_hash, issued_at, expires_at)
  values (v_admin.id, p_setup_token_hash, v_issued_at, v_issued_at + interval '72 hours')
  on conflict (admin_id) do update
    set token_hash = excluded.token_hash, issued_at = excluded.issued_at,
        expires_at = excluded.expires_at, consumed_at = null, consumed_auth_user_id = null;

  perform platform.write_audit('platform_admin', v_actor, 'platform.admin.setup_reissued', 'SUCCESS',
    null, null, 'platform_admin', v_admin.id, p_request_id, null, '{}'::jsonb);
  return v_issued_at + interval '72 hours';
end;
$$;

revoke all on function platform.login_may_sign_in(uuid) from public;
revoke all on function platform.end_stale_admin_session(text) from public;
revoke all on function platform.first_admin_recipient_fixed() from public;
revoke all on function platform.invite_admin_once(text, text, text, text[], bytea, uuid) from public;
revoke all on function platform.reissue_admin_setup(uuid, bytea, uuid) from public;
grant execute on function platform.login_may_sign_in(uuid) to app_auth;
grant execute on function platform.end_stale_admin_session(text) to app_auth;
grant execute on function platform.invite_admin_once(text, text, text, text[], bytea, uuid) to app_platform;
grant execute on function platform.reissue_admin_setup(uuid, bytea, uuid) to app_platform;

do $$
declare
  v_bad text;
begin
  select string_agg(format('%s -> %s', p.oid::regprocedure, coalesce(r.rolname, 'PUBLIC')), ', ') into v_bad
  from (values
      ('platform.list_admins()', 'app_platform'),
      ('platform.invite_admin_once(text, text, text, text[], bytea, uuid)', 'app_platform'),
      ('platform.reissue_admin_setup(uuid, bytea, uuid)', 'app_platform'),
      ('platform.login_may_sign_in(uuid)', 'app_auth'),
      ('platform.end_stale_admin_session(text)', 'app_auth'),
      ('platform.first_admin_recipient_fixed()', '-')) f(sig, allowed)
  join pg_proc p on p.oid = f.sig::regprocedure
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
  left join pg_roles r on r.oid = x.grantee
  where x.privilege_type = 'EXECUTE' and coalesce(r.rolname, 'PUBLIC') not in ('app_owner', f.allowed);
  if v_bad is not null then
    raise exception '0086: unexpected EXECUTE grant: %', v_bad;
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'platform' and c.relname = 'admin_invite_requests'
               and not (c.relrowsecurity and c.relforcerowsecurity)) then
    raise exception '0086: platform.admin_invite_requests without forced RLS';
  end if;
end;
$$;
