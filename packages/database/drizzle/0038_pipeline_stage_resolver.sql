-- PRAVSHI OS — Phase 3: pipeline stage resolver (SECURITY DEFINER).
--
-- WHY THIS FUNCTION EXISTS
--
-- POST /api/crm/deals/:id/move requires only deals.edit — a key held by
-- SALES_MANAGER and SALES. But the API's stage-membership validation probe
-- ("SELECT ... FROM pipeline_stages WHERE id = $to") runs under FORCE RLS as
-- the caller, and pipeline_stages SELECT requires pipelines.view — a key held
-- by SUPER_ADMIN and ADMIN only (0037). So every sales user's probe sees zero
-- stage rows and the move fails closed with 400, even for perfectly valid
-- stage targets. Granting pipelines.view to sales roles would expose pipeline
-- configuration to the whole sales force, which is not wanted.
--
-- crm_resolve_pipeline_stage() is the surgical fix: a SECURITY DEFINER
-- resolver that bypasses RLS for a single stage id and returns just enough
-- metadata to validate and process the move. It NEVER lists stages and it
-- NEVER reveals anything about stages outside the caller's org:
--
--   * Tenant isolation is enforced explicitly in the query:
--     ps.org_id = authz.org_id(). A stage id from another org returns zero
--     rows — indistinguishable from "stage does not exist" — so cross-org
--     existence cannot be probed (no exception is raised either way).
--   * Pipeline liveness is enforced: the stage is joined to its pipeline and
--     resolved only when p.deleted_at IS NULL. Stages of soft-deleted
--     pipelines are unresolvable.
--   * Unknown stage ids likewise return zero rows. The API maps zero rows to
--     400 unknown stage in all three cases.
--
-- The function returns metadata only (pipeline_id, stage_name, is_won,
-- is_lost) for the one stage it was asked about. Listing stages, browsing
-- pipeline configuration, or reading anything beyond a single id still
-- requires pipelines.view; the 0037 RLS policies are untouched.

create or replace function public.crm_resolve_pipeline_stage(p_stage_id uuid)
returns table (pipeline_id uuid, stage_name text, is_won boolean, is_lost boolean)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  -- SECURITY DEFINER runs as the function owner (app_owner), so this query
  -- bypasses the pipeline_stages RLS policies that hide stages from sales
  -- roles. The tenant filter and the pipeline-liveness join below are the
  -- explicit compensating controls: nothing leaves this function that does
  -- not belong to the caller's live org.
  return query
  select ps.pipeline_id, ps.name, ps.is_won, ps.is_lost
  from public.pipeline_stages ps
  join public.pipelines p
    on p.id = ps.pipeline_id
  where ps.id = p_stage_id
    and ps.org_id = authz.org_id()
    and p.deleted_at is null;
end;
$$;

comment on function public.crm_resolve_pipeline_stage(uuid) is
  'SECURITY DEFINER resolver for a single pipeline stage by id: bypasses '
  'pipeline_stages RLS for callers holding only deals.edit, but enforces '
  'tenant isolation (ps.org_id = authz.org_id()) and pipeline liveness '
  '(p.deleted_at IS NULL) explicitly. Returns metadata for the one stage '
  'only — never lists stages — and zero rows (no exception) for unknown, '
  'cross-org, or soft-deleted-pipeline stages.';

revoke all on function public.crm_resolve_pipeline_stage(uuid) from public;
grant execute on function public.crm_resolve_pipeline_stage(uuid) to app_user;
