-- ═════════════════════════════════════════════════════════════════════════════
-- 0087_org_admin_setup_email — first-administrator setup links delivered by email only
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Founder policy (2026-10-29): an organization's first administrator receives the setup link by
-- email only — the console never shows it. The link stays recipient-bound (0084/0086), expiring,
-- single-use and is now explicitly revocable:
--
--   platform.org_admin_setup_recipient  whom a pending setup's email goes to (address, name,
--                                       organization) — for the re-issue's email; app_platform
--                                       holds no table privilege. No token, no hash.
--   platform.revoke_org_admin_setup     ends a pending link without issuing another (reason
--                                       required, audited); re-issue afterwards works.
--   platform.record_failure             gains 'platform.organization.admin_setup_revoke'.
--
-- Additive: no table or column changes; 0083-0086 untouched.
-- ═════════════════════════════════════════════════════════════════════════════

create function platform.org_admin_setup_recipient(p_org_id uuid)
returns table (email text, full_name text, org_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform platform.require_permission('platform.organizations.assign_initial_admin');
  return query
  select p.work_email::text, p.full_legal_name, o.name
  from platform.org_admin_setup s
  join public.people p on p.id = s.person_id and p.org_id = s.org_id
  join public.organizations o on o.id = s.org_id
  where s.org_id = p_org_id and s.consumed_at is null and o.deleted_at is null
    and p.deleted_at is null;
end;
$$;

comment on function platform.org_admin_setup_recipient(uuid) is
  'The address a pending first-administrator setup is emailed to (0087). No token or hash. '
  'EXECUTE: app_platform; requires platform.organizations.assign_initial_admin.';

create function platform.revoke_org_admin_setup(p_org_id uuid, p_reason text, p_request_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := platform.require_permission('platform.organizations.assign_initial_admin');
  v_setup platform.org_admin_setup%rowtype;
  v_now timestamptz;
begin
  if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'platform: a reason is required (3-500 characters)' using errcode = '22023';
  end if;
  select * into v_setup from platform.org_admin_setup s where s.org_id = p_org_id for update;
  -- The time is read AFTER the lock: a re-issue or revocation that committed while this waited
  -- is then always in the past — never an expiry before its issue, never a second revocation.
  v_now := clock_timestamp();
  if not found then
    raise exception 'platform: this organization was not provisioned by the platform' using errcode = 'P0002';
  end if;
  if v_setup.consumed_at is not null then
    raise exception 'platform: the first administrator has already completed setup' using errcode = '55000';
  end if;
  if v_setup.expires_at <= v_now then
    return v_setup.expires_at; -- already dead: nothing to revoke, no second entry
  end if;

  -- Expire it AND replace its hash with a digest of fresh random values no one holds: a
  -- completion that started before this revocation (and re-reads the row after it) then finds
  -- no matching hash, rather than a link whose expiry is still later than its own start time.
  update platform.org_admin_setup s
  set expires_at = v_now,
      token_hash = sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text
                                     || clock_timestamp()::text, 'UTF8'))
  where s.org_id = p_org_id;

  perform platform.write_audit('platform_admin', v_actor, 'platform.organization.admin_setup_revoked',
    'SUCCESS', null, p_org_id, 'person', v_setup.person_id, p_request_id, null,
    jsonb_build_object('reason', btrim(p_reason)));
  return v_now;
end;
$$;

comment on function platform.revoke_org_admin_setup(uuid, text, uuid) is
  'Ends a pending first-administrator setup link without issuing another (0087). Audited with '
  'the reason. EXECUTE: app_platform; requires platform.organizations.assign_initial_admin.';

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
    'platform.admin.setup_reissue', 'platform.organization.admin_setup_revoke') then
    raise exception 'platform: unknown platform operation' using errcode = '22023';
  end if;
  perform platform.write_audit('platform_admin', v_actor, p_action, p_result, p_reason_code,
    p_target_org_id, null, null, p_request_id, null, '{}'::jsonb);
end;
$$;

revoke all on function platform.org_admin_setup_recipient(uuid) from public;
revoke all on function platform.revoke_org_admin_setup(uuid, text, uuid) from public;
grant execute on function platform.org_admin_setup_recipient(uuid) to app_platform;
grant execute on function platform.revoke_org_admin_setup(uuid, text, uuid) to app_platform;

do $$
declare
  v_bad text;
begin
  select string_agg(format('%s -> %s', p.oid::regprocedure, coalesce(r.rolname, 'PUBLIC')), ', ') into v_bad
  from (values ('platform.org_admin_setup_recipient(uuid)'),
               ('platform.revoke_org_admin_setup(uuid, text, uuid)')) f(sig)
  join pg_proc p on p.oid = f.sig::regprocedure
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
  left join pg_roles r on r.oid = x.grantee
  where x.privilege_type = 'EXECUTE' and coalesce(r.rolname, 'PUBLIC') not in ('app_owner', 'app_platform');
  if v_bad is not null then
    raise exception '0087: unexpected EXECUTE grant: %', v_bad;
  end if;
end;
$$;
