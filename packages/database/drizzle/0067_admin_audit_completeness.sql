-- ═════════════════════════════════════════════════════════════════════════════
-- 0067_admin_audit_completeness — every department and team administration
-- action writes exactly one audit entry, in the same transaction as the change
-- (multi-tenant audit WP-T1, finding MT-H3)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE GAP. The six administrative write functions from 0028 — create_department,
-- archive_department, create_team, update_team, archive_team, set_team_members —
-- are the only writers of departments, teams and team_members, and none of them
-- recorded anything: those tables carry no audit_row_change trigger and the
-- services (src/lib/admin/departments.ts, teams.ts) wrote no entry. An org
-- administrator could restructure the organization without a trace.
--
-- WHY NOT ROW TRIGGERS. A row-level audit trigger writes one entry per changed
-- row, so archive_team (team + every membership) or set_team_members (one row per
-- person added or removed) would produce many entries for one administrative
-- action. The requirement is one entry per action, so each function writes ONE
-- entry itself, as its last statement, with the before/after of the action.
--
-- WHAT EACH ENTRY HOLDS. write_audit_log() (0011) derives the actor and the
-- organization from the transaction identity — they cannot be passed in — and
-- stamps the time. The request id comes from the transaction-local setting
-- app.request_id, which the calling service sets from its Authorization just
-- before the call (absent or malformed → NULL, never an error). Payloads carry
-- codes, names and ids only — nothing secret exists in these tables.
--
-- CONSISTENCY. The entry is written inside the function, so it commits with the
-- change or not at all: an audit failure rolls the change back (fail-closed), and
-- a refused change (not found, already archived, foreign person) raises before
-- the entry is written, so no entry claims a change that did not happen.
--
-- Function bodies are otherwise VERBATIM from 0028: same checks, same errors,
-- same grants. person_departments has no writer anywhere in the codebase, so
-- there is nothing to audit there yet.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── the request id carried by the calling service ───────────────────────────
create or replace function public.audit_request_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when current_setting('app.request_id', true)
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then current_setting('app.request_id', true)::uuid
  end
$$;

comment on function public.audit_request_id() is
  'The transaction-local app.request_id as a uuid, or NULL when unset or malformed. '
  'Set by the admin services before calling an audited write function (0067).';

revoke all on function public.audit_request_id() from public;
grant execute on function public.audit_request_id() to app_user;

--> statement-breakpoint

