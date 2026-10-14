-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK of 0075_audit_partition_lock_order — RESTORES THE 0062 LOCK ORDER
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Restores public.ensure_audit_log_partitions() exactly as migration 0062 defined it
-- (the body below is 0062's, verbatim). Use only if 0075's maintenance itself
-- misbehaves — for example, if under sustained load its NOWAIT acquisition keeps
-- exhausting its retries and the partition window shrinks (the worker logs
-- "audit partition maintenance failed" with sqlstate 55P03 and, later, "audit
-- partition window ends soon"). It brings back the defect 0075 fixes: maintenance
-- waiting while holding audit_logs, deadlocking or stalling audited writes while a
-- partition is being created.
--
-- It does not touch the drizzle journal: 0075 stays recorded as applied, so the
-- runner will not re-apply it. Re-applying 0075 is a deliberate operator step (re-run
-- its statements). Run as the branch owner, in one transaction:
--   psql "$DATABASE_URL_MIGRATE" -v ON_ERROR_STOP=1 -1 -f scripts/db/rollback/0075_audit_partition_lock_order.down.sql
-- Never against production without the founder's explicit approval for this step.
-- ═════════════════════════════════════════════════════════════════════════════

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

revoke all on function public.ensure_audit_log_partitions(integer) from public;
