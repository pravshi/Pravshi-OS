---
paths:
  - 'drizzle/**'
  - 'scripts/migrate-ws.mjs'
  - 'scripts/db/**'
  - 'scripts/ops/**'
  - 'scripts/ci/**'
  - 'docs/runbooks/production-migration.md'
  - 'docs/runbooks/auth-pool-probe.md'
  - 'tests/db/**'
  - 'tests/serial/**'
  - 'tests/guards/production-runbook-journal.test.ts'
  - 'tests/guards/migration-history.test.ts'
---

# Database migrations and hosted-database safety

## The migration chain

- `drizzle/meta/_journal.json` is the chain; **its order is `idx`, never time**. Historical
  `when` values are not monotonic (idx 28–30 are dated before idx 27; idx 35 ties idx 34).
- The runner records one row per migration in `drizzle.__drizzle_migrations`:
  (sha256 of the file's bytes, journal `when`). Compare file-byte hashes only — the journal's
  embedded `hash` field is stale for idx 42, 47 and 51 and is never read.
- A database's history is valid only if, read `ORDER BY id`, it is exactly idx 0…K−1 with the
  same hash and `when`, row for row. Anything else — missing, duplicated, reordered, unknown or
  checksum-mismatched rows, or more rows than the journal — means **stop and escalate**. Never
  repair, backfill, reorder, re-apply or skip.
- The runner on `main` (since PR #99, merged as `d8ae017`) verifies this prefix and applies by
  `idx`, refusing anything else with exit 3. drizzle-kit and any older copy of the runner select
  by `when > max(created_at)` and can silently skip migrations — never use them.
- Never edit an applied migration, a `when` or a recorded hash. Fix forward with a new migration.
- A new migration needs: its journal entry (next `idx`, `when` +1,000,000 after the last), the
  production runbook's Appendix A row and pinned counts (`tests/guards/production-runbook-journal.test.ts`
  enforces them), forbidden-case tests, and a rehearsal on a disposable database from the
  previous `main` state with representative rows.
- Rollback scripts exist only for 0073 and 0075 on `main`, plus 0077's, which ships with its
  migration (`scripts/db/rollback/`); a migration that needs one prepares it in the same
  change. None is invented at incident time.
- Re-running `scripts/db/roles.sql` re-grants select/insert/update on every public table to
  `app_user`, undoing table-level revokes made by migrations (0002 organizations/people, 0077
  deal_stage_history). RLS policies are the durable control; never rely on a revoke alone.

## Roles

- Logins: `app_owner` (migrations), `app_user` (runtime), `app_auth` (credential store),
  `app_worker` (worker plane), `app_admin` (bootstrap). All `NOBYPASSRLS`; `roles.sql` asserts
  none holds `SUPERUSER`, `BYPASSRLS`, `CREATEROLE` or `CREATEDB`.
- On Neon the branch owner creates roles and is auto-granted ADMIN on them (PostgreSQL 16+). The
  membership rule (0070/0072/0073 and runbook step 3) admits only that database owner, and never
  an `app_*` role. Do not loosen it.

## Local versus hosted

- Local work uses disposable PostgreSQL (CI-shaped: superuser creates roles; Neon-shaped: a
  non-superuser owner with `CREATEROLE`) through `scripts/ci/neon-local.mjs` and the wsproxy.
  It is a simulation: **never claim Neon behaviour from it**.
- Hosted databases — Neon development branches, `Pravshi-OS-New`, the old development database,
  production — need **explicit approval naming the exact target and operation**, every time:
  connecting, `roles.sql`, migrations, password changes, branch create/rename/delete, settings.
  A branch named `production` is never a development target. Never print or commit a
  connection string, host name or password.
- Production work follows `docs/runbooks/production-migration.md` (Step 0 read-only first; HG-2
  approval; freeze; snapshot; rehearsal) — each step needs its own approval. Data cutover and
  retiring the old database are separate decisions (DB-14, open).
