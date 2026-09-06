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

-- Defensive: if a role already existed with different attributes, correct it.
-- BYPASSRLS on app_user would silently disable every policy in the system.
alter role app_owner nobypassrls nosuperuser;
alter role app_user  nobypassrls nosuperuser nocreatedb nocreaterole;
alter role app_admin nobypassrls nosuperuser nocreatedb nocreaterole;

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
