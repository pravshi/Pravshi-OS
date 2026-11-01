-- PRAVSHI OS — Phase 1 Task 1.13: TOTP, and making aal2 mean something.
--
-- Blueprint section 25: "TOTP, available to everyone, mandatory for SUPER_ADMIN, ADMIN,
-- HR_ADMIN and FINANCE. Sensitive surfaces require aal2, and because the level is set into
-- the transaction context alongside the person id, RLS ITSELF CAN REQUIRE IT — it cannot be
-- skipped by calling an API directly."
--
-- Task 1.3 created authz.aal() as a plain reader of app.aal and attached a warning to it:
-- "this value is set by the application from AuthContext and is NOT yet cryptographically
-- established. It must not gate a sensitive surface until Task 1.13 makes it mean
-- something. Reading it is safe; trusting it is not." This is that task.
--
-- ── WHAT MAKES A SESSION aal2, AND WHAT DOES NOT ─────────────────────────────────
--
-- NOT "the person has MFA enrolled". Enrolment is a property of the person; assurance is a
-- property of THIS session. Conflating them would mean a session minted before enrolment,
-- or by any future path that skips the challenge, silently inherits the higher level.
--
-- So the session row carries its own answer, written when the row is created and never
-- updated afterwards: aal2 only when the request that minted it was a two-factor
-- verification, aal1 for everything else. Better Auth mints a session after 2FA only in
-- verify-two-factor.ts, which consumes the challenge cookie ATOMICALLY before creating it —
-- so a replayed challenge cannot produce a second session.
--
-- ── AND THE DATABASE DOES NOT SIMPLY BELIEVE IT ──────────────────────────────────
--
-- app.aal is still set by the application, and an application that can set a GUC can set
-- the wrong one. authz.aal() therefore treats the claim the way authz.org_id() has treated
-- a mismatched tenant claim since Task 1.3: it can only ever DENY. A request claiming aal2
-- for a person who is not enrolled gets aal1 — the claim cannot widen access, only fail
-- closed.

-- ── two_factor_enabled on the login ──────────────────────────────────────────────
-- Better Auth's twoFactor plugin adds this to the user model. It answers "is a second
-- factor configured", not "was one used", which is why it is not the thing aal2 is read
-- from — but it is what authz.aal() checks the claim against.
alter table auth.auth_users
  add column two_factor_enabled boolean not null default false;

comment on column auth.auth_users.two_factor_enabled is
  'Whether a verified second factor exists for this login. Enrolment, not assurance: it says '
  'a factor is configured, never that it was used on any particular session.';

-- ── the assurance level of a session ─────────────────────────────────────────────
--
-- Declared to Better Auth as a session additionalField with input: false, so no client can
-- supply it. It is set once by the session-creation hook and never updated: a session does
-- not gain assurance after the fact, it is minted with it or without it.
alter table auth.auth_sessions
  add column aal text not null default 'aal1';

alter table auth.auth_sessions
  add constraint auth_sessions_aal_valid check (aal in ('aal1', 'aal2'));

comment on column auth.auth_sessions.aal is
  'The assurance this session was established at. aal2 only when the request that created '
  'it was a two-factor verification; aal1 otherwise. Written at creation, never upgraded.';

-- ── the factor itself ────────────────────────────────────────────────────────────
--
-- Columns are Better Auth's twoFactor model, in the auth schema and under the auth_*
-- naming convention Task 1.12 established.
--
-- WHAT IS IN secret AND backup_codes, having read the library rather than the docs:
--
--   secret        the TOTP seed, SYMMETRICALLY ENCRYPTED with the application secret
--                 before it is ever handed to the adapter (plugins/two-factor/index.mjs
--                 calls symmetricEncrypt on it at enrolment).
--   backup_codes  a JSON array of recovery codes, also symmetrically encrypted. This one
--                 is worth stating precisely: the low-level helper writes PLAINTEXT JSON
--                 when no storage mode is set, and it is the plugin that supplies
--                 storeBackupCodes: "encrypted" as its default. The application sets it
--                 explicitly anyway rather than depending on a library default staying put.
--
-- Neither is ever read by application code, neither appears in an API response (the plugin
-- marks both `returned: false`), and neither can reach audit_logs — no audit trigger exists
-- on the auth schema, and Task 1.11's allow-list is closed at seven public tables.
create table auth.auth_two_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.auth_users (id) on delete cascade,

  secret text not null,
  backup_codes text not null,

  -- False between generating a secret and proving possession of it. A row with
  -- verified = false is an enrolment in progress and grants nothing.
  verified boolean not null default true,

  -- Account-level lockout, counting CONSECUTIVE failures across challenges and factors.
  failed_verification_count integer not null default 0,
  locked_until timestamptz
);

