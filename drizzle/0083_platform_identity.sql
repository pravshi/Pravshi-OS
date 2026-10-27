-- ═════════════════════════════════════════════════════════════════════════════
-- 0083_platform_identity — the platform administrator plane (ADR-008 P-1, P-2)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Design: docs/architecture/proposals/2026-10-27-platform-administration-v1-minimum.md
-- (approved direction, ADR-008). This migration is package P1: the platform administrator's
-- identity, permissions, audit trail, first-administrator bootstrap, setup completion,
-- break-glass recovery and administrator management. Organization provisioning and
-- suspend/reactivate (P2, L1) follow in 0084.
--
-- THE BOUNDARY. A dedicated login role, app_platform, created by scripts/db/roles.sql (the
-- branch owner creates roles; app_owner cannot). It holds USAGE on schema platform and
-- EXECUTE on the platform functions it calls — no privilege on any table in any schema, no
-- RLS policy: it reaches data only through these definers, as app_worker does (0070). The
-- platform plane is recognised by session_user, which a caller cannot change.
--
-- WHO IS ACTING. The web app verifies the Better Auth session (aal2) of a platform
-- administrator and sets app.platform_admin_id and app.platform_aal transaction-locally on
-- the app_platform connection; platform.current_admin() re-derives the actor from them on
-- every call and requires an ACTIVE administrator and aal2. No function takes the actor as a
-- parameter. Operator steps (bootstrap, setup re-issue, recovery) run as app_admin from the
-- TTY-only CLI and are recorded with actor type 'operator'.
--
-- SEPARATION (N1). platform.bootstrap_state is its own singleton and never reads or writes
-- public.bootstrap_state. Once it exists, public.bootstrap_organization() refuses (PART 9):
-- organizations are then provisioned by the platform. The reverse does not hold.
--
-- MUTUAL EXCLUSION. A login (auth.auth_users) belongs to a platform administrator or to a
-- tenant person, never both (PART 7).
--
--   PART 1  preconditions: app_platform exists and is a plain, unconnected login
--   PART 2  schema platform, tables, RLS, privileges
--   PART 3  append-only audit trail
--   PART 4  the permission catalogue
--   PART 5  identity helpers: current_admin(), has_permission()
--   PART 6  operator functions: bootstrap, setup re-issue, recovery (app_admin)
--   PART 7  setup completion (app_auth) and login mutual exclusion
--   PART 8  administrator management and the failure audit (app_platform)
--   PART 9  organization bootstrap refuses after the platform bootstrap; the protected-role
--           genesis branch names its callers explicitly
--   PART 10 verification
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — preconditions
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_bad text;
begin
  if not exists (select 1 from pg_roles where rolname = 'app_platform') then
    raise exception 'role app_platform does not exist: run scripts/db/roles.sql as the branch owner first (it creates the role), set its password, then re-run the migrations';
  end if;

  if exists (
    select 1 from pg_roles
    where rolname = 'app_platform'
      and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or not rolcanlogin)
  ) then
    raise exception 'app_platform must be a plain login role (no SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB)';
  end if;

  -- As for app_worker (0070): a member of no role, and no member but the database owner,
  -- which PostgreSQL 16+ makes an ADMIN of the roles it creates.
  select string_agg(m.rolname || ' -> ' || r.rolname, ', ') into v_bad
  from pg_auth_members am
  join pg_roles m on m.oid = am.member
  join pg_roles r on r.oid = am.roleid
  where m.rolname = 'app_platform'
     or (r.rolname = 'app_platform'
         and (am.member <> (select datdba from pg_database where datname = current_database())
              or m.rolname like 'app\_%'));
  if v_bad is not null then
    raise exception 'app_platform must share no role membership: %', v_bad;
  end if;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — schema, tables, RLS, privileges
-- ═════════════════════════════════════════════════════════════════════════════
create schema platform authorization app_owner;

comment on schema platform is
  'The platform administrator plane (ADR-008): administrators, platform permissions, the '
  'platform audit trail and, from 0084, organization provisioning. Reached only through '
  'SECURITY DEFINER functions; no runtime login holds a table privilege here.';

revoke all on schema platform from public;
grant usage on schema platform to app_platform, app_admin, app_auth;

create table platform.permissions (
  key text primary key,
  description text not null,
  constraint permissions_key_format check (key ~ '^platform\.[a-z_]+(\.[a-z_]+)+$')
);

