-- Rollback for 0089_crm_leads_and_lineage — restores the 0088 state.
--
-- Prepared in advance. Run as the migration owner, in one transaction, only with the founder's
-- approval for the named database. It does NOT remove 0089's row from the history.
--
-- What this removes: the 6 CRM tables (crm_leads, crm_lead_assignment_history,
-- crm_assignment_cursors, crm_lead_tasks, crm_dedup_candidates, crm_lead_attribution_corrections)
-- and the operational crm_statement_identity table, with their policies and triggers; the 15
-- functions 0089 creates; the three leads.attribution.* permissions and every grant of them; the
-- columns 0089 added to contacts (merge pointers) and activities (logged_at); and it restores the
-- 0088 activities_entity_type check. Audit entries already written to audit_logs are append-only
-- and stay. An organization's settings.attribution value (set through
-- set_lead_attribution_policy) is left in place: 0088 never reads it.
--
-- DATA CONSEQUENCES — read before approving:
--   * Every lead, task, dedup candidate, assignment-history entry and attribution correction is
--     dropped with its table, and every role loses the three attribution permissions.
--   * It REFUSES while any activity is linked to a lead (entity_type = 'lead'): the 0088 check
--     cannot hold those rows, and deleting them silently is not this script's decision.
--   * It REFUSES while any contact records a merge (merged_into_contact_id set): dropping the
--     columns would silently undo recorded merges.
--   * It REFUSES while any record grant names a leads.attribution.* permission (the 0081
--     pattern): revoke those grants first.
--   The tables these refusals inspect are locked first, so nothing can change between the checks
--   and the drops.
--   Each refusal names what to decide first. Roll the APPLICATION back with the database: the
--   0089 application code reads these tables, columns and permissions.
--
-- PRECONDITIONS (all fail closed — a missing, empty or inconsistent value is a refusal):
--   * the history has exactly 89 rows, numbered without gaps, none with a missing or empty
--     checksum or a missing timing;
--   * its last row is THIS revision of 0089 (checksum and timing below) and is the only row at or
--     after that timing — earlier revisions of 0089 were pushed to the PR branch with different
--     contents (one created re_lead_preferences), and this script would not fully undo them.

begin;

set local lock_timeout = '5s';

-- Lock what the refusals below inspect before inspecting it (the 0081/0088 pattern), so nothing
-- checked here can change between the check and the drop: no lead activity, contact merge,
-- record grant or role grant can be committed by another session meanwhile.
lock table public.contacts, public.activities, public.record_grants, public.role_permissions
  in exclusive mode;

do $$
declare
  v_count bigint;
  v_min integer;
  v_max integer;
  v_incomplete bigint;
  v_last_hash text;
  v_last_created_at bigint;
  v_at_or_after bigint;
begin
  select count(*), min(id), max(id),
         count(*) filter (where hash is null or btrim(hash) = '' or created_at is null)
    into v_count, v_min, v_max, v_incomplete
  from drizzle.__drizzle_migrations;

  if v_count is distinct from 89 then
    raise exception '0089 rollback refused: the database is not at 0089 (roll back later migrations first)';
  end if;
  if v_incomplete is distinct from 0 then
    raise exception '0089 rollback refused: the migration history has rows with a missing or empty checksum or timing';
  end if;
  if v_max - v_min + 1 is distinct from v_count then
    raise exception '0089 rollback refused: the migration history is not numbered without gaps';
  end if;

  select hash, created_at into v_last_hash, v_last_created_at
  from drizzle.__drizzle_migrations order by id desc limit 1;
  if v_last_hash is distinct from '752f9f4582ff163c591cf08a4615168d6b89b92b41efee91cc337ea2c10cfe27'
     or v_last_created_at is distinct from 1791604728057 then
    raise exception '0089 rollback refused: the applied 0089 is not the revision this script undoes (checksum or timing differs)';
  end if;

  select count(*) into v_at_or_after
  from drizzle.__drizzle_migrations where created_at >= 1791604728057;
  if v_at_or_after is distinct from 1 then
    raise exception '0089 rollback refused: the migration history is inconsistent (more than one row at or after the 0089 timing)';
  end if;

  if exists (select 1 from public.activities where entity_type = 'lead') then
    raise exception '0089 rollback refused: activities are linked to leads; decide their disposal first (the 0088 check cannot hold them)';
  end if;
  if exists (select 1 from public.contacts where merged_into_contact_id is not null) then
    raise exception '0089 rollback refused: contacts record merges; decide how to preserve them first (dropping the columns would undo them)';
  end if;
  if exists (
    select 1 from public.record_grants g
    join public.permissions p on p.id = g.permission_id
    where p.key in ('leads.attribution.request', 'leads.attribution.approve',
                    'leads.attribution.single_manager')
  ) then
    raise exception '0089 rollback refused: record grants name a leads.attribution.* permission; revoke them first';
  end if;
end;
$$;

-- Drop the tables, children before crm_leads (their policies and triggers go with them).
-- No CASCADE: an unexpected dependent object must stop the rollback, not be dropped silently.
drop table if exists public.crm_lead_attribution_corrections;
drop table if exists public.crm_dedup_candidates;
drop table if exists public.crm_lead_tasks;
drop table if exists public.crm_assignment_cursors;
drop table if exists public.crm_lead_assignment_history;
drop table if exists public.crm_leads;
drop table if exists public.crm_statement_identity;

-- The functions, now that no trigger or policy refers to them.
drop function if exists public.apply_lead_attribution_correction(uuid);
drop function if exists public.reject_lead_attribution_correction(uuid, text);
drop function if exists public.crm_decide_lead_attribution_correction(uuid, boolean, text);
drop function if exists public.set_lead_attribution_policy(text);
drop function if exists public.crm_attribution_policy();
drop function if exists public.crm_lead_in_scope(text, uuid, uuid);
drop function if exists public.crm_record_lead_assignment();
drop function if exists public.crm_assert_statement_identity();
drop function if exists public.crm_capture_statement_identity();
drop function if exists public.guard_crm_dedup_candidate_identity();
drop function if exists public.crm_stamp_actor();
drop function if exists public.guard_crm_lead_owner_change();
drop function if exists public.guard_crm_lead_server_fields();
drop function if exists public.guard_crm_lead_attribution();
drop function if exists public.guard_crm_lead_assignment_history();

-- The attribution permissions and their grants (SUPER_ADMIN is a protected role: its grants are
-- changed with the protection trigger off, exactly as 0089 and 0081 add them).
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

delete from public.role_permissions rp
using public.permissions p
where p.id = rp.permission_id
  and p.key in ('leads.attribution.request', 'leads.attribution.approve',
                'leads.attribution.single_manager');

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

delete from public.permissions
where key in ('leads.attribution.request', 'leads.attribution.approve',
              'leads.attribution.single_manager');

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
