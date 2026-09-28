-- ── 0027: MFA enrollment enforcement + login lockout ──────────────────────────
--
-- Three pieces for the Phase 1 authentication hardening:
--
-- 1. auth.login_lockouts — consecutive failed password attempts per login, with a
--    15-minute window and a 15-minute lockout after 5 failures. Driven by three
--    narrow SECURITY DEFINER functions granted to app_user; app_user holds no
--    direct grant on the table.
--
-- 2. TOTP lifecycle audit — a trigger on auth.auth_two_factors writes HIGH audit
--    entries for enroll / enable / disable / backup-code-regenerate. This is the
--    first audit trigger on the auth schema (0014 noted none existed); it carries
--    only the action name and ids, never the secret or backup codes, which stay
--    encrypted in the row and out of audit_logs.
--
-- 3. authz.mfa_enrollment_required(p_auth_user_id) — true when the login's person
--    holds users.manage or roles.manage and has no verified TOTP factor. The login
--    route and the admin layout call it; scope_for() cannot be used because it
--    reads the transaction identity, which does not exist pre-auth.

-- ── 1. auth.login_lockouts ───────────────────────────────────────────────────

create table auth.login_lockouts (
  auth_user_id uuid primary key references auth.auth_users (id) on delete cascade,
  failed_count integer not null default 0 check (failed_count >= 0),
  window_start timestamptz not null default now(),
  locked_until timestamptz
);

alter table auth.login_lockouts owner to app_owner;
alter table auth.login_lockouts enable row level security;
alter table auth.login_lockouts force row level security;

-- Owner-only, like the other auth tables: app_user reaches this table only
-- through the three functions below.
create policy login_lockouts_owner_all on auth.login_lockouts
  for all to app_owner using (true) with check (true);

comment on table auth.login_lockouts is
  'Consecutive failed password attempts per login. 5 failures within 15 minutes '
  'locks the account for 15 minutes. Touched only by authz.check_login_lockout(), '
  'authz.record_login_failure() and authz.clear_login_lockout(); app_user holds '
  'no direct grant.';

-- ── 2. lockout functions ─────────────────────────────────────────────────────

