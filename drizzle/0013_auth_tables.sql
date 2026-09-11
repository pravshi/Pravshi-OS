-- PRAVSHI OS — Phase 1 Task 1.12: the Better Auth schema.
--
-- Blueprint section 6 splits identity into three concepts that are usually — and wrongly —
-- collapsed into one:
--
--   Login        auth.auth_users      a credential that can authenticate
--   Person       public.people        a human PRAVSHI has a relationship with
--   Engagement   public.engagements   a PERIOD of working with us
--
-- Tasks 1.2 to 1.11 built the second and third. This builds the first, and nothing else.
-- Authentication establishes identity. It grants no access: every question about what an
-- identity may reach is still answered by engagements, roles, permissions, scope_for() and
-- RLS, exactly as before.
--
-- ── WHY A SEPARATE SCHEMA ────────────────────────────────────────────────────────
--
-- `auth` is a security boundary, not a namespace preference.
--
-- Every table in `public` carries RLS, enabled and forced, and is reached only through
-- withAuthorizedDb() with an identity in the transaction. These tables cannot work that
-- way: you cannot present an identity while asking to be identified. The auth server has
-- to read a credential row before anybody is authenticated, so it is the one component
-- that queries outside the transaction-identity model.
--
-- Putting it in its own schema makes that exception visible and bounded rather than a
-- quiet hole in `public`:
--
--   * tests/guards/rls-enabled.test.ts scans `public` and keeps its promise intact —
--     "every table in public has RLS" stays true, because these are not in public.
--   * app_user's grants here are enumerated one table at a time below. The
--     `alter default privileges ... in schema public` in roles.sql does not reach this
--     schema, so nothing is granted by accident, now or by a future table.
--   * app_admin gets nothing at all.
--   * No business data lives here. The blast radius of the exception is the credential
--     store itself, which is the only thing that needs it.
--
-- RLS IS DELIBERATELY NOT ENABLED HERE, and that is worth stating plainly rather than
-- leaving to be discovered. The auth server is the sole reader and must see every row it
-- owns — a policy permissive enough to let it work would protect nothing, and one strict
-- enough to matter would break authentication. The protection is the schema boundary, the
-- enumerated grants, and the fact that no application code path reaches these tables.

create schema if not exists auth authorization app_owner;

comment on schema auth is
  'Better Auth credential and session store. A deliberate boundary: the one place queried '
  'outside withAuthorizedDb(), because identity cannot be presented while it is being '
  'established. No business data, no RLS, and grants enumerated per table.';

revoke all on schema auth from public;
grant usage on schema auth to app_user;

-- ── auth_users ───────────────────────────────────────────────────────────────────
--
-- Named auth_users rather than Better Auth's default `user`, which is a reserved word in
-- SQL and would need quoting at every mention. Blueprint section 6 calls it auth_users too.
--
-- The id is a uuid because public.people.auth_user_id has been uuid since Task 1.2 and that
-- schema is approved; the alternative was widening an approved column to text to suit a
-- library default.
--
-- THE DATABASE GENERATES IT. Better Auth's advanced.database.generateId = 'uuid' hands the
-- job to the database rather than minting the value itself — the same way its 'serial'
-- setting does — so the adapter sends DEFAULT and reads the id back. Without a column
-- default that insert fails outright, which is how this was found. Generating it here is
-- also the stronger arrangement: the type and the uuid-ness are guaranteed by the schema,
-- not by a library option somebody could change.
create table auth.auth_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- citext, per the database.md convention that emails are case-insensitive. Without it
  -- Alice@example.com and alice@example.com are two logins for one human.
  email public.citext not null,
  email_verified boolean not null default false,
  image text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint auth_users_email_unique unique (email)
);

comment on table auth.auth_users is
  'A credential that can authenticate. Holds no authorization of any kind: an auth_user '
  'with no public.people row pointing at it can sign in and reach nothing.';

-- ── auth_sessions ────────────────────────────────────────────────────────────────
--
-- Sessions are rows, which is the whole argument for database-backed auth in blueprint
-- section 25: "Revocation is immediate, not 'within one hour'. Suspend an account, offboard
-- a person, or revoke a session, and the very next request fails — because the session row
-- is gone." There is no token carrying stale claims to wait out.
create table auth.auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.auth_users (id) on delete cascade,
  token text not null,
  expires_at timestamptz not null,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint auth_sessions_token_unique unique (token)
);

