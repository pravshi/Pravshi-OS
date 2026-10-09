-- PRAVSHI OS — Phase 12: harden audit-log partition maintenance against
-- concurrent writers (reliability carry-over from Phase 10, PR #68 round 5).
--
-- THE HAZARD. ensure_audit_log_partitions() (0011) performs partition DDL —
-- CREATE TABLE ... PARTITION OF plus ALTER / CREATE POLICY / REVOKE per new
-- partition — in the same database where write_audit_log() inserts are
-- landing continuously. In PR #68's CI round 5, a maintenance call
-- (ensure_audit_log_partitions(14) in tests/db/audit-logs.test.ts) was
-- chosen as the victim of a Postgres deadlock (40P01) against a parallel
-- audit writer and the suite failed; a re-run with zero changes passed.
-- A maintenance routine that can be deadlocked by ordinary write traffic
-- will eventually fail an operator's window extension — or worse, be
-- "fixed" by running it during a write freeze. The function must instead
-- absorb transient lock contention itself.
--
-- THE HARDENING (signature, privilege shape and idempotence unchanged):
--   1. pg_advisory_xact_lock(hashtext('ensure-audit-log-partitions')),
--      acquired FIRST, with lock waits explicitly unbounded for the
--      acquisition (set_config('lock_timeout', '0', true) clears any
--      inherited timeout): the scheduler-tick idiom from 0046. Concurrent
--      maintenance runs (an operator extending the window while a
--      scheduled run is in flight, or two CI suites) serialize instead of
--      racing the to_regclass check-then-create into a duplicate-table
--      error or a catalog lock cycle. The lock is transaction-scoped, so
--      a holder that dies mid-run releases it automatically. Writers
--      never take this lock: the hot insert path is untouched.
--      The ORDER is the fix CI round 1 of PR #70 proved necessary: this
--      acquisition originally sat AFTER the lock_timeout below was armed
--      and OUTSIDE the retry loop, so a caller queueing behind another
--      maintenance run for more than 5s failed with lock_not_available
--      (55P03) — the queue itself exhausted the call. Serialization waits
--      are not contention: a maintenance caller must be able to wait for
--      its turn for as long as the run ahead of it takes.
--   2. lock_timeout = 5s, transaction-local via set_config(..., true),
--      armed only AFTER the advisory lock is held, so it bounds the DDL
--      lock waits of step 3 and nothing else: a wait that would have
--      escalated into a deadlock cycle against a writer instead aborts
--      fast with lock_not_available (55P03), which step 3 absorbs. SET
--      LOCAL scoping means the caller's session settings never leak.
--   3. Bounded in-function retry: the DDL loop runs inside a
--      BEGIN...EXCEPTION block that retries on deadlock_detected (40P01)
--      and lock_not_available (55P03), up to 5 attempts with a short
--      linear backoff (pg_sleep 0.1s * attempt). Partition DDL is
--      transactional in Postgres, so a failed attempt rolls back cleanly
--      and the idempotent to_regclass check simply re-evaluates on the
--      next attempt (v_created is reset per attempt — plpgsql variables
--      are not transactional, the DDL is). After the 5th failure the
--      error propagates: sustained contention is a real operational
--      signal and must stay loud, not be retried forever.
--
-- CREATE OR REPLACE preserves the function's existing ACL (owner-only
-- EXECUTE from 0011); the revoke is re-asserted so the migration is
-- self-verifying from an empty database.

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
begin
  if p_months < 0 or p_months > 120 then
    raise exception 'p_months must be between 0 and 120, got %', p_months
      using errcode = '22023';
  end if;

  -- (1) Serialize maintenance runs against each other for the rest of
  -- this transaction. The acquisition must NOT be bounded by the DDL
  -- lock_timeout armed in step (2): clear any lock_timeout first (ours
  -- or inherited from the caller's session) so a caller can queue for
  -- its turn behind another maintenance run indefinitely. Queueing
  -- behind a peer run is serialization, not contention.
  perform set_config('lock_timeout', '0', true);
  perform pg_advisory_xact_lock(hashtext('ensure-audit-log-partitions'));

  -- (2) Bound every DDL lock wait from here on; transaction-local.
  perform set_config('lock_timeout', '5s', true);

  -- (3) The 0011 DDL loop, retried as a unit on transient lock conflicts.
  for v_attempt in 1..5 loop
    begin
      v_created := 0;

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
        if v_attempt = 5 then
          raise;
        end if;
        perform pg_sleep(0.1 * v_attempt);
    end;
  end loop;

  -- Unreachable: the loop either returns or re-raises. Present so the
  -- function body has a defined end if the retry bound is ever edited.
  return v_created;
end;
$$;

--> statement-breakpoint

comment on function public.ensure_audit_log_partitions(integer) is
  'Creates any missing monthly partitions from the current month forward, each with RLS '
  'enabled and forced, an owner policy, and no privileges for the runtime roles. Idempotent. '
  'Returns how many it created. There is deliberately no DEFAULT partition. Hardened in '
  '0062: an advisory lock serializing maintenance runs (acquired with lock waits '
  'unbounded — queueing for a peer run is not contention), a transaction-local '
  'lock_timeout bounding only the DDL phase, and a bounded retry on '
  'deadlock/lock-timeout so concurrent audit writers cannot fail the call '
  '(Phase 10 PR #68 round-5 deadlock; ordering fixed after PR #70 CI round 1).';

--> statement-breakpoint

-- Not an application API (unchanged from 0011): granted to nobody; only its
-- owner can call it. CREATE OR REPLACE preserves the ACL — re-asserted here
-- so this migration verifies standalone from an empty database.
revoke all on function public.ensure_audit_log_partitions(integer) from public;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- Verification: fail the migration rather than leave a half-applied change
-- ═════════════════════════════════════════════════════════════════════════

do $$
declare
  v_problems text;
begin
  select string_agg(p, '; ') into v_problems
  from (values
    ('ensure_audit_log_partitions missing',
      exists (select 1 from pg_proc where proname = 'ensure_audit_log_partitions'
              and pronamespace = 'public'::regnamespace)),
    ('ensure_audit_log_partitions not security definer',
      exists (select 1 from pg_proc
              where proname = 'ensure_audit_log_partitions'
                and pronamespace = 'public'::regnamespace
                and prosecdef)),
    ('ensure_audit_log_partitions lost its deadlock hardening (0062)',
      pg_get_functiondef(
        (select oid from pg_proc
         where proname = 'ensure_audit_log_partitions'
           and pronamespace = 'public'::regnamespace)
      ) ~ 'pg_advisory_xact_lock'),
    ('ensure_audit_log_partitions executable by PUBLIC',
      not exists (select 1 from information_schema.role_routine_grants
                  where routine_schema = 'public'
                    and routine_name = 'ensure_audit_log_partitions'
                    and grantee = 'PUBLIC'))
  ) as checks(p, ok)
  where not ok;

  if v_problems is not null then
    raise exception 'audit partition maintenance hardening broken: %', v_problems;
  end if;
end;
$$;
