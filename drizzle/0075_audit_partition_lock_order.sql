-- ═════════════════════════════════════════════════════════════════════════════
-- 0075_audit_partition_lock_order — partition maintenance never waits while holding
-- a lock an application transaction may need
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT (WP-A1 review, MEDIUM; present since 0062). Creating an audit_logs
-- partition takes, measured on Postgres 18:
--
--   audit_logs (the partitioned parent)   ACCESS EXCLUSIVE
--   organizations, people                 SHARE ROW EXCLUSIVE   (cloning audit_logs'
--                                                               two foreign keys)
--   audit_logs' partitioned indexes       SHARE UPDATE EXCLUSIVE
--   the new partition and its indexes     (new objects: nobody else holds them)
--
-- — audit_logs FIRST, the referenced tables after. An application transaction that
-- writes organizations or people and then audits (write_audit_log, or the people
-- row-audit trigger) takes them the other way round. 0062 bounded the DDL waits
-- with lock_timeout = 5s, but the DDL still WAITED while holding audit_logs:
--   * a cycle: maintenance holds audit_logs and waits for people; the application
--     holds people and waits for audit_logs. Postgres killed the application side
--     (reproduced with bootstrap's shape and with session revoke-all's shape);
--   * a stall: while maintenance waited, every audit insert in the system queued
--     behind its ACCESS EXCLUSIVE lock — an unrelated one-row audit insert was
--     measured blocked for 2.96 s, up to the 5 s timeout on every attempt.
--
-- THE FIX. Inside the existing savepoint-and-retry block, before any DDL:
--   (a) if no partition is missing, return 0 at once — the hourly no-op run takes
--       no table lock at all;
--   (b) take every lock the DDL needs from other sessions, up front, with NOWAIT:
--         organizations, people   SHARE ROW EXCLUSIVE NOWAIT
--         ONLY audit_logs         ACCESS EXCLUSIVE NOWAIT   (last: the hot table is
--                                 held only once everything else is)
--       NOWAIT never queues: a conflict raises lock_not_available (55P03) at once.
--       The handler rolls back to the block's savepoint — which RELEASES whatever
--       this attempt locked — backs off, and tries again. So maintenance never
--       waits while holding a lock an application transaction could need: it cannot
--       join a cycle with one, and nothing queues behind it except for the
--       milliseconds the DDL itself takes. ONLY: LOCK TABLE on a partitioned table
--       would otherwise lock every existing partition, which the DDL does not need.
--   (c) the DDL itself is unchanged. With (b) held, its remaining lock — SHARE
--       UPDATE EXCLUSIVE on audit_logs' partitioned indexes — conflicts only with
--       other DDL or maintenance on those indexes, never with an application
--       insert, and lock_timeout still bounds it.
-- Retries: 10 attempts, backoff 0.05 s × attempt capped at 0.5 s (≈2.3 s in all).
-- Exhaustion re-raises 55P03, as 0062 did: the worker logs the SQLSTATE and runs again
-- an hour later, with twelve months of partitions ahead and its own alert when the
-- window runs short (src/lib/jobs/maintenance.ts).
--
-- WHAT IS UNCHANGED: the signature, SECURITY DEFINER, search_path, owner and ACL (owner
-- only; CREATE OR REPLACE keeps it, re-asserted below); the advisory lock serialising
-- maintenance runs (waited for indefinitely — queueing behind a peer is not contention);
-- idempotence; the per-partition RLS, policy and revokes. Application transactions are
-- untouched: a business change and its audit entry stay one transaction.
--
-- Forward-only by default. scripts/db/rollback/0075_audit_partition_lock_order.down.sql
-- restores 0062's body verbatim, should this ever need undoing; it brings the defect
-- back.

create or replace function public.ensure_audit_log_partitions(p_months integer default 12)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start date;
  v_end date;
  v_name text;
  v_created integer := 0;
  i integer;
  v_attempt integer;
  v_missing boolean;
