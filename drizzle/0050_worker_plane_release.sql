-- PRAVSHI OS — Phase 6: worker-plane privilege path for claim release and
-- retry backoff.
--
-- releaseClaim() and applyRetryBackoff() (src/lib/jobs/worker.ts) run on the
-- global worker plane: they act on a single job by id with no per-request
-- identity, so a raw UPDATE is fail-closed against the FORCED RLS on
-- public.jobs (zero rows matched). These two SECURITY DEFINER functions are
-- the ONLY release/backoff paths, following the public.jobs_claim_next()
-- pattern from 0045, the scheduler_tick_*() pattern from 0046, and the
-- jobs_sweep_retryable() / jobs_reap_stale() pattern from 0049:
--   language plpgsql security definer set search_path = '',
--   every relation schema-qualified (public.<table>),
--   revoke all from PUBLIC, grant EXECUTE to app_user only.
--
-- Both functions are idempotent release/backoff paths for a single row.
-- The WHERE clauses are the safety:
--   - jobs_release_claim flips only 'claimed'/'running' rows claimed by the
--     calling worker; it never touches a job another worker already finished
--     or completed (returns false instead). Attempts are NOT burned — a
--     release is a clean hand-back, not a failure.
--   - jobs_apply_backoff sets next_run_at only on 'failed' rows; a
--     concurrent dead_letter transition (status no longer 'failed') leaves
--     the row untouched, so a dead-lettered job can never pick up a backoff
--     delay it will never honor.
--
-- Release note: unlike the reaper (0049), a release is always due
-- immediately — the old raw-UPDATE implementation stamped
-- next_run_at = now() inline. Callers that need a specific due time pass it
-- through jobs_apply_backoff. jobs_release_claim itself only clears the
-- claim and returns the job to 'pending'; it never touches attempts or
-- error_*, and it never touches next_run_at.

-- ═════════════════════════════════════════════════════════════════════════════════
-- jobs_release_claim — hand a claimed/running job back to 'pending'
-- ═════════════════════════════════════════════════════════════════════════════════

drop function if exists public.jobs_release_claim(uuid, text);

create or replace function public.jobs_release_claim(
  p_job_id uuid,
  p_worker_id text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The guarded WHERE makes this a no-op if the job already moved on (e.g.
  -- the handler finished and completeJob won the race): found is false and
  -- the caller simply moves on.
  update public.jobs
  set status = 'pending',
      claimed_by = null,
      claimed_at = null,
      heartbeat_at = null,
      updated_at = now()
  where id = p_job_id
    and claimed_by = p_worker_id
    and status in ('claimed', 'running');

  return found;
end;
$$;

comment on function public.jobs_release_claim(uuid, text) is
  'SECURITY DEFINER: worker-plane claim release. Resets a job this worker '
  'claimed (status ''claimed''/''running'' AND claimed_by = p_worker_id) to '
  '''pending'', clearing the claim fields so another worker can retry it. '
  'Returns true when a row was released, false when the job already moved '
  'on. Attempts and error_* are kept; next_run_at is untouched.';

revoke all on function public.jobs_release_claim(uuid, text) from public;
grant execute on function public.jobs_release_claim(uuid, text) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- jobs_apply_backoff — set the retry backoff due time on a 'failed' job
-- ═════════════════════════════════════════════════════════════════════════════════

drop function if exists public.jobs_apply_backoff(uuid, timestamptz);

create or replace function public.jobs_apply_backoff(
  p_job_id uuid,
  p_next_run_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_next_run_at is null then
    raise exception 'INVALID_REQUEST: p_next_run_at must not be null';
  end if;

  -- Guarded to 'failed': a concurrent dead_letter transition races this
  -- path, and a dead-lettered job must never pick up a backoff delay.
  update public.jobs
  set next_run_at = p_next_run_at,
      updated_at = now()
  where id = p_job_id
    and status = 'failed';

  return found;
end;
$$;

comment on function public.jobs_apply_backoff(uuid, timestamptz) is
  'SECURITY DEFINER: worker-plane retry backoff. Sets next_run_at on a job '
  'currently ''failed'' (the failJob contract stamps now(); the worker then '
  'applies the exponential backoff absolute time). Returns true when the row '
  'was updated, false when it already left ''failed''. Attempts and error_* '
  'are kept.';

revoke all on function public.jobs_apply_backoff(uuid, timestamptz) from public;
grant execute on function public.jobs_apply_backoff(uuid, timestamptz) to app_user;

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
    ('jobs_release_claim missing',
      exists (select 1 from pg_proc where proname = 'jobs_release_claim'
              and pronamespace = 'public'::regnamespace)),
    ('jobs_release_claim not security definer',
      exists (select 1 from pg_proc
              where proname = 'jobs_release_claim'
                and pronamespace = 'public'::regnamespace
                and prosecdef)),
    ('jobs_apply_backoff missing',
      exists (select 1 from pg_proc where proname = 'jobs_apply_backoff'
              and pronamespace = 'public'::regnamespace)),
    ('jobs_apply_backoff not security definer',
      exists (select 1 from pg_proc
              where proname = 'jobs_apply_backoff'
                and pronamespace = 'public'::regnamespace
                and prosecdef)),
    ('jobs_release_claim executable by PUBLIC',
      not exists (select 1 from information_schema.role_routine_grants
                  where routine_schema = 'public'
                    and routine_name = 'jobs_release_claim'
                    and grantee = 'PUBLIC')),
    ('jobs_apply_backoff executable by PUBLIC',
      not exists (select 1 from information_schema.role_routine_grants
                  where routine_schema = 'public'
                    and routine_name = 'jobs_apply_backoff'
                    and grantee = 'PUBLIC'))
  ) as checks(p, ok)
  where not ok;

  if v_problems is not null then
    raise exception 'worker-plane release/backoff privilege path broken: %', v_problems;
  end if;
end;
$$;
