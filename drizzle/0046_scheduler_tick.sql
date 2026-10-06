-- PRAVSHI OS — Phase 6: scheduler tick worker-plane privilege path.
--
-- tickScheduler() (src/lib/jobs/scheduler.ts) is a global worker-plane loop:
-- it fires schedules across ALL orgs and carries no per-request identity, so
-- plain SQL is fail-closed against the FORCED RLS on public.schedules (zero
-- rows). These two SECURITY DEFINER functions are the ONLY cross-org tick
-- path, following the public.jobs_claim_next() pattern from 0045:
--   language plpgsql security definer set search_path = '',
--   every relation schema-qualified (public.<table>),
--   revoke all from PUBLIC, grant EXECUTE to app_user only.
--
-- Concurrency story (defense in depth):
--   1. The TS tick acquires pg_advisory_xact_lock(hashtext('scheduler-tick'))
--      FIRST, inside the same transaction — concurrent tick instances
--      serialize on it (transaction-scoped: released on commit/rollback).
--   2. scheduler_tick_claim() locks due rows FOR UPDATE for the transaction,
--      so a tick that somehow missed the advisory lock still cannot
--      double-fire a row another tick holds.
--   3. scheduler_tick_fire() re-checks due-ness under the row lock and
--      enqueues with INSERT ... ON CONFLICT (org_id, dedup_key) DO NOTHING,
--      so even a true double-fire of the same window is an idempotent no-op.
--
-- The dedup key is `sched:<schedule_id>:<window_start>` where window_start is
-- the SCHEDULED firing time at minute-precision UTC (computed by cron.ts's
-- cronWindowStart, never by now()).

-- ═════════════════════════════════════════════════════════════════════════════════
-- scheduler_tick_claim — due-schedule scan (cross-org read path)
-- ═════════════════════════════════════════════════════════════════════════════════

drop function if exists public.scheduler_tick_claim(timestamptz);

create or replace function public.scheduler_tick_claim(
  p_now timestamptz
) returns setof public.schedules
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select s.*
  from public.schedules s
  where s.is_active
    and s.next_run_at <= p_now
  order by s.next_run_at asc
  for update;
end;
$$;

comment on function public.scheduler_tick_claim(timestamptz) is
  'SECURITY DEFINER: scheduler tick due scan. Returns every active schedule '
  'with next_run_at <= p_now, row-locked FOR UPDATE for the caller''s '
  'transaction. The only cross-org schedule read path: RLS is FORCED on '
  'public.schedules, so the worker plane cannot see schedules through '
  'plain SQL. Takes no org_id (the tick is global).';

revoke all on function public.scheduler_tick_claim(timestamptz) from public;
grant execute on function public.scheduler_tick_claim(timestamptz) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- scheduler_tick_fire — enqueue + advance one schedule, atomically
-- ═════════════════════════════════════════════════════════════════════════════════

drop function if exists public.scheduler_tick_fire(uuid, timestamptz, timestamptz, text, text);

