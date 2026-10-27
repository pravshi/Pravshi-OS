-- ═════════════════════════════════════════════════════════════════════════════
-- 0086_platform_console — what the platform console reads that 0083/0084 did not offer
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ADR-008 P-1. The console's administrator page lists the platform administrators. 0083 can
-- invite and revoke them but had no read function, and app_platform holds no table privilege,
-- so the list is one more definer: holders of platform.admins.manage only; no login id, no
-- token, no credential — the administrator's id, email, name, status, timestamps and
-- permissions.
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