begin
  if p_months < 0 or p_months > 120 then
    raise exception 'p_months must be between 0 and 120, got %', p_months
      using errcode = '22023';
  end if;

  -- (1) Serialize maintenance runs against each other (0062): waited for without a
  -- bound — queueing behind a peer run is serialization, not contention.
  perform set_config('lock_timeout', '0', true);
  perform pg_advisory_xact_lock(hashtext('ensure-audit-log-partitions'));

  -- (2) Bound any remaining DDL lock wait; transaction-local.
  perform set_config('lock_timeout', '5s', true);

  -- (3) Retried as a unit. Each attempt is a savepoint: a failed attempt releases
  -- every lock it took.
  for v_attempt in 1..10 loop
    begin
      v_created := 0;

      -- (a) Nothing to create: no table lock at all.
      select exists (
        select 1
        from generate_series(0, p_months) g(m)
        where to_regclass('public.' || quote_ident(
                'audit_logs_' || to_char(date_trunc('month', now()) + make_interval(months => g.m),
                                         'YYYY_MM'))) is null
      ) into v_missing;
      if not v_missing then
        return 0;
      end if;

      -- (b) Every lock the DDL needs from other sessions, without waiting: the tables
      -- audit_logs references first, the hot audit_logs parent last.
      lock table public.organizations, public.people in share row exclusive mode nowait;
      lock table only public.audit_logs in access exclusive mode nowait;

      -- (c) The DDL, unchanged.
      for i in 0..p_months loop
        v_start := (date_trunc('month', now()) + make_interval(months => i))::date;
        v_end := (v_start + interval '1 month')::date;
        v_name := 'audit_logs_' || to_char(v_start, 'YYYY_MM');

        if to_regclass('public.' || quote_ident(v_name)) is null then
          execute format(
            'create table public.%I partition of public.audit_logs for values from (%L) to (%L)',
            v_name, v_start, v_end);
          execute format('alter table public.%I enable row level security', v_name);
          execute format('alter table public.%I force row level security', v_name);
          execute format(
            'create policy %I on public.%I for all to app_owner using (true) with check (true)',
            v_name || '_owner_all', v_name);
          execute format('revoke all on public.%I from app_user, app_admin', v_name);
          v_created := v_created + 1;
        end if;
      end loop;

      return v_created;
    exception
      when deadlock_detected or lock_not_available then
        if v_attempt = 10 then
          raise;
        end if;
        perform pg_sleep(least(0.05 * v_attempt, 0.5));
    end;
  end loop;

  -- Unreachable: the loop either returns or re-raises.
  return v_created;
end;
$$;

--> statement-breakpoint

comment on function public.ensure_audit_log_partitions(integer) is
  'Creates any missing monthly partitions from the current month forward, each with RLS '
  'enabled and forced, an owner policy, and no privileges for the runtime roles. Idempotent. '
  'Returns how many it created. There is deliberately no DEFAULT partition. 0062: an advisory '
  'lock serializing maintenance runs, a transaction-local lock_timeout and a bounded retry. '
  '0075: takes no table lock when nothing is missing, and otherwise takes every lock the DDL '
  'needs up front with NOWAIT (organizations and people SHARE ROW EXCLUSIVE, then ONLY '
  'audit_logs ACCESS EXCLUSIVE), so it never waits while holding a lock an application '
  'transaction may need; a conflict rolls the attempt back and retries (10 attempts, backoff).';

--> statement-breakpoint

-- Not an application API (unchanged since 0011): owner-only. Re-asserted.
revoke all on function public.ensure_audit_log_partitions(integer) from public;

--> statement-breakpoint

do $$
declare
  v_problems text;
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  where p.proname = 'ensure_audit_log_partitions' and p.pronamespace = 'public'::regnamespace;

  select string_agg(problem, '; ') into v_problems
  from (
    select 'ensure_audit_log_partitions missing' as problem where v_def is null
    union all
    select 'not SECURITY DEFINER' from pg_proc p
     where p.proname = 'ensure_audit_log_partitions' and p.pronamespace = 'public'::regnamespace
       and not p.prosecdef
    union all
    select 'search_path is not pinned empty' from pg_proc p
     where p.proname = 'ensure_audit_log_partitions' and p.pronamespace = 'public'::regnamespace
       and not coalesce('search_path=""' = any (p.proconfig), false)
    union all
    select 'owned by ' || pg_get_userbyid(p.proowner) from pg_proc p
     where p.proname = 'ensure_audit_log_partitions' and p.pronamespace = 'public'::regnamespace
       and pg_get_userbyid(p.proowner) <> 'app_owner'
    union all
    select 'lost the 0062 advisory serialization' where v_def !~ 'pg_advisory_xact_lock'
    union all
    select 'does not take the referenced tables with NOWAIT'
     where v_def !~* 'lock table public\.organizations, public\.people in share row exclusive mode nowait'
    union all
    select 'does not take ONLY audit_logs with NOWAIT'
     where v_def !~* 'lock table only public\.audit_logs in access exclusive mode nowait'
    union all
    select 'executable by ' || r from unnest(array['app_user', 'app_auth', 'app_worker', 'app_admin']) r
     where to_regrole(r) is not null
       and has_function_privilege(r, 'public.ensure_audit_log_partitions(integer)', 'execute')
    union all
    select 'executable by PUBLIC'
     where exists (select 1 from information_schema.role_routine_grants
                   where routine_schema = 'public' and routine_name = 'ensure_audit_log_partitions'
                     and grantee = 'PUBLIC')
  ) checks;

  if v_problems is not null then
    raise exception '0075 audit partition lock order: %', v_problems;
  end if;
end;
$$;
