-- PRAVSHI OS — Phase 5: workflow engine.
--
-- Three tables: workflows holds the automation definitions (trigger JSONB +
-- STORED generated trigger_type for indexed matching), workflow_executions
-- records one row per workflow run, and workflow_execution_steps records one
-- row per action attempt inside a run. Matching runs against the composite
-- index (org_id, status, trigger_type); dedup runs against the unique
-- (workflow_id, dedup_key).
--
-- Conventions carried over from 0033/0037/0042:
--   Task 1.4 composite-key strategy   workflows, workflow_executions and
--                                      workflow_execution_steps carry
--                                      UNIQUE (org_id, id) so the tenant is
--                                      pinned on every row. workflow_id and
--                                      execution_id are single-column FKs —
--                                      exactly like deals.pipeline_id in
--                                      0037 — and the tenant-isolation
--                                      guarantee comes from BEFORE triggers
--                                      that reject a foreign-org reference
--                                      with 42501
--                                      (workflow_executions_workflow_org_guard(),
--                                      workflow_execution_steps_execution_org_guard()).
--   Task 1.16 RLS template            org-scoped, deleted_at-excluded (where
--                                      the table has one), is_active()-gated.
--                                      Each policy gates on authz.has('<key>')
--                                      (the permission at any scope) instead of
--                                      an owner-based scope CASE. Executions
--                                      and steps carry SELECT-only policies
--                                      for app_user — their writes go
--                                      exclusively through the SECURITY
--                                      DEFINER record functions (D7).
--   Task 1.11 audit triggers          audit_row_change() whole-row: HIGH on
--                                      workflows (access-affecting: a changed
--                                      definition can move money and people),
--                                      MEDIUM on workflow_executions. Steps
--                                      inherit execution visibility — no
--                                      trigger, to avoid audit noise.
--   No DELETE policy                  on any of the three tables. Workflows
--                                      soft-delete through crm_soft_delete()
--                                      only ('workflows.delete' dispatch);
--                                      executions and steps are append-mostly
--                                      history and are never deleted by the
--                                      app (steps cascade on execution
--                                      hard-delete by the owner only).
--
-- DELIBERATE DEVIATIONS FROM THE §8.1 DDL, and why:
--   * workflows_name_unique_per_org is a partial UNIQUE INDEX, not a table
--     constraint: WHERE cannot appear on a table-constraint UNIQUE. Same
--     semantics — one live name per org, deleted names reusable.
--   * The §8.1 drafting placeholder `check (true)` on workflow_execution_steps
--     is not created: the org-guard trigger below is the real enforcement.
--   * workflows.delete reaches ADMIN (GLOBAL) + SUPER_ADMIN (cross join) and
--     no other role — the 0008 projects.delete precedent (seeded, then put
--     on the admin path). PROJECT_MANAGER gets view/create/edit/activate/
--     execute at DEPARTMENT.
--   * Permission seeds write resource/action as explicit literals, not via the
--     0008/0037 substring(key from '...\\....') derivation: the derived form's
--     backslash escaping depends on the session's standard_conforming_strings,
--     while the literal form is correct under either setting. The
--     permissions_key_matches_parts CHECK still proves key = resource.action.
--   * Definer functions validate terminal-only statuses on the finish paths
--     and compute duration_ms server-side; callers cannot forge either.

-- ═════════════════════════════════════════════════════════════════════════════════
-- Workflow definitions, executions, execution steps
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- workflows.trigger is TriggerConfig JSONB (§10); the STORED generated
-- trigger_type feeds the matcher index. conditions/actions stay JSONB,
-- validated by zod at the service boundary (A2) — never user code, never
-- eval. created_by/updated_by are nullable with NO FK (the "no synthetic
-- actor" rule: NULL for migration/seeds; a deleted person row must not
-- block reads). Execution/step actors are derived from the transaction
-- context inside the definer functions — never caller-supplied.

create table public.workflows (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id),
  name          text not null,
  description   text,
  status        text not null default 'DRAFT'
    check (status in ('DRAFT','ACTIVE','PAUSED','ARCHIVED')),
  trigger       jsonb not null,
  trigger_type  text generated always as (trigger ->> 'type') stored,
  conditions    jsonb not null default '[]'::jsonb,
  actions       jsonb not null default '[]'::jsonb,
  version       integer not null default 1,
  created_by    uuid,
  updated_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint workflows_org_id_unique unique (org_id, id)
);

--> statement-breakpoint
create table public.workflow_executions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id),
  workflow_id         uuid not null references public.workflows(id),
  workflow_version    integer not null,
  dedup_key           text not null,
  status              text not null default 'PENDING'
    check (status in ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  trigger_type        text not null,
  source_entity_type  text,
  source_entity_id    uuid,
  triggered_by        uuid,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  duration_ms         integer,
  error_code          text,
  error_message       text,
  result_summary      jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  constraint workflow_executions_org_id_unique unique (org_id, id),
  constraint workflow_executions_dedup unique (workflow_id, dedup_key)
);

--> statement-breakpoint
create table public.workflow_execution_steps (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id),
  execution_id  uuid not null references public.workflow_executions(id) on delete cascade,
  step_index    integer not null,
  action_type   text not null,
  action_params jsonb not null default '{}'::jsonb,
  status        text not null default 'PENDING'
    check (status in ('PENDING','RUNNING','SUCCEEDED','FAILED','SKIPPED')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  duration_ms   integer,
  result        jsonb,
  error_code    text,
  error_message text,
  created_at    timestamptz not null default now(),
  constraint workflow_execution_steps_org_id_unique unique (org_id, id)
);

--> statement-breakpoint
comment on table public.workflows is
  'Workflow automation definitions. Soft-deleted through crm_soft_delete() with the workflows.delete dispatch; execution history is append-only.';
comment on column public.workflows.trigger is
  'TriggerConfig JSONB (§10): type + entityType + filters. trigger_type is the STORED generated projection used by the matcher.';
comment on column public.workflows.trigger_type is
  'STORED generated column: trigger ->> ''type''. Read by the workflows_match_idx composite index.';
comment on table public.workflow_executions is
  'One row per workflow run. Written ONLY through workflow_record_execution()/workflow_finish_execution(); app_user has SELECT only.';
comment on table public.workflow_execution_steps is
  'One row per action attempt inside a run. Written ONLY through workflow_record_step()/workflow_finish_step(); app_user has SELECT only.';

--> statement-breakpoint
create trigger workflows_set_updated_at
  before update on public.workflows
  for each row execute function public.set_updated_at();

--> statement-breakpoint
-- workflows_match_idx: the engine's matcher (org_id + ACTIVE + trigger_type).
create index workflows_match_idx on public.workflows (org_id, status, trigger_type)
  where deleted_at is null;

--> statement-breakpoint
-- Partial unique: one live name per org; deleted names are reusable.
create unique index workflows_name_unique_per_org on public.workflows (org_id, name)
  where deleted_at is null;

--> statement-breakpoint
create index workflow_executions_lookup_idx on public.workflow_executions
  (org_id, workflow_id, started_at desc);

--> statement-breakpoint
create index workflow_execution_steps_exec_idx on public.workflow_execution_steps
  (execution_id, step_index);

-- ═════════════════════════════════════════════════════════════════════════════════
-- Row-level security — the 0042 template, verbatim shape
-- ═════════════════════════════════════════════════════════════════════════════════

alter table public.workflows enable row level security;
alter table public.workflows force row level security;

alter table public.workflow_executions enable row level security;
alter table public.workflow_executions force row level security;

alter table public.workflow_execution_steps enable row level security;
alter table public.workflow_execution_steps force row level security;

