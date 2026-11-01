-- PRAVSHI OS — 0082: two least-privilege leftovers found by the V1 acceptance review.
-- No tables, no data changes; applies identically on fresh and upgraded chains.
--
-- 1. 0036's two SECURITY DEFINER trigger functions,
--    enforce_activity_link_immutable() and enforce_relationship_link_immutable(), kept the
--    default EXECUTE for PUBLIC. A function returning `trigger` cannot be called directly, so
--    nothing was reachable through it; every other definer revokes PUBLIC, and these now do
--    too. A trigger fires without EXECUTE on its function (EXECUTE is checked when the trigger
--    is created), so the immutability checks keep working for every role.
--
-- 2. 0060 granted app_user DELETE on all five integration_* tables, uniformly, because
--    two flows hard-delete connections and subscriptions. Deliveries, inbound events and sync
--    checkpoints have no DELETE policy, so forced RLS made every DELETE there match zero rows;
--    no application path deletes them (the data-retention purge of deliveries and inbound
--    events runs as its SECURITY DEFINER owner, 0065). The privilege is revoked on those three:
--    a DELETE by app_user is now refused with 42501 instead of silently matching nothing.
--    integration_connections and integration_webhook_subscriptions keep DELETE (0060's flows).
--
-- scripts/db/roles.sql grants app_user only SELECT, INSERT and UPDATE, so re-running it does
-- not give these DELETEs back.

revoke all on function public.enforce_activity_link_immutable() from public;

revoke all on function public.enforce_relationship_link_immutable() from public;

revoke delete on
  public.integration_webhook_deliveries,
  public.integration_inbound_events,
  public.integration_sync_checkpoints
from app_user;

-- ── Verification ─────────────────────────────────────────────────────────────────

do $$
declare
  v_fn regprocedure;
  v_table text;
begin
  foreach v_fn in array array[
    'public.enforce_activity_link_immutable()'::regprocedure,
    'public.enforce_relationship_link_immutable()'::regprocedure
  ] loop
    if exists (
      select 1 from pg_proc p,
        lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = v_fn and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ) then
      raise exception '0082: % is still executable by PUBLIC', v_fn;
    end if;
  end loop;

  foreach v_table in array array[
    'public.integration_webhook_deliveries',
    'public.integration_inbound_events',
    'public.integration_sync_checkpoints'
  ] loop
    if has_table_privilege('app_user', v_table, 'DELETE') then
      raise exception '0082: app_user can still DELETE from %', v_table;
    end if;
  end loop;

  foreach v_table in array array[
    'public.integration_connections',
    'public.integration_webhook_subscriptions'
  ] loop
    if not has_table_privilege('app_user', v_table, 'DELETE') then
      raise exception '0082: app_user lost DELETE on % (0060''s flows need it)', v_table;
    end if;
  end loop;
end
$$;
