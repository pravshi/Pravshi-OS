-- Rollback for 0086_platform_console — restores the 0085 state.
--
-- Prepared in advance. Run as the migration owner, in one transaction, only with the founder's
-- approval for the named database. It does NOT remove 0086's row from the history.
--
-- What this re-opens: the platform actor is again trusted from the transaction settings without
-- a live session (0083's current_admin), and the administrator list stops working.
-- platform.record_failure and platform.current_admin are restored verbatim from 0083.
-- It refuses unless the database is exactly at 0086.

begin;

set local lock_timeout = '5s';

do $$
begin
  if (select count(*) from drizzle.__drizzle_migrations) <> 86 then
    raise exception '0086 rollback refused: the database is not at 0086 (roll back later migrations first)';
  end if;
end;
$$;

drop function platform.list_admins();

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
    'platform.organization.list', 'platform.audit.list') then
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

commit;
