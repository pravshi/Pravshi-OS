-- PRAVSHI OS — Phase 3 exit fix: pipeline assignment on deal creation + recovery.
--
-- WHAT BROKE
--
--   Migration 0037 added deals.pipeline_id / deals.pipeline_stage_id and seeded
--   one default pipeline per EXISTING org, but:
--     1. src/lib/crm/deals.ts createDeal() never wrote the two columns, so every
--        deal created after 0037 got NULL pipeline columns;
--     2. the deals_pipeline_immutable() trigger rejects NULL → value assignment,
--        and no API assigned a pipeline afterward — such deals could never enter
--        any pipeline (moveDealToStage 400s with "not assigned to a pipeline");
--     3. seed_system_roles() (redefined by 0037) seeds roles for new orgs but no
--        default pipeline, so organizations created after 0037 have no default
--        pipeline at all.
--
-- WHAT THIS MIGRATION DOES
--
--   1. seed_default_pipeline(p_org_id): idempotent helper that creates the
--      default pipeline (with the six legacy stages) for an org that lacks a
--      live default. Called once per existing org below, and from the
--      organizations_seed_system_roles trigger for every org created from here
--      on — every organization is born with a default pipeline.
--   2. crm_default_pipeline_stage(p_stage_name): SECURITY DEFINER resolver the
--      deal-creation service calls to pick the org's default pipeline and the
--      initial stage (exact legacy-name match → terminal-flag match for
--      WON/LOST → first stage by position). Callers holding only deals.create
--      cannot SELECT pipeline_stages (no pipelines.view), so the resolution
--      happens here, with org isolation and pipeline liveness enforced inside.
--   3. crm_resolve_pipeline_stage_by_name(p_pipeline_id, p_stage_name):
--      SECURITY DEFINER resolver the deal-update service calls so a PATCH of
--      the legacy `stage` dual-writes pipeline_stage_id (firing the history
--      trigger) instead of diverging from it.
--   4. Stranded-deal recovery: deals with NULL pipeline_id are backfilled into
--      their org's default pipeline (stage resolved exactly like the resolvers
--      above). The deals_pipeline_immutable() trigger is disabled for the
--      single backfill UPDATE and re-enabled immediately — the trigger keeps
--      its strict form (NULL → value still raises at runtime; assignment
--      stays INSERT-only), so no permanent loophole is opened.
--   5. crm_soft_delete(): the 'pipeline' branch gains the live-deal guard the
--      service layer already enforces, so a direct call cannot strand deals on
--      a soft-deleted pipeline.
--
-- Re-runnable: every step is guarded (IF NOT EXISTS / pre-checks / DO blocks
-- that no-op when the work is done), so a second run changes nothing.

-- ═════════════════════════════════════════════════════════════════════════════════
-- 1. seed_default_pipeline() — idempotent default-pipeline seeder
-- ═════════════════════════════════════════════════════════════════════════════════

