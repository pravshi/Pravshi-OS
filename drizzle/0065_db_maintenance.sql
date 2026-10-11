-- ═════════════════════════════════════════════════════════════════════════════
-- 0065_db_maintenance — automatic audit-partition extension and data retention
-- (Core V1 audit WP-2: findings D-1, D-2)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE TWO GAPS.
--
-- D-1. audit_logs is partitioned by month with NO DEFAULT partition (0011, by
--   founder decision), and ensure_audit_log_partitions() was only ever called
--   by migration 0011 itself — twelve months ahead of whenever that migration
--   ran. Nothing in the application, the worker, CI or the runbooks extends
--   the window. Once the last partition's month ends, every audit write fails
--   with "no partition of relation audit_logs found for row", and because
--   audit triggers run inside the business transaction, so does every write
--   that audits. A fixed date bomb, roughly a year after 0011 reached a
--   database.
--
-- D-2. Nothing deletes anything. The `cleanup` job handler (terminal jobs
--   older than 90 days) exists but nothing schedules it, and no other table
--   has a retention path at all — finished jobs, read notifications, workflow
--   execution history, webhook delivery and inbound-event logs, AI usage
--   rows and expired auth bookkeeping all grow for the life of the database.
--   On a Neon plan with a storage cap, that growth is eventually an outage
--   (writes are refused once the allowance is spent).
--
-- THE FIX — two worker-plane SECURITY DEFINER functions, called by the worker
-- on a fixed cadence (src/lib/jobs/maintenance.ts) and once at worker start:
--
-- PART 1 — public.maintain_audit_log_partitions(): no parameters. Calls the
--   0062-hardened ensure_audit_log_partitions(12), so the window is always
--   the current month plus twelve, and reports the window's end. Idempotent:
--   with the partitions present it is thirteen to_regclass lookups under a
--   transaction-scoped advisory lock (0062), so an hourly call costs nothing.
--
-- PART 2 — public.run_data_retention(int): deletes rows past their retention
--   period, at most p_batch_limit rows per target per call (bounded
--   transactions; a backlog drains over successive calls). Periods are fixed
--   here, not passed in: a caller can choose how much work one call does,
--   never what counts as old.
--
--     target                          deleted when
--     ──────────────────────────────  ──────────────────────────────────────────
--     webhook_deliveries              its job is succeeded/cancelled and was
--                                     created more than 90 days ago (deleted
--                                     BEFORE the job: job_id is a plain FK)
--     jobs                            succeeded/cancelled, created more than
--                                     90 days ago, no delivery row left
--                                     (the cleanup handler's existing contract;
--                                     dead_letter and failed are never touched
--                                     — the human review queue and the retry
--                                     path)
--     notifications                   read more than 90 days ago, or created
--                                     more than 365 days ago
--     workflow_executions             SUCCEEDED/FAILED/CANCELLED and finished
--                                     more than 180 days ago (steps cascade)
--     inbound_events                  received more than 90 days ago and no
--                                     longer RECEIVED (in flight). The payload
--                                     dedup window is 24 hours.
--     ai_usage_requests               created more than 400 days ago and not
--                                     STARTED (monthly limits read the current
--                                     month only)
--     auth_sessions                   expired more than 7 days ago
--     auth_verifications              expired more than 7 days ago
--     password_resets                 expired more than 30 days ago
--     login_lockouts                  window and any lock ended more than a day
--                                     ago
--     api_rate_limits                 window started more than a day ago
--     auth_rate_limits                last request more than a day ago
--
--   NEVER deleted: audit_logs (append-only evidence; dropping partitions is a
--   compliance decision, not housekeeping) and login_events (append-only by
--   trigger, 0018). Every business record — people, CRM, projects, tasks,
--   workflows themselves — is untouched; only operational history and expired
--   bookkeeping are in scope.
--
-- WHO MAY CALL. Both functions take no identity and are granted to app_user
-- only (the worker connects as app_user, like the web app). Both REFUSE when
-- a real person context is set (authz.person_id() is not null → 42501): they
-- are worker-plane maintenance, never something a signed-in request does.
-- Deletes made here write no per-row audit entries — audit_row_change() writes
-- nothing without an actor (0012) — and the worker logs per-target counts.
--
-- PART 3 — verification: fail the migration rather than leave a half-built
--   maintenance path (the 0046/0052/0061/0064 pattern).
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — maintain_audit_log_partitions
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.maintain_audit_log_partitions()
returns table (created integer, window_end date)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select authz.person_id()) is not null then
    raise exception 'maintain_audit_log_partitions is worker-plane only'
      using errcode = '42501';
  end if;

  created := public.ensure_audit_log_partitions(12);

  -- The upper bound of the latest partition: the first instant an audit write
  -- would have nowhere to go.
  select max((regexp_match(pg_get_expr(c.relpartbound, c.oid),
                           'TO \(''([0-9-]+)')
             )[1]::date)
    into window_end
  from pg_inherits i
  join pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.audit_logs'::regclass;

  return next;
