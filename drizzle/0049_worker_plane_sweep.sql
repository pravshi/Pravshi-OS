-- PRAVSHI OS — Phase 6: worker-plane privilege path for the retry sweeper and
-- the stale-claim reaper.
--
-- sweepRetryableJobs() (src/lib/jobs/retry-sweeper.ts) and reapStaleJobs()
-- (src/lib/jobs/worker.ts) are global worker-plane loops: they sweep/reap
-- jobs across ALL orgs and carry no per-request identity, so plain SQL is
-- fail-closed against the FORCED RLS on public.jobs (zero rows matched).
-- These two SECURITY DEFINER functions are the ONLY cross-org sweep/reap
-- paths, following the public.jobs_claim_next() pattern from 0045 and the
-- scheduler_tick_*() pattern from 0046:
--   language plpgsql security definer set search_path = '',
--   every relation schema-qualified (public.<table>),
--   revoke all from PUBLIC, grant EXECUTE to app_user only.
--
-- Both functions are cross-org by design (the worker plane). They take NO
-- org_id parameter — the WHERE clauses are the safety:
--   - jobs_sweep_retryable flips only 'failed' rows whose backoff elapsed and
--     whose attempt budget is not exhausted; it never touches 'dead_letter'.
--   - jobs_reap_stale flips only 'claimed'/'running' rows whose heartbeat is
--     older than the threshold; it never touches any other status.
--
-- Retry-sweeper race notes (preserved from the old raw-UPDATE implementation):
--   - The sweep keeps attempts/error_code untouched: attempts is the
--     exhaustion budget (failJob dead-letters at max_attempts) and error_*
--     is the evidence of the last failure. Manual POST /api/jobs/[id]/retry
--     still resets the budget explicitly.
--   - The outer WHERE repeats the status='failed' guard so the flip is one
--     atomic statement: if a manual retry wins the race (row now 'pending'),
--     the predicate no longer matches and the row is untouched.
--
-- Reaper note: reaped jobs keep their scheduled next_run_at — a claimed job
-- was due when it was claimed, so it is reclaimable immediately; attempts+1
-- burns one attempt for the abandoned run and error_code='STALE_CLAIM' marks
-- the reason.

-- ═════════════════════════════════════════════════════════════════════════════════
-- jobs_sweep_retryable — re-drive retryable 'failed' jobs to 'pending'
-- ═════════════════════════════════════════════════════════════════════════════════

drop function if exists public.jobs_sweep_retryable(int);

create or replace function public.jobs_sweep_retryable(
  p_limit int
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- Fail fast on a wiring bug: limit is embedded by the caller, so validate
  -- before touching rows (mirrors the old buildRetrySweepUpdate guards).
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'INVALID_REQUEST: p_limit must be an integer between 1 and 10000';
  end if;

  -- Postgres UPDATE takes no ORDER BY/LIMIT: a bounded id-subquery picks the
  -- oldest-due rows first. The outer WHERE repeats status='failed' so a row a
  -- manual retry already flipped is never re-swept (atomic race guard).
  update public.jobs j
  set status = 'pending',
      claimed_by = null,
      claimed_at = null,
      heartbeat_at = null,
      next_run_at = now(),
      updated_at = now()
  where j.id in (
    select id
    from public.jobs
    where status = 'failed'
      and next_run_at <= now()
      and attempts < max_attempts
    order by next_run_at asc
    limit p_limit
  )
    and j.status = 'failed';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.jobs_sweep_retryable(int) is
  'SECURITY DEFINER: worker-plane retry sweep. Flips up to p_limit jobs from '
  '''failed'' to ''pending'' where the backoff elapsed (next_run_at <= now()) '
  'and attempts < max_attempts, oldest-due first. Attempts and error_* are '
  'kept; ''dead_letter'' is never touched. Cross-org by design: takes no '
  'org_id; the WHERE clause is the safety.';

revoke all on function public.jobs_sweep_retryable(int) from public;
grant execute on function public.jobs_sweep_retryable(int) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- jobs_reap_stale — release stale claimed/running jobs back to 'pending'
-- ═════════════════════════════════════════════════════════════════════════════════

drop function if exists public.jobs_reap_stale(int);

create or replace function public.jobs_reap_stale(
  p_threshold_ms int
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_threshold_ms is null or p_threshold_ms < 0 then
    raise exception 'INVALID_REQUEST: p_threshold_ms must be a non-negative integer';
  end if;

  update public.jobs
  set status = 'pending',
      claimed_by = null,
      claimed_at = null,
      heartbeat_at = null,
      attempts = attempts + 1,
      error_code = 'STALE_CLAIM',
      updated_at = now()
  where status in ('claimed', 'running')
    and heartbeat_at < now() - (p_threshold_ms || ' milliseconds')::interval;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.jobs_reap_stale(int) is
  'SECURITY DEFINER: worker-plane stale-claim reaper. Resets jobs stuck in '
  '''claimed''/''running'' with a heartbeat older than p_threshold_ms back to '
  '''pending'', burning one attempt and stamping error_code=''STALE_CLAIM''. '
  'Cross-org by design: takes no org_id; the WHERE clause is the safety.';

revoke all on function public.jobs_reap_stale(int) from public;
grant execute on function public.jobs_reap_stale(int) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- Verification: fail the migration rather than leave a half-built worker path
-- ═════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_problems text;
begin
  select string_agg(p, '; ') into v_problems
  from (values
    ('jobs_sweep_retryable missing',
      exists (select 1 from pg_proc where proname = 'jobs_sweep_retryable'
              and pronamespace = 'public'::regnamespace)),
    ('jobs_sweep_retryable not security definer',
      exists (select 1 from pg_proc
              where proname = 'jobs_sweep_retryable'
                and pronamespace = 'public'::regnamespace
                and prosecdef)),
    ('jobs_reap_stale missing',
      exists (select 1 from pg_proc where proname = 'jobs_reap_stale'
              and pronamespace = 'public'::regnamespace)),
    ('jobs_reap_stale not security definer',
      exists (select 1 from pg_proc
              where proname = 'jobs_reap_stale'
                and pronamespace = 'public'::regnamespace
                and prosecdef)),
    ('jobs_sweep_retryable executable by PUBLIC',
      not exists (select 1 from information_schema.role_routine_grants
                  where routine_schema = 'public'
                    and routine_name = 'jobs_sweep_retryable'
                    and grantee = 'PUBLIC')),
    ('jobs_reap_stale executable by PUBLIC',
      not exists (select 1 from information_schema.role_routine_grants
                  where routine_schema = 'public'
                    and routine_name = 'jobs_reap_stale'
                    and grantee = 'PUBLIC'))
  ) as checks(p, ok)
  where not ok;

  if v_problems is not null then
    raise exception 'worker-plane sweep/reap privilege path broken: %', v_problems;
  end if;
end;
$$;