create or replace function public.seed_default_pipeline(p_org_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pipeline_id uuid;
begin
  -- Idempotent: an org that already has a live default keeps it, untouched.
  select p.id into v_pipeline_id
  from public.pipelines p
  where p.org_id = p_org_id
    and p.is_default
    and p.deleted_at is null
  limit 1;
  if v_pipeline_id is not null then
    return v_pipeline_id;
  end if;

  insert into public.pipelines (org_id, name, description, is_default)
  values (p_org_id, 'Sales Pipeline', 'The default sales pipeline', true)
  returning id into v_pipeline_id;

  -- The six legacy stage names, mirroring the 0037 seed exactly so the legacy
  -- `deals.stage` text maps 1:1 onto the default pipeline.
  insert into public.pipeline_stages
    (org_id, pipeline_id, name, position, probability, color, is_won, is_lost)
  select p_org_id, v_pipeline_id, s.name, s.position, s.probability, s.color,
         s.is_won, s.is_lost
  from (values
    ('NEW',         0,  10, '#6B7280', false, false),
    ('QUALIFIED',   1,  25, '#3B82F6', false, false),
    ('PROPOSAL',    2,  50, '#8B5CF6', false, false),
    ('NEGOTIATION', 3,  75, '#F59E0B', false, false),
    ('WON',         4, 100, '#10B981', true,  false),
    ('LOST',        5,   0, '#EF4444', false, true)
  ) as s(name, position, probability, color, is_won, is_lost);

  return v_pipeline_id;
end;
$$;

comment on function public.seed_default_pipeline(uuid) is
  'Idempotent: creates the default sales pipeline (with the six legacy '
  'stages) for an org that lacks a live default; returns the existing '
  'default''s id otherwise. Called by the 0039 backfill and by the '
  'organizations_seed_system_roles trigger for every new organization.';

revoke all on function public.seed_default_pipeline(uuid) from public;

-- ═════════════════════════════════════════════════════════════════════════════════
-- 2. Backfill: organizations created after 0037 never got a default pipeline
-- ═════════════════════════════════════════════════════════════════════════════════

do $$
declare
  o record;
begin
  for o in
    select org.id
    from public.organizations org
    where not exists (
      select 1
      from public.pipelines p
      where p.org_id = org.id
        and p.is_default
        and p.deleted_at is null
    )
  loop
    perform public.seed_default_pipeline(o.id);
  end loop;
end
$$;

-- ═════════════════════════════════════════════════════════════════════════════════
-- 3. Every organization created from here on is born with a default pipeline
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The trigger (from 0008) is unchanged; only its function body grows. The
-- pipeline seed runs in the same statement as the role seed, so an org can
-- never exist without both.

create or replace function public.organizations_seed_system_roles() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.seed_system_roles(new.id);
  -- 0039: a new organization needs a default pipeline the moment it exists —
  -- deal creation assigns it unconditionally (see crm_default_pipeline_stage).
  perform public.seed_default_pipeline(new.id);
  return null;
end;
$$;

comment on function public.organizations_seed_system_roles() is
  'Every organization gets the system roles at creation, so no tenant can exist without '
  'the role definitions the protected-role rule is anchored to. Since 0039 it also '
  'gets a default sales pipeline (seed_default_pipeline), so deal creation always '
  'has a pipeline to assign.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- 4. crm_resolve_pipeline_stage_by_name() — legacy name → stage, SECURITY DEFINER
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Shared ranking used by both resolvers below:
--   1. exact stage-name match inside the pipeline;
--   2. terminal-flag match (WON → is_won, LOST → is_lost) for pipelines whose
--      stage names were customized away from the legacy six;
--   3. the pipeline's first stage by position.
-- A pipeline with no stages resolves to zero rows (the caller fails closed).

create or replace function public.crm_resolve_pipeline_stage_by_name(
  p_pipeline_id uuid,
  p_stage_name text
)
returns table (stage_id uuid, stage_name text, is_won boolean, is_lost boolean)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  -- SECURITY DEFINER, like crm_resolve_pipeline_stage (0038): callers holding
  -- only deals.create / deals.edit cannot SELECT pipeline_stages (no
  -- pipelines.view), so the resolution happens here. Tenant isolation and
  -- pipeline liveness are enforced explicitly below: nothing leaves this
  -- function that does not belong to the caller's live org. A stage id from
  -- another org, or on a soft-deleted pipeline, yields zero rows —
  -- indistinguishable from "no such stage" by design.
  return query
  select ps.id, ps.name, ps.is_won, ps.is_lost
  from public.pipeline_stages ps
  join public.pipelines p
    on p.id = ps.pipeline_id
  where ps.pipeline_id = p_pipeline_id
    and ps.org_id = authz.org_id()
    and p.org_id = authz.org_id()
    and p.deleted_at is null
  order by
    (ps.name = p_stage_name) desc,
    ((p_stage_name = 'WON' and ps.is_won) or (p_stage_name = 'LOST' and ps.is_lost)) desc,
    ps.position asc,
    ps.id asc
  limit 1;
end;
$$;

comment on function public.crm_resolve_pipeline_stage_by_name(uuid, text) is
  'SECURITY DEFINER resolver: a legacy deal stage name → the best-matching '
  'stage of the given pipeline (exact name, then WON/LOST terminal flags, then '
  'first by position). Enforces tenant isolation and pipeline liveness '
  'explicitly; zero rows for unknown, cross-org, or soft-deleted-pipeline '
  'stages. Used by deal creation and by the deal-update dual-write.';

revoke all on function public.crm_resolve_pipeline_stage_by_name(uuid, text) from public;
grant execute on function public.crm_resolve_pipeline_stage_by_name(uuid, text) to app_user;

-- ═════════════════════════════════════════════════════════════════════════════════
-- 5. crm_default_pipeline_stage() — the deal-creation assignment
-- ═════════════════════════════════════════════════════════════════════════════════

create or replace function public.crm_default_pipeline_stage(p_stage_name text)
returns table (
  pipeline_id uuid,
  stage_id uuid,
  stage_name text,
  is_won boolean,
  is_lost boolean
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_pipeline_id uuid;
begin
  -- The partial unique index pipelines_one_default_per_org guarantees at most
  -- one live default per org; LIMIT 1 is belt and braces.
  select p.id into v_pipeline_id
  from public.pipelines p
  where p.org_id = authz.org_id()
    and p.is_default
    and p.deleted_at is null
  limit 1;

  if v_pipeline_id is null then
    -- No default pipeline: the service fails closed with a 400 telling the
    -- caller an administrator must create one. Zero rows, no exception —
    -- indistinguishable handling, like the 0038 resolver.
    return;
  end if;

  return query
  select v_pipeline_id, r.stage_id, r.stage_name, r.is_won, r.is_lost
  from public.crm_resolve_pipeline_stage_by_name(v_pipeline_id, p_stage_name) r;
end;
$$;

comment on function public.crm_default_pipeline_stage(text) is
  'SECURITY DEFINER resolver for deal creation: the caller''s org''s live '
  'default pipeline plus the initial stage for a legacy stage name (exact '
  'name, then WON/LOST terminal flags, then first by position). Zero rows when '
  'the org has no live default pipeline — the service fails closed.';

revoke all on function public.crm_default_pipeline_stage(text) from public;
grant execute on function public.crm_default_pipeline_stage(text) to app_user;

-- ═════════════════════════════════════════════════════════════════════════════════
-- 6. crm_soft_delete(): the 'pipeline' branch refuses pipelines with live deals
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The service layer (deletePipeline) already checks this, but a direct call to
-- the SECURITY DEFINER function bypassed it and stranded deals on a
-- soft-deleted pipeline (their pipeline_id would point at a pipeline the
-- stage resolver treats as dead). The check moves into the function as the
-- backstop — the same defense-in-depth posture as the M1 permission check.
-- Replaces the 0037 definition wholesale; every other branch is byte-identical.

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
  -- 0039 (LOW 4c): a pipeline with live deals cannot be soft-deleted, even by
  -- a direct call that bypasses the service layer's pre-check. Stranding
  -- deals on a deleted pipeline would break moves (the stage resolver treats
  -- deleted pipelines as dead) and silently drop them from the forecast.
  if p_entity = 'pipeline' then
    perform 1
    from public.deals d
    where d.pipeline_id = p_id
      and d.org_id = authz.org_id()
      and d.deleted_at is null
    limit 1;
    if found then
      raise exception 'pipeline has live deals and cannot be deleted'
        using errcode = '42501';
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
-- 7. Stranded-deal recovery: backfill NULL pipeline_id / pipeline_stage_id
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Deals created while createDeal() did not write the pipeline columns are
-- stranded: the deals_pipeline_immutable() trigger rejects NULL → value
-- assignment, so the backfill disables that trigger for its own UPDATE and
-- re-enables it immediately. The trigger keeps its strict form — at runtime,
-- pipeline_id assignment stays INSERT-only (the pinned tests still assert
-- 42501 on NULL → value). The UPDATE fires deals_record_stage_history the
-- same way the 0037 backfill did: one creation row per deal (from_stage_id
-- NULL, changed_by NULL — the migration runs without an authenticated actor).
--
-- Stage resolution mirrors the resolvers above: exact legacy-name match,
-- then the WON/LOST terminal flags, then the pipeline's first stage.

do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgname = 'deals_pipeline_immutable'
      and tgrelid = 'public.deals'::regclass
  ) then
    alter table public.deals disable trigger deals_pipeline_immutable;
  end if;
end
$$;

update public.deals d
set pipeline_id = r.pipeline_id,
    pipeline_stage_id = r.stage_id
from (
  -- The CTE keeps the UPDATE target out of the FROM list: PostgreSQL forbids
  -- referencing the updated table inside a JOIN's ON clause (the 0037 bug) or
  -- inside a LATERAL subquery (42P10). Inside the CTE, deals is a plain FROM
  -- relation, so the LATERAL reference is legal.
  select d.id as deal_id,
         p.id as pipeline_id,
         s.id as stage_id
  from public.deals d
  join public.pipelines p
    on p.org_id = d.org_id
   and p.is_default
   and p.deleted_at is null
  cross join lateral (
    select ps.id
    from public.pipeline_stages ps
    where ps.pipeline_id = p.id
      and ps.org_id = d.org_id
    order by
      (ps.name = d.stage) desc,
      ((d.stage = 'WON' and ps.is_won) or (d.stage = 'LOST' and ps.is_lost)) desc,
      ps.position asc,
      ps.id asc
    limit 1
  ) s
  where d.pipeline_id is null
    and d.deleted_at is null
) r
where d.id = r.deal_id;

do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgname = 'deals_pipeline_immutable'
      and tgrelid = 'public.deals'::regclass
  ) then
    alter table public.deals enable trigger deals_pipeline_immutable;
  end if;
end
$$;

-- ═════════════════════════════════════════════════════════════════════════════════
-- 8. Verification — fail the migration rather than leave a half-fixed model
-- ═════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_orgs_without_default int;
  v_stranded_deals int;
  v_trigger_missing int;
begin
  select count(*) into v_orgs_without_default
  from public.organizations o
  where not exists (
    select 1
    from public.pipelines p
    where p.org_id = o.id
      and p.is_default
      and p.deleted_at is null
  );
  if v_orgs_without_default > 0 then
    raise exception '0039: % organization(s) still lack a live default pipeline',
      v_orgs_without_default;
  end if;

  select count(*) into v_stranded_deals
  from public.deals d
  where d.pipeline_id is null
    and d.deleted_at is null;
  if v_stranded_deals > 0 then
    raise exception '0039: % live deal(s) still have no pipeline', v_stranded_deals;
  end if;

  select count(*) into v_trigger_missing
  from pg_trigger
  where tgname = 'deals_pipeline_immutable'
    and tgrelid = 'public.deals'::regclass
    and tgenabled = 'O';
  if v_trigger_missing = 0 then
    raise exception '0039: deals_pipeline_immutable is not enabled after the backfill';
  end if;
end
$$;