create policy workflows_owner_all on public.workflows
  for all to app_owner using (true) with check (true);

create policy workflow_executions_owner_all on public.workflow_executions
  for all to app_owner using (true) with check (true);

create policy workflow_execution_steps_owner_all on public.workflow_execution_steps
  for all to app_owner using (true) with check (true);

-- ── workflows ──────────────────────────────────────────────────────────────────

drop policy if exists workflows_select on public.workflows;
create policy workflows_select on public.workflows
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('workflows.view'))
  );

--> statement-breakpoint
drop policy if exists workflows_insert on public.workflows;
create policy workflows_insert on public.workflows
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('workflows.create'))
  );

--> statement-breakpoint
drop policy if exists workflows_update on public.workflows;
create policy workflows_update on public.workflows
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('workflows.edit'))
  )
  with check (
    org_id = (select authz.org_id())
  );

-- No DELETE policy on workflows: deletion goes through crm_soft_delete()
-- with the 'workflows.delete' dispatch only.

-- ── workflow_executions ────────────────────────────────────────────────────────
--
-- app_user gets SELECT only. Rows are written exclusively by the SECURITY
-- DEFINER record functions (D7): a direct app_user write would bypass the
-- actor/org derivation and input sanitization those functions enforce.

drop policy if exists workflow_executions_select on public.workflow_executions;
create policy workflow_executions_select on public.workflow_executions
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('workflows.view'))
  );

-- ── workflow_execution_steps ───────────────────────────────────────────────────

drop policy if exists workflow_execution_steps_select on public.workflow_execution_steps;
create policy workflow_execution_steps_select on public.workflow_execution_steps
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('workflows.view'))
  );

-- No INSERT/UPDATE/DELETE policies on workflow_executions or
-- workflow_execution_steps for app_user: definer-function writes only.

-- ═════════════════════════════════════════════════════════════════════════════════
-- workflow_executions_workflow_org_guard() — the execution's workflow must be its org's
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- workflow_id is a single-column FK, so without this an execution could
-- reference another org's workflow. The trigger closes that tenant-isolation
-- hole with 42501 before any FK check runs — the deals_pipeline_org_guard()
-- pattern.

create or replace function public.workflow_executions_workflow_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workflow_org uuid;
begin
  select w.org_id into v_workflow_org
  from public.workflows w
  where w.id = new.workflow_id;
  if v_workflow_org is distinct from new.org_id then
    raise exception 'workflow_id must belong to the execution''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.workflow_executions_workflow_org_guard() is
  'BEFORE INSERT/UPDATE on workflow_executions: workflow_id must belong to NEW.org_id. '
  'Closes the cross-org reference hole the single-column FK leaves open; '
  'raises 42501.';

revoke all on function public.workflow_executions_workflow_org_guard() from public;

drop trigger if exists workflow_executions_workflow_org_guard on public.workflow_executions;
create trigger workflow_executions_workflow_org_guard
  before insert or update on public.workflow_executions
  for each row execute function public.workflow_executions_workflow_org_guard();

--> statement-breakpoint
-- ═════════════════════════════════════════════════════════════════════════════════
-- workflow_execution_steps_execution_org_guard() — the step's execution must be its org's
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- execution_id is a single-column FK, so without this a step could reference
-- another org's execution. Same 42501 close as above.

create or replace function public.workflow_execution_steps_execution_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_execution_org uuid;
begin
  select e.org_id into v_execution_org
  from public.workflow_executions e
  where e.id = new.execution_id;
  if v_execution_org is distinct from new.org_id then
    raise exception 'execution_id must belong to the step''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.workflow_execution_steps_execution_org_guard() is
  'BEFORE INSERT/UPDATE on workflow_execution_steps: execution_id must belong to NEW.org_id. '
  'Closes the cross-org reference hole the single-column FK leaves open; '
  'raises 42501.';

revoke all on function public.workflow_execution_steps_execution_org_guard() from public;

drop trigger if exists workflow_execution_steps_execution_org_guard on public.workflow_execution_steps;
create trigger workflow_execution_steps_execution_org_guard
  before insert or update on public.workflow_execution_steps
  for each row execute function public.workflow_execution_steps_execution_org_guard();

-- ═════════════════════════════════════════════════════════════════════════════════
-- workflow_record_execution() — record a workflow run attempt (D7)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The engine's ONLY way to open an execution row. Org and actor come from
-- the transaction context (authz.org_id()/authz.person_id()) — the caller
-- never supplies either, so no synthetic actor can be fabricated. The
-- referenced workflow must live in the caller's org (missing or foreign
-- fails closed with 42501, never distinguishing the two). Returns the new
-- execution id, or NULL when (workflow_id, dedup_key) already exists: the
-- engine treats NULL as "already ran" and skips — the D4 idempotent
-- no-op.
--
-- F9 (2026-10-04): the caller additionally passes its org explicitly as
-- p_org_id; the function asserts it equals the transaction context's org.
-- Defense in depth for SECURITY DEFINER callables: the definer never acts
-- on a merely-claimed org that differs from the session identity.

-- Old 7-arg signature never shipped (no DB ran 0044 before F9); dropped for
-- hygiene so exactly one signature exists.
drop function if exists public.workflow_record_execution(uuid, int, text, text, text, uuid, text);

