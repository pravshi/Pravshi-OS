-- Rollback for 0077_deal_history_and_org_identity — restores the 0076 state.
--
-- Prepared in advance, as for 0073 and 0075: never invented at incident time.
-- Run as the migration owner (app_owner), only with the founder's approval for the
-- named database, and only if 0077 must be undone. It does NOT remove 0077's row
-- from drizzle.__drizzle_migrations: the history stays a record of what was
-- applied, and re-applying 0077 later is a forward migration decision.
--
-- What this re-opens: app_user with deals.edit can insert deal-stage history
-- directly again (MT-L6), and organizations.id/slug can be changed by anything
-- holding UPDATE on organizations (MT-L1; no runtime role does).

begin;

drop trigger if exists organizations_identity_freeze on public.organizations;
drop function if exists public.organizations_identity_freeze();

grant insert, update on public.deal_stage_history to app_user;

drop policy if exists deal_stage_history_insert on public.deal_stage_history;
create policy deal_stage_history_insert on public.deal_stage_history
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('deals.edit'))
  );

commit;
