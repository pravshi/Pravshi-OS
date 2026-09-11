-- PRAVSHI OS — Phase 1 Task 1.11: audit event integration, the trigger source.
--
-- Blueprint section 19.3 names two sources for the audit log: "Database triggers cover
-- create/update/delete on sensitive tables (THEY CANNOT BE FORGOTTEN). The application
-- layer adds intent — logins, denied authorizations, downloads, exports, role changes,
-- revocations — which triggers cannot see."
--
-- Task 1.10 built the table, the partitions, the append-only guarantee and the writer, and
-- left nothing writing to it. This connects the first source. The second — intent — arrives
-- with requirePermission() in Task 1.15 and is not this task.
--
-- The whole argument for triggers is the parenthesis. A service that remembers to audit is
-- a service that audits until somebody adds a code path in a hurry. A trigger fires on the
-- application, on psql, on a migration, on a bulk load, and on the path nobody thought of.
--
-- ── HISTORY BEGINS HERE ──────────────────────────────────────────────────────────
--
-- No backfill is attempted and none is possible: rows changed before this migration left no
-- record of who changed them, and inventing entries for them would be worse than having
-- none. The audit log is complete from this migration forward, not from the first migration.

-- ── the payload filter ───────────────────────────────────────────────────────────
--
-- Authorization tables are captured whole; they contain no personal data, and the whole row
-- is what an access review needs. `people` and `engagements` are captured through an
-- explicit column allow-list instead, because audit_logs is readable by every holder of
-- audit_logs.view at GLOBAL and there is no reason for a date of birth, a phone number or a
-- home address to be sitting in it. The allow-list is stated on each trigger below rather
-- than hidden in here, so the audited surface of a table is visible where it is attached.
create function public.audit_payload(p_row jsonb, p_columns text[]) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_row is null then null
    when p_columns is null then p_row
    else coalesce(
      (select jsonb_object_agg(e.key, e.value) from jsonb_each(p_row) e where e.key = any(p_columns)),
      '{}'::jsonb)
  end
$$;

comment on function public.audit_payload(jsonb, text[]) is
  'Reduces a row image to an allow-list of columns, or passes it through when the list is '
  'null. Reads nothing and writes nothing.';

revoke all on function public.audit_payload(jsonb, text[]) from public;

-- ── the trigger ──────────────────────────────────────────────────────────────────
--
-- One function, configured per table through TG_ARGV, so the audited surface of every table
-- is declared at the point the trigger is attached:
--
--   TG_ARGV[0]  entity_type   singular, lower_snake_case, the record_grants convention
--   TG_ARGV[1]  severity      HIGH for authority, MEDIUM for identity
--   TG_ARGV[2]  id column     which column names the SUBJECT of the change
--   TG_ARGV[3]  allow-list    optional; absent means capture the whole row
--
-- ── WHY IT SKIPS WHEN NOBODY IS ACTING ───────────────────────────────────────────
--
-- write_audit_log() raises when the transaction names no person. That is right for the
-- application — an unattributed audit entry is not an audit entry — but a trigger has no
-- say in what fires it. seed_system_roles() alone writes fourteen roles and roughly 270
-- grants for every organization created, from a migration, with no human anywhere near it.
-- A trigger that insisted on an actor would take organization creation down with it.
--
-- So: no resolvable actor, no entry, and the underlying write proceeds untouched. The
-- alternative was relaxing write_audit_log() to accept a null actor, which would have
-- reopened an approved Task 1.10 decision and put rows with no attribution into the one
-- table whose entire value is attribution.
--
-- WHAT THIS COSTS, stated plainly: a change made by a migration or a seed leaves no audit
-- entry. Nothing is fabricated to paper over it — there is no system actor and no synthetic
-- identity. Migrations are reviewed and committed to git, which is their audit trail.
--
-- ── WHY IT IS SECURITY DEFINER ───────────────────────────────────────────────────
--
-- It resolves the actor against `people` and must see the truth. As the invoking role it
-- would read `people` through FORCE RLS, where the SELF policy depends on
-- authz.person_id() — which returns NULL for a suspended or deleted person. The audit
-- entries for those people are the ones Task 1.10 went out of its way to keep, so resolving
-- through a filtered view would silently drop exactly the wrong ones. Same resolution as
-- write_audit_log() and for the same reason: identity, not authorization.
--
-- The actor is never taken from the row. There is no column on any audited table that can
-- put somebody else's name on a change.
create function public.audit_row_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity_type text := tg_argv[0];
  v_severity text := tg_argv[1];
  v_id_column text := tg_argv[2];
  v_columns text[] := case
    when tg_nargs > 3 and tg_argv[3] <> '' then string_to_array(tg_argv[3], ',')
    else null
  end;
  v_actor uuid;
  v_action text;
  v_entity_id uuid;
  v_before jsonb;
  v_after jsonb;
