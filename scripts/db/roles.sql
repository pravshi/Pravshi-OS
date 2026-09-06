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

-- Defensive: assert, rather than correct. BYPASSRLS or SUPERUSER on any of these roles
-- would silently disable every policy in the system, so a role that already existed with
-- the wrong attributes must stop this script rather than be quietly patched.
--
-- This is an assertion and not `alter role ... nobypassrls nosuperuser` on purpose:
-- ALTER ROLE checks the SUPERUSER and BYPASSRLS attributes on *mention*, not on value, so
-- even specifying the negative requires superuser. Neon's branch owner is not a superuser,
-- so the corrective form would hard-fail here and get deleted by whoever hit the error.
-- CREATE ROLE's check is value-gated, which is why `nobypassrls` above is fine.
do $$
declare bad text;
begin
  select string_agg(rolname, ', ') into bad
  from pg_roles
  where rolname in ('app_owner','app_user','app_admin') and (rolbypassrls or rolsuper);
  if bad is not null then
    raise exception 'FAIL: role(s) % hold BYPASSRLS or SUPERUSER. Every RLS policy in this database would be inert for them.', bad;
  end if;
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
