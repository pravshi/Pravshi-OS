import 'dotenv/config';
// Inert unless CI sets NEON_LOCAL_WSPROXY: points the Neon driver at CI's local Postgres.
import '../scripts/ci/neon-local.mjs';
import { assertTestDatabaseTargets } from './db-target-guard';

// Before any test file runs — and so before any pool, connection or fixture exists — every
// DATABASE_URL* must name an approved test target. A .env that points at a real database
// stops the run here instead of seeding fixtures into it.
assertTestDatabaseTargets(process.env);