create index auth_two_factors_user_idx on auth.auth_two_factors (user_id);

comment on table auth.auth_two_factors is
  'TOTP seed and recovery codes, both encrypted with the application secret. Deleted '
  'outright when a person disables MFA, which is what returns them to aal1.';

-- Disabling MFA deletes the row, so DELETE is required. Everything else matches the posture
-- Task 1.12 set for this schema: enumerated per table, nothing for app_admin.
grant select, insert, update, delete on auth.auth_two_factors to app_user;

-- ── authz.aal(), hardened ────────────────────────────────────────────────────────
--
-- Still reads app.aal, as database.md section 4.1 defines it and as the blueprint's "set
-- into the transaction context" requires. What changes is that the value is now checked.
--
-- THE RULE: a claim of aal2 is honoured only when the database independently agrees that
-- this person has a verified second factor. Otherwise the answer is aal1. This is exactly
-- the shape authz.org_id() has used since Task 1.3 for a mismatched tenant claim — the
-- claim can never widen access, it can only fail the request closed.
--
-- The floor is 'aal1' rather than NULL. Task 1.3 returned NULL when the setting was absent,
-- which fails closed against `= 'aal2'` just as well, but 'aal1' matches the documented
-- 'aal1' | 'aal2' type and leaves no third state for a future caller to mishandle.
--
-- WHAT THIS DOES AND DOES NOT PROVE. It proves a forged claim cannot manufacture assurance
-- for somebody with no second factor. It does not, by itself, prove the claim belongs to
-- this session — that is the session's aal column, set at creation and read by the
-- application. Two layers: the application derives the claim honestly, and the database
-- refuses to believe it when it is impossible.
create or replace function authz.aal() returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when nullif(current_setting('app.aal', true), '') = 'aal2'
     and exists (
       select 1
       from public.people p
       join auth.auth_users u on u.id = p.auth_user_id
       where p.id = authz.person_id()
         and u.two_factor_enabled
     )
    then 'aal2'
    else 'aal1'
  end
$$;

comment on function authz.aal() is
  'Authentication assurance for this transaction. Returns aal2 only when the application '
  'claims it AND the person holds a verified second factor; aal1 otherwise, including with '
  'no identity. A forged app.aal can never widen access.';

revoke all on function authz.aal() from public;
grant execute on function authz.aal() to app_user, app_admin;

-- ── what this task deliberately does NOT do ──────────────────────────────────────
--
-- NO SENSITIVE-TABLE POLICY GAINS `and (select authz.aal()) = 'aal2'`. database.md 4.2
-- describes that clause and section 7 names the tables it belongs on — employment_details,
-- emergency_contacts, people.date_of_birth — none of which exist before Phase 2. This task
-- makes the signal trustworthy; the surfaces that consume it come later.
--
-- MANDATORY MFA FOR PRIVILEGED ROLES IS STILL REQUIRED, AND IS STILL NOT ENFORCED.
-- Blueprint section 25: "mandatory for SUPER_ADMIN, ADMIN, HR_ADMIN and FINANCE". It is not
-- enforced here by founder decision, for an ordering reason rather than a security one:
-- refusing a session to an unenrolled privileged person would lock out the very first
-- SUPER_ADMIN before Task 1.14 can bootstrap them. The enforcement point is blueprint 7.4
-- step 3 — "Does MFA level meet this resource's requirement? no → 403 step-up" — which is
-- requirePermission() in Task 1.15. This comment exists so the requirement is carried
-- forward rather than quietly dropped.