create index auth_sessions_user_idx on auth.auth_sessions (user_id);
-- Expiry is read on every request, and sweeping expired rows is a maintenance query.
create index auth_sessions_expires_idx on auth.auth_sessions (expires_at);

comment on table auth.auth_sessions is
  'Database-backed sessions. Deleting a row ends access on the next request; there is no '
  'token to expire. Bulk invalidation is people.sessions_revoked_at, checked at resolution.';

-- ── auth_accounts ────────────────────────────────────────────────────────────────
--
-- One row per (provider, account) linked to a login. For email and password the provider is
-- 'credential' and `password` holds the KDF hash produced by the library — this project
-- does not implement its own hashing.
--
-- The table exists in this shape from day one because blueprint section 25 requires the
-- provider interface to be open: "adding Google OAuth later means enabling a provider,
-- adding an hd-claim check, and linking the identity to the existing people row. No table,
-- policy, or permission changes."
create table auth.auth_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.auth_users (id) on delete cascade,
  account_id text not null,
  provider_id text not null,
  password text,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index auth_accounts_user_idx on auth.auth_accounts (user_id);
create unique index auth_accounts_provider_unique
  on auth.auth_accounts (provider_id, account_id);

comment on table auth.auth_accounts is
  'Provider linkage and, for the credential provider, the password hash. One row per '
  'provider per login, so adding an OAuth provider later adds rows rather than tables.';

