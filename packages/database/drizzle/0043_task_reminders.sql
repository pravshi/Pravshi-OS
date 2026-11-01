-- ═════════════════════════════════════════════════════════════════════════════════
-- 0043_task_reminders — per-task self-reminders (Phase 4 V1)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- A task reminder is a self-reminder a user sets on a task they can access:
-- one row = one person, one task, one future datetime. There is deliberately
-- NO delivery in V1: rows are stored with is_sent = false and the Phase 6
-- automation sweep will flip is_sent when it delivers them. The pending
-- index below exists for that future sweep.
--
-- Design rules:
--   * org_id comes from the caller; every tenant boundary is enforced by
--     trigger guards (42501, the 0042 pattern) because task_id and
--     person_id are single-column FKs.
--   * Reminders cascade on task hard-delete (the task owner deletes through
--     the task; reminders are derivative data, not the record of truth).
--   * RLS mirrors the task_reminders contract in src/lib/work/reminders.ts:
--     a person sees/creates/deletes only their OWN reminders; insert also
--     pins person_id to the caller so nobody can plant reminders on others.
--   * One person may hold several reminders on the same task (multiple
--     pings); no uniqueness beyond (org_id, id).
-- ═════════════════════════════════════════════════════════════════════════════════

--> statement-breakpoint
create table public.task_reminders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  -- Single-column FK by contract; the org match is enforced by
  -- task_reminders_task_org_guard() below. ON DELETE CASCADE: reminders die
  -- with their task.
  task_id uuid not null references public.work_tasks (id) on delete cascade,

  -- Who gets reminded. Single-column FK by contract; the org match is
  -- enforced by task_reminders_person_org_guard(). Always the caller's own
  -- person in V1 (the insert policy pins it).
  person_id uuid not null references public.people (id),

  -- When the reminder should fire. Must be a future instant; the API
  -- validates it (a CHECK can't use now(), which is not immutable).
  remind_at timestamptz not null,

  -- V1 never sets this; Phase 6 automation flips it on delivery. Indexed
  -- for the future sweep.
  is_sent boolean not null default false,

  created_at timestamptz not null default now(),

  constraint task_reminders_org_id_unique unique (org_id, id)
);

--> statement-breakpoint
create index task_reminders_task_idx
  on public.task_reminders (task_id);

--> statement-breakpoint
create index task_reminders_person_idx
  on public.task_reminders (person_id);

--> statement-breakpoint
create index task_reminders_pending_idx
  on public.task_reminders (org_id, remind_at)
  where not is_sent;

--> statement-breakpoint
comment on table public.task_reminders is
  'Per-task self-reminders (Phase 4 V1). remind_at is a future instant; '
  'is_sent is false until Phase 6 automation delivers and flips it. '
  'Cascade-deleted with the task.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- Org guards — single-column FKs can't carry (org_id, id), so the triggers
-- close the tenant-isolation hole with 42501 before any FK check runs
-- (the deals_pipeline_org_guard() / 0042 pattern).
-- ═════════════════════════════════════════════════════════════════════════════════

--> statement-breakpoint
create or replace function public.task_reminders_task_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task_org uuid;
begin
  select t.org_id into v_task_org
  from public.work_tasks t
  where t.id = new.task_id;
  if v_task_org is distinct from new.org_id then
    raise exception 'task_id must belong to the reminder''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

--> statement-breakpoint
comment on function public.task_reminders_task_org_guard() is
  'BEFORE INSERT/UPDATE on task_reminders: task_id must belong to NEW.org_id. '
  'Raises 42501.';

--> statement-breakpoint
revoke all on function public.task_reminders_task_org_guard() from public;

--> statement-breakpoint
create or replace function public.task_reminders_person_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_org uuid;
begin
  select p.org_id into v_person_org
  from public.people p
  where p.id = new.person_id;
  if v_person_org is distinct from new.org_id then
    raise exception 'person_id must belong to the reminder''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

--> statement-breakpoint
comment on function public.task_reminders_person_org_guard() is
  'BEFORE INSERT/UPDATE on task_reminders: person_id must belong to '
  'NEW.org_id. Raises 42501.';

--> statement-breakpoint
revoke all on function public.task_reminders_person_org_guard() from public;

--> statement-breakpoint
create trigger task_reminders_task_org_guard
  before insert or update of task_id, org_id on public.task_reminders
  for each row execute function public.task_reminders_task_org_guard();

--> statement-breakpoint
create trigger task_reminders_person_org_guard
  before insert or update of person_id, org_id on public.task_reminders
  for each row execute function public.task_reminders_person_org_guard();

-- ═════════════════════════════════════════════════════════════════════════════════
-- RLS — org-scoped, is_active()-gated, self-only (the service layer owns the
-- assignee-or-creator set rule and task visibility).
-- ═════════════════════════════════════════════════════════════════════════════════

--> statement-breakpoint
alter table public.task_reminders enable row level security;

--> statement-breakpoint
alter table public.task_reminders force row level security;

--> statement-breakpoint
create policy task_reminders_owner_all on public.task_reminders
  for all to app_owner using (true) with check (true);

--> statement-breakpoint
drop policy if exists task_reminders_select on public.task_reminders;
--> statement-breakpoint
create policy task_reminders_select on public.task_reminders
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and person_id = (select authz.person_id())
  );

--> statement-breakpoint
drop policy if exists task_reminders_insert on public.task_reminders;
--> statement-breakpoint
create policy task_reminders_insert on public.task_reminders
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and person_id = (select authz.person_id())
  );

--> statement-breakpoint
drop policy if exists task_reminders_update on public.task_reminders;
--> statement-breakpoint
create policy task_reminders_update on public.task_reminders
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and person_id = (select authz.person_id())
  )
  with check (
    org_id = (select authz.org_id())
    and person_id = (select authz.person_id())
  );

--> statement-breakpoint
drop policy if exists task_reminders_delete on public.task_reminders;
--> statement-breakpoint
create policy task_reminders_delete on public.task_reminders
  for delete to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and person_id = (select authz.person_id())
  );

-- ═════════════════════════════════════════════════════════════════════════════════
-- Audit — personal data change, MEDIUM (the 0012 'person' level), whole-row.
-- ═════════════════════════════════════════════════════════════════════════════════

--> statement-breakpoint
create trigger task_reminders_audit
  after insert or update or delete on public.task_reminders
  for each row execute function public.audit_row_change('task_reminder', 'MEDIUM', 'id');
