-- Rollback for 0088_crm_import_decisions — restores the 0087 state.
--
-- Prepared in advance. Run as the migration owner, in one transaction, only with the founder's
-- approval for the named database. It does NOT remove 0088's row from the history.
--
-- What this removes: two tables (crm_import_decisions, crm_import_row_plans) with every
-- recorded duplicate decision and confirmed row plan, and their two guard functions.
-- Consequences: a PREVIEWED import falls back to 0081's behaviour (undecided possible duplicates
-- are skipped unless included per row) and its decisions are lost; a finished import keeps its
-- results. An import with a confirmed plan that is still QUEUED or RUNNING would lose that plan
-- and run under 0081's rules — its "use the existing" and "create new" rows would be skipped —
-- so the rollback refuses while one exists: let it finish, or cancel it, first. The 0088
-- application code reads both tables: roll the application back with it.
-- It refuses unless the database is exactly at 0088.

begin;

set local lock_timeout = '5s';

-- Taken before the check: a confirmation in flight (its plan written, not yet committed) holds
-- crm_imports and crm_import_row_plans; this waits for it, then sees it QUEUED and refuses. And
-- none can start between the check and the drops.
lock table public.crm_imports, public.crm_import_row_plans, public.crm_import_decisions
  in share row exclusive mode;

do $$
begin
  if (select count(*) from drizzle.__drizzle_migrations) <> 88 then
    raise exception '0088 rollback refused: the database is not at 0088 (roll back later migrations first)';
  end if;
  if exists (select 1 from public.crm_imports i
             where i.status in ('QUEUED', 'RUNNING')
               and exists (select 1 from public.crm_import_row_plans p where p.import_id = i.id)) then
    raise exception '0088 rollback refused: an import with a confirmed plan is queued or running';
  end if;
end;
$$;

drop table public.crm_import_row_plans;
drop function public.crm_import_row_plans_guard();
drop table public.crm_import_decisions;
drop function public.crm_import_decisions_guard();

commit;