-- ── auth_verifications ───────────────────────────────────────────────────────────
--
-- Short-lived tokens: password reset today, email verification and invitation acceptance
-- when those tasks land. Rows are consumed, which is why app_user holds DELETE here.
create table auth.auth_verifications (
  id uuid primary key default gen_random_uuid(),
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index auth_verifications_identifier_idx on auth.auth_verifications (identifier);
create index auth_verifications_expires_idx on auth.auth_verifications (expires_at);

comment on table auth.auth_verifications is
  'Single-use, expiring tokens. Consumed on use, which is why the runtime role may delete.';

-- ── auth_rate_limits ─────────────────────────────────────────────────────────────
--
-- THE ONE TABLE BEYOND THE FOUR APPROVED FOR THIS TASK, and it is here because of a
-- security requirement rather than a schema preference.
--
-- Blueprint section 25 and threat T-18 require rate limiting on login. Better Auth supports
-- it with either memory or database storage. Memory is per-instance, and this application
-- runs serverless: each cold start gets its own empty counter, so an attacker spreading
-- attempts across instances is not limited at all. Database storage is the only version of
-- the control that actually works here.
--
-- `last_request` is bigint because Better Auth stores epoch milliseconds, not a timestamp.
create table auth.auth_rate_limits (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  count integer not null,
  last_request bigint not null,

  constraint auth_rate_limits_key_unique unique (key)
);

comment on table auth.auth_rate_limits is
  'Rate-limit counters for the auth endpoints. Database-backed rather than in-memory '
  'because serverless instances do not share memory, and a per-instance counter limits '
  'nobody.';

-- ── grants: the minimum each table needs, and nothing more ───────────────────────
--
-- Enumerated one table at a time on purpose. roles.sql's default privileges cover schema
-- public only, so a table added to `auth` in future grants nothing until somebody writes
-- the line — which is the correct default for a credential store.
--
-- auth_users has no DELETE. A login is disabled, never deleted, for the same reason a
-- person is never deleted: the audit trail and the engagement history both point at it.
-- Offboarding removes sessions and stamps sessions_revoked_at; it does not erase evidence.
grant select, insert, update on auth.auth_users to app_user;
-- Sessions, verifications and rate-limit counters are all consumed or revoked in normal
-- operation, so these do need DELETE.
grant select, insert, update, delete on auth.auth_sessions to app_user;
grant select, insert, update, delete on auth.auth_accounts to app_user;
grant select, insert, update, delete on auth.auth_verifications to app_user;
grant select, insert, update, delete on auth.auth_rate_limits to app_user;

-- app_admin is named in blueprint section 25 for three audited paths — bootstrap,
-- provisioning, the audit writer — and authentication is none of them. It gets nothing,
-- including USAGE on the schema.

-- ── the link to people ───────────────────────────────────────────────────────────
--
-- public.people.auth_user_id has been a bare uuid since Task 1.2, whose comment reads: "FK
-- to the Better Auth user table, which does not exist until Task 1.12; the constraint is
-- added by that task, not invented here." This is that task.
--
-- The direction is the entire point. A PERSON POINTS AT A LOGIN. A login has no column
-- pointing back, cannot create a person, and cannot infer an organization. An authenticated
-- user that nothing points at reaches nothing at all — threat T-01, which the blueprint
-- states as "the callback links to an existing invitation or people row and REFUSES TO
-- CREATE ANYTHING".
--
-- NO CASCADE. Deleting a login must never delete the human being it belonged to, and with
-- NO ACTION the delete is refused while a person still points at it. The existing partial
-- unique index on people.auth_user_id already makes the relationship one-to-one.
alter table public.people
  add constraint people_auth_user_fk
  foreign key (auth_user_id) references auth.auth_users (id);

comment on column public.people.auth_user_id is
  'The login this person may authenticate with, or NULL for someone with no account — a '
  'candidate, an alumnus, anybody not yet invited. A person points at a login; a login '
  'never creates a person.';

-- ── resolving a session into a PRAVSHI OS identity ───────────────────────────────
--
-- THE PROBLEM THIS SOLVES. Every other read of public.people happens inside
-- withAuthorizedDb(), where authz.person_id() already knows who is asking. Session
-- resolution is the one query that runs BEFORE that is true: the application has an
-- auth_user_id from a session cookie and needs the person it belongs to. As app_user, with
-- no identity in the transaction, the people_select_self policy matches nothing and the
-- lookup returns zero rows — correctly, and uselessly.
--
-- So the bridge is a SECURITY DEFINER function, narrow enough to be safe to hand the
-- runtime role: it takes a login id and a session timestamp, and returns at most one
-- (person_id, org_id) pair. It cannot be asked anything else.
--
-- WHAT IT REFUSES, and why each one is an IDENTITY question rather than an authorization
-- question:
--
--   no people row points at this login   the login exists but nobody at PRAVSHI is it.
--                                        Threat T-01: authentication must not be able to
--                                        conjure a person, an organization or access.
--   the person is soft-deleted           the same condition authz.person_id() applies.
--   person_status is not ACTIVE          likewise.
--   the session predates                 bulk invalidation. people.sessions_revoked_at has
--   sessions_revoked_at                  existed unused since Task 1.2 for exactly this;
--                                        blueprint section 25 calls it "simpler and exact"
--                                        next to a token epoch.
--
-- WHAT IT DELIBERATELY DOES NOT CHECK: whether the engagement is ACTIVE, whether the
-- organization is ACTIVE, and anything at all about roles or permissions. Those are
-- authorization, they are already enforced by authz.is_active() on every single query, and
-- duplicating them here would create a second copy of the access model that can disagree
-- with the first. A person whose engagement ended still resolves to an identity, and then
-- reaches nothing — which is blueprint 7.4's step 2 doing its job rather than step 1
-- pretending to.
--
-- The organization is READ FROM THE PERSON ROW. There is no parameter for it, so no session,
-- cookie or caller can propose a tenant.
create function public.resolve_auth_identity(
  p_auth_user_id uuid,
  p_session_created_at timestamptz
)
returns table (person_id uuid, org_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.org_id
  from public.people p
  where p.auth_user_id = p_auth_user_id
    and p.deleted_at is null
    and p.person_status = 'ACTIVE'
    and (p.sessions_revoked_at is null or p_session_created_at > p.sessions_revoked_at)
$$;

comment on function public.resolve_auth_identity(uuid, timestamptz) is
  'Maps a Better Auth login to the PRAVSHI OS person and organization, or returns no row. '
  'Identity only: engagement and organization liveness stay with authz.is_active(). The '
  'organization comes from the person row and cannot be supplied by the caller.';

revoke all on function public.resolve_auth_identity(uuid, timestamptz) from public;
grant execute on function public.resolve_auth_identity(uuid, timestamptz) to app_user;
