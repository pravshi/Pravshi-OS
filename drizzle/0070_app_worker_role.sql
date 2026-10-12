-- ═════════════════════════════════════════════════════════════════════════════
-- 0070_app_worker_role — the background worker gets its own database role
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE GAP. The worker connected as app_user, the same role the web app uses,
-- and every worker-plane function was therefore executable by app_user. Anyone
-- able to run SQL as app_user — with no identity at all — could claim any
-- organization's job (payload included), complete, fail, release or reap jobs,
-- sweep retries, fire schedules, consume reminders, run retention and
-- partition maintenance, read a held job's protected email body, obtain the
-- execution principal of any running workflow job, and — by setting the
-- transaction-local app.org_id themselves — satisfy the "person-less" branch
-- of the notification and webhook-secret functions for any organization.
-- (Demonstrated in the WP-T2 review; design:
-- audit-output/2026-10-12-worker-role-package-design.md.)
--
-- THE BOUNDARY. A dedicated login role, app_worker, created by
-- scripts/db/roles.sql (the branch owner creates roles; app_owner cannot).
-- The worker is recognised by the role its connection AUTHENTICATED as —
-- session_user, which app_user cannot change (SET SESSION AUTHORIZATION needs
-- superuser; SET ROLE needs membership, asserted absent) — never by a setting
-- the caller can write.
--
--   PART 1  preconditions: app_worker exists, holds no dangerous attribute, and
--           shares no membership with any application role
--   PART 2  authz.is_worker() — session_user = 'app_worker'
--   PART 3  worker-only functions: EXECUTE moves from app_user to app_worker
--   PART 4  workflow_execute_as_job(job, worker_id) — the job must be running
--           under THIS worker's claim (the old 1-argument form is dropped)
--   PART 5  shared functions: the person-less branch (notifications_insert,
--           notifications_recipient_exists, notification_channel_enabled,
--           integration_webhook_resolve_delivery) requires the worker role AND
--           takes its organization (and, for a reminder, its recipient) from
--           the work item the worker holds — authz.worker_bound_scope() — never
--           from app.org_id; app_user keeps EXECUTE for the person branch web
--           requests use
--   PART 6  verification
--
-- app_worker gets NO table, sequence or schema-object privilege and no RLS
-- policy: it reaches data only through these definers. It cannot become a
-- person: workflow actions run as their real principal on the app_user
-- connection (resolved by PART 4), exactly as before.
--
-- DEPLOYMENT ORDER (both fail closed, nothing is lost):
--   migration before the new worker: the old worker (app_user) is refused
--     every claim (42501) and queued work waits;
--   new worker before the migration: app_worker exists but holds no EXECUTE
--     yet, so its claims are refused and queued work waits.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — preconditions
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_bad text;
begin
  if not exists (select 1 from pg_roles where rolname = 'app_worker') then
    raise exception 'role app_worker does not exist: run scripts/db/roles.sql as the branch owner first (it creates the role), set its password, then re-run the migrations';
  end if;

  select string_agg(rolname, ', ') into v_bad
  from pg_roles
  where rolname = 'app_worker'
    and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or not rolcanlogin);
  if v_bad is not null then
    raise exception 'app_worker must be a plain login role (no SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB)';
  end if;

  select string_agg(m.rolname || ' -> ' || r.rolname, ', ') into v_bad
  from pg_auth_members am
  join pg_roles m on m.oid = am.member
  join pg_roles r on r.oid = am.roleid
  where (m.rolname = 'app_worker' and r.rolname like 'app\_%')
     or (r.rolname = 'app_worker');
  if v_bad is not null then
    raise exception 'app_worker must share no role membership: %', v_bad;
  end if;
end;
$$;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — authz.is_worker()
-- ═════════════════════════════════════════════════════════════════════════════
-- session_user is the role the connection authenticated as. Inside a SECURITY
-- DEFINER function current_user is the owner, but session_user is unchanged,
-- so the definers below can ask it. Exact equality on purpose: no membership
-- test, so no future grant can widen it.
create function authz.is_worker()
returns boolean
language sql
stable
set search_path = ''
as $$
  select session_user = 'app_worker'::name
$$;

comment on function authz.is_worker() is
  'True only on a connection that authenticated as app_worker (session_user). Gates the '
  'worker-plane branches of shared definers (0070).';

