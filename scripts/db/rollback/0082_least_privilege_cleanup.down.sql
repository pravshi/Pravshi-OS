-- Rollback for 0082_least_privilege_cleanup — restores the 0081 state.
--
-- Prepared in advance. Run as the migration owner, in one transaction, only with the founder's
-- approval for the named database. It does NOT remove 0082's row from the history.
--
-- What this re-opens: PUBLIC may again EXECUTE the two 0036 trigger functions
-- (not callable directly), and app_user again holds DELETE on deliveries, inbound events and
-- sync checkpoints (forced RLS has no DELETE policy there, so a DELETE matches no row).

begin;

set local lock_timeout = '5s';

grant execute on function public.enforce_activity_link_immutable() to public;

grant execute on function public.enforce_relationship_link_immutable() to public;

grant delete on
  public.integration_webhook_deliveries,
  public.integration_inbound_events,
  public.integration_sync_checkpoints
to app_user;

commit;
