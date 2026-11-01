-- ═════════════════════════════════════════════════════════════════════════════
-- 0066_worker_next_due — the earliest instant the worker has anything to do
-- (WP-W: low-cost worker mode for Neon Free)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY. Neon Free suspends compute only after 5 minutes without a query, and
-- 100 CU-hours per project per month is the whole budget: when it is spent,
-- every compute in the project — production included — is suspended until the
-- next billing period. The worker used to read the database at least every
-- 10 s (idle claim poll), 30 s (retry sweep) and 60 s (reminder sweep,
-- scheduler tick), so compute could never suspend: ~730 h × 0.25 CU ≈ 182
-- CU-hours a month from the worker alone.
--
-- In low-cost mode (src/lib/jobs/worker.ts, idleMode 'deep-sleep') the worker,
-- once idle, asks this function when the next piece of work falls due and
-- sleeps until then — capped by a safety interval, and cut short by the wake
-- signal the web app sends whenever it enqueues work. While it sleeps it sends
-- no query at all, so compute can suspend.
--
-- PART 1 — public.worker_next_due_at(): the minimum of every timer the worker
--   honours, each matching EXACTLY the predicate of the sweep that acts on it:
--     pending jobs            next_run_at            (jobs_claim_next, 0045)
--     failed, retryable jobs  next_run_at            (jobs_sweep_retryable, 0049:
--                                                     status 'failed', attempts
--                                                     < max_attempts)
--     claimed/running jobs    coalesce(heartbeat_at, claimed_at) + 60 s
--                                                    (reapStaleJobs' default
--                                                     threshold, 0049)
--     unsent task reminders   remind_at              (claim_due_task_reminders,
--                                                     0064)
--     active schedules        next_run_at            (scheduler_tick_claim, 0046)
--   NULL when nothing is pending anywhere. A value in the past means "due now"
--   (overdue work after a restart or a long suspend) and the worker drains
--   immediately. Like every worker-plane function it takes no identity and is
--   global across orgs; it returns only a timestamp — no row, org or payload —
--   so there is nothing in its answer to leak. It refuses a signed-in person
--   context (42501), the 0065 rule.
--
-- PART 2 — two partial indexes so the answer stays an index probe as jobs
--   grows: failed jobs by next_run_at, and in-flight jobs by lease time.
--   Pending jobs (jobs_claim_idx), reminders (task_reminders_pending_idx) and
--   schedules (schedules_due_idx) are already indexed for exactly these reads.
--
-- PART 3 — verification (the 0046/0052/0061/0064/0065 pattern).
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — worker_next_due_at
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.worker_next_due_at()
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select authz.person_id()) is not null then
    raise exception 'worker_next_due_at is worker-plane only'
      using errcode = '42501';
  end if;

  return least(
    (select min(j.next_run_at) from public.jobs j
      where j.status = 'pending'),
    (select min(j.next_run_at) from public.jobs j
      where j.status = 'failed' and j.attempts < j.max_attempts),
    (select min(coalesce(j.heartbeat_at, j.claimed_at)) + interval '60 seconds'
       from public.jobs j
      where j.status in ('claimed', 'running')),
    (select min(r.remind_at) from public.task_reminders r
      where not r.is_sent),
    (select min(s.next_run_at) from public.schedules s
      where s.is_active)
  );
end;
$$;

comment on function public.worker_next_due_at() is
  'SECURITY DEFINER, worker plane only (refuses a person context, 42501): the '
  'earliest instant any pending job, retryable failed job, stale-claim reap, '
  'unsent task reminder or active schedule falls due, across all orgs; NULL '
  'when nothing is pending. Returns a timestamp only. WP-W low-cost worker mode.';

revoke all on function public.worker_next_due_at() from public;
grant execute on function public.worker_next_due_at() to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — indexes for the two job timers no existing index covers
-- ═════════════════════════════════════════════════════════════════════════════
create index if not exists jobs_failed_due_idx
  on public.jobs (next_run_at)
  where status = 'failed';

create index if not exists jobs_inflight_lease_idx
  on public.jobs ((coalesce(heartbeat_at, claimed_at)))
  where status in ('claimed', 'running');

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — verification
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_problems text;
begin
  select string_agg(p, '; ') into v_problems
  from (values
    ('worker_next_due_at missing or not security definer',
      exists (select 1 from pg_proc
              where proname = 'worker_next_due_at'
                and pronamespace = 'public'::regnamespace
                and prosecdef)),
    ('worker_next_due_at must pin search_path',
      exists (select 1 from pg_proc
              where proname = 'worker_next_due_at'
                and pronamespace = 'public'::regnamespace
                and coalesce('search_path=""' = any (proconfig), false))),
    ('worker_next_due_at executable by PUBLIC',
      not exists (select 1 from information_schema.role_routine_grants
                  where routine_schema = 'public'
                    and routine_name = 'worker_next_due_at'
                    and grantee = 'PUBLIC')),
    ('app_user cannot execute worker_next_due_at',
      has_function_privilege('app_user', 'public.worker_next_due_at()', 'execute')),
    ('jobs_failed_due_idx missing',
      to_regclass('public.jobs_failed_due_idx') is not null),
    ('jobs_inflight_lease_idx missing',
      to_regclass('public.jobs_inflight_lease_idx') is not null)
  ) as checks(p, ok)
  where not ok;

  if v_problems is not null then
    raise exception 'worker next-due path broken: %', v_problems;
  end if;
end;
$$;