create table platform.admins (
  id uuid primary key default gen_random_uuid(),
  email public.citext not null,
  full_name text not null,
  -- NULL until the administrator completes setup; then the login they created.
  auth_user_id uuid references auth.auth_users (id),
  status text not null default 'PENDING_ENROLMENT',
  created_at timestamptz not null default now(),
  -- NULL: created by the operator (bootstrap). Otherwise the administrator who invited them.
  created_by uuid references platform.admins (id),
  revoked_at timestamptz,
  revoked_by uuid references platform.admins (id),
  constraint admins_email_unique unique (email),
  constraint admins_auth_user_unique unique (auth_user_id),
  constraint admins_status_valid check (status in ('PENDING_ENROLMENT', 'ACTIVE', 'REVOKED')),
  constraint admins_full_name_valid check (length(btrim(full_name)) between 1 and 200),
  constraint admins_email_valid check (email::text ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint admins_active_has_login check (status <> 'ACTIVE' or auth_user_id is not null),
  constraint admins_revocation_consistent check ((status = 'REVOKED') = (revoked_at is not null))
);

comment on table platform.admins is
  'Platform administrators: a separate authority from every organization (ADR-008). A login '
  'is a platform administrator or a tenant person, never both.';

create table platform.admin_permissions (
  admin_id uuid not null references platform.admins (id),
  permission_key text not null references platform.permissions (key),
  granted_at timestamptz not null default now(),
  -- NULL: granted by the operator at bootstrap.
  granted_by uuid references platform.admins (id),
  primary key (admin_id, permission_key)
);

-- One live setup credential per administrator: issued at bootstrap, invitation or recovery,
-- consumed once by platform.complete_setup(). Only the SHA-256 digest is stored.
create table platform.setup_tokens (
  admin_id uuid primary key references platform.admins (id),
  token_hash bytea not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_auth_user_id uuid references auth.auth_users (id),
  constraint setup_tokens_hash_unique unique (token_hash),
  constraint setup_tokens_hash_is_sha256 check (octet_length(token_hash) = 32),
  constraint setup_tokens_expiry_after_issue check (expires_at > issued_at),
  constraint setup_tokens_consumption_complete
    check ((consumed_at is null) = (consumed_auth_user_id is null))
);

-- The platform bootstrap gate (N1): its own singleton, independent of public.bootstrap_state.
create table platform.bootstrap_state (
  id boolean primary key default true,
  admin_id uuid not null references platform.admins (id),
  performed_by name not null,
  bootstrapped_at timestamptz not null default clock_timestamp(),
  constraint bootstrap_state_singleton check (id)
);

create function platform.bootstrap_state_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'platform.bootstrap_state is immutable' using errcode = '42501';
end;
$$;

create trigger bootstrap_state_immutable
  before update or delete on platform.bootstrap_state
  for each row execute function platform.bootstrap_state_immutable();

create trigger bootstrap_state_no_truncate
  before truncate on platform.bootstrap_state
  for each statement execute function platform.bootstrap_state_immutable();

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — the platform audit trail
-- ═════════════════════════════════════════════════════════════════════════════
-- A separate table, because a tenant audit row requires an actor who is a person of the
-- organization (0011). Written only by the definers below; append-only for every role.
create table platform.audit_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default clock_timestamp(),
  actor_type text not null,
  actor_admin_id uuid references platform.admins (id),
  actor_email public.citext,
  action text not null,
  result text not null,
  reason_code text,
  target_org_id uuid,
  target_type text,
  target_id uuid,
  request_id uuid,
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  constraint audit_events_actor_type_valid check (actor_type in ('platform_admin', 'operator', 'system')),
  constraint audit_events_actor_consistent
    check ((actor_type = 'platform_admin') = (actor_admin_id is not null)),
  constraint audit_events_action_format check (action ~ '^platform\.[a-z_]+(\.[a-z_]+)+$'),
  constraint audit_events_result_valid check (result in ('SUCCESS', 'DENIED', 'ERROR')),
  constraint audit_events_reason_format check (reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  constraint audit_events_idempotency_format
    check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  constraint audit_events_metadata_object check (jsonb_typeof(metadata) = 'object')
);

comment on table platform.audit_events is
  'Platform audit trail (ADR-008): one SUCCESS entry per platform change, written in the '
  'same transaction; DENIED/ERROR entries in their own. Never a password, token or request '
  'body. Append-only; never removed by automatic retention.';

-- Exactly once: a retried request with the same idempotency key finds its SUCCESS entry.
create unique index audit_events_success_once
  on platform.audit_events (action, idempotency_key)
  where result = 'SUCCESS' and idempotency_key is not null;
create index audit_events_target_org_idx on platform.audit_events (target_org_id, occurred_at desc);
create index audit_events_occurred_idx on platform.audit_events (occurred_at desc);

create function platform.audit_events_append_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'platform.audit_events is append-only' using errcode = '42501';
end;
$$;

create trigger audit_events_no_update_delete
  before update or delete on platform.audit_events
  for each row execute function platform.audit_events_append_only();

create trigger audit_events_no_truncate
  before truncate on platform.audit_events
  for each statement execute function platform.audit_events_append_only();

-- RLS: forced on every platform table; only the owner (the definers) is admitted.
alter table platform.permissions enable row level security;
alter table platform.permissions force row level security;
alter table platform.admins enable row level security;
alter table platform.admins force row level security;
alter table platform.admin_permissions enable row level security;
alter table platform.admin_permissions force row level security;
alter table platform.setup_tokens enable row level security;
alter table platform.setup_tokens force row level security;
alter table platform.bootstrap_state enable row level security;
alter table platform.bootstrap_state force row level security;
alter table platform.audit_events enable row level security;
alter table platform.audit_events force row level security;

create policy permissions_owner_all on platform.permissions
  for all to app_owner using (true) with check (true);
create policy admins_owner_all on platform.admins
  for all to app_owner using (true) with check (true);
create policy admin_permissions_owner_all on platform.admin_permissions
  for all to app_owner using (true) with check (true);
create policy setup_tokens_owner_all on platform.setup_tokens
  for all to app_owner using (true) with check (true);
create policy bootstrap_state_owner_all on platform.bootstrap_state
  for all to app_owner using (true) with check (true);
create policy audit_events_owner_all on platform.audit_events
  for all to app_owner using (true) with check (true);

revoke all on all tables in schema platform from public, app_user, app_worker, app_auth, app_admin, app_platform;
revoke all on all functions in schema platform from public;

-- The audit trail and the bootstrap gate cannot be truncated even by their owner's
-- privilege: TRUNCATE is revoked, and the statement triggers above are the backstop.
revoke truncate on platform.audit_events, platform.bootstrap_state from app_owner;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — the permission catalogue (V1)
-- ═════════════════════════════════════════════════════════════════════════════
insert into platform.permissions (key, description) values
  ('platform.organizations.view', 'List and view organization metadata'),
  ('platform.organizations.create', 'Provision an organization with its type and first administrator'),
  ('platform.organizations.assign_initial_admin', 'Re-issue the first administrator''s setup while none is live'),
  ('platform.organizations.suspend', 'Suspend an organization (reason required)'),
  ('platform.organizations.reactivate', 'Reactivate a suspended organization (reason required)'),
  ('platform.audit.view', 'Read platform audit events'),
  ('platform.admins.manage', 'Invite and revoke platform administrators (step-up)');

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 5 — identity helpers
-- ═════════════════════════════════════════════════════════════════════════════
-- The acting platform administrator, or NULL. Requires: the app_platform connection, the
-- id the wrapper set for this transaction, an ACTIVE administrator, and aal2.
create function platform.current_admin() returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_raw text := current_setting('app.platform_admin_id', true);
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

comment on function platform.current_admin() is
  'The acting platform administrator: app_platform connection, app.platform_admin_id set by '
  'the wrapper, ACTIVE, aal2 backed by an enrolled second factor — or NULL. Never a parameter.';

create function platform.has_permission(p_key text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from platform.admin_permissions ap
    where ap.admin_id = platform.current_admin() and ap.permission_key = p_key
  )
$$;

-- Requires the permission or raises 42501. Every platform function starts with it.
create function platform.require_permission(p_key text) returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin uuid := platform.current_admin();
begin
  if v_admin is null then
    raise exception 'platform: no authenticated platform administrator' using errcode = '42501';
  end if;
  if not platform.has_permission(p_key) then
    raise exception 'platform: permission % required', p_key using errcode = '42501';
  end if;
  return v_admin;
end;
$$;

-- Internal: one audit entry. No runtime login may call it directly.
create function platform.write_audit(
  p_actor_type text,
  p_actor_admin_id uuid,
  p_action text,
  p_result text,
  p_reason_code text,
  p_target_org_id uuid,
  p_target_type text,
  p_target_id uuid,
  p_request_id uuid,
  p_idempotency_key text,
  p_metadata jsonb
) returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_email public.citext;
begin
  if p_actor_admin_id is not null then
    select a.email into v_email from platform.admins a where a.id = p_actor_admin_id;
  end if;
  insert into platform.audit_events (
    actor_type, actor_admin_id, actor_email, action, result, reason_code, target_org_id,
    target_type, target_id, request_id, idempotency_key, metadata
  ) values (
    p_actor_type, p_actor_admin_id, v_email, p_action, p_result, p_reason_code, p_target_org_id,
    p_target_type, p_target_id, p_request_id, p_idempotency_key, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Shared validation for operator and administrator inputs. Messages never echo a value.
create function platform.check_new_admin_identity(p_email text, p_full_name text) returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_full_name is null or length(btrim(p_full_name)) not between 1 and 200 then
    raise exception 'platform: full name is required (1-200 characters)' using errcode = '22023';
  end if;
  if p_email is null or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'platform: email is not a valid address' using errcode = '22023';
  end if;
  -- GOV-02 and mutual exclusion: a platform administrator's login is created by setup, never
  -- adopted. An address that already has a login — a tenant person's or anyone's — is refused.
  -- citext's case-insensitive "=" lives in schema public; under search_path = '' a bare "="
  -- silently compares as text, case-sensitively. Every email comparison here names it.
  if exists (select 1 from auth.auth_users u where u.email operator(public.=) p_email::public.citext) then
    raise exception 'platform: a login already exists for this email' using errcode = '55000';
  end if;
  if exists (select 1 from platform.admins a where a.email operator(public.=) p_email::public.citext) then
    raise exception 'platform: this email is already a platform administrator' using errcode = '55000';
  end if;
end;
$$;

create function platform.check_setup_token_hash(p_hash bytea) returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_hash is null or octet_length(p_hash) <> 32 then
    raise exception 'platform: setup token hash must be a 32-byte SHA-256 digest' using errcode = '22023';
  end if;
end;
$$;

create function platform.require_operator() returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if session_user not in ('app_admin'::name, 'app_owner'::name) then
    raise exception 'platform: this operation may only be performed by the operator (app_admin)'
      using errcode = '42501';
  end if;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 6 — operator functions (app_admin, TTY-only CLI)
-- ═════════════════════════════════════════════════════════════════════════════

-- The first platform administrator, once per database (ADR-008 P-2).
create function platform.bootstrap_first_admin(
  p_email text,
  p_full_name text,
  p_setup_token_hash bytea
)
returns table (bootstrapped_admin_id uuid, setup_expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid := gen_random_uuid();
  v_gate boolean;
  v_issued_at timestamptz;
begin
  perform platform.require_operator();
  perform set_config('app.platform_admin_id', '', true);
  perform set_config('app.platform_aal', '', true);
  perform platform.check_setup_token_hash(p_setup_token_hash);

  if exists (select 1 from platform.bootstrap_state) then
    raise exception 'the platform has already been bootstrapped in this database; it runs once'
      using errcode = '55000';
  end if;

  perform platform.check_new_admin_identity(p_email, p_full_name);

  insert into platform.admins (id, email, full_name, status, created_by)
  values (v_admin_id, p_email::public.citext, btrim(p_full_name), 'PENDING_ENROLMENT', null);

  -- THE GATE, as in 0015: a concurrent caller blocks on this uncommitted row, then finds the
  -- conflict. A rolled-back attempt does not consume the bootstrap.
  insert into platform.bootstrap_state (id, admin_id, performed_by)
  values (true, v_admin_id, session_user)
  on conflict (id) do nothing
  returning true into v_gate;
  if v_gate is null then
    raise exception 'the platform has already been bootstrapped in this database; it runs once'
      using errcode = '55000';
  end if;

  insert into platform.admin_permissions (admin_id, permission_key, granted_by)
  select v_admin_id, p.key, null from platform.permissions p;

  v_issued_at := clock_timestamp();
  insert into platform.setup_tokens (admin_id, token_hash, issued_at, expires_at)
  values (v_admin_id, p_setup_token_hash, v_issued_at, v_issued_at + interval '60 minutes');

  perform platform.write_audit('operator', null, 'platform.bootstrap.first_admin', 'SUCCESS', null,
    null, 'platform_admin', v_admin_id, null, null,
    jsonb_build_object('performed_by', session_user::text));

  return query select v_admin_id, v_issued_at + interval '60 minutes';
end;
$$;

comment on function platform.bootstrap_first_admin(text, text, bytea) is
  'ADR-008 P-2: creates the first platform administrator (pending setup) with every platform '
  'permission and a 60-minute setup token digest, once per database. EXECUTE: app_admin.';

-- A new setup credential for an administrator who has not completed setup (expired token).
create function platform.reissue_setup(p_email text, p_setup_token_hash bytea)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin platform.admins%rowtype;
  v_issued_at timestamptz := clock_timestamp();
begin
  perform platform.require_operator();
  perform platform.check_setup_token_hash(p_setup_token_hash);

  select * into v_admin from platform.admins a where a.email operator(public.=) p_email::public.citext for update;
  if not found or v_admin.status <> 'PENDING_ENROLMENT' then
    raise exception 'platform: no administrator awaiting setup has this email' using errcode = '55000';
  end if;

  insert into platform.setup_tokens (admin_id, token_hash, issued_at, expires_at)
  values (v_admin.id, p_setup_token_hash, v_issued_at, v_issued_at + interval '60 minutes')
  on conflict (admin_id) do update
    set token_hash = excluded.token_hash, issued_at = excluded.issued_at,
        expires_at = excluded.expires_at, consumed_at = null, consumed_auth_user_id = null;

  perform platform.write_audit('operator', null, 'platform.admin.setup_reissued', 'SUCCESS', null,
    null, 'platform_admin', v_admin.id, null, null,
    jsonb_build_object('performed_by', session_user::text));

  return v_issued_at + interval '60 minutes';
end;
$$;

-- Break glass: an ACTIVE administrator who lost their factor. Revokes every session and second
-- factor of their login and returns them to setup; the founder's written approval is recorded
-- in the run record (the CLI requires a reason).
create function platform.recover_admin(p_email text, p_reason text, p_setup_token_hash bytea)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin platform.admins%rowtype;
  v_issued_at timestamptz := clock_timestamp();
begin
  perform platform.require_operator();
  perform platform.check_setup_token_hash(p_setup_token_hash);
  if p_reason is null or length(btrim(p_reason)) not between 10 and 500 then
    raise exception 'platform: recovery requires a reason (10-500 characters)' using errcode = '22023';
  end if;

  select * into v_admin from platform.admins a where a.email operator(public.=) p_email::public.citext for update;
  if not found or v_admin.status <> 'ACTIVE' then
    raise exception 'platform: no active administrator has this email' using errcode = '55000';
  end if;

  -- The whole old credential goes, not only the factor: whoever may hold the old password or
  -- a reset link must not be able to sign in during the recovery window and enrol a factor of
  -- their own. The password is cleared (sign-in by password is impossible until setup sets a
  -- new one), outstanding reset links are retired, and every session ends.
  delete from auth.auth_sessions s where s.user_id = v_admin.auth_user_id;
  delete from auth.auth_two_factors f where f.user_id = v_admin.auth_user_id;
  -- Without this, sign-in would demand a factor that no longer exists (0014).
  update auth.auth_users u set two_factor_enabled = false where u.id = v_admin.auth_user_id;
  update auth.auth_accounts c set password = null
  where c.user_id = v_admin.auth_user_id and c.provider_id = 'credential';
  update auth.password_resets r set used_at = now()
  where r.auth_user_id = v_admin.auth_user_id and r.used_at is null;

  update platform.admins a set status = 'PENDING_ENROLMENT' where a.id = v_admin.id;

  insert into platform.setup_tokens (admin_id, token_hash, issued_at, expires_at)
  values (v_admin.id, p_setup_token_hash, v_issued_at, v_issued_at + interval '60 minutes')
  on conflict (admin_id) do update
    set token_hash = excluded.token_hash, issued_at = excluded.issued_at,
        expires_at = excluded.expires_at, consumed_at = null, consumed_auth_user_id = null;

  perform platform.write_audit('operator', null, 'platform.admin.recovered', 'SUCCESS', 'BREAK_GLASS',
    null, 'platform_admin', v_admin.id, null, null,
    jsonb_build_object('performed_by', session_user::text, 'reason', btrim(p_reason)));

  return v_issued_at + interval '60 minutes';
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 7 — setup completion (app_auth) and login mutual exclusion
-- ═════════════════════════════════════════════════════════════════════════════

-- Advisory, as bootstrap_setup_token_is_valid() (0015): lets the runtime refuse a dead token
-- before hashing a password. complete_setup() decides.
create function platform.setup_token_is_valid(p_setup_token_hash bytea) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from platform.setup_tokens t
    join platform.admins a on a.id = t.admin_id
    where t.token_hash = p_setup_token_hash
      and t.consumed_at is null
      and t.expires_at > now()
      and a.status = 'PENDING_ENROLMENT'
  )
$$;

-- Consumes a setup token and gives the administrator their credential, atomically. A new
-- administrator gets a new login (refused if any login has the email — never adopted); a
-- recovered one keeps their login and gets a new password. The caller supplies only the digest
-- and a Better Auth password hash; whose credential it becomes comes from the token. The
-- administrator becomes ACTIVE; every platform action still needs aal2, i.e. an enrolled TOTP.
create function platform.complete_setup(p_setup_token_hash bytea, p_password_hash text)
returns table (setup_admin_id uuid, setup_auth_user_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_token platform.setup_tokens%rowtype;
  v_admin platform.admins%rowtype;
  v_auth_user_id uuid;
  v_recovery boolean;
begin
  if p_setup_token_hash is null or octet_length(p_setup_token_hash) <> 32 then
    raise exception 'platform setup token is invalid, expired or already used' using errcode = '28000';
  end if;

  select * into v_token from platform.setup_tokens t
  where t.token_hash = p_setup_token_hash
  for update;
  if not found or v_token.consumed_at is not null or v_token.expires_at <= v_now then
    raise exception 'platform setup token is invalid, expired or already used' using errcode = '28000';
  end if;

  if p_password_hash is null or p_password_hash !~ '^[0-9a-f]{32}:[0-9a-f]{128}$' then
    raise exception 'platform setup: the credential must be a password hash from the authentication library'
      using errcode = '22023';
  end if;

  select * into v_admin from platform.admins a where a.id = v_token.admin_id for update;
  if not found or v_admin.status <> 'PENDING_ENROLMENT' then
    raise exception 'platform setup token is invalid, expired or already used' using errcode = '28000';
  end if;

  v_recovery := v_admin.auth_user_id is not null;
  if v_recovery then
    v_auth_user_id := v_admin.auth_user_id;
    update auth.auth_accounts c set password = p_password_hash
    where c.user_id = v_auth_user_id and c.provider_id = 'credential';
    if not found then
      raise exception 'platform setup: the administrator''s login has no password credential'
        using errcode = '55000';
    end if;
    -- Nothing created during the recovery window survives it: the administrator enrols a new
    -- factor after this, on a fresh session.
    delete from auth.auth_sessions s where s.user_id = v_auth_user_id;
    delete from auth.auth_two_factors f where f.user_id = v_auth_user_id;
    update auth.auth_users u set two_factor_enabled = false where u.id = v_auth_user_id;
  else
    if exists (select 1 from auth.auth_users u where u.email operator(public.=) v_admin.email) then
      raise exception 'platform setup: a login already exists for this email and will not be adopted'
        using errcode = '55000';
    end if;
    insert into auth.auth_users (name, email, email_verified)
    values (v_admin.full_name, v_admin.email, false)
    returning id into v_auth_user_id;
    insert into auth.auth_accounts (user_id, account_id, provider_id, password)
    values (v_auth_user_id, v_auth_user_id::text, 'credential', p_password_hash);
  end if;

  update platform.admins a set auth_user_id = v_auth_user_id, status = 'ACTIVE'
  where a.id = v_admin.id;

  update platform.setup_tokens t set consumed_at = v_now, consumed_auth_user_id = v_auth_user_id
  where t.admin_id = v_admin.id;

  perform platform.write_audit('platform_admin', v_admin.id, 'platform.admin.setup_completed',
    'SUCCESS', case when v_recovery then 'RECOVERY' end, null, 'platform_admin', v_admin.id,
    null, null, '{}'::jsonb);

  return query select v_admin.id, v_auth_user_id;
end;
$$;

-- Mutual exclusion, both sides. The setup paths already refuse an existing login; these
-- triggers make it a database rule for every writer.
-- Both lock the login's auth.auth_users row first, so two transactions attaching the same login
-- from the two sides serialise, and the second sees the first's committed attachment.
create function platform.login_not_a_person() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.auth_user_id is not null then
    perform 1 from auth.auth_users u where u.id = new.auth_user_id for update;
  end if;
  if new.auth_user_id is not null
     and exists (select 1 from public.people p where p.auth_user_id = new.auth_user_id) then
    raise exception 'a login cannot be both a platform administrator and a person' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger admins_login_not_a_person
  before insert or update of auth_user_id on platform.admins
  for each row execute function platform.login_not_a_person();

create function platform.login_not_an_admin() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.auth_user_id is not null then
    perform 1 from auth.auth_users u where u.id = new.auth_user_id for update;
  end if;
  if new.auth_user_id is not null
     and exists (select 1 from platform.admins a where a.auth_user_id = new.auth_user_id) then
    raise exception 'a login cannot be both a platform administrator and a person' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger people_login_not_a_platform_admin
  before insert or update of auth_user_id on public.people
  for each row execute function platform.login_not_an_admin();

-- The tenant resolver must never treat a platform administrator's login as a person: it
-- already resolves only through people.auth_user_id, which the trigger above keeps disjoint.

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 8 — administrator management and the failure audit (app_platform)
-- ═════════════════════════════════════════════════════════════════════════════

-- The acting administrator's own profile and permissions (for the console's session check).
create function platform.whoami()
returns table (admin_id uuid, email public.citext, full_name text, permissions text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin uuid := platform.current_admin();
begin
  if v_admin is null then
    raise exception 'platform: no authenticated platform administrator' using errcode = '42501';
  end if;
  return query
  select a.id, a.email, a.full_name,
         coalesce((select array_agg(ap.permission_key order by ap.permission_key)
                   from platform.admin_permissions ap where ap.admin_id = a.id), '{}')
  from platform.admins a where a.id = v_admin;
end;
$$;

-- Resolves a verified login to a platform administrator for the wrapper (the web app's auth
-- step), before any identity is set: ACTIVE or PENDING_ENROLMENT (the latter may only enrol a
-- factor). Returns no row for a tenant person's login.
create function platform.admin_for_login(p_auth_user_id uuid)
returns table (admin_id uuid, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.status from platform.admins a
  where a.auth_user_id = p_auth_user_id and a.status in ('ACTIVE', 'PENDING_ENROLMENT')
    and session_user = 'app_platform'::name
$$;

create function platform.invite_admin(
  p_email text,
  p_full_name text,
  p_permissions text[],
  p_setup_token_hash bytea,
  p_request_id uuid
)
returns table (invited_admin_id uuid, setup_expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := platform.require_permission('platform.admins.manage');
  v_admin_id uuid := gen_random_uuid();
  v_issued_at timestamptz := clock_timestamp();
  v_unknown text;
begin
  perform platform.check_setup_token_hash(p_setup_token_hash);
  perform platform.check_new_admin_identity(p_email, p_full_name);

  select string_agg(k, ', ') into v_unknown
  from unnest(coalesce(p_permissions, '{}'::text[])) k
  where not exists (select 1 from platform.permissions p where p.key = k);
  if v_unknown is not null then
    raise exception 'platform: unknown permission requested' using errcode = '22023';
  end if;
  -- No administrator can grant more than they hold.
  if exists (
    select 1 from unnest(coalesce(p_permissions, '{}'::text[])) k
    where not exists (select 1 from platform.admin_permissions ap
                      where ap.admin_id = v_actor and ap.permission_key = k)
  ) then
    raise exception 'platform: an administrator can grant only permissions they hold'
      using errcode = '42501';
  end if;

  insert into platform.admins (id, email, full_name, status, created_by)
  values (v_admin_id, p_email::public.citext, btrim(p_full_name), 'PENDING_ENROLMENT', v_actor);

  -- Least privilege: the view permissions always; anything else only as requested.
  insert into platform.admin_permissions (admin_id, permission_key, granted_by)
  select distinct v_admin_id, k, v_actor
  from unnest(array['platform.organizations.view', 'platform.audit.view']
              || coalesce(p_permissions, '{}'::text[])) k;

  insert into platform.setup_tokens (admin_id, token_hash, issued_at, expires_at)
  values (v_admin_id, p_setup_token_hash, v_issued_at, v_issued_at + interval '72 hours');

  perform platform.write_audit('platform_admin', v_actor, 'platform.admin.invited', 'SUCCESS', null,
    null, 'platform_admin', v_admin_id, p_request_id, null,
    jsonb_build_object('permissions',
      (select jsonb_agg(ap.permission_key order by ap.permission_key)
       from platform.admin_permissions ap where ap.admin_id = v_admin_id)));

  return query select v_admin_id, v_issued_at + interval '72 hours';
end;
$$;

-- Revokes an administrator and every session of their login, in one transaction. Never self;
-- never the last ACTIVE holder of platform.admins.manage.
create function platform.revoke_admin(p_admin_id uuid, p_reason text, p_request_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := platform.require_permission('platform.admins.manage');
  v_target platform.admins%rowtype;
begin
  if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'platform: a reason is required (3-500 characters)' using errcode = '22023';
  end if;
  if p_admin_id = v_actor then
    raise exception 'platform: an administrator cannot revoke themselves' using errcode = '42501';
  end if;

  -- Serialise every revocation, so two administrators cannot revoke each other concurrently
  -- and leave nobody holding admins.manage.
  perform pg_advisory_xact_lock(hashtext('platform.revoke_admin'));

  select * into v_target from platform.admins a where a.id = p_admin_id for update;
  if not found then
    raise exception 'platform: no such administrator' using errcode = 'P0002';
  end if;
  if v_target.status = 'REVOKED' then
    return; -- already revoked: no second entry
  end if;

  if exists (select 1 from platform.admin_permissions ap
             where ap.admin_id = v_target.id and ap.permission_key = 'platform.admins.manage')
     and not exists (
       select 1 from platform.admins a
       join platform.admin_permissions ap on ap.admin_id = a.id
       where a.status = 'ACTIVE' and a.id <> v_target.id
         and ap.permission_key = 'platform.admins.manage') then
    raise exception 'platform: the last holder of platform.admins.manage cannot be revoked'
      using errcode = '42501';
  end if;

  update platform.admins a
  set status = 'REVOKED', revoked_at = clock_timestamp(), revoked_by = v_actor
  where a.id = v_target.id;

  if v_target.auth_user_id is not null then
    delete from auth.auth_sessions s where s.user_id = v_target.auth_user_id;
  end if;

  perform platform.write_audit('platform_admin', v_actor, 'platform.admin.revoked', 'SUCCESS', null,
    null, 'platform_admin', v_target.id, p_request_id, null,
    jsonb_build_object('reason', btrim(p_reason)));
end;
$$;

-- DENIED / ERROR entries, written by the wrapper in a separate transaction after a refused or
-- failed platform call (the failing transaction rolled back its own work). Only an
-- authenticated administrator can write one, and only about themselves.
create function platform.record_failure(
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
    'platform.organization.list', 'platform.audit.list') then
    raise exception 'platform: unknown platform operation' using errcode = '22023';
  end if;
  perform platform.write_audit('platform_admin', v_actor, p_action, p_result, p_reason_code,
    p_target_org_id, null, null, p_request_id, null, '{}'::jsonb);
end;
$$;

-- Newest first, paged by the (occurred_at, id) of the last row of the previous page, so
-- entries sharing a timestamp are never skipped.
create function platform.list_audit_events(p_before_at timestamptz, p_before_id uuid, p_limit integer)
returns setof platform.audit_events
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform platform.require_permission('platform.audit.view');
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'platform: limit must be between 1 and 200' using errcode = '22023';
  end if;
  if (p_before_at is null) <> (p_before_id is null) then
    raise exception 'platform: a page cursor needs both its time and its id' using errcode = '22023';
  end if;
  return query
  select * from platform.audit_events e
  where p_before_at is null or (e.occurred_at, e.id) < (p_before_at, p_before_id)
  order by e.occurred_at desc, e.id desc
  limit p_limit;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Function privileges: nothing in schema platform is executable unless granted below.
-- ═════════════════════════════════════════════════════════════════════════════
revoke all on all functions in schema platform from public;

grant execute on function platform.bootstrap_first_admin(text, text, bytea) to app_admin;
grant execute on function platform.reissue_setup(text, bytea) to app_admin;
grant execute on function platform.recover_admin(text, text, bytea) to app_admin;

grant execute on function platform.setup_token_is_valid(bytea) to app_auth;
grant execute on function platform.complete_setup(bytea, text) to app_auth;

grant execute on function platform.admin_for_login(uuid) to app_platform;
grant execute on function platform.whoami() to app_platform;
grant execute on function platform.invite_admin(text, text, text[], bytea, uuid) to app_platform;
grant execute on function platform.revoke_admin(uuid, text, uuid) to app_platform;
grant execute on function platform.record_failure(text, text, text, uuid, uuid) to app_platform;
grant execute on function platform.list_audit_events(timestamptz, uuid, integer) to app_platform;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 9 — the organization bootstrap closes after the platform bootstrap; the
--          protected-role genesis branch names its callers; web password reset never
--          reaches a platform administrator's login
-- ═════════════════════════════════════════════════════════════════════════════
-- 0015's function, verbatim, with one added check after its own gate check. CREATE OR
-- REPLACE keeps its grants (app_admin only). A concurrent organization bootstrap and platform
-- bootstrap can both commit (the check reads no uncommitted gate): that outcome is the same as
-- "organization first, platform second", which N1 allows, so no lock is taken.
create or replace function public.bootstrap_organization(
  p_org_name text,
  p_org_slug text,
  p_owner_full_name text,
  p_owner_work_email text,
  p_setup_token_hash bytea
)
returns table (
  organization_id uuid,
  owner_person_id uuid,
  owner_engagement_id uuid,
  setup_token_expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org_id uuid := gen_random_uuid();
  v_department_id uuid := gen_random_uuid();
  v_person_id uuid := gen_random_uuid();
  v_engagement_id uuid := gen_random_uuid();
  v_role_id uuid;
  v_timezone text;
  v_code text;
  v_issued_at timestamptz;
  v_gate boolean;
begin
  if session_user not in ('app_admin', 'app_owner') then
    raise exception 'bootstrap may only be performed by the bootstrap database role'
      using errcode = '42501';
  end if;

  -- Nobody is acting, and this makes it structurally true rather than assumed: whatever the
  -- caller put in the transaction context, no row written below can be attributed to a
  -- person, and may_manage_protected_roles() cannot evaluate an identity.
  perform set_config('app.person_id', '', true);
  perform set_config('app.org_id', '', true);
  perform set_config('app.aal', '', true);

  -- Error messages name the parameter and never echo the value.
  if p_org_name is null or length(btrim(p_org_name)) = 0 then
    raise exception 'bootstrap: organization name is required' using errcode = '22023';
  end if;
  if p_org_slug is null then
    raise exception 'bootstrap: organization slug is required' using errcode = '22023';
  end if;
  if p_owner_full_name is null or length(btrim(p_owner_full_name)) = 0 then
    raise exception 'bootstrap: owner full name is required' using errcode = '22023';
  end if;
  if p_owner_work_email is null
     or p_owner_work_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'bootstrap: owner work email is not a valid address' using errcode = '22023';
  end if;
  if p_setup_token_hash is null or octet_length(p_setup_token_hash) <> 32 then
    raise exception 'bootstrap: setup token hash must be a 32-byte SHA-256 digest'
      using errcode = '22023';
  end if;

  if exists (select 1 from public.bootstrap_state) then
    raise exception 'this database has already been bootstrapped; bootstrap runs once and cannot be repeated'
      using errcode = '55000';
  end if;

  -- 0083 (ADR-008 P-2): once the platform is bootstrapped, every organization in this database
  -- is provisioned by the platform, with its audit entry; this path is closed.
  if exists (select 1 from platform.bootstrap_state) then
    raise exception 'organizations in this database are provisioned by the platform; the organization bootstrap is closed'
      using errcode = '42501';
  end if;

  -- A login that already uses the owner's address cannot be shown to belong to the owner, and
  -- the first SUPER_ADMIN must not be attachable to a credential this path did not create.
  if exists (
    select 1 from auth.auth_users u where u.email = p_owner_work_email::public.citext
  ) then
    raise exception 'bootstrap: a login already exists for the owner work email'
      using errcode = '55000';
  end if;

  -- THE GATE. The first write. A concurrent caller blocks here on this uncommitted row and,
  -- once it commits, finds the conflict and writes nothing. If this transaction rolls back
  -- instead, the row goes with it and the next caller proceeds: a failed attempt does not
  -- consume the one bootstrap.
  insert into public.bootstrap_state (id, org_id, department_id, person_id, engagement_id, performed_by)
  values (true, v_org_id, v_department_id, v_person_id, v_engagement_id, session_user)
  on conflict (id) do nothing
  returning true into v_gate;

  if v_gate is null then
    raise exception 'this database has already been bootstrapped; bootstrap runs once and cannot be repeated'
      using errcode = '55000';
  end if;

  -- organizations_seed_system_roles fires here and creates the fourteen system roles and the
  -- security.md matrix, SUPER_ADMIN at GLOBAL on the whole catalogue among them.
  insert into public.organizations (id, name, slug)
  values (v_org_id, btrim(p_org_name), p_org_slug);

  select o.timezone into v_timezone from public.organizations o where o.id = v_org_id;

  insert into public.departments (id, org_id, code, name)
  values (v_department_id, v_org_id, 'EXEC', 'Executive');

  v_code := authz.next_identity_code(v_org_id, 'EMP', to_char(now() at time zone v_timezone, 'YYYY'));

  insert into public.people (id, org_id, code, full_legal_name, work_email, person_status)
  values (v_person_id, v_org_id, v_code, btrim(p_owner_full_name),
          p_owner_work_email::public.citext, 'ACTIVE');

  -- Inserted directly at ACTIVE. The Task 1.6 transition machine polices status CHANGES on
  -- UPDATE; an engagement that begins active is a starting state, not a transition.
  insert into public.engagements
    (id, org_id, person_id, engagement_type, status, department_id, start_date)
  values
    (v_engagement_id, v_org_id, v_person_id, 'EMPLOYEE', 'ACTIVE', v_department_id,
     (now() at time zone v_timezone)::date);

  -- Blueprint 29.4 names the grant, so the role is found by its seeded identity — and then
  -- required to be the protected system role, not merely a row with that key.
  select r.id into v_role_id
  from public.roles r
  where r.org_id = v_org_id
    and r.key = 'SUPER_ADMIN'
    and r.is_system
    and r.is_protected
    and r.status = 'ACTIVE'
    and r.deleted_at is null;

  if v_role_id is null then
    raise exception 'bootstrap: the organization has no protected system SUPER_ADMIN role'
      using errcode = '55000';
  end if;

  -- granted_by is NULL because nobody granted it. enforce_protected_role_assignment() admits it
  -- through the genesis branch: this organization has no roles.manage holder, and session_user
  -- is not app_user. After this statement it has one, and that branch is closed for good.
  insert into public.person_roles (person_id, role_id, org_id, granted_by, expires_at)
  values (v_person_id, v_role_id, v_org_id, null, null);

  -- Postcondition. A bootstrap that produced an owner unable to manage roles would leave an
  -- organization nobody can administer and genesis already closed. Refuse to commit that.
  if not exists (
    select 1
    from public.person_roles pr
    join public.roles r on r.id = pr.role_id and r.org_id = pr.org_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where pr.person_id = v_person_id
      and pr.org_id = v_org_id
      and pr.expires_at is null
      and r.status = 'ACTIVE'
      and r.deleted_at is null
      and p.key = 'roles.manage'
      and rp.scope = 'GLOBAL'
  ) then
    raise exception 'bootstrap: the owner would not hold roles.manage at GLOBAL scope'
      using errcode = '55000';
  end if;

  v_issued_at := clock_timestamp();

  insert into public.bootstrap_setup_token (id, org_id, person_id, token_hash, issued_at, expires_at)
  values (true, v_org_id, v_person_id, p_setup_token_hash, v_issued_at,
          v_issued_at + interval '60 minutes');

  return query select v_org_id, v_person_id, v_engagement_id, v_issued_at + interval '60 minutes';
end;
$$;

-- 0008's function, verbatim, except the genesis condition: it admitted any session_user but
-- app_user — so app_worker and app_auth too, kept out only by their lack of write privilege
-- on the role tables. It now names exactly the logins that may perform a genesis grant: the
-- bootstrap (app_admin), the schema owner (app_owner: migrations and CI fixtures) and
-- platform provisioning (app_platform, 0084).
create or replace function public.may_manage_protected_roles(p_org_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with holders as (
    select pr.person_id
    from public.person_roles pr
    join public.roles r on r.id = pr.role_id and r.org_id = pr.org_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where pr.org_id = p_org_id
      and (pr.expires_at is null or pr.expires_at > now())
      and r.deleted_at is null
      and r.status = 'ACTIVE'
      and p.key = 'roles.manage'
      and rp.scope = 'GLOBAL'
  )
  select (
      exists (select 1 from holders h where h.person_id = authz.person_id())
      and authz.is_active()
    )
    or (
      not exists (select 1 from holders)
      and session_user in ('app_admin', 'app_owner', 'app_platform')
    )
$$;

-- 0024's function, verbatim, with one added check: a platform administrator's login is
-- recovered only by the operator (recover_admin), never through the web application's reset
-- link, so a reset request for it answers exactly as for an unknown address.
create or replace function authz.request_password_reset(p_email text, p_token_hash text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_auth_user_id uuid;
  v_reset_id uuid;
begin
  select u.id into v_auth_user_id
  from auth.auth_users u
  where u.email = lower(p_email)
  limit 1;

  if v_auth_user_id is null then
    return null;
  end if;

  -- 0083 (ADR-008): a platform administrator's login is recovered only by the operator.
  if exists (select 1 from platform.admins a where a.auth_user_id = v_auth_user_id) then
    return null;
  end if;

  -- Retire the user's outstanding tokens: only the newest token in the inbox works.
  update auth.password_resets
  set used_at = now()
  where auth_user_id = v_auth_user_id
    and used_at is null;

  insert into auth.password_resets (auth_user_id, token_hash, expires_at)
  values (v_auth_user_id, p_token_hash, now() + interval '1 hour')
  returning id into v_reset_id;

  return v_reset_id;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 10 — verification
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_bad text;
begin
  -- Nobody but the owner holds any privilege on a platform table — no runtime login and not
  -- PUBLIC (grantee 0).
  select string_agg(distinct coalesce(r.rolname, 'PUBLIC') || ' on ' || c.relname || ':' || x.privilege_type, ', ')
    into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'platform'
  cross join lateral aclexplode(c.relacl) x
  left join pg_roles r on r.oid = x.grantee
  where c.relkind in ('r', 'p') and coalesce(r.rolname, 'PUBLIC') <> 'app_owner';
  if v_bad is not null then
    raise exception '0083: a platform table privilege is held by a non-owner: %', v_bad;
  end if;

  -- The owner cannot TRUNCATE the audit trail or the bootstrap gate.
  if has_table_privilege('app_owner', 'platform.audit_events', 'TRUNCATE')
     or has_table_privilege('app_owner', 'platform.bootstrap_state', 'TRUNCATE') then
    raise exception '0083: app_owner can still TRUNCATE platform.audit_events or platform.bootstrap_state';
  end if;

  -- Every platform table forces RLS, and its only policy is the owner's.
  select string_agg(c.relname, ', ') into v_bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'platform'
  where c.relkind = 'r' and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception '0083: platform table without forced RLS: %', v_bad;
  end if;
  select string_agg(p.polname, ', ') into v_bad
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'platform'
  where p.polroles <> array[(select oid from pg_roles where rolname = 'app_owner')];
  if v_bad is not null then
    raise exception '0083: platform policy for a role other than app_owner: %', v_bad;
  end if;

  -- Schema USAGE: exactly app_platform, app_admin and app_auth besides the owner.
  select string_agg(coalesce(r.rolname, 'PUBLIC'), ', ') into v_bad
  from pg_namespace n
  cross join lateral aclexplode(n.nspacl) x
  left join pg_roles r on r.oid = x.grantee
  where n.nspname = 'platform' and x.privilege_type = 'USAGE'
    and coalesce(r.rolname, 'PUBLIC') not in ('app_owner', 'app_platform', 'app_admin', 'app_auth');
  if v_bad is not null then
    raise exception '0083: unexpected USAGE on schema platform: %', v_bad;
  end if;

  -- Exactly the intended EXECUTE grants in schema platform; PUBLIC holds none.
  select string_agg(p.proname || ' -> ' || coalesce(r.rolname, 'PUBLIC'), ', ' order by p.proname) into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'platform'
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
  left join pg_roles r on r.oid = x.grantee
  where x.privilege_type = 'EXECUTE'
    and coalesce(r.rolname, 'PUBLIC') <> 'app_owner'
    and (coalesce(r.rolname, 'PUBLIC'), p.proname::text) not in (
      ('app_admin', 'bootstrap_first_admin'), ('app_admin', 'reissue_setup'),
      ('app_admin', 'recover_admin'),
      ('app_auth', 'setup_token_is_valid'), ('app_auth', 'complete_setup'),
      ('app_platform', 'admin_for_login'), ('app_platform', 'whoami'),
      ('app_platform', 'invite_admin'), ('app_platform', 'revoke_admin'),
      ('app_platform', 'record_failure'), ('app_platform', 'list_audit_events'));
  if v_bad is not null then
    raise exception '0083: unexpected EXECUTE grant: %', v_bad;
  end if;

  -- Every platform function pins search_path to ''.
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'platform'
  where p.proconfig is null or not ('search_path=""' = any(p.proconfig));
  if v_bad is not null then
    raise exception '0083: platform function without search_path='''': %', v_bad;
  end if;

  if (select count(*) from platform.permissions) <> 7 then
    raise exception '0083: the platform permission catalogue must have 7 entries';
  end if;

  if position('platform.bootstrap_state' in
       pg_get_functiondef('public.bootstrap_organization(text, text, text, text, bytea)'::regprocedure)) = 0 then
    raise exception '0083: bootstrap_organization does not check the platform bootstrap';
  end if;
  if position('''app_platform''' in pg_get_functiondef('public.may_manage_protected_roles(uuid)'::regprocedure)) = 0
     or position('<> ''app_user''' in pg_get_functiondef('public.may_manage_protected_roles(uuid)'::regprocedure)) > 0 then
    raise exception '0083: the genesis branch does not name its callers';
  end if;
  if position('platform.admins' in pg_get_functiondef('authz.request_password_reset(text, text)'::regprocedure)) = 0 then
    raise exception '0083: request_password_reset does not exclude platform administrators';
  end if;
end;
$$;
