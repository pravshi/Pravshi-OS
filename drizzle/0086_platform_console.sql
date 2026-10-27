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
-- login, unexpired and within the 12-hour / 30-minute limits, checked in SQL.
-- CREATE OR REPLACE keeps both functions' grants.
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
    'platform.organization.list', 'platform.audit.list', 'platform.admin.list') then
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
  -- created with a second factor (aal2), unexpired, within the platform's 12-hour absolute and
  -- 30-minute idle limits. Holding the app_platform credential alone acts as nobody.
  if v_session is null or v_session !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  if not exists (
    select 1
    from platform.admins a
    join auth.auth_sessions s on s.user_id = a.auth_user_id
    where a.id = v_id and s.id = v_session::uuid and s.aal = 'aal2'
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

do $$
begin
  if exists (
    select 1 from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    left join pg_roles r on r.oid = x.grantee
    where p.oid = 'platform.list_admins()'::regprocedure and x.privilege_type = 'EXECUTE'
      and coalesce(r.rolname, 'PUBLIC') not in ('app_owner', 'app_platform')
  ) then
    raise exception '0086: platform.list_admins() is executable beyond app_platform';
  end if;
end;
$$;
