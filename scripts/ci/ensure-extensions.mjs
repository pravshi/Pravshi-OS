#!/usr/bin/env node
// Ensure the database-level extensions that scripts/db/roles.sql installs
// "once, by the branch owner" also exist on an ephemeral CI branch.
//
// Why this step exists: roles.sql installs pgcrypto + pg_trgm, but a Neon
// branch inherits its parent's database state at cut time — roles.sql is
// never re-run on the child. A parent provisioned before an extension was
// added to roles.sql (pg_trgm arrived with Phase 8) therefore produces
// children without it, and migration 0053 fails closed by design
// ("operator class gin_trgm_ops does not exist"). Running the same
// idempotent CREATE EXTENSION statements on the child restores parity
// with a freshly provisioned branch without touching the parent.
//
// Both extensions are TRUSTED (pg13+), and app_owner holds CREATE ON
// DATABASE, so the migrate connection can install them — the same
// privilege decision recorded in drizzle/0053_search_indexes.sql.

import { neon } from '@neondatabase/serverless';

const EXTENSIONS = ['pgcrypto', 'pg_trgm'];

async function main() {
  const url = process.env.DATABASE_URL_MIGRATE;
  if (!url) throw new Error('DATABASE_URL_MIGRATE is required');
  const sql = neon(url);
  for (const ext of EXTENSIONS) {
    await sql.query(`create extension if not exists ${ext}`);
    console.log(`extension ensured: ${ext}`);
  }
}

main().catch((e) => {
  console.error('ensure-extensions error:', e.message);
  process.exit(1);
});