-- ── departments ─────────────────────────────────────────────────────────────
create or replace function public.create_department(p_code text, p_name text, p_parent_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
  v_id uuid;
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  if v_org_id is null or v_actor is null then
    raise exception 'create_department requires an authorized transaction'
      using errcode = '42501';
  end if;

  if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{1,15}$' then
    raise exception 'department code must match ^[A-Z][A-Z0-9_]{1,15}$'
      using errcode = 'P0001';
  end if;

  if p_name is null or length(btrim(p_name)) = 0 then
    raise exception 'department name is required'
      using errcode = 'P0001';
  end if;

  if p_parent_id is not null and not exists (
    select 1 from public.departments d
    where d.id = p_parent_id
      and d.org_id = v_org_id
      and d.deleted_at is null
  ) then
    raise exception 'parent department not found in this organization'
      using errcode = 'P0001';
  end if;

  insert into public.departments (org_id, code, name, parent_id)
  values (v_org_id, p_code, p_name, p_parent_id)
  returning id into v_id;

  perform public.write_audit_log(
    p_action := 'department.created',
    p_entity_type := 'department',
    p_entity_id := v_id,
    p_severity := 'MEDIUM',
    p_after := jsonb_build_object('code', p_code, 'name', p_name, 'parent_id', p_parent_id),
    p_request_id := public.audit_request_id());

  return v_id;
end;
$$;

create or replace function public.archive_department(p_department_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
  v_code text;
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  if v_org_id is null or v_actor is null then
    raise exception 'archive_department requires an authorized transaction'
      using errcode = '42501';
  end if;

  update public.departments
  set status = 'ARCHIVED', updated_at = now()
  where id = p_department_id
    and org_id = v_org_id
    and deleted_at is null
    and status = 'ACTIVE'
  returning code into v_code;

  if not found then
    raise exception 'department not found or already archived'
      using errcode = 'P0001';
  end if;

  perform public.write_audit_log(
    p_action := 'department.archived',
    p_entity_type := 'department',
    p_entity_id := p_department_id,
    p_severity := 'MEDIUM',
    p_before := jsonb_build_object('status', 'ACTIVE'),
    p_after := jsonb_build_object('status', 'ARCHIVED'),
    p_metadata := jsonb_build_object('code', v_code),
    p_request_id := public.audit_request_id());
end;
$$;

--> statement-breakpoint

-- ── teams ───────────────────────────────────────────────────────────────────
create or replace function public.create_team(p_department_id uuid, p_name text, p_lead_person_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
  v_id uuid;
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  if v_org_id is null or v_actor is null then
    raise exception 'create_team requires an authorized transaction'
      using errcode = '42501';
  end if;

  if p_name is null or length(btrim(p_name)) = 0 then
    raise exception 'team name is required'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.departments d
    where d.id = p_department_id
      and d.org_id = v_org_id
      and d.deleted_at is null
      and d.status = 'ACTIVE'
  ) then
    raise exception 'department not found in this organization'
      using errcode = 'P0001';
  end if;

  if p_lead_person_id is not null and not exists (
    select 1 from public.people p
    where p.id = p_lead_person_id
      and p.org_id = v_org_id
      and p.deleted_at is null
  ) then
    raise exception 'team lead not found in this organization'
      using errcode = 'P0001';
  end if;

  insert into public.teams (org_id, department_id, name, lead_person_id)
  values (v_org_id, p_department_id, p_name, p_lead_person_id)
  returning id into v_id;

  perform public.write_audit_log(
    p_action := 'team.created',
    p_entity_type := 'team',
    p_entity_id := v_id,
    p_severity := 'MEDIUM',
    p_after := jsonb_build_object(
      'department_id', p_department_id, 'name', p_name, 'lead_person_id', p_lead_person_id),
    p_request_id := public.audit_request_id());

  return v_id;
end;
$$;

create or replace function public.update_team(p_team_id uuid, p_name text, p_lead_person_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
  v_before jsonb;
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  if v_org_id is null or v_actor is null then
    raise exception 'update_team requires an authorized transaction'
      using errcode = '42501';
  end if;

  if p_name is null or length(btrim(p_name)) = 0 then
    raise exception 'team name is required'
      using errcode = 'P0001';
  end if;

  if p_lead_person_id is not null and not exists (
    select 1 from public.people p
    where p.id = p_lead_person_id
      and p.org_id = v_org_id
      and p.deleted_at is null
  ) then
    raise exception 'team lead not found in this organization'
      using errcode = 'P0001';
  end if;

  select jsonb_build_object('name', t.name, 'lead_person_id', t.lead_person_id)
    into v_before
  from public.teams t
  where t.id = p_team_id
    and t.org_id = v_org_id
    and t.deleted_at is null;

  update public.teams
  set name = p_name,
      lead_person_id = p_lead_person_id,
      updated_at = now()
  where id = p_team_id
    and org_id = v_org_id
    and deleted_at is null;

  if not found then
    raise exception 'team not found in this organization'
      using errcode = 'P0001';
  end if;

  perform public.write_audit_log(
    p_action := 'team.updated',
    p_entity_type := 'team',
    p_entity_id := p_team_id,
    p_severity := 'MEDIUM',
    p_before := v_before,
    p_after := jsonb_build_object('name', p_name, 'lead_person_id', p_lead_person_id),
    p_request_id := public.audit_request_id());
end;
$$;

create or replace function public.archive_team(p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
  v_members_ended integer;
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  if v_org_id is null or v_actor is null then
    raise exception 'archive_team requires an authorized transaction'
      using errcode = '42501';
  end if;

  -- Soft-delete the team and end its active memberships in the same statement
  -- set, so no orphaned membership outlives its team.
  update public.team_members
  set deleted_at = now(), updated_at = now()
  where team_id = p_team_id
    and org_id = v_org_id
    and deleted_at is null;
  get diagnostics v_members_ended = row_count;

  update public.teams
  set deleted_at = now(), updated_at = now()
  where id = p_team_id
    and org_id = v_org_id
    and deleted_at is null;

  if not found then
    raise exception 'team not found in this organization'
      using errcode = 'P0001';
  end if;

  -- One entry for the action; the memberships it ended are counted, not
  -- listed as entries of their own.
  perform public.write_audit_log(
    p_action := 'team.archived',
    p_entity_type := 'team',
    p_entity_id := p_team_id,
    p_severity := 'MEDIUM',
    p_metadata := jsonb_build_object('memberships_ended', v_members_ended),
    p_request_id := public.audit_request_id());
end;
$$;

--> statement-breakpoint

-- ── set_team_members ────────────────────────────────────────────────────────
create or replace function public.set_team_members(p_team_id uuid, p_person_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_actor uuid;
  v_before uuid[];
  v_after uuid[];
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  if v_org_id is null or v_actor is null then
    raise exception 'set_team_members requires an authorized transaction'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.teams t
    where t.id = p_team_id
      and t.org_id = v_org_id
      and t.deleted_at is null
  ) then
    raise exception 'team not found in this organization'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1 from unnest(p_person_ids) as pid
    where not exists (
      select 1 from public.people p
      where p.id = pid
        and p.org_id = v_org_id
        and p.deleted_at is null
    )
  ) then
    raise exception 'one or more people are not members of this organization'
      using errcode = 'P0001';
  end if;

  select coalesce(array_agg(tm.person_id order by tm.person_id), '{}')
    into v_before
  from public.team_members tm
  where tm.team_id = p_team_id
    and tm.org_id = v_org_id
    and tm.deleted_at is null;

  -- End memberships that are not in the new set.
  update public.team_members
  set deleted_at = now(), updated_at = now()
  where team_id = p_team_id
    and org_id = v_org_id
    and deleted_at is null
    and not (person_id = any (p_person_ids));

  -- Rejoiners: reactivate their most recent tombstoned membership instead of
  -- inserting a duplicate row.
  update public.team_members tm
  set deleted_at = null, updated_at = now()
  from (
    select distinct on (person_id) id
    from public.team_members
    where team_id = p_team_id
      and org_id = v_org_id
      and person_id = any (p_person_ids)
      and deleted_at is not null
    order by person_id, deleted_at desc
  ) rejoin
  where tm.id = rejoin.id;

  -- Brand-new members: insert rows for people with no active membership.
  insert into public.team_members (org_id, team_id, person_id)
  select v_org_id, p_team_id, pid
  from unnest(p_person_ids) as pid
  where not exists (
    select 1 from public.team_members tm2
    where tm2.team_id = p_team_id
      and tm2.person_id = pid
      and tm2.deleted_at is null
  );

  select coalesce(array_agg(tm.person_id order by tm.person_id), '{}')
    into v_after
  from public.team_members tm
  where tm.team_id = p_team_id
    and tm.org_id = v_org_id
    and tm.deleted_at is null;

  perform public.write_audit_log(
    p_action := 'team.members_changed',
    p_entity_type := 'team',
    p_entity_id := p_team_id,
    p_severity := 'MEDIUM',
    p_before := jsonb_build_object('person_ids', to_jsonb(v_before)),
    p_after := jsonb_build_object('person_ids', to_jsonb(v_after)),
    p_metadata := jsonb_build_object(
      'added', (select count(*) from unnest(v_after) a where not (a = any (v_before))),
      'removed', (select count(*) from unnest(v_before) b where not (b = any (v_after)))),
    p_request_id := public.audit_request_id());
end;
$$;

--> statement-breakpoint

-- ── verification ────────────────────────────────────────────────────────────
do $$
declare
  v_problems text;
begin
  select string_agg(fn, '; ') into v_problems
  from (values
    ('create_department(text,text,uuid)'),
    ('archive_department(uuid)'),
    ('create_team(uuid,text,uuid)'),
    ('update_team(uuid,text,uuid)'),
    ('archive_team(uuid)'),
    ('set_team_members(uuid,uuid[])')
  ) as f(fn)
  where not exists (
    select 1 from pg_proc p
    where p.oid = to_regprocedure('public.' || f.fn)
      and p.prosecdef
      and coalesce('search_path=""' = any (p.proconfig), false)
      and pg_get_functiondef(p.oid) like '%public.write_audit_log(%'
  )
  or not has_function_privilege('app_user', 'public.' || f.fn, 'execute')
  or has_function_privilege('public', 'public.' || f.fn, 'execute');

  if v_problems is not null then
    raise exception 'admin audit completeness incomplete for: %', v_problems;
  end if;
end;
$$;
