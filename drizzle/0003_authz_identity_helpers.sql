-- PRAVSHI OS — Phase 1 Task 1.3: the authz identity primitives.
--
-- Completes the helpers whose tables and semantics exist today, and deliberately does
-- not invent the ones that do not.
--
-- IMPLEMENTED HERE
--   authz.person_id()          the authenticated person, validated against people
--   authz.is_active_person()   identity-level liveness — NOT the engagement check
--   authz.org_id()             DERIVED from the person, not accepted from the caller
--   authz.aal()                assurance level, read-only until MFA exists
--
-- DEFERRED, with the table each one needs
--   authz.is_active()          engagements                    → Task 1.5
--   authz.my_departments()     departments, person_departments → Task 1.4
--   authz.reports_to_me()      engagements.manager_person_id  → Task 1.5
--   authz.scope_for(), has()   roles, permissions, role_permissions → Tasks 1.7/1.8
--   authz.is_project_member()  project_members                → Phase 4
--   authz.has_record_grant()   record_grants                  → Task 1.9
--
-- No stub, no placeholder, no "return true for now". A helper that exists and answers
-- permissively is worse than one that does not exist, because callers will use it and
-- reviewers will assume it works.

-- ── person_id() — identity, validated ────────────────────────────────────────────
--
-- Task 1.2 read the setting and trusted it. That was enough to express SELF scope, but
-- it meant a soft-deleted or deactivated person still produced a usable authorization
-- identity: the row was gone from every policy's view, yet person_id() still named them.
--
-- The identity is now resolved against `people` on every call, so a person who is
-- deleted or not ACTIVE yields NULL, and every policy written in terms of person_id()
-- inherits that without being rewritten.
--
-- Reading `people` from inside a policy that itself calls this function does not recurse:
-- SECURITY DEFINER runs as app_owner, so the people_owner_all policy applies and it does
-- not call any helper. Verified against a live branch before this migration was written.
create or replace function authz.person_id() returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.people p
  where p.id = nullif(current_setting('app.person_id', true), '')::uuid
    and p.deleted_at is null
    and p.person_status = 'ACTIVE'
$$;

comment on function authz.person_id() is
  'The authenticated person, validated against people: NULL when there is no identity '
  'context, when the id does not exist, or when the person is soft-deleted or not ACTIVE.';

-- ── is_active_person() — identity liveness, NOT authorization ────────────────────
--
-- Named apart from the planned authz.is_active() on purpose. is_active() answers "is
-- this person currently engaged to work here", which is a question about `engagements`
-- and cannot be answered until Task 1.5. This answers only "is this identity usable at
-- all". Conflating the two would let a person with no live engagement keep access, which
-- is precisely the failure the engagement model exists to prevent.
create or replace function authz.is_active_person() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select authz.person_id() is not null
$$;

comment on function authz.is_active_person() is
  'Identity-level liveness only. NOT the engagement-based authz.is_active(), which '
  'arrives with Task 1.5 and is the check that authorization must ultimately use.';

-- ── org_id() — derived, never accepted ───────────────────────────────────────────
--
-- The organization is a property of the person, so it is read from the person. A caller
-- cannot select its own tenant.
--
-- `app.org_id` is still consulted, but only to DENY: if the application claims an
-- organization that is not the person's, that is a bug or an attack, and the answer is
-- NULL rather than the derived value. The claim can never widen access — it can only
-- fail the request closed. Absent claim, the derived value stands.
create or replace function authz.org_id() returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.org_id
  from public.people p
  where p.id = authz.person_id()
    and (
      nullif(current_setting('app.org_id', true), '') is null
      or p.org_id = nullif(current_setting('app.org_id', true), '')::uuid
    )
$$;

comment on function authz.org_id() is
  'The organization of the authenticated person, derived from people. A mismatching '
  'app.org_id claim denies (returns NULL); it can never grant a different tenant.';

-- ── aal() — assurance level ──────────────────────────────────────────────────────
--
-- Unchanged in behaviour, and deliberately so: TOTP enrolment and verification arrive
-- with Task 1.13, and until they do nothing in the system establishes assurance.
--
-- CAUTION FOR FUTURE POLICIES: this value is set by the application from AuthContext and
-- is NOT yet cryptographically established. It must not gate a sensitive surface until
-- Task 1.13 makes it mean something. Reading it is safe; trusting it is not.
create or replace function authz.aal() returns text
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(current_setting('app.aal', true), '')
$$;

comment on function authz.aal() is
  'Authentication assurance level from the transaction context. NOT verified until MFA '
  'lands in Task 1.13 — do not gate sensitive access on this yet.';

-- ── grants ───────────────────────────────────────────────────────────────────────
-- No PUBLIC execute on any of them. CREATE OR REPLACE preserves existing grants, so the
-- revoke/grant pair is repeated to keep the migration correct on a database where these
-- functions were created by 0002 and on one where they were not.

revoke all on function authz.person_id() from public;
revoke all on function authz.is_active_person() from public;
revoke all on function authz.org_id() from public;
revoke all on function authz.aal() from public;

grant execute on function authz.person_id() to app_user, app_admin;
grant execute on function authz.is_active_person() to app_user, app_admin;
grant execute on function authz.org_id() to app_user, app_admin;
grant execute on function authz.aal() to app_user, app_admin;
