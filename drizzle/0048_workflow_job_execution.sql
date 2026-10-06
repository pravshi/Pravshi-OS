-- PRAVSHI OS — Phase 6: workflow job execution identity (Phase 6 → Phase 5 bridge).
--
-- THE PROBLEM (P0): handleWorkflowRun (src/lib/jobs/workflow-jobs.ts) built a
-- `system:job:<id>` actor and called the Phase 5 engine with it. The system
-- actor is not a row in public.people, so authz.person_id() → NULL,
-- authz.org_id() → NULL, authz.has(_) → false and authz.is_active() → false.
-- Consequences: executeWorkflowManual's authz.has('workflows.execute') gate
-- raised FORBIDDEN, the manual workflow row was RLS-invisible (NOT_FOUND),
-- and even the 0044 SECURITY DEFINER record functions raised for that
-- identity ('inactive caller' / 'org_id mismatch'). The core Phase 6 →
-- Phase 5 integration could never execute end-to-end.
--
-- THE FIX (Option A — chosen over Option B, per "why not Option B" below):
-- the JOB is the authority. New SECURITY DEFINER
-- workflow_execute_as_job(p_job_id) verifies the job row — type IN
-- ('workflow_run','scheduled_trigger'), status = 'running' (reachable only
-- through the claimed_by-checked jobs_start(), so exactly one legitimate
-- worker holds the job) — and binds the EXISTING principal that authorized
-- the work: jobs.enqueued_by for 'workflow_run' (stamped at enqueue by the
-- jobs_enqueued_by_stamp trigger, from the enqueueing user's app.person_id),
-- schedules.created_by for 'scheduled_trigger' (the schedule owner, resolved
-- through the job payload's scheduleId with an org-equality check). It
-- returns the verified (org_id, person_id); the worker then drives the Phase 5
-- engine under that REAL person's Authorization. Every Phase 5 gate —
-- authz.has('workflows.execute'), the RLS policies, authz.is_active() —
-- evaluates against that person, live, at execution time. A suspension,
-- permission revocation, or org deactivation between enqueue and execution
-- fails closed. D2 holds: actions inherit exactly the authorizing principal's
-- permissions — the workflow can do no more than the user who scheduled it.
--
-- WHY NOT OPTION B (provision a per-org system actor with workflows.execute):
-- the worker identity would need STANDING permissions — not just
-- workflows.execute but every permission any workflow action might need
-- (deals.view/edit, work_tasks.create, …), an unbounded set — making the
-- worker a per-org super-user with ambient privilege. 0047 already rejected
-- provisioning permissions to the worker identity for the jobs plane for the
-- same reason. Option A grants the worker NOTHING ambient: it can only obtain
-- an execution identity by presenting a job it holds the claim for, and the
-- identity comes from the job row — never chosen by the worker. No RLS policy
-- is touched; no permission is granted; no cross-org access is possible (the
-- org comes from the job row, the person is verified to belong to it, and the
-- function takes no org_id, workflow_id, or person_id parameter).
--
-- Error codes: 22023 for job-row verification failures (not found, wrong
-- type, wrong status, dangling/malformed schedule ref) — the TS handler maps
-- these to non-retryable VALIDATION_ERROR, because retrying can never
-- succeed. 42501 for principal verification failures (no/inactive/wrong-org
-- principal, no live engagement, schedule org mismatch) — these flow to the
-- normal retry classifier (a re-activated user or re-granted role can succeed
-- on a later attempt).

-- ═════════════════════════════════════════════════════════════════════════════════
-- 1. Provenance: who authorized the job
-- ═════════════════════════════════════════════════════════════════════════════════

alter table public.jobs
  add column enqueued_by uuid;

comment on column public.jobs.enqueued_by is
  'The person whose authority the job executes under (Phase 6 → Phase 5 '
  'bridge, 0048). Stamped by jobs_enqueued_by_stamp() from app.person_id at '
  'enqueue time; NULL for system-enqueued jobs (e.g. scheduler_tick_fire, '
  'which runs without an identity). workflow_execute_as_job() resolves this '
  'to the execution principal for workflow_run jobs.';

--> statement-breakpoint

-- BEFORE INSERT trigger: stamp enqueued_by from the transaction identity.
-- Fail-OPEN at enqueue (a NULL stamp just means the job cannot resolve an
-- execution principal — workflow_execute_as_job fails closed at execution);
-- the enqueue path's own jobs.create gate already ran, so a bad stamp must
-- never break the insert. Never overwrites an explicit stamp.
create or replace function public.jobs_enqueued_by_stamp() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_setting text;
  v_person uuid;
begin
  if new.enqueued_by is not null then
    return new;
  end if;
  v_setting := nullif(current_setting('app.person_id', true), '');
  -- Guard the cast: worker-plane identities (e.g. 'system:job:…') are not
  -- UUIDs and must not raise 22P02 inside the trigger.
  if v_setting is null
     or v_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    return new;
  end if;
  select p.id into v_person
  from public.people p
  where p.id = v_setting::uuid
    and p.org_id = new.org_id
    and p.deleted_at is null
    and p.person_status = 'ACTIVE';
  if v_person is not null then
    new.enqueued_by := v_person;
  end if;
  return new;
end;
$$;

comment on function public.jobs_enqueued_by_stamp() is
  'BEFORE INSERT on jobs: stamps enqueued_by from app.person_id when it names '
  'an ACTIVE, non-deleted person of the job''s org. Fail-open (leaves NULL on '
  'any mismatch) — execution-time verification is workflow_execute_as_job().';

revoke all on function public.jobs_enqueued_by_stamp() from public;

drop trigger if exists jobs_enqueued_by_stamp on public.jobs;
create trigger jobs_enqueued_by_stamp
  before insert on public.jobs
  for each row execute function public.jobs_enqueued_by_stamp();

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- 2. The execution-identity bridge
-- ═════════════════════════════════════════════════════════════════════════════════

drop function if exists public.workflow_execute_as_job(uuid);

create or replace function public.workflow_execute_as_job(
  p_job_id uuid
) returns table (
  org_id uuid,
  person_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_type text;
  v_job_status text;
  v_job_org uuid;
  v_job_payload jsonb;
  v_principal uuid;
  v_schedule_id uuid;
  v_schedule_org uuid;
  v_schedule_creator uuid;
begin
  -- The job row is the authority: lock it, then verify type + status.
  -- status = 'running' is reachable only via jobs_start(p_worker_id, …),
  -- which enforces the claimed_by ownership check — so a 'running' job is
  -- held by exactly one legitimate worker. The function takes no org_id,
  -- workflow_id, or person_id parameter: everything comes from the row.
  select j.type, j.status, j.org_id, j.payload, j.enqueued_by
    into v_job_type, v_job_status, v_job_org, v_job_payload, v_principal
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

comment on function public.workflow_execute_as_job(uuid) is
  'Phase 6 → Phase 5 execution bridge (0048). Verifies the job row (type '
  'workflow_run/scheduled_trigger, status running = held by the claiming '
  'worker) and returns the verified (org_id, person_id) execution principal '
  'bound to that row: jobs.enqueued_by, or the schedule owner for '
  'scheduled_trigger. The worker gains no ambient privilege — it cannot '
  'choose the identity, and the function takes no org/workflow/person '
  'parameter. 22023 = job-row verification failure (non-retryable); '
  '42501 = principal verification failure (retry classifier decides).';

revoke all on function public.workflow_execute_as_job(uuid) from public;
grant execute on function public.workflow_execute_as_job(uuid) to app_user;
