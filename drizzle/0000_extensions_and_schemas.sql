-- OWNERSHIP BOUNDARY — read before adding anything to this file.
--
-- Roles, schemas and bootstrap privileges belong to scripts/db/roles.sql, which runs
-- ONCE as the Neon branch owner. Drizzle migrations run as app_owner and own the
-- application objects: tables, indexes, constraints, and their evolution.
--
-- app_owner deliberately holds no CREATE privilege on the database (roles.sql asserts
-- against CREATEDB/CREATEROLE as defence in depth), so a `create schema` here fails
-- with "permission denied for database". That is the boundary working, not a bug:
-- roles.sql:60 already creates `authz` with `authorization app_owner`.
--
-- Creating TABLES in public or authz needs no database-level CREATE, because app_owner
-- owns both schemas. Phase 1 migrations are therefore unaffected by this boundary.

comment on schema authz is
  'Authorization helper functions. Every RLS policy is written in terms of these. Phase 1 populates it.';
