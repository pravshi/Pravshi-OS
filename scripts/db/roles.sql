-- PRAVSHI OS — database roles.
-- Run once per Neon branch, connected as that branch's owner role.
-- Idempotent: safe to re-run.
--
-- Passwords are deliberately NOT set here. See scripts/db/README.md.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_owner') then
    create role app_owner login nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user login nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_admin') then
    create role app_admin login nobypassrls;
  end if;
end $$;

-- Defensive: assert, rather than correct. BYPASSRLS and SUPERUSER defeat RLS directly:
-- either attribute on any of these roles would silently disable every RLS policy for that
-- role. CREATEROLE and CREATEDB are asserted as defense-in-depth, not as known bypasses.
-- They are privilege-escalation surface that an application's runtime roles have no
-- legitimate reason to hold, and asserting them restores the coverage of the
-- `alter role ... nocreatedb nocreaterole` that this assertion replaced. On PG16+ a
-- CREATEROLE holder may only administer roles it created or holds ADMIN OPTION on, so
-- CREATEROLE alone is not a route to app_owner here. A role that already holds any of
-- these four attributes must stop this script rather than be quietly patched.
--
-- This is an assertion and not `alter role ... nobypassrls nosuperuser` on purpose:
-- ALTER ROLE checks the SUPERUSER and BYPASSRLS attributes on *mention*, not on value, so
-- even specifying the negative requires superuser. Neon's branch owner is not a superuser,
-- so the corrective form would hard-fail here and get deleted by whoever hit the error.
-- CREATE ROLE's check is value-gated, which is why `nobypassrls` above is fine.
do $$
declare bad text;
begin
  -- The four `case when` branches below and the four-term `where` predicate must name the
  -- same four attributes. Nothing enforces that agreement — if they drift, the worst case
  -- is a confusing message (an empty `()` suffix if a `where` term outruns its `case
  -- when`), not a fail-open, since `bad is not null` below is driven by the `where` clause
  -- alone. Edit both halves together.
  select string_agg(
    rolname || ' (' || concat_ws(', ',
      case when rolbypassrls then 'BYPASSRLS' end,
      case when rolsuper then 'SUPERUSER' end,
      case when rolcreaterole then 'CREATEROLE' end,
      case when rolcreatedb then 'CREATEDB' end
    ) || ')',
    ', '
  ) into bad
  from pg_roles
  where rolname in ('app_owner','app_user','app_admin')
    and (rolbypassrls or rolsuper or rolcreaterole or rolcreatedb);
  if bad is not null then
    raise exception 'FAIL: role(s) % hold an attribute this script asserts against. BYPASSRLS and SUPERUSER defeat RLS directly. CREATEROLE and CREATEDB are asserted as defense-in-depth, not as known RLS bypasses: they are privilege-escalation surface these roles have no legitimate reason to hold. Fix the role attributes rather than deleting this check.', bad;
  end if;
end $$;

-- app_owner needs CREATE on the DATABASE, and only that.
--
-- Drizzle's migration runner unconditionally executes
--   CREATE SCHEMA IF NOT EXISTS <migrations schema>
-- before it touches its bookkeeping table, and PostgreSQL evaluates the database-level
-- CREATE privilege BEFORE the IF NOT EXISTS short-circuit. So the statement fails even
-- for a schema app_owner already owns, and no migration can run without this grant.
--
-- This is a database-level GRANT, not a role attribute. The assertion above still holds:
-- app_owner remains NOBYPASSRLS, NOSUPERUSER, NOCREATEDB, NOCREATEROLE. It may create
-- schemas in this one database; it gains no privilege-escalation surface beyond that.
--
-- current_database() keeps this correct on every Neon branch rather than hardcoding a name.
do $$
begin
  execute format('grant create on database %I to app_owner', current_database());
end $$;

create schema if not exists authz authorization app_owner;
alter schema public owner to app_owner;

grant usage on schema public, authz to app_user, app_admin;

-- app_user gets DML only. Never DDL, never ownership.
grant select, insert, update on all tables in schema public to app_user;
grant usage, select on all sequences in schema public to app_user;

alter default privileges for role app_owner in schema public
  grant select, insert, update on tables to app_user;
alter default privileges for role app_owner in schema public
  grant usage, select on sequences to app_user;

-- Nobody creates objects in public except the owner, and nobody rewrites history.
-- audit_logs arrives in Phase 1; this is the standing rule it will inherit.
revoke create on schema public from app_user, app_admin, public;
