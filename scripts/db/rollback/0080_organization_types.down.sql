-- Rollback for 0080_organization_types — restores the 0079 state.
--
-- Prepared in advance, as for 0073, 0075, 0077, 0078 and 0079: never invented at incident time.
-- Run as the migration owner (app_owner), only with the founder's approval for the
-- named database, and only if 0080 must be undone. It does NOT remove 0080's row from
-- drizzle.__drizzle_migrations: the history stays a record of what was applied, and
-- re-applying 0080 later is a forward migration decision.
--
-- What this removes: the organization-type catalog, the versioned templates, and each
-- organization's recorded type and template version. New organizations are again seeded
-- by 0039's hard-coded six-stage default pipeline. Pipelines already seeded from a
-- template are organization data and are NOT removed.
--
-- It REFUSES to run while any organization is on anything but generic_crm version 1:
-- dropping the columns would silently erase which type and version that organization was
-- created from. Resolve those organizations first (a separate, approved decision).

begin;

set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.organizations
              where type_key <> 'generic_crm' or template_version <> 1) then
    raise exception '0080 rollback refused: an organization is not on generic_crm version 1';
  end if;
end
$$;

drop trigger if exists organizations_type_guard on public.organizations;
drop function if exists public.organizations_type_guard();

drop function if exists public.upgrade_organization_template(uuid, integer);

-- 0039's seed_default_pipeline, word for word.
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

drop function if exists public.seed_template_pipelines(uuid, jsonb);

alter table public.organizations
  drop constraint if exists organizations_template_fk,
  drop constraint if exists organizations_type_fk;
drop index if exists public.organizations_type_idx;
alter table public.organizations
  drop column if exists template_version,
  drop column if exists type_key;

drop table if exists public.organization_type_templates;
drop function if exists public.organization_type_templates_guard();
drop table if exists public.organization_types;
drop function if exists public.organization_template_definition_valid(jsonb);

commit;