end;
$$;

comment on function public.maintain_audit_log_partitions() is
  'SECURITY DEFINER, worker plane only (refuses a person context, 42501): keeps '
  'audit_logs partitioned twelve months ahead via ensure_audit_log_partitions(12) '
  'and returns how many partitions it created and the window''s end date. '
  'Core V1 audit WP-2, D-1.';

revoke all on function public.maintain_audit_log_partitions() from public;
grant execute on function public.maintain_audit_log_partitions() to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — run_data_retention
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.run_data_retention(p_batch_limit integer)
returns table (target text, deleted integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if (select authz.person_id()) is not null then
    raise exception 'run_data_retention is worker-plane only'
      using errcode = '42501';
  end if;
  if p_batch_limit is null or p_batch_limit < 1 or p_batch_limit > 10000 then
    raise exception 'p_batch_limit must be between 1 and 10000, got %', p_batch_limit
      using errcode = '22023';
  end if;

  -- Deliveries first: integration_webhook_deliveries.job_id references jobs
  -- without a cascade, so a job is only deletable once its deliveries are gone.
  delete from public.integration_webhook_deliveries d
  where d.ctid = any (array(
    select d2.ctid
    from public.integration_webhook_deliveries d2
    join public.jobs j on j.id = d2.job_id
    where j.status in ('succeeded', 'cancelled')
      and j.created_at < now() - interval '90 days'
    limit p_batch_limit));
  get diagnostics n = row_count;
  target := 'webhook_deliveries'; deleted := n; return next;

  delete from public.jobs j
  where j.ctid = any (array(
    select j2.ctid
    from public.jobs j2
    where j2.status in ('succeeded', 'cancelled')
      and j2.created_at < now() - interval '90 days'
      and not exists (
        select 1 from public.integration_webhook_deliveries d where d.job_id = j2.id)
    limit p_batch_limit));
  get diagnostics n = row_count;
  target := 'jobs'; deleted := n; return next;

  delete from public.notifications x
  where x.ctid = any (array(
    select x2.ctid
    from public.notifications x2
    where x2.read_at < now() - interval '90 days'
       or x2.created_at < now() - interval '365 days'
    limit p_batch_limit));
  get diagnostics n = row_count;
  target := 'notifications'; deleted := n; return next;

  delete from public.workflow_executions x
  where x.ctid = any (array(
    select x2.ctid
    from public.workflow_executions x2
    where x2.status in ('SUCCEEDED', 'FAILED', 'CANCELLED')
      and x2.finished_at < now() - interval '180 days'
    limit p_batch_limit));
  get diagnostics n = row_count;
  target := 'workflow_executions'; deleted := n; return next;

  delete from public.integration_inbound_events x
  where x.ctid = any (array(
    select x2.ctid
    from public.integration_inbound_events x2
    where x2.status <> 'RECEIVED'
      and x2.received_at < now() - interval '90 days'
    limit p_batch_limit));
  get diagnostics n = row_count;
  target := 'inbound_events'; deleted := n; return next;

  delete from public.ai_usage_requests x
  where x.ctid = any (array(
    select x2.ctid
    from public.ai_usage_requests x2
    where x2.status <> 'STARTED'
      and x2.created_at < now() - interval '400 days'
    limit p_batch_limit));
  get diagnostics n = row_count;
  target := 'ai_usage_requests'; deleted := n; return next;

  delete from auth.auth_sessions x
  where x.ctid = any (array(
    select x2.ctid from auth.auth_sessions x2
    where x2.expires_at < now() - interval '7 days'
    limit p_batch_limit));
  get diagnostics n = row_count;
  target := 'auth_sessions'; deleted := n; return next;

  delete from auth.auth_verifications x
  where x.ctid = any (array(
    select x2.ctid from auth.auth_verifications x2
    where x2.expires_at < now() - interval '7 days'
    limit p_batch_limit));
  get diagnostics n = row_count;
  target := 'auth_verifications'; deleted := n; return next;

  delete from auth.password_resets x
  where x.ctid = any (array(
    select x2.ctid from auth.password_resets x2
    where x2.expires_at < now() - interval '30 days'
    limit p_batch_limit));
  get diagnostics n = row_count;
  target := 'password_resets'; deleted := n; return next;

  delete from auth.login_lockouts x
  where x.ctid = any (array(
    select x2.ctid from auth.login_lockouts x2
    where x2.window_start < now() - interval '1 day'
      and (x2.locked_until is null or x2.locked_until < now() - interval '1 day')
    limit p_batch_limit));
  get diagnostics n = row_count;
  target := 'login_lockouts'; deleted := n; return next;

  delete from auth.api_rate_limits x
  where x.ctid = any (array(
    select x2.ctid from auth.api_rate_limits x2
    where x2.window_start < now() - interval '1 day'
    limit p_batch_limit));
  get diagnostics n = row_count;
  target := 'api_rate_limits'; deleted := n; return next;

  -- Better Auth stores last_request as epoch milliseconds.
  delete from auth.auth_rate_limits x
  where x.ctid = any (array(
    select x2.ctid from auth.auth_rate_limits x2
    where x2.last_request < (extract(epoch from now() - interval '1 day') * 1000)::bigint
    limit p_batch_limit));
  get diagnostics n = row_count;
  target := 'auth_rate_limits'; deleted := n; return next;
end;
$$;

comment on function public.run_data_retention(integer) is
  'SECURITY DEFINER, worker plane only (refuses a person context, 42501): deletes '
  'operational history and expired auth bookkeeping past fixed retention periods '
  '(see migration 0065 header), at most p_batch_limit rows (1..10000) per target '
  'per call, returning per-target counts. Never touches audit_logs, login_events '
  'or business records. Core V1 audit WP-2, D-2.';

revoke all on function public.run_data_retention(integer) from public;
grant execute on function public.run_data_retention(integer) to app_user;

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
    ('maintain_audit_log_partitions missing or not security definer',
      exists (select 1 from pg_proc
              where proname = 'maintain_audit_log_partitions'
                and pronamespace = 'public'::regnamespace
                and prosecdef)),
    ('run_data_retention missing or not security definer',
      exists (select 1 from pg_proc
              where proname = 'run_data_retention'
                and pronamespace = 'public'::regnamespace
                and prosecdef)),
    ('maintenance functions must pin search_path',
      not exists (select 1 from pg_proc
                  where proname in ('maintain_audit_log_partitions', 'run_data_retention')
                    and pronamespace = 'public'::regnamespace
                    and not coalesce('search_path=""' = any (proconfig), false))),
    ('maintenance functions executable by PUBLIC',
      not exists (select 1 from information_schema.role_routine_grants
                  where routine_schema = 'public'
                    and routine_name in ('maintain_audit_log_partitions', 'run_data_retention')
                    and grantee = 'PUBLIC')),
    ('app_user cannot execute maintain_audit_log_partitions',
      has_function_privilege('app_user', 'public.maintain_audit_log_partitions()', 'execute')),
    ('app_user cannot execute run_data_retention',
      has_function_privilege('app_user', 'public.run_data_retention(integer)', 'execute'))
  ) as checks(p, ok)
  where not ok;

  if v_problems is not null then
    raise exception 'db maintenance path broken: %', v_problems;
  end if;
end;
$$;
