-- Rollback for 0079_rate_limit_first_use — restores the 0078 state.
--
-- Prepared in advance. Run as the migration owner, in one transaction, only with the founder's
-- approval for the named database. It does NOT remove 0079's row from the history.
--
-- What this re-opens (FU-3 / F-MFA-5): concurrent first uses of a rate-limit key fail with a
-- unique violation, which callers turn into a spurious refusal and an alert.

begin;

set local lock_timeout = '5s';

-- 0024's check_rate_limit body, verbatim (as CREATE OR REPLACE; grants are unchanged by it).
create or replace function authz.check_rate_limit(p_key text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row auth.api_rate_limits%rowtype;
begin
  select * into v_row
  from auth.api_rate_limits
  where key = p_key
  for update;

  if v_row.key is null then
    insert into auth.api_rate_limits (key, window_start, count)
    values (p_key, now(), 1);
    return true;
  end if;

  if v_row.window_start <= now() - (p_window_seconds * interval '1 second') then
    -- Stale window: restart it. The row is already locked by the select above.
    update auth.api_rate_limits
    set window_start = now(),
        count = 1
    where key = p_key;
    return true;
  end if;

  update auth.api_rate_limits
  set count = count + 1
  where key = p_key
  returning * into v_row;

  return v_row.count <= p_max;
end;
$$;

comment on function authz.check_rate_limit(text, integer, integer) is
  'Fixed-window rate limiting for custom pre-auth API routes. Returns true while '
  'the key stays within p_max hits per p_window_seconds; resets stale windows.';

commit;
