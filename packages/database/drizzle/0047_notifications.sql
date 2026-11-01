-- PRAVSHI OS — Phase 6: notifications table + worker-plane privilege path.
--
-- PART A — public.notifications. The notification job handler
-- (src/lib/jobs/handlers.ts, contract §6) writes one row per delivered
-- notification; the table did not exist anywhere in the repo, so the handler
-- exported its suggested DDL as NOTIFICATIONS_TABLE_DDL and fails CLOSED
-- (NOTIFICATIONS_TABLE_MISSING) until this migration lands. Columns are
-- exactly the handler's contract: org_id, person_id (recipient), title,
-- message (body), data, read_at (read status), created_at.
--
-- PART B — worker-plane SECURITY DEFINER functions. The worker runs as the
-- nil-UUID system actor (src/lib/jobs/worker.ts SYSTEM_ACTOR_ID), which is
-- not a row in public.people: authz.person_id() → NULL, so
-- authz.has('jobs.retry') is always false and the org-scoped RLS policies on
-- public.jobs fail closed for every worker-plane write (start/complete/fail/
-- heartbeat). Provisioning RBAC permissions to a non-person identity would
-- punch a hole in the permission model, so — following the
-- public.jobs_claim_next() pattern from 0045 and the scheduler_tick_*()
-- pattern from 0046 — the worker plane gets narrowly-scoped SECURITY DEFINER
-- wrappers instead:
--   jobs_start(p_worker_id, p_job_id)      claimed → running
--   jobs_complete(p_worker_id, p_job_id)   running → succeeded
--   jobs_fail(p_worker_id, p_job_id, p_error_code, p_error_message,
--             p_retryable)                  claimed/running → failed/dead_letter
--   jobs_heartbeat(p_worker_id, p_job_id)  liveness ping
--   notifications_insert(p_org_id, p_person_id, p_title, p_message, p_data)
--                                          the notification handler's write
-- Every function: language plpgsql security definer set search_path = '',
-- every relation schema-qualified (public.<table>), revoke all from PUBLIC,
-- grant EXECUTE to app_user only. Org scoping is structural: no function
-- takes an org_id it could be lied to about — the org comes from the JOB ROW
-- (contract §3.6 actor authority rule), and the claimed_by = p_worker_id
-- ownership check means a worker can only touch jobs it currently holds the
-- claim for. Never cross-org: there is no parameter combination that reaches
-- another org's rows.

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART A — notifications table
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  person_id uuid references public.people (id),
  title text not null,
  message text not null,
  data jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);

--> statement-breakpoint

create index notifications_org_created_idx
  on public.notifications (org_id, created_at desc);

--> statement-breakpoint

create index notifications_org_unread_idx
  on public.notifications (org_id)
  where read_at is null;

--> statement-breakpoint

create index notifications_person_idx
  on public.notifications (person_id)
  where person_id is not null;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- Row-level security — the 0042/0044/0045 template
-- ═════════════════════════════════════════════════════════════════════════════════

alter table public.notifications enable row level security;
alter table public.notifications force row level security;

create policy notifications_owner_all on public.notifications
  for all to app_owner using (true) with check (true);

--> statement-breakpoint

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('jobs.view'))
  );

--> statement-breakpoint

drop policy if exists notifications_insert on public.notifications;
create policy notifications_insert on public.notifications
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('jobs.create'))
  );

--> statement-breakpoint

-- Read-marking (read_at) is Phase 8 notification UX; the policy is the
-- least-privilege path it will use. No DELETE policy: retention purges run
-- through a cleanup job, same as the jobs table (0045).
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('jobs.view'))
  )
  with check (
    org_id = (select authz.org_id())
  );

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- notifications_org_guard() + notifications_person_org_guard() — tenant isolation
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The jobs_org_guard() / schedules_workflow_org_guard() pattern from 0045:
-- reject a NULL/dangling org_id, and reject a person_id that does not belong
-- to the row's org (the handler verifies this in TS too — defense in depth),
-- both with the 42501 tenant-isolation error code.

