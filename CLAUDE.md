# Pravshi OS — instructions for Claude Code

The rules shared by every agent on this project — V1 scope, roles, file ownership, the
founder's approval gates, security, databases, Git, collaboration with Antigravity and the
reporting format — are in [AGENTS.md](AGENTS.md), imported here:

@AGENTS.md

These are working instructions, not a security boundary: nothing here is enforced by a tool.
The enforced controls are the database (roles, forced RLS), the CI guards and human review.
Focused rules load from `.claude/rules/`; specialist reviewers live in `.claude/agents/`; how to
use them is in [docs/development/claude-agent-workflow.md](docs/development/claude-agent-workflow.md).

## Claude Code's role

Engineering lead (AGENTS.md §2): owns the plan, backend contracts and the backend, database,
auth, authorization, RLS and security code, integration and the test gates. Antigravity owns the
frontend under [`.agents/rules/pravshi-frontend-only.md`](.agents/rules/pravshi-frontend-only.md);
do not edit its files outside a task the founder assigned to Claude, and never its branch or
worktree. Handoffs to and from Antigravity follow AGENTS.md §6. The private coordination ledger
(`.coordination/` at the primary worktree root) does not exist yet — collaboration Phase 1.

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

## Detailed rules

- Security and data access: `.claude/rules/tenant-security.md` (AGENTS.md §5).
- Databases and migrations: `.claude/rules/database-migrations.md` (AGENTS.md §5).
- Git and release gates: `.claude/rules/git-and-release.md` (AGENTS.md §4–5).
- Testing and reporting: `.claude/rules/testing-and-reporting.md` (AGENTS.md §7).
