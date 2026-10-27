-- Rollback for 0086_platform_console — restores the 0085 state.
--
-- Prepared in advance. Run as the migration owner, in one transaction, only with the founder's
-- approval for the named database. It does NOT remove 0086's row from the history.
--
-- What this re-opens: nothing; the platform console's administrator list stops working.
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

commit;
