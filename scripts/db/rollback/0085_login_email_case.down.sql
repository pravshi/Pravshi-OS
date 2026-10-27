-- Rollback for 0085_login_email_case — restores the 0084 behaviour.
--
-- Prepared in advance. Run as the migration owner, in one transaction, only with the founder's
-- approval for the named database. It does NOT remove 0085's row from the history.
--
-- What this re-opens: LOCK-1 — a login whose address is written in mixed case from now on is not
-- locked out and is not found by a reset request. Addresses lower-cased by 0085 stay lower-case
-- (the original spelling is not kept; citext treats the spellings as equal).
-- It refuses unless the database is exactly at 0085.

begin;

set local lock_timeout = '5s';

do $$
begin
  if (select count(*) from drizzle.__drizzle_migrations) <> 85 then
    raise exception '0085 rollback refused: the database is not at 0085 (roll back later migrations first)';
  end if;
end;
$$;

-- 0020's function, verbatim.
create or replace function public.resolve_login_org(p_email public.citext)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  -- The same address can exist in two orgs only by administrative accident; prefer the
  -- person who actually holds a login, then the oldest row. A login event attributed
  -- to the wrong org is a misfiled security signal, so the preference is explicit.
  select p.org_id
  from public.people p
  where p.work_email = p_email
    and p.deleted_at is null
  order by (p.auth_user_id is null), p.created_at
  limit 1;
$$;

alter table auth.auth_users drop constraint auth_users_email_lowercase;

drop trigger auth_users_normalize_email on auth.auth_users;

drop function auth.normalize_login_email();

commit;