-- True when the account is currently locked out. Read-only; the login route
-- calls it before attempting the credential check.
create function authz.check_login_lockout(p_email text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_locked boolean;
begin
  select exists (
    select 1
    from auth.login_lockouts l
    join auth.auth_users u on u.id = l.auth_user_id
    where u.email = lower(p_email)
      and l.locked_until > now()
  ) into v_locked;
  return coalesce(v_locked, false);
end;
$$;

comment on function authz.check_login_lockout(text) is
  'True when the login for p_email is inside a 15-minute lockout. Read-only.';

revoke all on function authz.check_login_lockout(text) from public;
grant execute on function authz.check_login_lockout(text) to app_user;

-- Records one failed password attempt. Returns true when THIS call crossed the
-- threshold and started a new lockout — the caller writes nothing; the HIGH
-- audit entry is written here, attributed to the person being locked out.
--
-- Unknown emails are not tracked: Better Auth's own per-address rate limit
-- covers them, and creating rows for addresses that hold no login would let an
-- attacker pollute the table. A lockout already in force is neither extended
-- nor re-audited.
create function authz.record_login_failure(p_email text, p_ip inet, p_user_agent text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_auth_user_id uuid;
  v_failed integer;
  v_window timestamptz;
  v_locked_until timestamptz;
  v_newly_locked boolean := false;
  v_person_id uuid;
  v_org_id uuid;
begin
  select u.id into v_auth_user_id
  from auth.auth_users u
  where u.email = lower(p_email)
  limit 1;

  if v_auth_user_id is null then
    return false;
  end if;

  select l.failed_count, l.window_start, l.locked_until
  into v_failed, v_window, v_locked_until
  from auth.login_lockouts l
  where l.auth_user_id = v_auth_user_id
  for update;

  if not found then
    insert into auth.login_lockouts (auth_user_id, failed_count, window_start)
    values (v_auth_user_id, 1, now());
    return false;
  end if;

  if v_locked_until is not null and v_locked_until > now() then
    return false;
  end if;

  if v_window < now() - interval '15 minutes' then
    update auth.login_lockouts
    set failed_count = 1, window_start = now(), locked_until = null
    where auth.login_lockouts.auth_user_id = v_auth_user_id;
    return false;
  end if;

  v_failed := v_failed + 1;
  if v_failed >= 5 then
    update auth.login_lockouts
    set failed_count = v_failed, locked_until = now() + interval '15 minutes'
    where auth.login_lockouts.auth_user_id = v_auth_user_id;
    v_newly_locked := true;
  else
    update auth.login_lockouts
    set failed_count = v_failed
    where auth.login_lockouts.auth_user_id = v_auth_user_id;
  end if;

  if v_newly_locked then
    select p.id, p.org_id into v_person_id, v_org_id
    from public.people p
    where p.auth_user_id = v_auth_user_id
      and p.deleted_at is null
    limit 1;

    -- org_id is NOT NULL on audit_logs; without a tenant there is nothing to
    -- attribute the entry to, so skip — the login event already recorded the
    -- outcome. Same posture as record_password_reset_audit (0025).
    if v_org_id is not null then
      insert into public.audit_logs (
        org_id, actor_person_id, actor_email_snapshot, actor_ip, user_agent,
        action, entity_type, entity_id, severity, result, metadata
      )
      values (
        v_org_id, v_person_id, lower(p_email), p_ip, p_user_agent,
        'auth.login.lockout', 'auth_user', v_auth_user_id, 'HIGH', 'DENIED',
        jsonb_build_object('failed_count', v_failed, 'locked_minutes', 15)
      );
    end if;
  end if;

  return v_newly_locked;
end;
$$;

comment on function authz.record_login_failure(text, inet, text) is
  'Records a failed password attempt for p_email. Returns true when this call '
  'started a new 15-minute lockout, in which case a HIGH audit entry '
  '(auth.login.lockout) is written here. Unknown emails are ignored.';

revoke all on function authz.record_login_failure(text, inet, text) from public;
grant execute on function authz.record_login_failure(text, inet, text) to app_user;

-- Clears the failure counter on a successful login. A success proves possession
-- of the credential, so past failures stop counting.
create function authz.clear_login_lockout(p_email text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from auth.login_lockouts
  where auth_user_id = (
    select u.id from auth.auth_users u where u.email = lower(p_email) limit 1
  );
end;
$$;

comment on function authz.clear_login_lockout(text) is
  'Clears the failed-attempt counter after a successful login.';

revoke all on function authz.clear_login_lockout(text) from public;
grant execute on function authz.clear_login_lockout(text) to app_user;

-- ── 3. TOTP lifecycle audit trigger ──────────────────────────────────────────
--
-- enroll:            INSERT (secret generated; verified = false until proven)
-- enabled:           UPDATE verified false → true (possession proven)
-- backup_codes.regenerated: UPDATE backup_codes changed
-- disabled:          DELETE (0014: disabling deletes the row outright)
--
-- Anything else — e.g. failed_verification_count bumps on wrong codes — is not
-- a lifecycle event and stays quiet. The entries carry the action and ids only;
-- the secret and backup codes never reach audit_logs.

create function authz.audit_two_factor_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_factor_id uuid;
  v_person_id uuid;
  v_org_id uuid;
  v_email text;
  v_action text;
begin
  if TG_OP = 'DELETE' then
    v_user_id := OLD.user_id;
    v_factor_id := OLD.id;
    v_action := 'mfa.totp.disabled';
  elsif TG_OP = 'INSERT' then
    v_user_id := NEW.user_id;
    v_factor_id := NEW.id;
    v_action := 'mfa.totp.enroll';
  else
    v_user_id := NEW.user_id;
    v_factor_id := NEW.id;
    if OLD.verified = false and NEW.verified = true then
      v_action := 'mfa.totp.enabled';
    elsif OLD.backup_codes is distinct from NEW.backup_codes then
      v_action := 'mfa.backup_codes.regenerated';
    else
      return null;
    end if;
  end if;

  select p.id, p.org_id, u.email into v_person_id, v_org_id, v_email
  from public.people p
  join auth.auth_users u on u.id = p.auth_user_id
  where p.auth_user_id = v_user_id
    and p.deleted_at is null
  limit 1;

  if v_org_id is null then
    return null;
  end if;

  insert into public.audit_logs (
    org_id, actor_person_id, actor_email_snapshot,
    action, entity_type, entity_id, severity, result, metadata
  )
  values (
    v_org_id, v_person_id, v_email,
    v_action, 'auth_two_factor', v_factor_id, 'HIGH', 'SUCCESS',
    jsonb_build_object()
  );

  return null;
end;
$$;

comment on function authz.audit_two_factor_change() is
  'AFTER trigger on auth.auth_two_factors: HIGH audit entries for the TOTP '
  'lifecycle (enroll / enabled / disabled / backup-codes-regenerated). Action '
  'and ids only — the secret and backup codes never reach audit_logs.';

revoke all on function authz.audit_two_factor_change() from public;

create trigger audit_two_factor_change
after insert or update or delete on auth.auth_two_factors
for each row execute function authz.audit_two_factor_change();

-- ── 4. authz.mfa_enrollment_required ───────────────────────────────────────────
--
-- True when the login's person holds users.manage or roles.manage and has no
-- verified TOTP factor. The login route calls it after a successful password
-- check (to steer the client to /me/security); the admin layout calls it to
-- block admin routes until enrollment.
--
-- scope_for() is not usable here: it reads the transaction identity, which does
-- not exist pre-auth, so the role/permission/engagement join is replicated with
-- the explicit person. users.manage is not in the current permission catalogue
-- (the user-administration permissions are users.create/edit/suspend/delete), so
-- the first disjunct is future-proofing; roles.manage carries the weight today.

create function authz.mfa_enrollment_required(p_auth_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_org_id uuid;
  v_privileged boolean;
  v_enrolled boolean;
begin
  select p.id, p.org_id into v_person_id, v_org_id
  from public.people p
  where p.auth_user_id = p_auth_user_id
    and p.deleted_at is null
  limit 1;

  if v_person_id is null then
    return false;
  end if;

  select exists (
    select 1
    from public.person_roles pr
    join public.roles r on r.id = pr.role_id and r.org_id = pr.org_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions perm on perm.id = rp.permission_id
    where pr.person_id = v_person_id
      and pr.org_id = v_org_id
      and (pr.expires_at is null or pr.expires_at > now())
      and r.deleted_at is null
      and r.status = 'ACTIVE'
      and perm.key in ('users.manage', 'roles.manage')
      -- same engagement gate as authz.is_active(): an ACTIVE engagement in an
      -- ACTIVE organization. An offboarded admin is not asked to enroll.
      and exists (
        select 1
        from public.engagements e
        join public.organizations o on o.id = e.org_id
        where e.person_id = v_person_id
          and e.org_id = v_org_id
          and e.status = 'ACTIVE'
          and e.deleted_at is null
          and o.status = 'ACTIVE'
          and o.deleted_at is null
      )
  ) into v_privileged;

  if not v_privileged then
    return false;
  end if;

  select exists (
    select 1
    from auth.auth_two_factors tf
    where tf.user_id = p_auth_user_id
      and tf.verified = true
  ) into v_enrolled;

  return not v_enrolled;
end;
$$;

comment on function authz.mfa_enrollment_required(uuid) is
  'True when the login belongs to a person holding users.manage or roles.manage '
  'with no verified TOTP factor. Drives the post-login enrollment redirect and '
  'the admin-layout enrollment gate.';

revoke all on function authz.mfa_enrollment_required(uuid) from public;
grant execute on function authz.mfa_enrollment_required(uuid) to app_user;
