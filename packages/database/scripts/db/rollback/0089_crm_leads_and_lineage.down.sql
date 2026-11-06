-- Rollback for 0089_crm_leads_and_lineage — restores the 0088 state.
--
-- Prepared in advance. Run as the migration owner, in one transaction, only with the founder's
-- approval for the named database. It does NOT remove 0089's row from the history.
--
-- What this removes: 6 tables (crm_leads, crm_lead_assignment_history, crm_assignment_cursors,
-- crm_lead_tasks, crm_dedup_candidates, crm_lead_attribution_corrections) with their triggers
-- (guards, actor stamping, row audit), and the 0089 functions (the two guards, the actor stamp,
-- the edit-scope helper, the attribution mutator); drops added columns from contacts and
-- activities, and restores activities_entity_type check constraint. Audit entries already
-- written to audit_logs are append-only and stay.
--
-- Refuses unless the database is exactly at 0089.

begin;

set local lock_timeout = '5s';

do $$
begin
  if (select count(*) from drizzle.__drizzle_migrations) <> 89 then
    raise exception '0089 rollback refused: the database is not at 0089 (roll back later migrations first)';
  end if;
end;
$$;

-- Drop security triggers and functions
drop trigger if exists crm_leads_attribution_guard on public.crm_leads;
drop trigger if exists crm_leads_owner_guard on public.crm_leads;
drop trigger if exists crm_leads_actor_stamp on public.crm_leads;
drop trigger if exists crm_lead_tasks_actor_stamp on public.crm_lead_tasks;
drop function if exists public.guard_crm_lead_attribution();
drop function if exists public.guard_crm_lead_owner_change();
drop function if exists public.crm_stamp_actor();
drop function if exists public.apply_lead_attribution_correction(uuid);

drop trigger if exists crm_lead_assignment_history_guard on public.crm_lead_assignment_history;
drop function if exists public.guard_crm_lead_assignment_history();

-- Drop new tables in reverse dependency order (their audit triggers go with them)
drop table if exists public.crm_lead_attribution_corrections cascade;
drop table if exists public.crm_dedup_candidates cascade;
drop table if exists public.crm_lead_tasks cascade;
drop table if exists public.crm_assignment_cursors cascade;
drop table if exists public.crm_lead_assignment_history cascade;
drop table if exists public.crm_leads cascade;

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

