# Pravshi OS — instructions for Claude Code

These are working instructions, not a security boundary: nothing here is enforced by a tool.
The enforced controls are the database (roles, forced RLS), the CI guards and human review.
Focused rules load from `.claude/rules/`; specialist reviewers live in `.claude/agents/`; how to
use them is in [docs/development/claude-agent-workflow.md](docs/development/claude-agent-workflow.md).

## Product scope (V1)

- **V1 is the multi-tenant Business OS** that was built: CRM, pipelines, work management,
  workflows, jobs and schedules, analytics, search, notifications, AI with permission-aware
  context, integrations, administration and audit —
  [ADR-006](docs/architecture/adr/006-v1-scope-business-os.md).
- **The HR and operations blueprint is deferred** as a separate future product. Its documents
  are preserved; do not delete them and do not silently restore HR modules to V1 (ADR-006).
- **Founder decisions of 2026-10-16** (to be recorded as ADR-007, prepared on branch
  `docs/v1-founder-decisions` and not yet merged at the time of writing):
  - one login belongs to exactly one organization in V1;
  - organizations are provisioned by a separate, audited platform Super Admin authority —
    implement it only from an **approved** design (the proposal is pending founder review);
  - free-trial and paid organizations share the core capabilities and identical isolation and
    security guarantees; plans, entitlements, billing and usage limits are deferred;
  - the Sales Sheet import is in V1, built only from approved requirements and the real
    source-column mapping (not yet supplied).
- Never invent a product decision. If a requirement is ambiguous, stop and ask.

## Engineering workflow (substantial work)

1. Establish state: `git fetch`, the actual `origin/main` SHA, branch, worktrees, clean tree.
2. Inspect the relevant code, migrations, tests and architecture docs before deciding.
3. Write a bounded plan with acceptance criteria.
4. Delegate independent read-only investigations where useful (see the workflow guide).
5. Implement narrow, reviewable changes on a feature branch.
6. Add regression tests, including forbidden and failure cases; prove them with a mutation
   check (the test must fail without the fix) where practical.
7. Run the relevant verification and the release gates below.
8. Request an independent review (`independent-code-reviewer`; `security-auditor` /
   `database-migration-auditor` when their areas are touched).
9. Fix findings; re-run the affected tests.
10. Review the full diff and the documentation it affects.
11. Commit locally; prepare the PR text.
12. Wait for approval to push, open a PR or merge.

## Commands (from `package.json` and `.github/workflows/ci.yml` — do not invent others)

- Node `>=22.12`, `pnpm@12.3.4` (`corepack enable`). Install: `pnpm install --frozen-lockfile`.
- Gates: `pnpm typecheck` · `pnpm lint` · `pnpm format:check` · `pnpm guards` ·
  `pnpm audit --audit-level=high` · `pnpm test` · `pnpm build`.
- Migrations: `node scripts/migrate-ws.mjs` — the only runner. Never `drizzle-kit migrate`.
- `pnpm test` needs a migrated database and the `DATABASE_URL*` variables (see
  [DEVELOPMENT.md](DEVELOPMENT.md)); DB suites skip when they are absent — a skip is not a pass.
- Opt-in, not in CI: `pnpm e2e` (Playwright); the worker end-to-end suite
  (`WPW_E2E=1 … tests/e2e-worker/low-cost-worker.e2e.test.ts`, verdict via `WPW_E2E_REPORT`).

## Security and data access (details: `.claude/rules/tenant-security.md`)

- Tenant isolation is enforced by the database: forced RLS on every table, identity set
  transaction-locally by `withAuthorizedDb()` — the only path to Postgres. Never add another.
- Every protected route uses `withPermission()` / `requirePermission()` first. Frontend checks
  are UX only. Fail closed: no context means zero rows or a refusal, never a default allow.
- Keep the database logins separate: `app_user` (web runtime), `app_auth` (credential store),
  `app_worker` (worker plane), `app_admin` (bootstrap only), `app_owner` (migrations only —
  never in a runtime). No role may gain `BYPASSRLS`, `SUPERUSER`, `CREATEROLE` or `CREATEDB`.
- A guard failure is a security failure: fix the cause, never weaken the guard or a test.

## Databases and migrations (details: `.claude/rules/database-migrations.md`)

- Order is the journal's `idx`, never time; history must be an exact, checksum-verified prefix.
  Stop on any missing, duplicated, reordered or mismatched history — never repair, backfill or
  skip. (The runner on `main` still selects by timestamp until branch
  `fix/migration-journal-order` is merged; do not migrate any persistent database before then.)
- Never edit an applied migration, a journal `when` or a recorded hash.
- Local disposable PostgreSQL is a simulation: never present its results as Neon behaviour.
- **No hosted database work without explicit approval for the exact target and operation**:
  no connection to Neon or production, no `roles.sql`, no migration, no branch create/rename/
  delete, no configuration change. Production access, production migration, data cutover and
  old-database retirement each need their own approval.

## Git and release (details: `.claude/rules/git-and-release.md`)

- Branch from `main` (`feature/*`, `fix/*`, `chore/*`, `docs/*`; `hotfix/*` only for a production
  incident — [CONTRIBUTING.md](CONTRIBUTING.md)). Never commit to `main` directly.
- Never force-push, rewrite shared history, auto-merge, merge your own PR, or deploy. Push and
  open PRs only when explicitly authorized; push with an explicit refspec.
- Never stage private audit reports (`audit-output/`), scratch logs, `.env*` or secrets. Run the
  secret scan after committing (it reads HEAD).
- Never change billing, repository settings, permissions, secrets or deployment settings.
- The repository is **public**: every pushed line is world-readable.
- Do not modify another agent's branch or worktree (e.g. a separate frontend agent's).

## Reporting (details: `.claude/rules/testing-and-reporting.md`)

- A pending, blocked, unexpectedly skipped, interrupted or unstarted required check is **not**
  a pass. A later green rerun does not erase an earlier failure: report both.
- Keep unexplained anomalies visible (for example the intermittent worker start-up slowness).
- Every final report uses these sections and includes actual SHAs, exact commands, evidence
  and remaining blockers:

  `[AGENT]` `[CONTEXT]` `[DECISION]` `[CONTRACT]` `[DEPENDENCIES]` `[FILE OWNERSHIP]` `[RISKS]`
  `[STATUS]`