begin
  select p.id into v_actor
  from public.people p
  where p.id = nullif(current_setting('app.person_id', true), '')::uuid;

  if v_actor is null then
    return null;
  end if;

  v_action := v_entity_type || '.' || case tg_op
    when 'INSERT' then 'created'
    when 'UPDATE' then 'updated'
    else 'deleted'
  end;

  -- The subject is read from the UNFILTERED row, so an allow-list that omitted the key
  -- column could not quietly produce entries that point at nothing.
  if tg_op = 'DELETE' then
    v_entity_id := (to_jsonb(old) ->> v_id_column)::uuid;
  else
    v_entity_id := (to_jsonb(new) ->> v_id_column)::uuid;
  end if;

  if tg_op <> 'INSERT' then
    v_before := public.audit_payload(to_jsonb(old), v_columns);
  end if;
  if tg_op <> 'DELETE' then
    v_after := public.audit_payload(to_jsonb(new), v_columns);
  end if;

  -- The organization comes from write_audit_log(), which derives it from the actor. An
  -- entry therefore records the tenant the change was made FROM, which is the question an
  -- investigator is asking. The credential redaction inside that function still applies.
  perform public.write_audit_log(
    p_action := v_action,
    p_entity_type := v_entity_type,
    p_result := 'SUCCESS'::public.audit_result,
    p_entity_id := v_entity_id,
    p_severity := v_severity,
    p_before := v_before,
    p_after := v_after);

  return null;
end;
$$;

comment on function public.audit_row_change() is
  'Records a row change in audit_logs through write_audit_log(). Skips silently when the '
  'transaction names no actor, so migrations and seeds are never blocked and no identity is '
  'ever fabricated.';

revoke all on function public.audit_row_change() from public;

-- ── the allow-list ───────────────────────────────────────────────────────────────
--
-- Seven tables, and deliberately no others.
--
-- audit_logs carries no trigger: it would recurse, and the table is already append-only for
-- every role including app_owner, so there is nothing a trigger could add.
--
-- engagement_events carries no trigger either. It is already immutable lifecycle history
-- written by a trigger of its own, so auditing it would record the same event twice under
-- two names. The access-affecting mutation is the `engagements` row that produced it, and
-- that is what is audited.

-- Authority and configuration: captured whole, HIGH.
create trigger roles_audit
  after insert or update or delete on public.roles
  for each row execute function public.audit_row_change('role', 'HIGH', 'id');

create trigger permissions_audit
  after insert or update or delete on public.permissions
  for each row execute function public.audit_row_change('permission', 'HIGH', 'id');

-- role_permissions and person_roles have composite keys and no id column of their own, so
-- the subject is the row the change is ABOUT: which role gained a permission, and which
-- person gained a role. The other half of the key is in the payload.
create trigger role_permissions_audit
  after insert or update or delete on public.role_permissions
  for each row execute function public.audit_row_change('role_permission', 'HIGH', 'role_id');

create trigger person_roles_audit
  after insert or update or delete on public.person_roles
  for each row execute function public.audit_row_change('person_role', 'HIGH', 'person_id');

create trigger record_grants_audit
  after insert or update or delete on public.record_grants
  for each row execute function public.audit_row_change('record_grant', 'HIGH', 'id');

-- Identity: allow-listed, MEDIUM.
--
-- people — the access-affecting surface and nothing else. person_status and deleted_at
-- decide whether authz.person_id() will name them at all; auth_user_id is the login
-- linkage; sessions_revoked_at is bulk session invalidation. `code` is the human-readable
-- identifier and is not sensitive. Deliberately absent: full_legal_name, preferred_name,
-- both email addresses, phone, date_of_birth, photo_url, location, timezone. None of them
-- change what anybody can reach, and audit_logs is read by everyone holding
-- audit_logs.view at GLOBAL.
create trigger people_audit
  after insert or update or delete on public.people
  for each row execute function public.audit_row_change(
    'person', 'MEDIUM', 'id',
    'id,org_id,code,person_status,auth_user_id,sessions_revoked_at,deleted_at,updated_at');

-- engagements — the fields that decide access. status drives authz.is_active();
-- department_id and team_id drive authz.my_departments() and DEPARTMENT scope;
-- manager_person_id will drive reports_to_me(); is_primary and deleted_at decide which
-- engagement counts. Deliberately absent: job_title, work_location, employment_mode, the
-- date fields, exit_reason and exit_type, which are HR facts rather than access facts.
create trigger engagements_audit
  after insert or update or delete on public.engagements
  for each row execute function public.audit_row_change(
    'engagement', 'MEDIUM', 'id',
    'id,org_id,person_id,engagement_type,status,department_id,team_id,manager_person_id,is_primary,deleted_at,updated_at');

-- ── on disabling these ───────────────────────────────────────────────────────────
--
-- ALTER TABLE ... DISABLE TRIGGER requires table ownership, which app_user and app_admin do
-- not have, so no application operation can switch auditing off. Migration 0010 disables
-- role_permissions_enforce_protection by name for a single statement; naming one trigger
-- leaves the others alone, so role_permissions_audit stays armed through it. During that
-- statement there is no actor anyway, so it would skip rather than record.
