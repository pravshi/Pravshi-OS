-- Rollback for 0089_crm_leads_and_lineage — restores the 0088 state.
--
-- Prepared in advance. Run as the migration owner, in one transaction, only with the founder's
-- approval for the named database. It does NOT remove 0089's row from the history.
--
-- What this removes: 6 tables (crm_leads, crm_lead_assignment_history, crm_assignment_cursors,
-- crm_lead_tasks, crm_dedup_candidates, crm_lead_attribution_corrections) with their policies and
-- triggers (guards, actor stamping, row audit), and the 0089 functions (the attribution, owner and
-- dedup guards, the actor stamp, the edit-scope helper, the attribution mutator); drops the
-- columns 0089 added to contacts (merge pointers) and activities (logged_at), and restores the
-- 0088 activities_entity_type check. Audit entries already written to audit_logs are append-only
-- and stay.
--
-- DATA CONSEQUENCES — read before approving:
--   * Every lead, task, dedup candidate, assignment-history entry and attribution correction is
--     dropped with its table.
--   * It REFUSES while any activity is linked to a lead (entity_type = 'lead'): the 0088 check
--     cannot hold those rows, and deleting them silently is not this script's decision.
--   * It REFUSES while any contact records a merge (merged_into_contact_id set): dropping the
--     columns would silently undo recorded merges.
--   Each refusal names what to decide first. Roll the APPLICATION back with the database: the
--   0089 application code reads these tables and columns.
--
-- Refuses unless the database is at exactly THIS revision of 0089 (count, checksum and timing of
-- the last history row): earlier revisions of 0089 were pushed to the PR branch with different
-- contents (one created re_lead_preferences), and this script would not fully undo them.

begin;

set local lock_timeout = '5s';

do $$
declare
  v_last record;
begin
  if (select count(*) from drizzle.__drizzle_migrations) <> 89 then
    raise exception '0089 rollback refused: the database is not at 0089 (roll back later migrations first)';
  end if;
  select hash, created_at into v_last from drizzle.__drizzle_migrations order by id desc limit 1;
  if v_last.hash <> '8de1b87403e8d5bece5a82bc3ebe45ba337a5188bd8e4a6e3f3d3c4719e0330d'
     or v_last.created_at <> 1791604728057 then
    raise exception '0089 rollback refused: the applied 0089 is not the revision this script undoes (checksum or timing differs)';
  end if;
  if exists (select 1 from public.activities where entity_type = 'lead') then
    raise exception '0089 rollback refused: activities are linked to leads; decide their disposal first (the 0088 check cannot hold them)';
  end if;
  if exists (select 1 from public.contacts where merged_into_contact_id is not null) then
    raise exception '0089 rollback refused: contacts record merges; decide how to preserve them first (dropping the columns would undo them)';
  end if;
end;
$$;

-- Drop security triggers and functions
drop trigger if exists crm_leads_attribution_guard on public.crm_leads;
drop trigger if exists crm_leads_owner_guard on public.crm_leads;
drop trigger if exists crm_leads_actor_stamp on public.crm_leads;
drop trigger if exists crm_lead_tasks_actor_stamp on public.crm_lead_tasks;
drop trigger if exists crm_dedup_candidates_identity_guard on public.crm_dedup_candidates;
drop function if exists public.guard_crm_lead_attribution();
drop function if exists public.guard_crm_lead_owner_change();
drop function if exists public.crm_stamp_actor();
drop function if exists public.guard_crm_dedup_candidate_identity();
drop function if exists public.apply_lead_attribution_correction(uuid);

drop trigger if exists crm_lead_assignment_history_guard on public.crm_lead_assignment_history;
drop function if exists public.guard_crm_lead_assignment_history();

-- Drop new tables, children before crm_leads (their policies and audit triggers go with them).
-- No CASCADE: an unexpected dependent object must stop the rollback, not be dropped silently.
drop table if exists public.crm_lead_attribution_corrections;
drop table if exists public.crm_dedup_candidates;
drop table if exists public.crm_lead_tasks;
drop table if exists public.crm_assignment_cursors;
drop table if exists public.crm_lead_assignment_history;
drop table if exists public.crm_leads;

-- Referenced by crm_lead_attr_corr_insert, so only after its table is gone.
drop function if exists public.crm_lead_in_edit_scope(uuid, uuid);

-- Revert altered contacts table
alter table public.contacts
  drop constraint if exists contacts_no_self_merge,
  drop constraint if exists contacts_merged_into_same_org,
  drop column if exists merged_into_contact_id,
  drop column if exists merged_at,
  drop column if exists merge_reason;

-- Revert altered activities table
drop index if exists public.activities_org_lead_timeline_idx;

alter table public.activities
  drop column if exists logged_at;

alter table public.activities
  drop constraint if exists activities_entity_type;

alter table public.activities
  add constraint activities_entity_type
  check (entity_type in ('company', 'contact', 'deal'));

commit;
