-- ── 0024: password reset flow ─────────────────────────────────────────────────
--
-- The password-reset flow without a browser session, in four narrow functions plus
-- two private tables. The reset token travels to the user (via email) and back to
-- the server (in the reset link); only its sha256 digest is ever stored or looked
-- up — the database, like the application, never sees the token or the password in
-- plaintext. app_user holds no grant on either table; every touch goes through a
-- SECURITY DEFINER function granted to app_user alone.
--
-- Login-event vocabulary for the reset (PASSWORD_RESET_REQUESTED /
-- PASSWORD_RESET_COMPLETED) is already in the 0018 constraint; the API routes that
-- call these functions are responsible for emitting those events. The invitation
-- vocabulary (INVITATION_REJECTED etc.) lives in 0019's record_login_event().

-- ── auth.password_resets ──────────────────────────────────────────────────────
--
-- One row per issued reset token, single-use and expiring after one hour. A new
-- request marks all prior unused tokens for that user used, so only the newest
-- token in the user's inbox can work.

create table auth.password_resets (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.auth_users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table auth.password_resets owner to app_owner;
alter table auth.password_resets enable row level security;
alter table auth.password_resets force row level security;

-- The owner policy: SECURITY DEFINER functions run as app_owner, and FORCE RLS
-- denies even the owner without a policy. This is the same shape as
-- people_owner_all (0002): the owner can do everything so the narrow functions
-- can do their one thing; app_user and app_admin still have no grant at all.

create policy password_resets_owner_all on auth.password_resets
  for all to app_owner using (true) with check (true);

comment on table auth.password_resets is
  'Single-use password-reset tokens. Stores only the sha256 digest of the reset '
  'token — the plaintext token is emailed to the user and never lands here. '
  'Written only by authz.request_password_reset() / authz.consume_password_reset(); '
  'consumed rows are kept as evidence, never deleted.';

-- ── auth.api_rate_limits ──────────────────────────────────────────────────────
--
-- Generic fixed-window rate-limit buckets for our custom pre-auth API routes
-- (password reset request/complete, invitation accept, bootstrap). better-auth has
-- its own auth.auth_rate_limits table for its internal paths; this one is ours and
-- is driven by authz.check_rate_limit() below.

create table auth.api_rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count integer not null default 1
);

alter table auth.api_rate_limits owner to app_owner;
alter table auth.api_rate_limits enable row level security;
alter table auth.api_rate_limits force row level security;

-- Same owner-policy rationale as password_resets_owner_all above.

create policy api_rate_limits_owner_all on auth.api_rate_limits
  for all to app_owner using (true) with check (true);

comment on table auth.api_rate_limits is
  'Fixed-window rate-limit counters for custom pre-auth API routes. '
  'Distinct from auth.auth_rate_limits, which serves better-auth''s internal paths. '
  'Touched only by authz.check_rate_limit(); app_user holds no direct grant.';

-- ── authz.request_password_reset ──────────────────────────────────────────────
--
-- Issues a reset token for the login holding p_email. Prior unused tokens for that
-- user are retired first so only the newest token can be consumed. Returns the new
-- row id on success, NULL when no such login exists — the caller must answer with
-- a generic success either way, and this function must not leak existence. The
-- token digest is computed by the caller; the token itself never reaches this
-- function.

create function authz.request_password_reset(p_email text, p_token_hash text)
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

comment on function authz.request_password_reset(text, text) is
  'Issues a single-use 1-hour password-reset token (sha256 digest) for a login, '
  'retiring prior unused tokens. Returns NULL for unknown emails; never leaks existence.';

revoke all on function authz.request_password_reset(text, text) from public;
grant execute on function authz.request_password_reset(text, text) to app_user;

-- ── authz.consume_password_reset ──────────────────────────────────────────────
--
-- Consumes a reset token: locks the row, refuses it unless it exists, is unused
-- and unexpired, then marks it used and returns the login it belongs to. The row
-- lock serializes two concurrent consumes of the same token; the second finds
-- used_at set and is rejected.

create function authz.consume_password_reset(p_token_hash text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row auth.password_resets%rowtype;
begin
  select * into v_row
  from auth.password_resets
  where token_hash = p_token_hash
  for update;

  if v_row.id is null
     or v_row.used_at is not null
     or v_row.expires_at <= now() then
    raise exception 'password reset token invalid or expired'
      using errcode = '28000';
  end if;

  update auth.password_resets
  set used_at = now()
  where id = v_row.id;

  return v_row.auth_user_id;
end;
$$;

comment on function authz.consume_password_reset(text) is
  'Single-use consume of a password-reset token (sha256 digest): marks it used and '
  'returns the owning login id. Raises 28000 for unknown, used or expired tokens.';

revoke all on function authz.consume_password_reset(text) from public;
grant execute on function authz.consume_password_reset(text) to app_user;

-- ── authz.update_credential_password ───────────────────────────────────────────
--
-- Replaces the credential-provider password hash for a login. The hash is the
-- scrypt KDF output produced by the application (better-auth); the database never
-- sees a plaintext password. Raises when the login has no credential account,
-- which can only happen if it never had a password — fail closed, never create.

create function authz.update_credential_password(p_auth_user_id uuid, p_password_hash text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update auth.auth_accounts
  set password = p_password_hash,
      updated_at = now()
  where user_id = p_auth_user_id
    and provider_id = 'credential';

  if not found then
    raise exception 'no credential account for this login'
      using errcode = '55000';
  end if;
end;
$$;

comment on function authz.update_credential_password(uuid, text) is
  'Replaces the credential-provider password hash for a login. The hash is scrypt '
  'produced by the application; the DB never sees plaintext. Raises 55000 when the '
  'login has no credential account.';

revoke all on function authz.update_credential_password(uuid, text) from public;
grant execute on function authz.update_credential_password(uuid, text) to app_user;

-- ── authz.check_rate_limit ────────────────────────────────────────────────────
--
-- Fixed-window counter for pre-auth routes: returns true while the caller is under
-- the allowance, false once it is exceeded. The key is a caller-chosen bucket such
-- as 'reset:request:203.0.113.7' or 'reset:request:user@example.com'. A stale
-- window resets to (now(), 1) and is allowed.

create function authz.check_rate_limit(p_key text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row auth.api_rate_limits%rowtype;
begin
  select * into v_row
  from auth.api_rate_limits
  where key = p_key
  for update;

  if v_row.key is null then
    insert into auth.api_rate_limits (key, window_start, count)
    values (p_key, now(), 1);
    return true;
  end if;

  if v_row.window_start <= now() - (p_window_seconds * interval '1 second') then
    -- Stale window: restart it. The row is already locked by the select above.
    update auth.api_rate_limits
    set window_start = now(),
        count = 1
    where key = p_key;
    return true;
  end if;

  update auth.api_rate_limits
  set count = count + 1
  where key = p_key
  returning * into v_row;

  return v_row.count <= p_max;
end;
$$;

comment on function authz.check_rate_limit(text, integer, integer) is
  'Fixed-window rate limiting for custom pre-auth API routes. Returns true while '
  'the key stays within p_max hits per p_window_seconds; resets stale windows.';

revoke all on function authz.check_rate_limit(text, integer, integer) from public;
grant execute on function authz.check_rate_limit(text, integer, integer) to app_user;
