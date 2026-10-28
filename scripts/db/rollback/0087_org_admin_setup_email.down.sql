-- Rollback for 0087_org_admin_setup_email — restores the 0086 state.
--
-- Prepared in advance. Run as the migration owner, in one transaction, only with the founder's
-- approval for the named database. It does NOT remove 0087's row from the history.
--
-- What this re-opens: a pending first-administrator link can no longer be revoked without
-- re-issuing it, and the 0087 application code can no longer find the re-issue's recipient
-- (re-issue answers an error): roll the application back with it. record_failure is restored
-- verbatim from 0086.
-- It refuses unless the database is exactly at 0087.

begin;

set local lock_timeout = '5s';

do $$
begin
  if (select count(*) from drizzle.__drizzle_migrations) <> 87 then
    raise exception '0087 rollback refused: the database is not at 0087 (roll back later migrations first)';
  end if;
end;
$$;

drop function platform.revoke_org_admin_setup(uuid, text, uuid);
drop function platform.org_admin_setup_recipient(uuid);

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

commit;
