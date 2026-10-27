-- ═════════════════════════════════════════════════════════════════════════════════
-- PRAVSHI OS — 0079: rate-limit buckets count correctly on concurrent first use (FU-3)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- authz.check_rate_limit() (0024) read the bucket with SELECT … FOR UPDATE and inserted it
-- when absent. FOR UPDATE locks nothing when there is no row, so two requests arriving
-- together on a key's first use both tried to INSERT; the second failed with a unique
-- violation (23505). Callers fail closed on a limiter error (the MFA route answers its
-- generic INVALID_CODE and raises an alert; the login and reset routes refuse), so this
-- was never a bypass — it was a spurious refusal and a false alert for a legitimate burst.
-- Found in the MFA review as F-MFA-5; reproduced locally against 0077 before this fix.
--
-- The function is now one INSERT … ON CONFLICT DO UPDATE: the row lock is taken by the
-- statement itself, so concurrent first uses serialize on the key and each is counted.
-- Semantics are unchanged: first use counts 1 and is allowed; a stale window restarts at 1
-- and is allowed; otherwise the count goes up by one and the call is allowed while it is
-- within p_max. Signature, SECURITY DEFINER, search_path and grants are unchanged.
--
-- Rollback: scripts/db/rollback/0079_rate_limit_first_use.down.sql restores 0024's body.

set local lock_timeout = '5s';

create or replace function authz.check_rate_limit(p_key text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into auth.api_rate_limits as r (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update
    set window_start = case
          when r.window_start <= now() - (p_window_seconds * interval '1 second') then now()
          else r.window_start
        end,
        count = case
          when r.window_start <= now() - (p_window_seconds * interval '1 second') then 1
          else r.count + 1
        end
  returning r.count into v_count;

  -- A count of 1 is a first use or a restarted window, which 0024 always allowed
  -- (whatever p_max is); every later hit is allowed while within p_max — as before.
  return v_count = 1 or v_count <= p_max;
end;
$$;

comment on function authz.check_rate_limit(text, integer, integer) is
  'Fixed-window rate limiting for custom pre-auth API routes. Returns true while '
  'the key stays within p_max hits per p_window_seconds; resets stale windows. 0079: '
  'one INSERT … ON CONFLICT DO UPDATE, so concurrent first uses of a key are counted '
  'instead of failing with a unique violation (FU-3 / F-MFA-5).';

-- ── Verification ─────────────────────────────────────────────────────────────────

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('authz.check_rate_limit(text, integer, integer)'::regprocedure)
    into v_def;
  if position('on conflict (key) do update' in v_def) = 0 then
    raise exception '0079: check_rate_limit is not the upsert form';
  end if;
  if not (select prosecdef from pg_proc
           where oid = 'authz.check_rate_limit(text, integer, integer)'::regprocedure) then
    raise exception '0079: check_rate_limit must stay SECURITY DEFINER';
  end if;
  if not has_function_privilege('app_auth', 'authz.check_rate_limit(text, integer, integer)', 'EXECUTE')
     or has_function_privilege('app_user', 'authz.check_rate_limit(text, integer, integer)', 'EXECUTE') then
    raise exception '0079: check_rate_limit grants changed (app_auth only, since 0073)';
  end if;
end
$$;
