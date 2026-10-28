-- Rollback for 0088_crm_import_decisions — restores the 0087 state.
--
-- Prepared in advance. Run as the migration owner, in one transaction, only with the founder's
-- approval for the named database. It does NOT remove 0088's row from the history.
--
-- What this removes: every recorded duplicate decision and every confirmed row plan (the
-- tables go with their rows). Imports
-- already confirmed have been or will be committed from the decisions that were in force; a
-- PREVIEWED import falls back to 0081's behaviour (undecided possible duplicates are skipped
-- unless included per row). The 0088 application code reads the table: roll the application
-- back with it.
-- It refuses unless the database is exactly at 0088.

begin;

set local lock_timeout = '5s';

do $$
begin
  if (select count(*) from drizzle.__drizzle_migrations) <> 88 then
    raise exception '0088 rollback refused: the database is not at 0088 (roll back later migrations first)';
  end if;
end;
$$;

drop table public.crm_import_row_plans;
drop function public.crm_import_row_plans_guard();
drop table public.crm_import_decisions;
drop function public.crm_import_decisions_guard();

commit;
