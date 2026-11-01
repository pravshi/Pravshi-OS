-- ═════════════════════════════════════════════════════════════════════════════════
-- PRAVSHI OS — 0078: audit history cannot be truncated (Phase 3, MT-L3)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- audit_logs, login_events and engagement_events are append-only: row triggers refuse every
-- UPDATE and DELETE (0006, 0011, 0018). TRUNCATE fires no row trigger, so it removed history
-- with nothing in the way. No runtime role holds TRUNCATE (roles.sql grants app_user select,
-- insert and update only), so the exposure is the owner role and anything run with it — an
-- operator's TRUNCATE, or a TRUNCATE … CASCADE on a table the history references.
--
-- Measured on PostgreSQL 18.6 before writing this: a statement-level TRUNCATE trigger on the
-- partitioned audit_logs parent is NOT cloned to its partitions, and a direct TRUNCATE of one
-- partition succeeds past it. So the guard is created on the parent, on every existing
-- partition, and — by ensure_audit_log_partitions() from here on — on every new partition.
-- TRUNCATE … CASCADE reaching the history (e.g. from organizations) is refused as a whole.
--
-- Additive. Nothing that runs today truncates these tables (no code, no maintenance, no
-- retention path does). Rollback: scripts/db/rollback/0078_audit_history_truncate_guard.down.sql.

set local lock_timeout = '5s';

create function public.audit_history_no_truncate() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only history and cannot be truncated', tg_table_name
    using errcode = '23514';
end;
$$;

comment on function public.audit_history_no_truncate() is
  'BEFORE TRUNCATE guard for append-only history (audit_logs and each partition, login_events, '
  'engagement_events) — MT-L3, 0078. Row triggers already refuse UPDATE and DELETE.';

revoke all on function public.audit_history_no_truncate() from public;

create trigger audit_history_no_truncate before truncate on public.audit_logs
  for each statement execute function public.audit_history_no_truncate();
create trigger audit_history_no_truncate before truncate on public.login_events
  for each statement execute function public.audit_history_no_truncate();
create trigger audit_history_no_truncate before truncate on public.engagement_events
  for each statement execute function public.audit_history_no_truncate();

-- Every partition that already exists.
do $$
declare
  p record;
begin
  for p in
    select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
     where i.inhparent = 'public.audit_logs'::regclass
  loop
    execute format(
      'create trigger audit_history_no_truncate before truncate on public.%I '
      'for each statement execute function public.audit_history_no_truncate()', p.relname);
  end loop;
end
$$;

-- Every partition created from here on: 0075's ensure_audit_log_partitions(), with one
-- statement added after each partition's revoke (marked 0078 below). Nothing else changes.
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

      -- 0078 self-repair begin (MT-L3). A history table or audit partition without its
      -- truncate guard — created outside this function (a fixture did) or with the guard
      -- dropped — gets it back here, on every maintenance run. Only that table is locked
      -- (SHARE ROW EXCLUSIVE, the lock CREATE TRIGGER needs, NOWAIT): a conflict rolls the
      -- attempt back and retries like everything below. With every table guarded this
      -- finds nothing and takes no lock, so the no-op path stays lock-free.
      for v_name in
        select c.relname
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and (c.relname in ('audit_logs', 'login_events', 'engagement_events')
                or c.oid in (select i.inhrelid from pg_inherits i
                              where i.inhparent = 'public.audit_logs'::regclass))
           and not exists (select 1 from pg_trigger g
                            where g.tgrelid = c.oid and g.tgname = 'audit_history_no_truncate')
      loop
        execute format('lock table only public.%I in share row exclusive mode nowait', v_name);
        execute format(
          'create trigger audit_history_no_truncate before truncate on public.%I '
          'for each statement execute function public.audit_history_no_truncate()', v_name);
      end loop;
      -- 0078 self-repair end

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
          -- 0078: no partition can be truncated directly (MT-L3).
          execute format(
            'create trigger audit_history_no_truncate before truncate on public.%I '
            'for each statement execute function public.audit_history_no_truncate()', v_name);
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

-- ── Verification: the migration fails rather than leave a gap ────────────────────

do $$
begin
  if exists (
    select 1 from (
      select 'public.audit_logs'::regclass as rel
      union all select 'public.login_events'::regclass
      union all select 'public.engagement_events'::regclass
      union all select i.inhrelid::regclass from pg_inherits i
       where i.inhparent = 'public.audit_logs'::regclass
    ) t
    where not exists (select 1 from pg_trigger g
                       where g.tgrelid = t.rel and g.tgname = 'audit_history_no_truncate'
                         and g.tgenabled = 'O')
  ) then
    raise exception '0078: an append-only history table or audit partition has no truncate guard';
  end if;
end
$$;
