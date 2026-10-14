-- ═════════════════════════════════════════════════════════════════════════════
-- 0071_cleanup_job_worker_plane — the `cleanup` job runs on the worker plane
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE GAP. The `cleanup` job handler was the one worker path still running raw
-- SQL on the web application's role: it deleted and reset rows of public.jobs
-- through app_user (withAuthorizedDb) as the system actor. That could never
-- work without widening app_user — app_user holds no DELETE on jobs, and the
-- jobs policies admit only a live person holding jobs.* — so the job type
-- failed or silently did nothing, and the only way to "fix" it in place would
-- have been to give the web role the purge and lease-reset power itself.
--
-- THE BOUNDARY. One worker-plane definer, public.jobs_run_cleanup(job, worker),
-- executable by app_worker alone (0070's model):
--   * only the worker role may call it (authz.is_worker(): session_user);
--   * the job must be a `cleanup` job RUNNING under the caller's own claim;
--   * everything else — the organization, the target, the retention, dry run,
--     the lease threshold — is read from that job row and validated here,
--     never taken from the caller or from a session setting;
--   * it touches only that organization's jobs, never the cleanup job itself,
--     never a non-terminal job (stale_jobs), never a job that still has webhook
--     delivery evidence (platform retention removes those, 0065), and never a
--     lease fresher than the reaper's own 60 s threshold (expired_leases);
--   * at most 10000 rows per run, so one job cannot hold locks unbounded.
-- app_user gains nothing and keeps no path to this work.
--
--   PART 1  public.jobs_run_cleanup(uuid, text)
--   PART 2  verification
--
-- DEPLOYMENT ORDER (both fail closed, nothing is purged by the wrong role):
--   migration before the new worker: the old handler still runs on app_user,
--     which cannot purge or reset anything (as before this migration);
--   new worker before the migration: the function does not exist yet, the
--     cleanup job fails retryably and is retried or dead-lettered for replay.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — public.jobs_run_cleanup(job, worker)
-- ═════════════════════════════════════════════════════════════════════════════
create function public.jobs_run_cleanup(p_job_id uuid, p_worker_id text)
returns table (target text, dry_run boolean, affected integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_batch_limit constant integer := 10000;
  c_min_lease_ms constant numeric := 60000;          -- the worker reaper's threshold
  c_max_lease_ms constant numeric := 30::numeric * 86400000;  -- 30 days
  v_type text;
  v_status text;
  v_org uuid;
  v_payload jsonb;
  v_claimed_by text;
  v_target text;
  v_days numeric := 90;
  v_dry_run boolean := false;
  v_lease_ms numeric := 300000;
  v_n integer;
begin
  if not (select authz.is_worker()) then
    raise exception 'jobs_run_cleanup is worker-plane only'
      using errcode = '42501';
  end if;

  -- The job row is the authority: type, status and claim first.
  select j.type, j.status, j.org_id, j.payload, j.claimed_by
    into v_type, v_status, v_org, v_payload, v_claimed_by
  from public.jobs j
  where j.id = p_job_id;

  if not found then
    raise exception 'jobs_run_cleanup: job % not found', p_job_id
      using errcode = '22023';
  end if;
  if v_type <> 'cleanup' then
    raise exception 'jobs_run_cleanup: job % has type %, not cleanup', p_job_id, v_type
      using errcode = '22023';
  end if;
  if v_status <> 'running' then
    raise exception 'jobs_run_cleanup: job % is %, not running (not held by a worker)',
      p_job_id, v_status
      using errcode = '22023';
  end if;
  if p_worker_id is null or v_claimed_by is distinct from p_worker_id then
    raise exception 'jobs_run_cleanup: job % is not held by this worker', p_job_id
      using errcode = '42501';
  end if;

  -- The work is what the held job says, validated here (the handler's own
  -- validation mirrors these rules; this is the one that cannot be skipped).
  if jsonb_typeof(v_payload) is distinct from 'object' then
    raise exception 'jobs_run_cleanup: job % payload is not an object', p_job_id
      using errcode = '22023';
  end if;

  v_target := v_payload ->> 'target';
  if v_target is null or v_target not in ('stale_jobs', 'expired_leases') then
    raise exception 'jobs_run_cleanup: unknown cleanup target %', coalesce(v_target, '(none)')
      using errcode = '22023';
  end if;

  -- Each value's type is checked before it is cast, in separate steps: SQL does
  -- not promise to evaluate an OR left to right.
  if v_payload ? 'olderThanDays' then
    if jsonb_typeof(v_payload -> 'olderThanDays') <> 'number' then
      raise exception 'jobs_run_cleanup: olderThanDays must be an integer between 1 and 3650'
        using errcode = '22023';
    end if;
    v_days := (v_payload ->> 'olderThanDays')::numeric;
    if v_days not between 1 and 3650 or v_days <> trunc(v_days) then
      raise exception 'jobs_run_cleanup: olderThanDays must be an integer between 1 and 3650'
        using errcode = '22023';
    end if;
  end if;

  if v_payload ? 'dryRun' then
    if jsonb_typeof(v_payload -> 'dryRun') <> 'boolean' then
      raise exception 'jobs_run_cleanup: dryRun must be a boolean'
        using errcode = '22023';
    end if;
    v_dry_run := (v_payload ->> 'dryRun')::boolean;
  end if;

  if v_payload ? 'params' then
    if jsonb_typeof(v_payload -> 'params') <> 'object' then
      raise exception 'jobs_run_cleanup: params must be an object'
        using errcode = '22023';
    end if;
    if v_payload -> 'params' ? 'staleThresholdMs' then
      if jsonb_typeof(v_payload -> 'params' -> 'staleThresholdMs') <> 'number' then
        raise exception 'jobs_run_cleanup: params.staleThresholdMs must be between % and % ms',
          c_min_lease_ms, c_max_lease_ms
          using errcode = '22023';
      end if;
      v_lease_ms := trunc((v_payload -> 'params' ->> 'staleThresholdMs')::numeric);
      if v_lease_ms not between c_min_lease_ms and c_max_lease_ms then
        raise exception 'jobs_run_cleanup: params.staleThresholdMs must be between % and % ms',
          c_min_lease_ms, c_max_lease_ms
          using errcode = '22023';
      end if;
    end if;
  end if;

  if v_target = 'stale_jobs' then
    -- Terminal jobs only (succeeded / cancelled — never failed or dead_letter,
    -- the human review queue), of this organization, past the retention, and
    -- without webhook delivery evidence (those leave with platform retention).
    if v_dry_run then
      select count(*)::integer into v_n
      from public.jobs j2
      where j2.org_id = v_org
        and j2.id <> p_job_id
        and j2.status in ('succeeded', 'cancelled')
        and j2.created_at < now() - make_interval(days => v_days::integer)
        and not exists (
          select 1 from public.integration_webhook_deliveries d where d.job_id = j2.id);
    else
      delete from public.jobs j
      where j.ctid = any (array(
        select j2.ctid
        from public.jobs j2
        where j2.org_id = v_org
          and j2.id <> p_job_id
          and j2.status in ('succeeded', 'cancelled')
          and j2.created_at < now() - make_interval(days => v_days::integer)
          and not exists (
            select 1 from public.integration_webhook_deliveries d where d.job_id = j2.id)
        limit c_batch_limit));
      get diagnostics v_n = row_count;
    end if;
  else
    -- Claimed / running jobs of this organization whose heartbeat (or claim,
    -- when none yet) is older than the threshold go back to pending.
    if v_dry_run then
      select count(*)::integer into v_n
      from public.jobs j2
      where j2.org_id = v_org
        and j2.id <> p_job_id
        and j2.status in ('claimed', 'running')
        and coalesce(j2.heartbeat_at, j2.claimed_at)
              < now() - make_interval(secs => v_lease_ms / 1000);
    else
      update public.jobs j
      set status = 'pending',
          attempts = j.attempts + 1,
          claimed_by = null,
          claimed_at = null,
          heartbeat_at = null,
          error_code = 'LEASE_EXPIRED',
          error_message = 'lease expired: no heartbeat; reset to pending by cleanup job',
          updated_at = now()
      where j.ctid = any (array(
        select j2.ctid
        from public.jobs j2
        where j2.org_id = v_org
          and j2.id <> p_job_id
          and j2.status in ('claimed', 'running')
          and coalesce(j2.heartbeat_at, j2.claimed_at)
                < now() - make_interval(secs => v_lease_ms / 1000)
        limit c_batch_limit));
      get diagnostics v_n = row_count;
    end if;
  end if;

  target := v_target;
  dry_run := v_dry_run;
  affected := v_n;
  return next;
end;
$$;

comment on function public.jobs_run_cleanup(uuid, text) is
  'Worker-plane only (app_worker): runs the cleanup a `cleanup` job the calling worker holds '
  '(running, claimed_by = p_worker_id) describes, inside that job''s organization; the target, '
  'retention, dry run and lease threshold are read from the job row and validated (0071).';

revoke all on function public.jobs_run_cleanup(uuid, text) from public;
grant execute on function public.jobs_run_cleanup(uuid, text) to app_worker;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — verification
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_problems text;
  v_sig constant text := 'public.jobs_run_cleanup(uuid,text)';
begin
  select string_agg(problem, '; ') into v_problems
  from (
    select v_sig || ' is missing' as problem
    where to_regprocedure(v_sig) is null
    union all
    select v_sig || ' is executable by ' || r
    from unnest(array['app_user', 'app_admin']) r
    where to_regprocedure(v_sig) is not null
      and has_function_privilege(r, v_sig, 'execute')
    union all
    select v_sig || ' is executable by PUBLIC'
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid = to_regprocedure(v_sig)
      and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    union all
    select v_sig || ' is not executable by app_worker'
    where to_regprocedure(v_sig) is not null
      and not has_function_privilege('app_worker', v_sig, 'execute')
    union all
    select v_sig || ' is not a SECURITY DEFINER with an empty search_path, or not owned by app_owner'
    from pg_proc p
    where p.oid = to_regprocedure(v_sig)
      and (not p.prosecdef
           or not (coalesce(p.proconfig, '{}') @> array['search_path=""'])
           or pg_get_userbyid(p.proowner) <> 'app_owner')
    union all
    select v_sig || ' does not bind to the worker role, the job type and the claim'
    from pg_proc p
    where p.oid = to_regprocedure(v_sig)
      and (strpos(p.prosrc, 'if not (select authz.is_worker()) then') = 0
           or strpos(p.prosrc, 'v_type <> ''cleanup''') = 0
           or strpos(p.prosrc, 'v_status <> ''running''') = 0
           or strpos(p.prosrc, 'v_claimed_by is distinct from p_worker_id') = 0
           or strpos(p.prosrc, 'current_setting(') > 0)
    union all
    select 'app_worker holds ' || priv || ' on ' || c.oid::regclass::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace,
         unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) priv
    where n.nspname in ('public', 'authz', 'auth')
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_table_privilege('app_worker', c.oid, priv)
    union all
    select 'app_user holds DELETE on public.jobs'
    where has_table_privilege('app_user', 'public.jobs', 'delete')
  ) problems;

  if v_problems is not null then
    raise exception '0071 cleanup worker-plane boundary incomplete: %', v_problems;
  end if;
end;
$$;