revoke all on function authz.is_worker() from public;
grant execute on function authz.is_worker() to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — worker-only functions belong to app_worker
-- ═════════════════════════════════════════════════════════════════════════════
grant usage on schema public to app_worker;

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.jobs_claim_next(text,text[])',
    'public.jobs_start(text,uuid)',
    'public.jobs_complete(text,uuid)',
    'public.jobs_fail(text,uuid,text,text,boolean)',
    'public.jobs_heartbeat(text,uuid)',
    'public.jobs_release_claim(uuid,text)',
    'public.jobs_apply_backoff(uuid,timestamptz)',
    'public.jobs_reap_stale(integer)',
    'public.jobs_sweep_retryable(integer)',
    'public.worker_next_due_at()',
    'public.claim_due_task_reminders(integer)',
    'public.scheduler_tick_claim(timestamptz)',
    'public.scheduler_tick_fire(uuid,timestamptz,timestamptz,text,text)',
    'public.maintain_audit_log_partitions()',
    'public.run_data_retention(integer)',
    'public.job_email_content_for_worker(uuid,text)',
    'public.integration_webhook_resolve_delivery(uuid,uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, app_user', v_sig);
    execute format('grant execute on function %s to app_worker', v_sig);
  end loop;
end;
$$;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — workflow_execute_as_job(job, worker_id)
-- ═════════════════════════════════════════════════════════════════════════════
-- Before: any caller could obtain the (org, person) execution principal of any
-- running workflow job. Now the job must be running under the caller's own
-- claim, and only the worker role can ask. Body otherwise verbatim (0048).
drop function public.workflow_execute_as_job(uuid);

