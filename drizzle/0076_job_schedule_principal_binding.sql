-- ═════════════════════════════════════════════════════════════════════════════
-- 0076_job_schedule_principal_binding — a job or schedule can only name its own
-- caller as the person it runs as (V1 audit TI-09 / S-2)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- workflow_execute_as_job() (0048) runs a 'workflow_run' job as jobs.enqueued_by
-- and a 'scheduled_trigger' job as the creator of the schedule its payload names
-- (schedules.created_by). Those columns are frozen after insert (0061), but the
-- insert side and one update path still accepted a principal the caller chose. On
-- app_user, a person holding jobs.create (ADMIN globally, PROJECT_MANAGER for a
-- department) could:
--
--   1. insert a job with enqueued_by = someone else — jobs_enqueued_by_stamp
--      (0048) never overwrites an explicit value and jobs_insert (0045) did not
--      look at the column;
--   2. insert a schedule with created_by = someone else — schedules_insert (0045)
--      did not look at the column;
--   3. repoint another person's schedule at a workflow of their own —
--      schedules_update allows any jobs.create holder to change workflow_id;
--   4. insert a 'scheduled_trigger' job naming another person's schedule, forcing
--      an out-of-cycle run as that person.
--
-- Each would run a workflow with another person's permissions. None is reachable
-- through the current API: enqueueJob() and the schedule writers stamp the
-- principal from the verified session, the API has no workflow_id edit, and only
-- scheduler_tick_fire() enqueues 'scheduled_trigger' jobs. The database is meant
-- to enforce authorization on its own, so this closes all four in the database.
--
-- THE FIX
--
--   * jobs_insert: the stored enqueued_by must be the caller (authz.person_id()).
--     RLS WITH CHECK runs after BEFORE triggers, so the existing stamp still fills
--     an omitted value; an explicit value naming anyone else is refused (42501).
--     'scheduled_trigger' jobs cannot be inserted on app_user at all.
--   * schedules_insert: created_by must be the caller. A NULL creator is refused
--     too — a schedule without a principal can never run (0048 fails it closed).
--   * schedules_workflow_owner_guard: only the schedule's creator may change its
--     workflow_id. Other edits (name, cron, activation) keep their 0045 rules.
--
-- WHAT DOES NOT CHANGE. app_owner (migrations and the SECURITY DEFINER paths —
-- scheduler_tick_fire, the password-reset and cleanup enqueues) keeps its
-- jobs_owner_all / schedules_owner_all policies; those inserts carry no principal
-- or a system one, exactly as before. app_worker has no table privileges on jobs
-- or schedules (0070). No column, constraint or existing row is altered.
--
-- Rollback (not prepared as a script; nothing destructive happens here): recreate
-- jobs_insert and schedules_insert from 0045 and drop the trigger and function
-- below.

-- ── jobs: the stored principal is the caller; no direct scheduled_trigger ────

drop policy if exists jobs_insert on public.jobs;
create policy jobs_insert on public.jobs
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('jobs.create'))
    and type <> 'scheduled_trigger'
    and enqueued_by = (select authz.person_id())
  );

comment on function public.jobs_enqueued_by_stamp() is
  'BEFORE INSERT on jobs: stamps enqueued_by from app.person_id when it names '
  'an ACTIVE, non-deleted person of the job''s org; leaves an explicit value '
  'alone. On app_user the jobs_insert policy (0076) then requires the stored '
  'value to be the caller, so an explicit value naming anyone else is refused.';

--> statement-breakpoint

-- ── schedules: the creator is the caller ─────────────────────────────────────

drop policy if exists schedules_insert on public.schedules;
create policy schedules_insert on public.schedules
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('jobs.create'))
    and created_by = (select authz.person_id())
  );

-- ── schedules: only the creator may change the workflow a schedule runs ──────

create or replace function public.schedules_workflow_owner_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_setting text;
begin
  v_setting := nullif(current_setting('app.person_id', true), '');
  -- No person identity: the owner and maintenance plane. An app_user transaction
  -- cannot reach an UPDATE without one — schedules_update needs authz.is_active().
  if v_setting is null then
    return new;
  end if;
  -- A non-UUID identity (a worker-plane 'system:…' id) is nobody's schedule. The
  -- format check comes first so authz.person_id() never raises 22P02.
  if v_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or old.created_by is null
     or old.created_by is distinct from authz.person_id() then
    raise exception
      'only the person who created a schedule can change the workflow it runs'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.schedules_workflow_owner_guard() is
  'BEFORE UPDATE OF workflow_id on schedules (0076, TI-09): a scheduled run '
  'executes as schedules.created_by, so only that person may change which '
  'workflow it runs; anyone else raises 42501. Sessions without a person '
  'identity (owner/maintenance) are not restricted.';

revoke all on function public.schedules_workflow_owner_guard() from public;

-- Fires after schedules_workflow_org_guard (triggers run in name order), so a
-- foreign-org workflow is still refused by the org guard first.
drop trigger if exists schedules_workflow_owner_guard on public.schedules;
create trigger schedules_workflow_owner_guard
  before update of workflow_id on public.schedules
  for each row
  when (new.workflow_id is distinct from old.workflow_id)
  execute function public.schedules_workflow_owner_guard();

--> statement-breakpoint

-- ── verify ───────────────────────────────────────────────────────────────────

do $$
declare
  v_problems text;
begin
  with problems as (
    select 'jobs_insert does not bind enqueued_by to the caller' as problem
    where not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'jobs' and policyname = 'jobs_insert'
        and cmd = 'INSERT' and roles = '{app_user}'
        and position('enqueued_by = ( SELECT authz.person_id()' in with_check) > 0
        and position('''scheduled_trigger''' in with_check) > 0)
    union all
    select 'schedules_insert does not bind created_by to the caller'
    where not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'schedules'
        and policyname = 'schedules_insert'
        and cmd = 'INSERT' and roles = '{app_user}'
        and position('created_by = ( SELECT authz.person_id()' in with_check) > 0)
    union all
    select 'schedules_workflow_owner_guard trigger missing or disabled'
    where not exists (
      select 1 from pg_trigger t
      where t.tgrelid = 'public.schedules'::regclass
        and t.tgname = 'schedules_workflow_owner_guard'
        and t.tgenabled = 'O'
        and t.tgfoid = 'public.schedules_workflow_owner_guard()'::regprocedure)
    union all
    select 'schedules_workflow_owner_guard() executable by PUBLIC'
    where exists (
      select 1 from aclexplode(coalesce(
        (select proacl from pg_proc
         where oid = 'public.schedules_workflow_owner_guard()'::regprocedure),
        acldefault('f', (select proowner from pg_proc
                         where oid = 'public.schedules_workflow_owner_guard()'::regprocedure)))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE')
  )
  select string_agg(problem, '; ' order by problem) into v_problems from problems;

  if v_problems is not null then
    raise exception '0076 verification failed: %', v_problems;
  end if;
end;
$$;