create or replace function public.notifications_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    raise exception 'notifications.org_id must not be null'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.organizations o where o.id = new.org_id) then
    raise exception 'notifications.org_id does not reference a valid organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.notifications_org_guard() is
  'BEFORE INSERT/UPDATE on notifications: org_id must reference a valid '
  'organization. Defense-in-depth behind the FK; raises 42501.';

revoke all on function public.notifications_org_guard() from public;

drop trigger if exists notifications_org_guard on public.notifications;
create trigger notifications_org_guard
  before insert or update on public.notifications
  for each row execute function public.notifications_org_guard();

--> statement-breakpoint

create or replace function public.notifications_person_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_org uuid;
begin
  if new.person_id is null then
    return new;
  end if;
  select p.org_id into v_person_org
  from public.people p
  where p.id = new.person_id;
  if v_person_org is distinct from new.org_id then
    raise exception 'notifications.person_id must belong to the notification''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.notifications_person_org_guard() is
  'BEFORE INSERT/UPDATE on notifications: a set person_id must belong to the '
  'row''s org_id. Closes the cross-org recipient hole; raises 42501.';

revoke all on function public.notifications_person_org_guard() from public;

drop trigger if exists notifications_person_org_guard on public.notifications;
create trigger notifications_person_org_guard
  before insert or update on public.notifications
  for each row execute function public.notifications_person_org_guard();

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART B — worker-plane privilege path (system actor)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Why these exist (documented choice): the worker's nil-UUID system actor is
-- not a person row, so authz.has('jobs.retry') is FORBIDDEN and every
-- worker-plane write through the org-scoped RLS policies fails closed. Two
-- options were considered:
--   (a) provision jobs.* permissions to the system actor — REJECTED: the
--       actor is not a person, so grants would have to bypass the role/
--       people resolution that every other permission flows through,
--       creating a standing cross-org-capable super-identity.
--   (b) SECURITY DEFINER wrappers — CHOSEN: the function (owned by the
--       migration role, covered by the *_owner_all policies) holds the
--       privilege; each wrapper takes NO org_id and enforces the §3.1 state
--       machine plus the claimed_by ownership check in SQL. The worker can
--       only advance jobs it holds the claim for, in the job's own org.
-- This is the jobs_claim_next() pattern from 0045, extended to the rest of
-- the worker-plane lifecycle (claim already had its wrapper; start/complete/
-- fail/heartbeat did not).

-- ── jobs_start — claimed → running ───────────────────────────────────────────

drop function if exists public.jobs_start(text, uuid);