create function public.workflow_execute_as_job(p_job_id uuid, p_worker_id text)
returns table (org_id uuid, person_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_type text;
  v_job_status text;
  v_job_org uuid;
  v_job_payload jsonb;
  v_job_claimed_by text;
  v_principal uuid;
  v_schedule_id uuid;
  v_schedule_org uuid;
  v_schedule_creator uuid;
begin
  if not (select authz.is_worker()) then
    raise exception 'workflow_execute_as_job is worker-plane only'
      using errcode = '42501';
  end if;

  -- The job row is the authority: lock it, then verify type + status + claim.
  select j.type, j.status, j.org_id, j.payload, j.enqueued_by, j.claimed_by
    into v_job_type, v_job_status, v_job_org, v_job_payload, v_principal, v_job_claimed_by
  from public.jobs j
  where j.id = p_job_id
  for update;

  if not found then
    raise exception 'workflow_execute_as_job: job % not found', p_job_id
      using errcode = '22023';
  end if;

  if v_job_type not in ('workflow_run', 'scheduled_trigger') then
    raise exception 'workflow_execute_as_job: job % has type %, not executable as a workflow',
      p_job_id, v_job_type
      using errcode = '22023';
  end if;

  if v_job_status <> 'running' then
    raise exception 'workflow_execute_as_job: job % is %, not running (not held by a worker)',
      p_job_id, v_job_status
      using errcode = '22023';
  end if;

  if p_worker_id is null or v_job_claimed_by is distinct from p_worker_id then
    raise exception 'workflow_execute_as_job: job % is not held by this worker', p_job_id
      using errcode = '42501';
  end if;

  -- Resolve the execution principal from the job row.
  if v_job_type = 'scheduled_trigger' then
    -- The scheduler enqueues without an identity; the schedule owner is the
    -- authorizing principal (cron runs as the crontab owner).
    begin
      v_schedule_id := (v_job_payload ->> 'scheduleId')::uuid;
    exception when invalid_text_representation then
      v_schedule_id := null;
    end;
    if v_schedule_id is null then
      raise exception 'workflow_execute_as_job: job % payload has no usable scheduleId',
        p_job_id
        using errcode = '22023';
    end if;
    select s.org_id, s.created_by
      into v_schedule_org, v_schedule_creator
    from public.schedules s
    where s.id = v_schedule_id;
    if not found then
      raise exception 'workflow_execute_as_job: schedule % not found for job %',
        v_schedule_id, p_job_id
        using errcode = '22023';
    end if;
    if v_schedule_org is distinct from v_job_org then
      raise exception 'workflow_execute_as_job: schedule % belongs to a different org than job %',
        v_schedule_id, p_job_id
        using errcode = '42501';
    end if;
    v_principal := v_schedule_creator;
  end if;

  -- The principal must be a live person of the job's org: exists, not
  -- soft-deleted, ACTIVE, with a live engagement in an ACTIVE org. (The
  -- engine re-checks authz.is_active() on every call; this makes the
  -- boundary explicit and fails fast.)
  if v_principal is null then
    raise exception 'workflow_execute_as_job: job % has no execution principal', p_job_id
      using errcode = '42501';
  end if;

  perform 1
  from public.people p
  join public.engagements e
    on e.person_id = p.id
   and e.org_id = p.org_id
   and e.status = 'ACTIVE'
   and e.deleted_at is null
  join public.organizations o
    on o.id = p.org_id
   and o.status = 'ACTIVE'
   and o.deleted_at is null
  where p.id = v_principal
    and p.org_id = v_job_org
    and p.deleted_at is null
    and p.person_status = 'ACTIVE';

  if not found then
    raise exception 'workflow_execute_as_job: no live principal % in org % for job %',
      v_principal, v_job_org, p_job_id
      using errcode = '42501';
  end if;

  org_id := v_job_org;
  person_id := v_principal;
  return next;
end;
$$;

comment on function public.workflow_execute_as_job(uuid, text) is
  'Worker-plane only (app_worker): the verified execution principal of a workflow job the '
  'calling worker holds (running, claimed_by = p_worker_id). 0048, bound to the claim in 0070.';

revoke all on function public.workflow_execute_as_job(uuid, text) from public;
grant execute on function public.workflow_execute_as_job(uuid, text) to app_worker;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 5 — shared functions: the person-less branch is the worker's alone
-- ═════════════════════════════════════════════════════════════════════════════
-- Web requests call these with a person context (unchanged). The person-less
-- branch trusted the caller-set app.org_id. It now requires the worker role,
-- and its organization comes from the work item the worker HOLDS — a database
-- row — never from a setting: the worker names the item (app.work_kind,
-- app.work_id, app.worker_id; untrusted selectors) and the row decides.
--   job       running, claimed_by = app.worker_id   -> the job's organization
--   reminder  claimed (is_sent)                     -> its organization AND person
-- So a worker bug, or a forged app.org_id, cannot reach another tenant.
create function authz.worker_bound_scope()
returns table (org_id uuid, person_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind text := nullif(current_setting('app.work_kind', true), '');
  v_raw text := nullif(current_setting('app.work_id', true), '');
  v_worker text := nullif(current_setting('app.worker_id', true), '');
  v_id uuid;
begin
  if not (select authz.is_worker()) or v_raw is null then
    return;
  end if;
  begin
    v_id := v_raw::uuid;
  exception when invalid_text_representation then
    return;
  end;

  if v_kind = 'job' and v_worker is not null then
    return query
    select j.org_id, null::uuid
    from public.jobs j
    where j.id = v_id
      and j.status = 'running'
      and j.claimed_by = v_worker;
  elsif v_kind = 'reminder' then
    return query
    select r.org_id, r.person_id
    from public.task_reminders r
    where r.id = v_id
      and r.is_sent;
  end if;
end;
$$;

comment on function authz.worker_bound_scope() is
  'The organization (and, for a reminder, the recipient) a worker-plane call is bound to: '
  'derived from the job the worker holds (running, claimed_by = app.worker_id) or the reminder '
  'it claimed (is_sent). Empty for anyone but app_worker or for an unheld item (0070).';

revoke all on function authz.worker_bound_scope() from public;

create or replace function public.notifications_insert(
  p_org_id uuid,
  p_person_id uuid,
  p_title text,
  p_message text,
  p_data jsonb,
  p_type text default 'SYSTEM_ALERT'::text,
  p_event_id text default null::text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_bound_org uuid;
  v_bound_person uuid;
begin
  if (select authz.person_id()) is not null then
    if p_org_id is distinct from (select authz.org_id()) then
      raise exception 'org_id mismatch' using errcode = '42501';
    end if;
  elsif not (select authz.is_worker()) then
    raise exception 'org_id mismatch' using errcode = '42501';
  else
    select b.org_id, b.person_id into v_bound_org, v_bound_person
    from authz.worker_bound_scope() b;
    if v_bound_org is null
       or p_org_id is distinct from v_bound_org
       or (v_bound_person is not null and p_person_id is distinct from v_bound_person) then
      raise exception 'org_id mismatch' using errcode = '42501';
    end if;
  end if;

  insert into public.notifications (org_id, person_id, title, message, data, type, event_id)
  values (p_org_id, p_person_id, p_title, p_message, coalesce(p_data, '{}'::jsonb), p_type, p_event_id)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.notifications_recipient_exists(p_org_id uuid, p_person_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_bound_org uuid;
  v_bound_person uuid;
begin
  if (select authz.person_id()) is not null then
    if p_org_id is distinct from (select authz.org_id()) then
      raise exception 'org_id mismatch' using errcode = '42501';
    end if;
  elsif not (select authz.is_worker()) then
    raise exception 'org_id mismatch' using errcode = '42501';
  else
    select b.org_id, b.person_id into v_bound_org, v_bound_person
    from authz.worker_bound_scope() b;
    if v_bound_org is null
       or p_org_id is distinct from v_bound_org
       or (v_bound_person is not null and p_person_id is distinct from v_bound_person) then
      raise exception 'org_id mismatch' using errcode = '42501';
    end if;
  end if;

  return exists (
    select 1
    from public.people p
    where p.id = p_person_id
      and p.org_id = p_org_id
      and p.deleted_at is null
  );
end;
$$;

create or replace function public.notification_channel_enabled(
  p_org_id uuid,
  p_person_id uuid,
  p_event_type text,
  p_channel text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_bound_org uuid;
  v_bound_person uuid;
begin
  if (select authz.person_id()) is not null then
    if p_org_id is distinct from (select authz.org_id()) then
      raise exception 'org_id mismatch' using errcode = '42501';
    end if;
  elsif not (select authz.is_worker()) then
    raise exception 'org_id mismatch' using errcode = '42501';
  else
    select b.org_id, b.person_id into v_bound_org, v_bound_person
    from authz.worker_bound_scope() b;
    if v_bound_org is null
       or p_org_id is distinct from v_bound_org
       or (v_bound_person is not null and p_person_id is distinct from v_bound_person) then
      raise exception 'org_id mismatch' using errcode = '42501';
    end if;
  end if;

  return coalesce(
    (select np.enabled
       from public.notification_preferences np
      where np.org_id = p_org_id
        and np.person_id = p_person_id
        and np.event_type = p_event_type
        and np.channel = p_channel),
    (select np.enabled
       from public.notification_preferences np
      where np.org_id = p_org_id
        and np.person_id = p_person_id
        and np.event_type = '*'
        and np.channel = p_channel),
    true
  );
end;
$$;

create or replace function public.integration_webhook_resolve_delivery(
  p_org_id uuid,
  p_subscription_id uuid
)
returns table (is_active boolean, signing_secret_ciphertext text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_bound_org uuid;
  v_bound_person uuid;
begin
  if (select authz.person_id()) is not null then
    if p_org_id is distinct from (select authz.org_id()) then
      raise exception 'integration_webhook_resolve_delivery: organization mismatch'
        using errcode = '42501';
    end if;
  elsif not (select authz.is_worker()) then
    raise exception 'integration_webhook_resolve_delivery: organization mismatch'
      using errcode = '42501';
  else
    -- Only a held JOB resolves a secret (a reminder never does).
    select b.org_id, b.person_id into v_bound_org, v_bound_person
    from authz.worker_bound_scope() b;
    if v_bound_org is null
       or p_org_id is distinct from v_bound_org
       or v_bound_person is not null then
      raise exception 'integration_webhook_resolve_delivery: organization mismatch'
        using errcode = '42501';
    end if;
  end if;

  return query
  select s.active, s.signing_secret_ciphertext
  from public.integration_webhook_subscriptions s
  where s.org_id = p_org_id
    and s.id = p_subscription_id;
end;
$$;

grant execute on function public.notifications_insert(uuid, uuid, text, text, jsonb, text, text) to app_worker;
grant execute on function public.notifications_recipient_exists(uuid, uuid) to app_worker;
grant execute on function public.notification_channel_enabled(uuid, uuid, text, text) to app_worker;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 6 — verification
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_problems text;
begin
  with worker_only(sig) as (
    values
      ('public.jobs_claim_next(text,text[])'),
      ('public.jobs_start(text,uuid)'),
      ('public.jobs_complete(text,uuid)'),
      ('public.jobs_fail(text,uuid,text,text,boolean)'),
      ('public.jobs_heartbeat(text,uuid)'),
      ('public.jobs_release_claim(uuid,text)'),
      ('public.jobs_apply_backoff(uuid,timestamptz)'),
      ('public.jobs_reap_stale(integer)'),
      ('public.jobs_sweep_retryable(integer)'),
      ('public.worker_next_due_at()'),
      ('public.claim_due_task_reminders(integer)'),
      ('public.scheduler_tick_claim(timestamptz)'),
      ('public.scheduler_tick_fire(uuid,timestamptz,timestamptz,text,text)'),
      ('public.maintain_audit_log_partitions()'),
      ('public.run_data_retention(integer)'),
      ('public.job_email_content_for_worker(uuid,text)'),
      ('public.integration_webhook_resolve_delivery(uuid,uuid)'),
      ('public.workflow_execute_as_job(uuid,text)')
  ),
  shared(sig) as (
    values
      ('public.notifications_insert(uuid,uuid,text,text,jsonb,text,text)'),
      ('public.notifications_recipient_exists(uuid,uuid)'),
      ('public.notification_channel_enabled(uuid,uuid,text,text)')
  )
  select string_agg(problem, '; ') into v_problems
  from (
    select w.sig || ' is missing' as problem
    from worker_only w where to_regprocedure(w.sig) is null
    union all
    select w.sig || ' is executable by ' || r
    from worker_only w, unnest(array['app_user', 'app_admin']) r
    where to_regprocedure(w.sig) is not null
      and has_function_privilege(r, w.sig, 'execute')
    union all
    select w.sig || ' is not executable by app_worker'
    from worker_only w
    where to_regprocedure(w.sig) is not null
      and not has_function_privilege('app_worker', w.sig, 'execute')
    union all
    select s.sig || ' lost app_user (person branch) or lacks app_worker'
    from shared s
    where not has_function_privilege('app_user', s.sig, 'execute')
       or not has_function_privilege('app_worker', s.sig, 'execute')
    union all
    select x.sig || ' person-less branch is not gated on the worker role and its held work item'
    from (select sig from shared
          union all select 'public.integration_webhook_resolve_delivery(uuid,uuid)') x
    join pg_proc p on p.oid = to_regprocedure(x.sig)
    where strpos(p.prosrc, 'elsif not (select authz.is_worker()) then') = 0
       or strpos(p.prosrc, 'from authz.worker_bound_scope() b') = 0
       or strpos(p.prosrc, 'current_setting(''app.org_id''') > 0
    union all
    select 'authz.worker_bound_scope() is missing'
    where to_regprocedure('authz.worker_bound_scope()') is null
    union all
    select 'authz.worker_bound_scope() does not bind to the held job and the claimed reminder'
    from pg_proc p
    where p.oid = to_regprocedure('authz.worker_bound_scope()')
      and (not p.prosecdef
           or strpos(p.prosrc, 'j.claimed_by = v_worker') = 0
           or strpos(p.prosrc, 'r.is_sent') = 0
           or strpos(p.prosrc, 'authz.is_worker()') = 0)
    union all
    select 'workflow_execute_as_job does not bind to the claim'
    from pg_proc p
    where p.oid = to_regprocedure('public.workflow_execute_as_job(uuid,text)')
      and (strpos(p.prosrc, 'v_job_claimed_by is distinct from p_worker_id') = 0
           or strpos(p.prosrc, 'authz.is_worker()') = 0)
    union all
    select 'the unbound workflow_execute_as_job(uuid) still exists'
    where to_regprocedure('public.workflow_execute_as_job(uuid)') is not null
    union all
    select 'authz.is_worker() is not exactly session_user = app_worker'
    from pg_proc p
    where p.oid = 'authz.is_worker()'::regprocedure
      and (p.prosrc not like '%session_user = ''app_worker''::name%' or p.prosecdef)
    union all
    select 'app_worker holds ' || priv || ' on ' || c.oid::regclass::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace,
         unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) priv
    where n.nspname in ('public', 'authz', 'auth')
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_table_privilege('app_worker', c.oid, priv)
    union all
    select 'app_worker holds a sequence privilege on ' || c.oid::regclass::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'authz', 'auth') and c.relkind = 'S'
      and (has_sequence_privilege('app_worker', c.oid, 'usage')
           or has_sequence_privilege('app_worker', c.oid, 'select')
           or has_sequence_privilege('app_worker', c.oid, 'update'))
    union all
    select 'app_worker owns ' || c.oid::regclass::text
    from pg_class c where c.relowner = (select oid from pg_roles where rolname = 'app_worker')
    union all
    select 'a policy names app_worker: ' || tablename
    from pg_policies where 'app_worker' = any(roles)
  ) problems;

  if v_problems is not null then
    raise exception '0070 app_worker boundary incomplete: %', v_problems;
  end if;
end;
$$;
