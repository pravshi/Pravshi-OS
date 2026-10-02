-- PRAVSHI OS — Pipeline stage membership guard (DB-level backstop).
--
-- WHAT THIS MIGRATION DOES
--
--   Strengthens public.deals_pipeline_org_guard() (CREATE OR REPLACE; the
--   trigger itself is unchanged): a deal's pipeline_stage_id must belong to
--   the deal's pipeline_id, not merely to the same org. This closes the
--   cross-pipeline stage assignment hole at the database level — the single-
--   column FKs cannot express stage↔pipeline membership, and 0037's guard
--   only checked org membership.
--
--   moveDealToStage's API check stays the primary enforcement point (it
--   answers 400 with a friendlier message); this trigger is the backstop no
--   writer can bypass, even with direct SQL.
--
-- WHY IT IS SAFE
--
--   - The 0037 backfill assigned pipeline_id and pipeline_stage_id together
--     from the same (pipeline, stage) pair, and 0039's recovery does the
--     same — no existing row violates the new assertion.
--   - The assertion only fires when NEW.pipeline_stage_id IS NOT NULL, so
--     legacy rows with both columns NULL (and every UPDATE that leaves them
--     alone) pass untouched.
--   - A stage with no pipeline is incoherent and is rejected: when
--     NEW.pipeline_stage_id is set but NEW.pipeline_id is null, the
--     membership check fails closed (42501).
--
-- ═════════════════════════════════════════════════════════════════════════════════
-- deals_pipeline_org_guard() — strengthened: stage must belong to the pipeline
-- ═════════════════════════════════════════════════════════════════════════════════

create or replace function public.deals_pipeline_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pipeline_org uuid;
  v_stage_org uuid;
  v_stage_pipeline uuid;
begin
  if new.pipeline_id is not null then
    select p.org_id into v_pipeline_org
    from public.pipelines p
    where p.id = new.pipeline_id;
    if v_pipeline_org is distinct from new.org_id then
      raise exception 'pipeline_id must belong to the deal''s organization'
        using errcode = '42501';
    end if;
  end if;
  if new.pipeline_stage_id is not null then
    select s.org_id, s.pipeline_id into v_stage_org, v_stage_pipeline
    from public.pipeline_stages s
    where s.id = new.pipeline_stage_id;
    if v_stage_org is distinct from new.org_id then
      raise exception 'pipeline_stage_id must belong to the deal''s organization'
        using errcode = '42501';
    end if;
    -- The stage must live in the deal's pipeline — not just in the same org.
    -- moveDealToStage's API check is the primary enforcement point (it
    -- answers 400 with a friendlier message); this is the backstop no writer
    -- can bypass. A stage with no pipeline is incoherent and rejected too:
    -- v_stage_pipeline IS DISTINCT FROM NULL when new.pipeline_id is null.
    if v_stage_pipeline is distinct from new.pipeline_id then
      raise exception 'pipeline_stage_id must belong to the deal''s pipeline'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.deals_pipeline_org_guard() is
  'BEFORE INSERT/UPDATE on deals: pipeline_id and pipeline_stage_id must belong '
  'to NEW.org_id (0037), and pipeline_stage_id must additionally belong to '
  'NEW.pipeline_id — the DB-level backstop for cross-pipeline stage '
  'assignment. Closes the tenant-isolation and stage-membership holes the '
  'single-column FKs leave open; raises 42501.';