create or replace function public.scheduler_tick_fire(
  p_schedule_id uuid,
  p_fired_at timestamptz,    -- the tick's now: stamped as last_run_at
  p_next_run_at timestamptz, -- TS-computed next occurrence (cron.ts nextRunAt)
  p_window_start text,       -- minute-precision UTC ISO of the fired window
  p_dedup_key text           -- 'sched:<schedule_id>:<window_start>'
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_workflow_id uuid;
  v_is_active boolean;
  v_next_run_at timestamptz;
  v_row_count integer;
begin
  -- Re-check due-ness under the row lock: a schedule another tick already
  -- advanced (or deactivated) is not fired again.
  select s.org_id, s.workflow_id, s.is_active, s.next_run_at
    into v_org_id, v_workflow_id, v_is_active, v_next_run_at
  from public.schedules s
  where s.id = p_schedule_id
  for update;

  if not found or not v_is_active or v_next_run_at > p_fired_at then
    return false;
  end if;

  -- Enqueue the scheduled_trigger job. The dedup window is the SCHEDULED
  -- time; a repeated fire of the same window hits the partial unique index
  -- (partial indexes need the predicate in the arbiter clause).
  insert into public.jobs (org_id, type, payload, dedup_key)
  values (
    v_org_id,
    'scheduled_trigger',
    jsonb_build_object(
      'scheduleId', p_schedule_id::text,
      'workflowId', v_workflow_id::text,
      'windowStart', p_window_start
    ),
    p_dedup_key
  )
  on conflict (org_id, dedup_key) where dedup_key is not null do nothing;

  get diagnostics v_row_count = row_count;

  -- Advance the schedule deterministically: a duplicate fire recomputes the
  -- same values, so this stays idempotent.
  update public.schedules
  set last_run_at = p_fired_at,
      next_run_at = p_next_run_at,
      updated_at = now()
  where id = p_schedule_id;

  return v_row_count = 1;
end;
$$;

comment on function public.scheduler_tick_fire(uuid, timestamptz, timestamptz, text, text) is
  'SECURITY DEFINER: fire one due schedule. Re-checks due-ness under the row '
  'lock, inserts a scheduled_trigger job (payload {scheduleId, workflowId, '
  'windowStart}) with dedup_key sched:<schedule_id>:<window_start> via '
  'INSERT ... ON CONFLICT DO NOTHING, then advances last_run_at/next_run_at. '
  'Returns true only when a job row was newly enqueued. The only cross-org '
  'schedule write path for the tick.';

revoke all on function public.scheduler_tick_fire(uuid, timestamptz, timestamptz, text, text) from public;
grant execute on function public.scheduler_tick_fire(uuid, timestamptz, timestamptz, text, text) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- scheduler_admin_delete — hard-delete one schedule (jobs.delete path)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- There is intentionally NO delete RLS policy on public.schedules (0045:
-- deactivation is the lifecycle; purges run through a retention cleanup
-- job), so the jobs.delete-authorized delete path goes through this
-- SECURITY DEFINER function. The caller (scheduler.ts deleteSchedule)
-- verifies jobs.delete AND the row's visibility to the caller's org BEFORE
-- calling; this function deletes by id only.

drop function if exists public.scheduler_admin_delete(uuid);

create or replace function public.scheduler_admin_delete(
  p_schedule_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.schedules where id = p_schedule_id;
end;
$$;

comment on function public.scheduler_admin_delete(uuid) is
  'SECURITY DEFINER: hard-delete one schedule by id. The only delete path '
  'for schedules (no DELETE RLS policy by design). Callers must verify '
  'jobs.delete and the row''s org-visibility before invoking.';

revoke all on function public.scheduler_admin_delete(uuid) from public;
grant execute on function public.scheduler_admin_delete(uuid) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- Verification: fail the migration rather than leave a half-built tick path
-- ═════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_problems text;
begin
  select string_agg(p, '; ') into v_problems
  from (values
    ('scheduler_tick_claim missing',
      exists (select 1 from pg_proc where proname = 'scheduler_tick_claim'
              and pronamespace = 'public'::regnamespace)),
    ('scheduler_tick_claim not security definer',
      exists (select 1 from pg_proc
              where proname = 'scheduler_tick_claim'
                and pronamespace = 'public'::regnamespace
                and prosecdef)),
    ('scheduler_tick_fire missing',
      exists (select 1 from pg_proc where proname = 'scheduler_tick_fire'
              and pronamespace = 'public'::regnamespace)),
    ('scheduler_tick_fire not security definer',
      exists (select 1 from pg_proc
              where proname = 'scheduler_tick_fire'
                and pronamespace = 'public'::regnamespace
                and prosecdef)),
    ('scheduler_admin_delete missing',
      exists (select 1 from pg_proc where proname = 'scheduler_admin_delete'
              and pronamespace = 'public'::regnamespace)),
    ('scheduler_admin_delete not security definer',
      exists (select 1 from pg_proc
              where proname = 'scheduler_admin_delete'
                and pronamespace = 'public'::regnamespace
                and prosecdef)),
    ('scheduler_tick_claim executable by PUBLIC',
      not exists (select 1 from information_schema.role_routine_grants
                  where routine_schema = 'public'
                    and routine_name = 'scheduler_tick_claim'
                    and grantee = 'PUBLIC')),
    ('scheduler_tick_fire executable by PUBLIC',
      not exists (select 1 from information_schema.role_routine_grants
                  where routine_schema = 'public'
                    and routine_name = 'scheduler_tick_fire'
                    and grantee = 'PUBLIC')),
    ('scheduler_admin_delete executable by PUBLIC',
      not exists (select 1 from information_schema.role_routine_grants
                  where routine_schema = 'public'
                    and routine_name = 'scheduler_admin_delete'
                    and grantee = 'PUBLIC'))
  ) as checks(p, ok)
  where not ok;

  if v_problems is not null then
    raise exception 'scheduler tick privilege path broken: %', v_problems;
  end if;
end;
$$;
