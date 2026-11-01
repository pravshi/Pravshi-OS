-- ═════════════════════════════════════════════════════════════════════════════
-- 0077_deal_history_and_org_identity — deal-stage history is written only by its
-- trigger (Phase 3, MT-L6); an organization's id and slug are fixed once it is
-- created (Phase 3, MT-L1)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- MT-L6. public.deal_stage_history is written by deals_record_stage_history()
-- (0037), a SECURITY DEFINER trigger that runs in the deal write's own
-- transaction and stamps changed_by from authz.person_id(). 0037 also gave
-- app_user an INSERT policy (deal_stage_history_insert, gated on deals.edit) "so
-- the table is not silently unwritable outside the trigger path". No code inserts
-- through it, and it let anyone executing SQL as app_user with deals.edit insert
-- rows the trigger never would: another organization's stage or person ids (the
-- single-column foreign keys ignore RLS), a changed_by naming a colleague, any
-- changed_at, any from/to pair. Those rows feed the CRM lead and velocity
-- analytics and the "latest history row" lookups behind workflow and webhook
-- deduplication. Dropping the policy removes the path; the trigger keeps writing
-- as its definer, and its rows stay readable through deal_stage_history_select.
-- The INSERT and UPDATE grants go too (UPDATE already had no policy, 0037 F3):
-- the policy drop is the durable control, because scripts/db/roles.sql re-grants
-- select, insert, update on every table when it is re-run.
--
-- MT-L1. Nothing stopped a write to public.organizations.id or .slug. No runtime
-- role can update organizations at all (0002: no UPDATE grant, owner-only write
-- policy), and changing the id of an organization that has rows already fails on
-- the foreign keys (23503). The tenancy root should still be fixed by the
-- database, not by those accidents: a BEFORE UPDATE trigger refuses any change of
-- id or slug with 23514, the code the other identity freezes use (people.code
-- 0002, jobs/schedules 0061). status, deleted_at, name and every other column stay
-- writable — suspension, archiving and the test fixtures depend on that. A future
-- audited rename path (platform design, WP-T4) would be a deliberate exception
-- added by its own migration.
--
-- Both controls stop runtime roles and accidents. The table owner (app_owner)
-- can still disable a trigger or re-create a policy; that boundary is the
-- migration review, not this file.
--
-- No data is rewritten and no rows are read. Takes brief locks on
-- deal_stage_history (policy drop, revoke) and organizations (trigger create),
-- held until the migration commits. lock_timeout bounds the wait: if either lock
-- is not granted within 5 s (a long transaction, or audit-partition maintenance
-- holding organizations), the migration fails with nothing committed and is
-- retried, instead of queueing every deal move behind it.
-- Rollback: scripts/db/rollback/0077_deal_history_and_org_identity.down.sql.

set local lock_timeout = '5s';

-- ── MT-L6 ────────────────────────────────────────────────────────────────────

drop policy if exists deal_stage_history_insert on public.deal_stage_history;

revoke insert, update on public.deal_stage_history from app_user, app_admin;

-- ── MT-L1 ────────────────────────────────────────────────────────────────────

create function public.organizations_identity_freeze() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- slug is citext; compare as text so a case-only rename is refused too, whatever
  -- operator the search_path would otherwise resolve.
  if new.id is distinct from old.id or new.slug::text is distinct from old.slug::text then
    raise exception 'an organization''s id and slug are fixed once it is created'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.organizations_identity_freeze() is
  'BEFORE UPDATE on organizations: refuses any change of id or slug (MT-L1, 0077).';

revoke all on function public.organizations_identity_freeze() from public;

create trigger organizations_identity_freeze
  before update on public.organizations
  for each row execute function public.organizations_identity_freeze();

-- ── Verification: the migration fails rather than leave either gap open ─────

do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'deal_stage_history'
      and cmd in ('INSERT', 'UPDATE', 'ALL')
      and roles && array['app_user', 'app_admin', 'public']::name[]
  ) then
    raise exception '0077: a runtime role still has a write policy on deal_stage_history';
  end if;
  if has_table_privilege('app_user', 'public.deal_stage_history', 'INSERT')
     or has_table_privilege('app_user', 'public.deal_stage_history', 'UPDATE') then
    raise exception '0077: app_user still holds INSERT or UPDATE on deal_stage_history';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.organizations'::regclass
      and tgname = 'organizations_identity_freeze'
      and tgenabled = 'O' and not tgisinternal
  ) then
    raise exception '0077: organizations_identity_freeze is missing or disabled';
  end if;
  -- The recorder keeps writing history only as a definer owned by the table's
  -- owner (whose owner-only policy admits it under FORCE RLS).
  if not exists (
    select 1 from pg_proc p, pg_class c
    where p.oid = 'public.deals_record_stage_history()'::regprocedure and p.prosecdef
      and c.oid = 'public.deal_stage_history'::regclass and p.proowner = c.relowner
  ) then
    raise exception '0077: deals_record_stage_history must stay SECURITY DEFINER, owned by the table owner';
  end if;
end;
$$;
