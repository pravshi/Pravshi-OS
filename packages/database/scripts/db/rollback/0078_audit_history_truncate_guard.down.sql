-- Rollback for 0078_audit_history_truncate_guard — restores the 0077 state.
--
-- Prepared in advance, as for 0073, 0075 and 0077: never invented at incident time. Run as the
-- migration owner (app_owner), in one transaction, only with the founder's approval for the
-- named database. It does NOT remove 0078's row from drizzle.__drizzle_migrations.
--
-- What this re-opens (MT-L3): audit_logs, its partitions, login_events and engagement_events
-- can be truncated again by the owner role, and a TRUNCATE … CASCADE can reach them.

begin;

set local lock_timeout = '5s';

-- 0075's ensure_audit_log_partitions(), verbatim.
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

do $$
declare
  t record;
begin
  for t in
    select g.tgrelid::regclass as rel from pg_trigger g
     where g.tgname = 'audit_history_no_truncate'
  loop
    execute format('drop trigger audit_history_no_truncate on %s', t.rel);
  end loop;
end
$$;

drop function if exists public.audit_history_no_truncate();

commit;