create or replace function public.workflow_record_execution(
  p_workflow_id uuid,
  p_workflow_version int,
  p_dedup_key text,
  p_trigger_type text,
  p_source_entity_type text,
  p_source_entity_id uuid,
  p_status text,
  p_org_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
  v_workflow_org uuid;
  v_dedup_key text;
  v_trigger_type text;
  v_status text;
  v_execution_id uuid;
begin
  if not (select authz.is_active()) then
    raise exception 'inactive caller' using errcode = '42501';
  end if;
  v_org_id := (select authz.org_id());
  v_actor := (select authz.person_id());

  if p_org_id is distinct from v_org_id then
    raise exception 'org_id mismatch' using errcode = '42501';
  end if;

  select w.org_id into v_workflow_org
  from public.workflows w
  where w.id = p_workflow_id;
  if v_workflow_org is distinct from v_org_id then
    raise exception 'workflow not in caller organization' using errcode = '42501';
  end if;

  -- Input hygiene at the boundary: blank or overlong text is rejected here,
  -- never stored. The engine sanitizes; the DB refuses the rest.
  v_dedup_key := nullif(btrim(coalesce(p_dedup_key, '')), '');
  if v_dedup_key is null or length(v_dedup_key) > 256 then
    raise exception 'dedup_key must be 1..256 characters' using errcode = '22001';
  end if;
  v_trigger_type := nullif(btrim(coalesce(p_trigger_type, '')), '');
  if v_trigger_type is null or length(v_trigger_type) > 64 then
    raise exception 'trigger_type must be 1..64 characters' using errcode = '22001';
  end if;
  if p_source_entity_type is not null
     and p_source_entity_type not in ('deal','task','project','company','contact') then
    raise exception 'unknown source entity type' using errcode = '22023';
  end if;
  v_status := coalesce(p_status, 'PENDING');
  if v_status not in ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED') then
    raise exception 'unknown execution status' using errcode = '22023';
  end if;
  if p_workflow_version is null or p_workflow_version < 1 then
    raise exception 'workflow_version must be a positive integer' using errcode = '22003';
  end if;

  insert into public.workflow_executions (
    org_id, workflow_id, workflow_version, dedup_key, status,
    trigger_type, source_entity_type, source_entity_id, triggered_by
  ) values (
    v_org_id, p_workflow_id, p_workflow_version, v_dedup_key, v_status,
    v_trigger_type, p_source_entity_type, p_source_entity_id, v_actor
  )
  on conflict (workflow_id, dedup_key) do nothing
  returning id into v_execution_id;

  return v_execution_id;
end;
$$;

comment on function public.workflow_record_execution(uuid, int, text, text, text, uuid, text, uuid) is
  'SECURITY DEFINER: records a workflow run attempt for the caller''s org/actor from the transaction context. '
  'The explicit p_org_id must equal the context org. '
  'Returns the execution id, or NULL when (workflow_id, dedup_key) already exists (idempotent no-op). '
  'Raises 42501 for an inactive caller, an org_id mismatch, or a workflow outside the caller''s org.';

revoke all on function public.workflow_record_execution(uuid, int, text, text, text, uuid, text, uuid) from public;
grant execute on function public.workflow_record_execution(uuid, int, text, text, text, uuid, text, uuid) to app_user;

--> statement-breakpoint
-- ═════════════════════════════════════════════════════════════════════════════════
-- workflow_finish_execution() — close an execution with a terminal status (D7)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Closes an execution with a terminal status (SUCCEEDED / FAILED / CANCELLED);
-- anything else is a caller bug and raises. NOTE: the prior status is NOT
-- re-checked here (the "PENDING/RUNNING only" phrasing of an earlier draft
-- was stale — the UPDATE below has no prior-state predicate by design, so a
-- finish call always lands). finished_at and duration_ms are computed
-- server-side — callers cannot forge timing. error_code is a short token;
-- error_message is capped at 2000 chars and NUL-stripped. Raw DB errors and
-- PII-bearing payloads never reach these columns: the engine sanitizes
-- before calling (audit contract §17).
--
-- F9 (2026-10-04): p_org_id must equal the transaction context's org
-- (same defense-in-depth rationale as workflow_record_execution).

drop function if exists public.workflow_finish_execution(uuid, text, jsonb, text, text);

create or replace function public.workflow_finish_execution(
  p_execution_id uuid,
  p_status text,
  p_result_summary jsonb,
  p_error_code text,
  p_error_message text,
  p_org_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_started timestamptz;
  v_error_code text;
  v_error_message text;
  v_result_summary jsonb;
  v_n bigint;
begin
  if not (select authz.is_active()) then
    raise exception 'inactive caller' using errcode = '42501';
  end if;
  v_org_id := (select authz.org_id());

  if p_org_id is distinct from v_org_id then
    raise exception 'org_id mismatch' using errcode = '42501';
  end if;

  if coalesce(p_status, '') not in ('SUCCEEDED','FAILED','CANCELLED') then
    raise exception 'finish requires a terminal execution status' using errcode = '22023';
  end if;

  select e.started_at into v_started
  from public.workflow_executions e
  where e.id = p_execution_id and e.org_id = v_org_id;
  if v_started is null then
    raise exception 'execution not in caller organization' using errcode = '42501';
  end if;

  v_error_code := nullif(btrim(coalesce(p_error_code, '')), '');
  if v_error_code is not null and length(v_error_code) > 64 then
    raise exception 'error_code must be 1..64 characters' using errcode = '22001';
  end if;
  v_error_message := nullif(btrim(replace(coalesce(p_error_message, ''), chr(0), '')), '');
  if v_error_message is not null and length(v_error_message) > 2000 then
    raise exception 'error_message must be at most 2000 characters' using errcode = '22001';
  end if;
  v_result_summary := case
    when p_result_summary is null then '{}'::jsonb
    when jsonb_typeof(p_result_summary) = 'object' then p_result_summary
    else '{}'::jsonb
  end;

  update public.workflow_executions
  set status = p_status,
      finished_at = now(),
      duration_ms = (extract(epoch from (now() - v_started)) * 1000)::int,
      error_code = v_error_code,
      error_message = v_error_message,
      result_summary = v_result_summary
  where id = p_execution_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'execution vanished mid-finish' using errcode = '02000';
  end if;
end;
$$;

comment on function public.workflow_finish_execution(uuid, text, jsonb, text, text, uuid) is
  'SECURITY DEFINER: closes an execution of the caller''s org with a terminal status. '
  'The explicit p_org_id must equal the context org. '
  'Computes finished_at/duration_ms server-side; error fields are length-capped and sanitized. '
  'Raises 42501 for an org_id mismatch or a foreign or missing execution.';

revoke all on function public.workflow_finish_execution(uuid, text, jsonb, text, text, uuid) from public;
grant execute on function public.workflow_finish_execution(uuid, text, jsonb, text, text, uuid) to app_user;

--> statement-breakpoint
-- ═════════════════════════════════════════════════════════════════════════════════
-- workflow_record_step() — record one action attempt inside a run (D7)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The step inherits its execution's org (the caller's org is verified to
-- match first). action_params carries the template-resolved params; a
-- non-object is coerced to '{}' rather than failing the run.
--
-- F9 (2026-10-04): p_org_id must equal the transaction context's org
-- (same defense-in-depth rationale as workflow_record_execution).

drop function if exists public.workflow_record_step(uuid, int, text, jsonb);

create or replace function public.workflow_record_step(
  p_execution_id uuid,
  p_step_index int,
  p_action_type text,
  p_action_params jsonb,
  p_org_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_execution_org uuid;
  v_action_type text;
  v_step_id uuid;
begin
  if not (select authz.is_active()) then
    raise exception 'inactive caller' using errcode = '42501';
  end if;
  v_org_id := (select authz.org_id());

  if p_org_id is distinct from v_org_id then
    raise exception 'org_id mismatch' using errcode = '42501';
  end if;

  select e.org_id into v_execution_org
  from public.workflow_executions e
  where e.id = p_execution_id;
  if v_execution_org is distinct from v_org_id then
    raise exception 'execution not in caller organization' using errcode = '42501';
  end if;

  v_action_type := nullif(btrim(coalesce(p_action_type, '')), '');
  if v_action_type is null or length(v_action_type) > 64 then
    raise exception 'action_type must be 1..64 characters' using errcode = '22001';
  end if;
  if p_step_index is null or p_step_index < 0 then
    raise exception 'step_index must be a non-negative integer' using errcode = '22003';
  end if;

  insert into public.workflow_execution_steps (
    org_id, execution_id, step_index, action_type, action_params
  ) values (
    v_execution_org, p_execution_id, p_step_index, v_action_type,
    case
      when p_action_params is null then '{}'::jsonb
      when jsonb_typeof(p_action_params) = 'object' then p_action_params
      else '{}'::jsonb
    end
  )
  returning id into v_step_id;

  return v_step_id;
end;
$$;

comment on function public.workflow_record_step(uuid, int, text, jsonb, uuid) is
  'SECURITY DEFINER: records one action attempt for an execution of the caller''s org. '
  'The explicit p_org_id must equal the context org. '
  'The step inherits the execution''s org; raises 42501 for an org_id mismatch or a foreign or missing execution.';

revoke all on function public.workflow_record_step(uuid, int, text, jsonb, uuid) from public;
grant execute on function public.workflow_record_step(uuid, int, text, jsonb, uuid) to app_user;

--> statement-breakpoint
-- ═════════════════════════════════════════════════════════════════════════════════
-- workflow_finish_step() — close a step with its action result (D7)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Accepts RUNNING / SUCCEEDED / FAILED / SKIPPED as the new status (the
-- code validates the incoming p_status; the prior status is intentionally
-- not re-checked — see workflow_finish_execution's note). result carries
-- the sanitized ActionResult.output (objects only); error fields follow the
-- same sanitization as workflow_finish_execution.
--
-- F9 (2026-10-04): p_org_id must equal the transaction context's org
-- (same defense-in-depth rationale as workflow_record_execution).

drop function if exists public.workflow_finish_step(uuid, text, jsonb, text, text);

create or replace function public.workflow_finish_step(
  p_step_id uuid,
  p_status text,
  p_result jsonb,
  p_error_code text,
  p_error_message text,
  p_org_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_started timestamptz;
  v_error_code text;
  v_error_message text;
  v_n bigint;
begin
  if not (select authz.is_active()) then
    raise exception 'inactive caller' using errcode = '42501';
  end if;
  v_org_id := (select authz.org_id());

  if p_org_id is distinct from v_org_id then
    raise exception 'org_id mismatch' using errcode = '42501';
  end if;

  if coalesce(p_status, '') not in ('RUNNING','SUCCEEDED','FAILED','SKIPPED') then
    raise exception 'finish requires a non-pending step status' using errcode = '22023';
  end if;

  select s.started_at into v_started
  from public.workflow_execution_steps s
  where s.id = p_step_id and s.org_id = v_org_id;
  if v_started is null then
    raise exception 'step not in caller organization' using errcode = '42501';
  end if;

  v_error_code := nullif(btrim(coalesce(p_error_code, '')), '');
  if v_error_code is not null and length(v_error_code) > 64 then
    raise exception 'error_code must be 1..64 characters' using errcode = '22001';
  end if;
  v_error_message := nullif(btrim(replace(coalesce(p_error_message, ''), chr(0), '')), '');
  if v_error_message is not null and length(v_error_message) > 2000 then
    raise exception 'error_message must be at most 2000 characters' using errcode = '22001';
  end if;

  update public.workflow_execution_steps
  set status = p_status,
      finished_at = now(),
      duration_ms = (extract(epoch from (now() - v_started)) * 1000)::int,
      result = case
        when p_result is null then null
        when jsonb_typeof(p_result) = 'object' then p_result
        else null
      end,
      error_code = v_error_code,
      error_message = v_error_message
  where id = p_step_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'step vanished mid-finish' using errcode = '02000';
  end if;
end;
$$;

comment on function public.workflow_finish_step(uuid, text, jsonb, text, text, uuid) is
  'SECURITY DEFINER: closes a step of the caller''s org with its action result. '
  'The explicit p_org_id must equal the context org. '
  'Computes finished_at/duration_ms server-side; error fields are length-capped and sanitized. '
  'Raises 42501 for an org_id mismatch or a foreign or missing step.';

revoke all on function public.workflow_finish_step(uuid, text, jsonb, text, text, uuid) from public;
grant execute on function public.workflow_finish_step(uuid, text, jsonb, text, text, uuid) to app_user;

--> statement-breakpoint
-- ═════════════════════════════════════════════════════════════════════════════════
-- workflow_find_matching() — trigger matcher for the engine (F10, 2026-10-04)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Returns the org's ACTIVE, non-deleted workflows for one trigger type
-- (the (org_id, status, trigger_type) narrowing of §13 step 3, served by
-- workflows_match_idx). SECURITY DEFINER: it intentionally bypasses the
-- workflows_select RLS policy's workflows.view requirement, because
-- automations must fire on the trigger actor's actions regardless of whether
-- that actor may *read* workflow definitions (A16 §3 observation: otherwise
-- e.g. a sales rep moving a deal never triggers "deal WON → create
-- project"). Tenant scoping is enforced inside the function — the org comes
-- from authz.org_id() (asserted against the explicit p_org_id, F9 pattern),
-- never from parameters alone — so no cross-org leak is possible. Actions
-- still execute under the trigger actor's own Authorization (D2 unchanged);
-- definitions carry no secrets (audit §17).
--
-- Corrupt rows are NOT filtered here: the engine's parseWorkflowRow skips
-- them with a Sentry warning (fail-closed, never breaking the request).

create or replace function public.workflow_find_matching(
  p_trigger_type text,
  p_org_id uuid
)
returns table (
  id uuid,
  version int,
  trigger jsonb,
  conditions jsonb,
  actions jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_trigger_type text;
begin
  if not (select authz.is_active()) then
    raise exception 'inactive caller' using errcode = '42501';
  end if;
  v_org_id := (select authz.org_id());

  if p_org_id is distinct from v_org_id then
    raise exception 'org_id mismatch' using errcode = '42501';
  end if;

  v_trigger_type := nullif(btrim(coalesce(p_trigger_type, '')), '');
  if v_trigger_type is null or length(v_trigger_type) > 64 then
    raise exception 'trigger_type must be 1..64 characters' using errcode = '22001';
  end if;

  return query
    select w.id, w.version, w.trigger, w.conditions, w.actions
    from public.workflows w
    where w.org_id = v_org_id
      and w.status = 'ACTIVE'
      and w.trigger_type = v_trigger_type
      and w.deleted_at is null;
end;
$$;

comment on function public.workflow_find_matching(text, uuid) is
  'SECURITY DEFINER: returns the caller''s org ACTIVE workflows for one trigger type. '
  'The explicit p_org_id must equal the context org; tenant scoping is enforced inside. '
  'Bypasses the workflows.view RLS requirement by design so automations fire for any '
  'trigger actor (D2 execution authority is unchanged).';

revoke all on function public.workflow_find_matching(text, uuid) from public;
grant execute on function public.workflow_find_matching(text, uuid) to app_user;

-- ═════════════════════════════════════════════════════════════════════════════════
-- Audit triggers — the dual-layer DB half (whole-row, skips silently with no actor)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- workflows at HIGH: a definition change is access-affecting (it can move
-- deals, assign tasks, create projects). workflow_executions at MEDIUM.
-- workflow_execution_steps carry no trigger: they inherit execution
-- visibility and per-step audit rows would be noise (§17).

drop trigger if exists workflows_audit on public.workflows;
create trigger workflows_audit
  after insert or update or delete on public.workflows
  for each row execute function public.audit_row_change('workflow', 'HIGH', 'id');

--> statement-breakpoint
drop trigger if exists workflow_executions_audit on public.workflow_executions;
create trigger workflow_executions_audit
  after insert or update or delete on public.workflow_executions
  for each row execute function public.audit_row_change('workflow_execution', 'MEDIUM', 'id');

-- ═════════════════════════════════════════════════════════════════════════════════
-- crm_soft_delete(): the runtime soft-delete path gains workflows
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The 0042 function, unchanged except for the new allowlist mapping:
-- 'workflow' → public.workflows with the 'workflows.delete' permission
-- dispatch. Migration 0042 itself is never edited; it is already applied.
-- The M1 in-function delete-permission probe covers the new entity:
-- workflows.delete is a catalogue key seeded below and granted to ADMIN at
-- GLOBAL (and held by SUPER_ADMIN through the cross join), so the probe
-- resolves there and fail-closes everywhere else.

create or replace function public.crm_soft_delete(p_entity text, p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_perm text;
  v_n bigint;
begin
  v_table := case p_entity
    when 'company' then 'companies'
    when 'contact' then 'contacts'
    when 'deal' then 'deals'
    when 'activity' then 'activities'
    when 'company_contact' then 'company_contacts'
    when 'company_link' then 'company_links'
    when 'contact_link' then 'contact_links'
    when 'pipeline' then 'pipelines'
    when 'work_project' then 'work_projects'
    when 'work_task' then 'work_tasks'
    -- API alias: the work-tasks DELETE endpoint calls crm_soft_delete('task').
    when 'task' then 'work_tasks'
    when 'workflow' then 'workflows'
  end;
  v_perm := case p_entity
    when 'company' then 'companies.delete'
    when 'contact' then 'contacts.delete'
    when 'deal' then 'deals.delete'
    when 'activity' then 'activities.delete'
    when 'company_contact' then 'company_contacts.delete'
    when 'company_link' then 'company_links.delete'
    when 'contact_link' then 'contact_links.delete'
    when 'pipeline' then 'pipelines.delete'
    when 'work_project' then 'projects.delete'
    when 'work_task' then 'tasks.delete'
    when 'task' then 'tasks.delete'
    when 'workflow' then 'workflows.delete'
  end;
  if v_table is null then
    raise exception 'unknown soft-delete entity: %', p_entity using errcode = '42501';
  end if;
  -- M1: fail closed unless the caller holds the delete permission. This is
  -- defense-in-depth: the service layer already probes edit rights, but a
  -- SECURITY DEFINER function granted to app_user must not rely on callers
  -- to enforce the permission.
  if not (select authz.has(v_perm)) then
    raise exception 'missing delete permission for %', p_entity using errcode = '42501';
  end if;
  -- Phase 4: a pipeline with live deals cannot be soft-deleted. The caller must
  -- move or close the deals first. The guard is scoped to the caller's org so
  -- a foreign pipeline still raises 02000 (no tenant leak) via the probe below.
  if p_entity = 'pipeline' then
    if exists (
      select 1 from public.deals d
      where d.pipeline_id = p_id
        and d.org_id = (select authz.org_id())
        and d.deleted_at is null
    ) then
      raise exception 'pipeline has live deals' using errcode = '42501';
    end if;
  end if;
  execute format(
    'update public.%I set deleted_at = now(), updated_at = now() '
    'where id = $1 and org_id = authz.org_id() and deleted_at is null',
    v_table
  ) using p_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    -- The service already proved edit rights on this row in this transaction;
    -- reaching here means the row vanished or left the caller's org.
    raise exception 'soft delete affected no rows' using errcode = '02000';
  end if;
end;
$$;

revoke all on function public.crm_soft_delete(text, uuid) from public;
grant execute on function public.crm_soft_delete(text, uuid) to app_user;

-- ═════════════════════════════════════════════════════════════════════════════════
-- Permission catalogue — the workflow keys
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Six keys, module 'workflows', all is_sensitive=false. Reads ride on
-- workflows.view; definition writes need create/edit; lifecycle needs
-- activate; manual runs need execute; deletion needs delete (admin path
-- only — see the grant matrix below).
--
-- DELIBERATE DEVIATION from the 0008/0037 seed shape: resource and action
-- are written as explicit literals instead of being derived with
-- substring(key from '...\\....'). The derived form depends on the
-- session's standard_conforming_strings for its backslash escaping; the
-- literal form is correct under either setting, and the
-- permissions_key_matches_parts CHECK constraint still proves
-- key = resource || '.' || action on every row.

insert into public.permissions (key, resource, action, module, description, is_sensitive)
values
  ('workflows.view',     'workflows', 'view',     'workflows', 'See workflows and their execution history', false),
  ('workflows.create',   'workflows', 'create',   'workflows', 'Create workflow definitions',               false),
  ('workflows.edit',     'workflows', 'edit',     'workflows', 'Change workflow definitions',               false),
  ('workflows.delete',   'workflows', 'delete',   'workflows', 'Soft-delete workflow definitions',          false),
  ('workflows.activate', 'workflows', 'activate', 'workflows', 'Activate and pause workflows',              false),
  ('workflows.execute',  'workflows', 'execute',  'workflows', 'Run a workflow manually',                   false)
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════════
-- Permission grants — the workflow keys reach the matrix
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The 0008 catalogue seeded tasks.create, tasks.delete, tasks.comment and
-- projects.delete but granted them to ZERO roles; 0042 later put
-- projects.delete on the admin path. workflows.delete follows that
-- precedent: ADMIN holds it at GLOBAL, SUPER_ADMIN through the cross join,
-- no other role. seed_system_roles() is recreated with the 0042 body plus
-- the Phase 5 rows (0042's pattern: the earlier migration is never edited),
-- so organizations created from here on get the grants; the backfill below
-- covers organizations that already exist.

create or replace function public.seed_system_roles(p_org_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.roles (org_id, key, name, description, is_system, is_protected)
  values
    -- is_protected is true for SUPER_ADMIN alone, and it is not a judgement about
    -- seniority: it is the mechanical consequence of blueprint 6.2, which defines a
    -- protected role as one carrying roles.manage or permissions.manage. The matrix
    -- grants those to SUPER_ADMIN and to nobody else.
    (p_org_id, 'SUPER_ADMIN',     'Super Administrator', 'Full access, including role and permission management and security settings', true, true),
    (p_org_id, 'ADMIN',           'Administrator',       'Operational administration. Deliberately NOT a superset of HR: no identity documents, no compensation', true, false),
    (p_org_id, 'HR_ADMIN',        'HR Administrator',    'Full people, HR and hiring administration. No sales pipeline and no audit log', true, false),
    (p_org_id, 'HR_MANAGER',      'HR Manager',          'People and HR administration within their own departments', true, false),
    (p_org_id, 'MANAGER',         'Manager',             'Line management. No permissions are seeded: the architecture defines no matrix column for this role', true, false),
    (p_org_id, 'SALES_MANAGER',   'Sales Manager',       'Sales and delivery leadership across their departments', true, false),
    (p_org_id, 'SALES',           'Sales',               'Own leads, own clients, own tasks', true, false),
    (p_org_id, 'PROJECT_MANAGER', 'Project Manager',     'Projects, tasks and delivery within their departments', true, false),
    (p_org_id, 'DEVELOPER',       'Developer',           'The projects they are assigned to, and their own profile', true, false),
    (p_org_id, 'VIBECODER',       'Vibecoder',           'The projects they are assigned to, and nothing wider', true, false),
    (p_org_id, 'FINANCE',         'Finance',             'Commercial and compensation data. A separate boundary from HR, not a subset of it', true, false),
    (p_org_id, 'MARKETING',       'Marketing',           'No permissions are seeded: the architecture defines no matrix column for this role', true, false),
    (p_org_id, 'INTERN',          'Intern',              'Self and assigned projects only. The legal classification lives on the engagement, never here', true, false),
    (p_org_id, 'EMPLOYEE',        'Employee',            'The baseline every active engagement receives. Self-service only', true, false)
  on conflict do nothing;

  -- SUPER_ADMIN: the whole catalogue at GLOBAL, minus the one permission V1 does not
  -- implement.
  insert into public.role_permissions (role_id, permission_id, scope)
  select r.id, p.id, 'GLOBAL'::public.access_scope
  from public.roles r
  cross join public.permissions p
  where r.org_id = p_org_id
    and r.key = 'SUPER_ADMIN'
    and p.key <> 'users.impersonate'
  on conflict do nothing;

  insert into public.role_permissions (role_id, permission_id, scope)
  select r.id, p.id, m.scope::public.access_scope
  from (values
    -- ADMIN
    ('ADMIN','users.view','GLOBAL'),('ADMIN','users.create','GLOBAL'),
    ('ADMIN','users.suspend','GLOBAL'),('ADMIN','sessions.revoke','GLOBAL'),
    ('ADMIN','departments.manage','GLOBAL'),
    ('ADMIN','people.view','GLOBAL'),('ADMIN','people.edit','GLOBAL'),('ADMIN','people.export','GLOBAL'),
    ('ADMIN','engagements.transition','GLOBAL'),
    ('ADMIN','candidates.view','GLOBAL'),('ADMIN','offers.approve','GLOBAL'),
    ('ADMIN','onboarding.manage','GLOBAL'),('ADMIN','offboarding.initiate','GLOBAL'),
    ('ADMIN','projects.view','GLOBAL'),('ADMIN','projects.create','GLOBAL'),
    ('ADMIN','projects.edit','GLOBAL'),('ADMIN','projects.manage_members','GLOBAL'),
    ('ADMIN','tasks.view','GLOBAL'),('ADMIN','tasks.edit','GLOBAL'),('ADMIN','tasks.assign','GLOBAL'),
    ('ADMIN','documents.view','GLOBAL'),('ADMIN','documents.upload','GLOBAL'),('ADMIN','documents.download','GLOBAL'),
    ('ADMIN','policies.manage','GLOBAL'),('ADMIN','policies.acknowledge','SELF'),
    ('ADMIN','policies.view_compliance','GLOBAL'),
    ('ADMIN','reports.view','GLOBAL'),('ADMIN','audit_logs.view','GLOBAL'),('ADMIN','settings.manage','GLOBAL'),
    -- ADMIN (Phase 5): the full workflow sextet at GLOBAL. workflows.delete
    -- is granted to ADMIN alone outside the SUPER_ADMIN cross join.
    ('ADMIN','workflows.view','GLOBAL'),('ADMIN','workflows.create','GLOBAL'),
    ('ADMIN','workflows.edit','GLOBAL'),('ADMIN','workflows.delete','GLOBAL'),
    ('ADMIN','workflows.activate','GLOBAL'),('ADMIN','workflows.execute','GLOBAL'),

    -- HR_ADMIN
    ('HR_ADMIN','users.view','GLOBAL'),('HR_ADMIN','users.create','GLOBAL'),
    ('HR_ADMIN','users.suspend','DEPARTMENT'),('HR_ADMIN','sessions.revoke','DEPARTMENT'),
    ('HR_ADMIN','departments.manage','GLOBAL'),
    ('HR_ADMIN','people.view','GLOBAL'),('HR_ADMIN','people.edit','GLOBAL'),('HR_ADMIN','people.export','GLOBAL'),
    ('HR_ADMIN','hr.sensitive.view','GLOBAL'),('HR_ADMIN','compensation.view','GLOBAL'),
    ('HR_ADMIN','engagements.transition','GLOBAL'),
    ('HR_ADMIN','candidates.view','GLOBAL'),('HR_ADMIN','scorecards.view_all','GLOBAL'),
    ('HR_ADMIN','offers.approve','GLOBAL'),
    ('HR_ADMIN','onboarding.manage','GLOBAL'),('HR_ADMIN','offboarding.initiate','GLOBAL'),
    ('HR_ADMIN','documents.view','GLOBAL'),('HR_ADMIN','documents.upload','GLOBAL'),
    ('HR_ADMIN','documents.download','GLOBAL'),('HR_ADMIN','documents.verify','GLOBAL'),
    ('HR_ADMIN','policies.manage','GLOBAL'),('HR_ADMIN','policies.acknowledge','SELF'),
    ('HR_ADMIN','policies.view_compliance','GLOBAL'),('HR_ADMIN','reports.view','GLOBAL'),

    -- HR_MANAGER
    ('HR_MANAGER','users.view','DEPARTMENT'),
    ('HR_MANAGER','people.view','DEPARTMENT'),('HR_MANAGER','people.edit','DEPARTMENT'),
    ('HR_MANAGER','hr.sensitive.view','DEPARTMENT'),
    ('HR_MANAGER','engagements.transition','DEPARTMENT'),
    ('HR_MANAGER','candidates.view','GLOBAL'),('HR_MANAGER','scorecards.view_all','GLOBAL'),
    ('HR_MANAGER','onboarding.manage','DEPARTMENT'),('HR_MANAGER','offboarding.initiate','DEPARTMENT'),
    ('HR_MANAGER','documents.view','DEPARTMENT'),('HR_MANAGER','documents.upload','DEPARTMENT'),
    ('HR_MANAGER','documents.download','DEPARTMENT'),('HR_MANAGER','documents.verify','DEPARTMENT'),
    ('HR_MANAGER','policies.acknowledge','SELF'),('HR_MANAGER','policies.view_compliance','DEPARTMENT'),
    ('HR_MANAGER','reports.view','DEPARTMENT'),

    -- SALES_MANAGER
    ('SALES_MANAGER','people.view','DEPARTMENT'),
    ('SALES_MANAGER','candidates.view','DEPARTMENT'),('SALES_MANAGER','scorecards.view_all','DEPARTMENT'),
    ('SALES_MANAGER','onboarding.manage','DEPARTMENT'),('SALES_MANAGER','offboarding.initiate','DEPARTMENT'),
    ('SALES_MANAGER','projects.view','DEPARTMENT'),('SALES_MANAGER','projects.create','DEPARTMENT'),
    ('SALES_MANAGER','projects.edit','DEPARTMENT'),('SALES_MANAGER','projects.manage_members','DEPARTMENT'),
    ('SALES_MANAGER','tasks.view','DEPARTMENT'),('SALES_MANAGER','tasks.edit','DEPARTMENT'),
    ('SALES_MANAGER','tasks.assign','DEPARTMENT'),
    ('SALES_MANAGER','documents.view','DEPARTMENT'),('SALES_MANAGER','documents.upload','DEPARTMENT'),
    ('SALES_MANAGER','documents.download','DEPARTMENT'),
    ('SALES_MANAGER','policies.acknowledge','SELF'),('SALES_MANAGER','policies.view_compliance','DEPARTMENT'),
    ('SALES_MANAGER','reports.view','DEPARTMENT'),

    -- SALES. tasks.view / tasks.edit are the matrix S+P cells; see the note above.
    ('SALES','people.view','SELF'),('SALES','people.edit','SELF'),
    ('SALES','projects.view','SELF'),
    ('SALES','tasks.view','SELF'),('SALES','tasks.edit','SELF'),
    ('SALES','documents.view','SELF'),('SALES','documents.upload','SELF'),('SALES','documents.download','SELF'),
    ('SALES','policies.acknowledge','SELF'),('SALES','reports.view','SELF'),

    -- PROJECT_MANAGER
    ('PROJECT_MANAGER','people.view','DEPARTMENT'),
    ('PROJECT_MANAGER','candidates.view','DEPARTMENT'),('PROJECT_MANAGER','scorecards.view_all','DEPARTMENT'),
    ('PROJECT_MANAGER','onboarding.manage','DEPARTMENT'),('PROJECT_MANAGER','offboarding.initiate','DEPARTMENT'),
    ('PROJECT_MANAGER','clients.view','DEPARTMENT'),('PROJECT_MANAGER','clients.edit','DEPARTMENT'),
    ('PROJECT_MANAGER','projects.view','DEPARTMENT'),('PROJECT_MANAGER','projects.create','DEPARTMENT'),
    ('PROJECT_MANAGER','projects.edit','DEPARTMENT'),('PROJECT_MANAGER','projects.manage_members','DEPARTMENT'),
    ('PROJECT_MANAGER','tasks.view','DEPARTMENT'),('PROJECT_MANAGER','tasks.edit','DEPARTMENT'),
    ('PROJECT_MANAGER','tasks.assign','DEPARTMENT'),
    ('PROJECT_MANAGER','documents.view','DEPARTMENT'),('PROJECT_MANAGER','documents.upload','DEPARTMENT'),
    ('PROJECT_MANAGER','documents.download','DEPARTMENT'),
    ('PROJECT_MANAGER','policies.acknowledge','SELF'),('PROJECT_MANAGER','policies.view_compliance','DEPARTMENT'),
    ('PROJECT_MANAGER','reports.view','DEPARTMENT'),
    -- PROJECT_MANAGER (Phase 5): build and run automations inside their
    -- departments. No workflows.delete — deletion stays on the admin path.
    ('PROJECT_MANAGER','workflows.view','DEPARTMENT'),
    ('PROJECT_MANAGER','workflows.create','DEPARTMENT'),
    ('PROJECT_MANAGER','workflows.edit','DEPARTMENT'),
    ('PROJECT_MANAGER','workflows.activate','DEPARTMENT'),
    ('PROJECT_MANAGER','workflows.execute','DEPARTMENT'),

    -- DEVELOPER
    ('DEVELOPER','people.view','SELF'),('DEVELOPER','people.edit','SELF'),
    ('DEVELOPER','clients.view','PROJECT'),
    ('DEVELOPER','projects.view','PROJECT'),('DEVELOPER','projects.edit','PROJECT'),
    ('DEVELOPER','tasks.view','PROJECT'),('DEVELOPER','tasks.edit','PROJECT'),('DEVELOPER','tasks.assign','PROJECT'),
    ('DEVELOPER','documents.view','SELF'),('DEVELOPER','documents.upload','SELF'),('DEVELOPER','documents.download','SELF'),
    ('DEVELOPER','policies.acknowledge','SELF'),('DEVELOPER','reports.view','PROJECT'),

    -- VIBECODER
    ('VIBECODER','people.view','SELF'),('VIBECODER','people.edit','SELF'),
    ('VIBECODER','clients.view','PROJECT'),('VIBECODER','projects.view','PROJECT'),
    ('VIBECODER','tasks.view','PROJECT'),('VIBECODER','tasks.edit','PROJECT'),
    ('VIBECODER','documents.view','SELF'),('VIBECODER','documents.upload','SELF'),('VIBECODER','documents.download','SELF'),
    ('VIBECODER','policies.acknowledge','SELF'),

    -- INTERN
    ('INTERN','people.view','SELF'),('INTERN','people.edit','SELF'),
    ('INTERN','hr.sensitive.view','SELF'),
    ('INTERN','clients.view','PROJECT'),('INTERN','projects.view','PROJECT'),
    ('INTERN','tasks.view','SELF'),('INTERN','tasks.edit','SELF'),
    ('INTERN','documents.view','SELF'),('INTERN','documents.upload','SELF'),('INTERN','documents.download','SELF'),
    ('INTERN','policies.acknowledge','SELF'),

    -- FINANCE
    ('FINANCE','people.view','SELF'),('FINANCE','people.edit','SELF'),
    ('FINANCE','compensation.view','GLOBAL'),
    ('FINANCE','clients.view','GLOBAL'),('FINANCE','projects.view','GLOBAL'),
    ('FINANCE','documents.view','GLOBAL'),('FINANCE','documents.upload','GLOBAL'),('FINANCE','documents.download','GLOBAL'),
    ('FINANCE','policies.acknowledge','SELF'),('FINANCE','reports.view','GLOBAL'),

    -- EMPLOYEE
    ('EMPLOYEE','people.view','SELF'),('EMPLOYEE','people.edit','SELF'),
    ('EMPLOYEE','hr.sensitive.view','SELF'),('EMPLOYEE','compensation.view','SELF'),
    ('EMPLOYEE','tasks.view','SELF'),('EMPLOYEE','tasks.edit','SELF'),
    ('EMPLOYEE','documents.view','SELF'),('EMPLOYEE','documents.upload','SELF'),('EMPLOYEE','documents.download','SELF'),
    ('EMPLOYEE','policies.acknowledge','SELF'),

    -- ── Phase 2 CRM Core (migration 0033): the crm module replaces the legacy
    -- sales vocabulary. ADMIN/SALES_MANAGER/SALES get the new keys at the same
    -- scopes the matrix already uses for leads.* / clients.*.
    -- ADMIN
    ('ADMIN','companies.view','GLOBAL'),('ADMIN','companies.create','GLOBAL'),
    ('ADMIN','companies.edit','GLOBAL'),('ADMIN','companies.delete','GLOBAL'),
    ('ADMIN','contacts.view','GLOBAL'),('ADMIN','contacts.create','GLOBAL'),
    ('ADMIN','contacts.edit','GLOBAL'),('ADMIN','contacts.delete','GLOBAL'),
    ('ADMIN','contacts.export','GLOBAL'),
    ('ADMIN','deals.view','GLOBAL'),('ADMIN','deals.create','GLOBAL'),
    ('ADMIN','deals.edit','GLOBAL'),('ADMIN','deals.delete','GLOBAL'),
    ('ADMIN','deals.export','GLOBAL'),
    -- SALES_MANAGER
    ('SALES_MANAGER','companies.view','DEPARTMENT'),('SALES_MANAGER','companies.create','DEPARTMENT'),
    ('SALES_MANAGER','companies.edit','DEPARTMENT'),('SALES_MANAGER','companies.delete','DEPARTMENT'),
    ('SALES_MANAGER','contacts.view','DEPARTMENT'),('SALES_MANAGER','contacts.create','DEPARTMENT'),
    ('SALES_MANAGER','contacts.edit','DEPARTMENT'),('SALES_MANAGER','contacts.delete','DEPARTMENT'),
    ('SALES_MANAGER','contacts.export','DEPARTMENT'),
    ('SALES_MANAGER','deals.view','DEPARTMENT'),('SALES_MANAGER','deals.create','DEPARTMENT'),
    ('SALES_MANAGER','deals.edit','DEPARTMENT'),('SALES_MANAGER','deals.delete','DEPARTMENT'),
    ('SALES_MANAGER','deals.export','DEPARTMENT'),
    -- SALES (SELF on view/create/edit only — mirrors the leads.* SELF column:
    -- no delete, no export, no assign)
    ('SALES','companies.view','SELF'),('SALES','companies.create','SELF'),
    ('SALES','companies.edit','SELF'),
    ('SALES','contacts.view','SELF'),('SALES','contacts.create','SELF'),
    ('SALES','contacts.edit','SELF'),
    ('SALES','deals.view','SELF'),('SALES','deals.create','SELF'),
    ('SALES','deals.edit','SELF'),
    -- ── Track B: activities + relationships (migration 0034). The catalogue keys are
    -- seeded above; the matrix below grants them at the same scopes as the CRM
    -- Core rows: ADMIN at GLOBAL, SALES_MANAGER at DEPARTMENT, SALES at SELF on
    -- view/create/edit only (mirroring the leads.* SELF column: no delete).
    -- ADMIN
    ('ADMIN','activities.view','GLOBAL'),('ADMIN','activities.create','GLOBAL'),
    ('ADMIN','activities.edit','GLOBAL'),('ADMIN','activities.delete','GLOBAL'),
    ('ADMIN','relationships.view','GLOBAL'),('ADMIN','relationships.create','GLOBAL'),
    ('ADMIN','relationships.edit','GLOBAL'),('ADMIN','relationships.delete','GLOBAL'),
    -- SALES_MANAGER
    ('SALES_MANAGER','activities.view','DEPARTMENT'),('SALES_MANAGER','activities.create','DEPARTMENT'),
    ('SALES_MANAGER','activities.edit','DEPARTMENT'),('SALES_MANAGER','activities.delete','DEPARTMENT'),
    ('SALES_MANAGER','relationships.view','DEPARTMENT'),('SALES_MANAGER','relationships.create','DEPARTMENT'),
    ('SALES_MANAGER','relationships.edit','DEPARTMENT'),('SALES_MANAGER','relationships.delete','DEPARTMENT'),
    -- SALES (SELF on view/create/edit only — mirrors the leads.* SELF column)
    ('SALES','activities.view','SELF'),('SALES','activities.create','SELF'),
    ('SALES','activities.edit','SELF'),
    ('SALES','relationships.view','SELF'),('SALES','relationships.create','SELF'),
    ('SALES','relationships.edit','SELF'),
    -- ── Phase 3 sales pipeline (migration 0037): pipeline configuration is an
    -- admin surface. ADMIN holds the five keys at GLOBAL; SUPER_ADMIN gets them
    -- through the whole-catalogue cross join above. No other role is granted
    -- pipeline keys.
    -- ADMIN
    ('ADMIN','pipelines.view','GLOBAL'),('ADMIN','pipelines.create','GLOBAL'),
    ('ADMIN','pipelines.edit','GLOBAL'),('ADMIN','pipelines.delete','GLOBAL'),
    ('ADMIN','pipeline_stages.manage','GLOBAL'),
    -- ── Phase 4 work management (migration 0042): the work tables are an
    -- operational surface, not an admin surface like pipelines. MANAGER gains
    -- the project and task keys at DEPARTMENT (line management — the 0008
    -- matrix seeded MANAGER no permissions at all); ADMIN gains
    -- projects.delete and tasks.delete at GLOBAL; tasks.create rides with
    -- tasks.view at each role's existing scope, so no role gains task
    -- visibility it did not already hold. tasks.delete is deliberately NOT
    -- seeded to non-admin roles: creators delete through the work_tasks
    -- DELETE RLS policy, not through a seed grant. tasks.comment stays
    -- ungranted (fail closed) until the comments feature lands.
    -- MANAGER
    ('MANAGER','projects.view','DEPARTMENT'),('MANAGER','projects.create','DEPARTMENT'),
    ('MANAGER','projects.edit','DEPARTMENT'),
    ('MANAGER','tasks.view','DEPARTMENT'),('MANAGER','tasks.create','DEPARTMENT'),
    ('MANAGER','tasks.edit','DEPARTMENT'),
    ('MANAGER','policies.acknowledge','SELF'),
    -- ADMIN
    ('ADMIN','projects.delete','GLOBAL'),
    ('ADMIN','tasks.create','GLOBAL'),('ADMIN','tasks.delete','GLOBAL'),
    -- tasks.create rides alongside tasks.view at each role's existing scope
    ('SALES_MANAGER','tasks.create','DEPARTMENT'),
    ('PROJECT_MANAGER','tasks.create','DEPARTMENT'),
    ('DEVELOPER','tasks.create','PROJECT'),
    ('VIBECODER','tasks.create','PROJECT'),
    ('INTERN','tasks.create','SELF'),
    ('SALES','tasks.create','SELF'),
    ('EMPLOYEE','tasks.create','SELF')
  ) as m(role_key, permission_key, scope)
  join public.roles r on r.org_id = p_org_id and r.key = m.role_key
  join public.permissions p on p.key = m.permission_key
  on conflict do nothing;
end;
$$;

-- ── Backfill: existing organizations ──────────────────────────────────────────
--
-- The protection trigger guards runtime changes to the authorization model, which
-- a migration is not, so it is disabled for the insert and re-enabled immediately
-- — the same pattern migrations 0010, 0033, 0034, 0037 and 0042 used.
--
-- 17 grants per org (SUPER_ADMIN 6 + ADMIN 6 + PROJECT_MANAGER 5), all at the scopes
-- in the matrix. Only the new pairs are inserted — no legacy cleanup,
-- no re-seeding of existing grants (on conflict do nothing).
-- SUPER_ADMIN is backfilled explicitly because the six catalogue keys are new in
-- this migration: the original whole-catalogue cross join granted only the keys
-- that existed when each org was seeded.

do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgname = 'role_permissions_enforce_protection'
      and tgrelid = 'public.role_permissions'::regclass
  ) then
    alter table public.role_permissions disable trigger role_permissions_enforce_protection;
  end if;
end
$$;

--> statement-breakpoint
insert into public.role_permissions (role_id, permission_id, scope)
select r.id, p.id, m.scope::public.access_scope
from public.roles r
cross join public.permissions p
join (values
  ('SUPER_ADMIN','workflows.view','GLOBAL'),('SUPER_ADMIN','workflows.create','GLOBAL'),
  ('SUPER_ADMIN','workflows.edit','GLOBAL'),('SUPER_ADMIN','workflows.delete','GLOBAL'),
  ('SUPER_ADMIN','workflows.activate','GLOBAL'),('SUPER_ADMIN','workflows.execute','GLOBAL'),
  ('ADMIN','workflows.view','GLOBAL'),('ADMIN','workflows.create','GLOBAL'),
  ('ADMIN','workflows.edit','GLOBAL'),('ADMIN','workflows.delete','GLOBAL'),
  ('ADMIN','workflows.activate','GLOBAL'),('ADMIN','workflows.execute','GLOBAL'),
  ('PROJECT_MANAGER','workflows.view','DEPARTMENT'),
  ('PROJECT_MANAGER','workflows.create','DEPARTMENT'),
  ('PROJECT_MANAGER','workflows.edit','DEPARTMENT'),
  ('PROJECT_MANAGER','workflows.activate','DEPARTMENT'),
  ('PROJECT_MANAGER','workflows.execute','DEPARTMENT')
) as m(role_key, permission_key, scope)
  on r.key = m.role_key and p.key = m.permission_key
on conflict do nothing;

--> statement-breakpoint
do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgname = 'role_permissions_enforce_protection'
      and tgrelid = 'public.role_permissions'::regclass
  ) then
    alter table public.role_permissions enable trigger role_permissions_enforce_protection;
  end if;
end
$$;

-- ── Verification ──────────────────────────────────────────────────────────────
--
-- Fail the migration rather than leave a half-seeded authorization model: all
-- six catalogue keys must exist, and every org's SUPER_ADMIN and ADMIN system
-- roles must hold all six grants while PROJECT_MANAGER holds the five
-- non-delete keys. (Future orgs are covered by the recreated
-- seed_system_roles() above; this checks the orgs that already exist.)

do $$
declare
  v_missing_keys int;
  v_missing_grants int;
begin
  select count(*) into v_missing_keys
  from (values
    ('workflows.view'),
    ('workflows.create'),
    ('workflows.edit'),
    ('workflows.delete'),
    ('workflows.activate'),
    ('workflows.execute')
  ) as k(key)
  where not exists (
    select 1 from public.permissions p where p.key = k.key
  );
  if v_missing_keys > 0 then
    raise exception 'workflow permission catalogue incomplete: % of 6 keys missing',
      v_missing_keys;
  end if;

  select count(*) into v_missing_grants
  from public.roles r
  cross join (values
    ('SUPER_ADMIN','workflows.view'),('SUPER_ADMIN','workflows.create'),
    ('SUPER_ADMIN','workflows.edit'),('SUPER_ADMIN','workflows.delete'),
    ('SUPER_ADMIN','workflows.activate'),('SUPER_ADMIN','workflows.execute'),
    ('ADMIN','workflows.view'),('ADMIN','workflows.create'),
    ('ADMIN','workflows.edit'),('ADMIN','workflows.delete'),
    ('ADMIN','workflows.activate'),('ADMIN','workflows.execute'),
    ('PROJECT_MANAGER','workflows.view'),('PROJECT_MANAGER','workflows.create'),
    ('PROJECT_MANAGER','workflows.edit'),('PROJECT_MANAGER','workflows.activate'),
    ('PROJECT_MANAGER','workflows.execute')
  ) as k(role_key, key)
  where r.is_system
    and r.key = k.role_key
    and not exists (
      select 1
      from public.role_permissions rp
      join public.permissions p on p.id = rp.permission_id
      where rp.role_id = r.id
        and p.key = k.key
    );
  if v_missing_grants > 0 then
    raise exception 'workflow role grants incomplete: % role/key pairs missing',
      v_missing_grants;
  end if;
end
$$;