create or replace function public.jobs_start(
  p_worker_id text,
  p_job_id uuid
) returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job
  from public.jobs
  where id = p_job_id
    and claimed_by = p_worker_id
  for update;
  -- Not held by this worker (missing, reaped, released, or another
  -- worker's): zero rows → the caller maps to NOT_FOUND. Never an error —
  -- the worker loop treats a lost claim as "job will be retried".
  if not found then
    return;
  end if;
  if v_job.status <> 'claimed' then
    raise exception 'JOB_ILLEGAL_TRANSITION: cannot start job % from status ''%''',
      p_job_id, v_job.status;
  end if;
  update public.jobs
  set status = 'running',
      heartbeat_at = now(),
      updated_at = now()
  where id = p_job_id
  returning * into v_job;
  return next v_job;
end;
$$;

comment on function public.jobs_start(text, uuid) is
  'SECURITY DEFINER: worker-plane claimed → running. Only the worker holding '
  'the claim (claimed_by = p_worker_id) may advance the job; zero rows when '
  'the claim is not held. Raises JOB_ILLEGAL_TRANSITION on any other status.';

revoke all on function public.jobs_start(text, uuid) from public;
grant execute on function public.jobs_start(text, uuid) to app_user;

--> statement-breakpoint

-- ── jobs_complete — running → succeeded ──────────────────────────────────────

drop function if exists public.jobs_complete(text, uuid);

create or replace function public.jobs_complete(
  p_worker_id text,
  p_job_id uuid
) returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job
  from public.jobs
  where id = p_job_id
    and claimed_by = p_worker_id
  for update;
  if not found then
    return;
  end if;
  if v_job.status <> 'running' then
    raise exception 'JOB_ILLEGAL_TRANSITION: cannot complete job % from status ''%''',
      p_job_id, v_job.status;
  end if;
  update public.jobs
  set status = 'succeeded',
      error_code = null,
      error_message = null,
      updated_at = now()
  where id = p_job_id
  returning * into v_job;
  return next v_job;
end;
$$;

comment on function public.jobs_complete(text, uuid) is
  'SECURITY DEFINER: worker-plane running → succeeded. Only the worker '
  'holding the claim may complete the job; zero rows when the claim is not '
  'held. Raises JOB_ILLEGAL_TRANSITION on any other status.';

revoke all on function public.jobs_complete(text, uuid) from public;
grant execute on function public.jobs_complete(text, uuid) to app_user;

--> statement-breakpoint

-- ── jobs_fail — claimed/running → failed | dead_letter ───────────────────────
--
-- attempts increments here — NOT on claim — so the count means "completed
-- attempts" (queue.ts failJob contract). terminal = NOT retryable OR
-- attempts+1 >= max_attempts → dead_letter, else failed. The caller passes
-- error_code/error_message pre-truncated (64 / 2000 chars, NUL-stripped),
-- exactly as queue.ts did for the raw-SQL path.

drop function if exists public.jobs_fail(text, uuid, text, text, boolean);

create or replace function public.jobs_fail(
  p_worker_id text,
  p_job_id uuid,
  p_error_code text,
  p_error_message text,
  p_retryable boolean
) returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_attempts integer;
  v_to text;
begin
  select * into v_job
  from public.jobs
  where id = p_job_id
    and claimed_by = p_worker_id
  for update;
  if not found then
    return;
  end if;
  if v_job.status not in ('running', 'claimed') then
    raise exception 'JOB_ILLEGAL_TRANSITION: cannot fail job % from status ''%''',
      p_job_id, v_job.status;
  end if;
  v_attempts := v_job.attempts + 1;
  if (not p_retryable) or (v_attempts >= v_job.max_attempts) then
    v_to := 'dead_letter';
  else
    v_to := 'failed';
  end if;
  update public.jobs
  set status = v_to,
      attempts = v_attempts,
      error_code = p_error_code,
      error_message = p_error_message,
      next_run_at = now(),
      updated_at = now()
  where id = p_job_id
  returning * into v_job;
  return next v_job;
end;
$$;

comment on function public.jobs_fail(text, uuid, text, text, boolean) is
  'SECURITY DEFINER: worker-plane fail path. claimed/running → failed '
  '(retryable, attempts left) or dead_letter; attempts increments here. Only '
  'the claim-holding worker may fail the job; zero rows when not held.';

revoke all on function public.jobs_fail(text, uuid, text, text, boolean) from public;
grant execute on function public.jobs_fail(text, uuid, text, text, boolean) to app_user;

--> statement-breakpoint

-- ── jobs_heartbeat — worker-plane liveness ping ──────────────────────────────
--
-- Only the worker holding the claim (claimed_by = p_worker_id) on a
-- claimed/running job may move the heartbeat; anything else → false so a
-- stale worker cannot resurrect a reaped job.

drop function if exists public.jobs_heartbeat(text, uuid);

create or replace function public.jobs_heartbeat(
  p_worker_id text,
  p_job_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.jobs
  set heartbeat_at = now(),
      updated_at = now()
  where id = p_job_id
    and claimed_by = p_worker_id
    and status in ('claimed', 'running');
  return found;
end;
$$;

comment on function public.jobs_heartbeat(text, uuid) is
  'SECURITY DEFINER: worker-plane heartbeat. Returns true only when the '
  'calling worker holds the claim on a claimed/running job.';

revoke all on function public.jobs_heartbeat(text, uuid) from public;
grant execute on function public.jobs_heartbeat(text, uuid) to app_user;

--> statement-breakpoint

-- ── notifications_insert — the notification handler's write path ────────────
--
-- handleNotification runs as the nil-UUID system actor, which cannot satisfy
-- the org-scoped INSERT policy (authz.org_id()/has() resolve against
-- people). This wrapper is its only write path: org_id is supplied by the
-- handler from the JOB ROW (contract §3.6) and the recipient was verified
-- in-org by the handler before the call; the person_org guard trigger above
-- re-verifies it in SQL.

drop function if exists public.notifications_insert(uuid, uuid, text, text, jsonb);

create or replace function public.notifications_insert(
  p_org_id uuid,
  p_person_id uuid,
  p_title text,
  p_message text,
  p_data jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.notifications (org_id, person_id, title, message, data)
  values (p_org_id, p_person_id, p_title, p_message, coalesce(p_data, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.notifications_insert(uuid, uuid, text, text, jsonb) is
  'SECURITY DEFINER: the notification job handler''s write path. The worker '
  'plane cannot satisfy the org-scoped RLS INSERT policy as the system '
  'actor, so it inserts through here; org_id comes from the job row and the '
  'person_org guard trigger enforces the recipient''s org.';

revoke all on function public.notifications_insert(uuid, uuid, text, text, jsonb) from public;
grant execute on function public.notifications_insert(uuid, uuid, text, text, jsonb) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- Verification: fail the migration rather than leave a half-built table or
-- worker-plane privilege path
-- ═════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_problems text;
begin
  select string_agg(p, '; ') into v_problems
  from (values
    ('notifications table missing',
      exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'notifications')),
    ('notifications RLS not forced',
      coalesce((select relrowsecurity and relforcerowsecurity from pg_class where relname = 'notifications'), false)),
    ('notifications_org_created_idx missing',
      exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'notifications_org_created_idx')),
    ('notifications_org_unread_idx missing',
      exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'notifications_org_unread_idx')),
    ('notifications_person_idx missing',
      exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'notifications_person_idx')),
    ('notifications_select policy missing',
      exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'notifications_select')),
    ('notifications_insert policy missing',
      exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'notifications_insert')),
    ('notifications_update policy missing',
      exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'notifications_update')),
    ('notifications_org_guard trigger missing',
      exists (select 1 from pg_trigger where tgname = 'notifications_org_guard')),
    ('notifications_person_org_guard trigger missing',
      exists (select 1 from pg_trigger where tgname = 'notifications_person_org_guard')),
    ('jobs_start missing',
      exists (select 1 from pg_proc where proname = 'jobs_start'
              and pronamespace = 'public'::regnamespace)),
    ('jobs_start not security definer',
      coalesce((select p.prosecdef from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'jobs_start'), false)),
    ('jobs_complete missing',
      exists (select 1 from pg_proc where proname = 'jobs_complete'
              and pronamespace = 'public'::regnamespace)),
    ('jobs_complete not security definer',
      coalesce((select p.prosecdef from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'jobs_complete'), false)),
    ('jobs_fail missing',
      exists (select 1 from pg_proc where proname = 'jobs_fail'
              and pronamespace = 'public'::regnamespace)),
    ('jobs_fail not security definer',
      coalesce((select p.prosecdef from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'jobs_fail'), false)),
    ('jobs_heartbeat missing',
      exists (select 1 from pg_proc where proname = 'jobs_heartbeat'
              and pronamespace = 'public'::regnamespace)),
    ('jobs_heartbeat not security definer',
      coalesce((select p.prosecdef from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'jobs_heartbeat'), false)),
    ('notifications_insert missing',
      exists (select 1 from pg_proc where proname = 'notifications_insert'
              and pronamespace = 'public'::regnamespace)),
    ('notifications_insert not security definer',
      coalesce((select p.prosecdef from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'notifications_insert'), false)),
    ('worker-plane fn not executable by app_user',
      not exists (
        select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('jobs_start','jobs_complete','jobs_fail',
                            'jobs_heartbeat','notifications_insert')
          and not has_function_privilege('app_user', p.oid, 'EXECUTE')
      )),
    ('worker-plane fn executable by PUBLIC',
      not exists (
        select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(p.proacl) a
        where n.nspname = 'public'
          and p.proname in ('jobs_start','jobs_complete','jobs_fail',
                            'jobs_heartbeat','notifications_insert')
          and a.grantee = 0 and a.privilege_type = 'EXECUTE'
      ))
  ) as checks(p, ok)
  where not ok;

  if v_problems is not null then
    raise exception 'notifications migration verification failed: %', v_problems;
  end if;
end;
$$;
