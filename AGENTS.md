# Pravshi OS — shared rules for every coding agent

This is the one rulebook that every agent working on Pravshi OS follows: **Claude Code** (it
imports this file from [CLAUDE.md](CLAUDE.md)) and **Google Antigravity** (it loads `AGENTS.md`
at session start; its frontend restrictions are in §8, and the detailed rule is
[`.agents/rules/pravshi-frontend-only.md`](.agents/rules/pravshi-frontend-only.md)).
Tool-specific files add detail; they never relax a rule here. If two instructions disagree,
follow the stricter one and ask the founder.

These are working instructions, not a security boundary. The controls that are actually
enforced are the database (separate logins, forced RLS), the CI guards and human review.

## 1. Product scope (V1)

- **V1 is the multi-tenant Business OS** that was built: CRM, pipelines, work management,
  workflows, jobs and schedules, analytics, search, notifications, AI with permission-aware
  context, integrations, administration and audit —
  [ADR-006](docs/architecture/adr/006-v1-scope-business-os.md).
- **The HR and operations blueprint is deferred** as a separate future product. Its documents
  are preserved; do not delete them and do not silently restore HR modules to V1 (ADR-006).
- **Founder decisions of 2026-10-16**, recorded in
  [ADR-007](docs/architecture/adr/007-v1-founder-product-decisions.md) and amended on 2026-10-27
  by [ADR-008](docs/architecture/adr/008-v1-platform-and-import-decisions.md) (both on `main`):
  - one login belongs to exactly one organization in V1;
  - organizations are provisioned by a separate, audited platform administrator authority — built
    (the platform console, ADR-008); extend it only from an **approved** design;
  - free-trial and paid organizations share the core capabilities and identical isolation and
    security guarantees; plans, entitlements, billing and usage limits are deferred;
  - the Sales Sheet import is in V1 and is built (migrations 0081 and 0088) against a
    representative mapping only. The real source-column mapping has not been supplied, so
    validation against the real sheet is **pending**: never claim it is validated, and never
    invent a mapping.
- V1 comes before any later product work (including "Pro Max"), until V1 passes its
  acceptance gate.
- Never invent a product decision. If a requirement is ambiguous, stop and ask.

## 2. Roles

- **Founder (human owner)** — final authority on scope, decisions and every gate in §4.
- **Claude Code — engineering lead.** Plans and splits work, owns backend contracts and the
  backend, database, authentication, authorization, RLS and security code, integrates changes,
  runs the test gates and writes the handoffs.
- **Antigravity — frontend engineer and independent reviewer.** Builds the frontend within the
  boundaries of [`.agents/rules/pravshi-frontend-only.md`](.agents/rules/pravshi-frontend-only.md);
  does UI, browser and accessibility verification; reviews and critiques other work read-only.
- Each task has **exactly one implementation owner**. The other agent may research or review
  it, read-only, and reports findings (§6) — it does not edit that task's files.

## 3. File ownership

**Workspace layout (redesign Step 7).** The repository is a pnpm workspace: `apps/web` (the
Next.js application, which keeps its own `src/` folder: `apps/web/src/{app,components,hooks}`,
`middleware.ts`, `instrumentation.ts`), `apps/worker` (`apps/worker/src/`) and, until Step 8
extracts packages, the shared server code at the repository root: `src/lib/**` and `src/env.ts`.
The `@/` import alias resolves `@/worker/*` to `apps/worker/src/*` and `@/*` to `apps/web/src/*`,
then `src/*`. Shared tool configuration (the TypeScript, Prettier, ESLint and Vitest bases) lives in
`packages/shared-config` since Step 8 (package 1) — a shared area the founder decides; the root
`tsconfig.json`, `eslint.config.mjs`, `vitest.config.mts` and `.prettierrc` extend it. Ownership is
unchanged; only the paths are.

- **Claude Code:**
  - `drizzle/`, `scripts/db/`, `scripts/migrate-ws.mjs`, and every database schema, migration,
    role and RLS policy;
  - `src/lib/**` (backend services, data access, auth, authz), except the shared
    `src/lib/utils.ts`;
  - `apps/worker/src/**` (the background worker plane: its entry point, job handlers, scheduler and
    maintenance — ADR-010, redesign Step 5);
  - inside `apps/web/src/app/`: `apps/web/src/app/api/**`, every `route.ts`, every file starting with
    `'use server'`, and the server-side calls in pages and layouts (`withAuthorizedDb`,
    `withPermission`, `requirePermission`);
  - `.github/` (CI), `scripts/guards/`, `scripts/ci/`, and the tests of backend, security and
    database behaviour.
- **Antigravity** (under its frontend rule): the rest of `apps/web/src/app/` (pages, layouts, client
  components, styles), `apps/web/src/components/`, `src/modules/`, frontend assets and frontend-specific
  tests.
- **Shared — the founder decides:** `package.json`, `pnpm-lock.yaml`, `apps/web/src/middleware.ts`,
  `src/env.ts`, `src/lib/utils.ts`, root configuration files, shared contracts and validation
  schemas, and the agent rule files (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.agents/`).
- **Neither agent — founder only:** secrets, `.env*`, deployment configuration, billing,
  repository settings.

A file owned by one agent may be edited by the other only as the assigned owner of a task the
founder approved for it. Anything not listed: ask before editing.

## 4. Founder approval gates — stop and ask first

Each needs explicit approval for that exact action and target; approval for one never extends
to the next.

- Opening or updating a PR, merging a PR (the founder merges), pushing any branch other than
  `main`, deploying. The standing milestone workflow (§5) pre-authorises exactly one push: a
  verified fast-forward of finished work to `main`, under the conditions stated there. It never
  extends to anything else in this list or to a push that fails those conditions.
- Any connection to a hosted database (Neon, `Pravshi-OS-New`, the old development database,
  production) — each database and each operation separately, production last; running
  `roles.sql`; any migration on a persistent database; creating, renaming or deleting a Neon
  branch; any database configuration change; production access, production migration, data
  cutover and old-database retirement, each on its own.
- Billing, repository settings or permissions, secrets, deployment settings, global tool
  settings, installing extensions or MCP servers, adding or upgrading a dependency.
- Changing a shared file (§3), a scope or product decision, or these rule files.
- Deleting or rewriting anything that is not your own: branches, worktrees, private files.

## 5. Safety rules (both agents)

**Data access and tenancy**

- Tenant isolation is enforced by the database: forced RLS on every table, identity set
  transaction-locally by `withAuthorizedDb()` — the only path to Postgres. Never add another.
- Every protected route uses `withPermission()` / `requirePermission()` first. Frontend checks
  are UX only. Fail closed: no context means zero rows or a refusal, never a default allow.
- Keep the database logins separate: `app_user` (web runtime), `app_auth` (credential store),
  `app_worker` (worker plane), `app_platform` (platform console), `app_admin` (bootstrap only),
  `app_owner` (migrations only — never in a runtime). No role may gain `BYPASSRLS`, `SUPERUSER`, `CREATEROLE` or `CREATEDB`.
- A guard failure is a security failure: fix the cause, never weaken the guard or a test.

**Databases and migrations**

- Order is the journal's `idx`, never time; history must be an exact, checksum-verified prefix.
  Stop on any missing, duplicated, reordered or mismatched history — never repair, backfill or
  skip. `node scripts/migrate-ws.mjs` (on `main` since PR #99) is the only runner; never
  `drizzle-kit migrate` or an older copy of the runner.
- Never edit an applied migration, a journal `when` or a recorded hash.
- Local disposable PostgreSQL is a simulation: never present its results as Neon behaviour.
- Antigravity never runs migrations or connects to any database. Claude Code runs migrations
  only on disposable local databases unless §4 approval says otherwise.

**Secrets and external services**

- Never print, paste, log or commit a secret, token, password or connection string — including
  in chat, PR text, tickets and these rule files. If a tool prints one, stop, do not repeat it,
  and tell the founder so it can be rotated.
- External MCP and design services must never receive secrets, credentials, private audit
  content or unpublished security findings.
- Never use an auto-approve mode (`--dangerously-skip-permissions`, a bypass-permissions mode,
  or Antigravity's always-proceed mode).

**Git and worktrees**

- **Milestone workflow (standing founder decision, 2026-10-30).** Work locally and commit
  meaningfully at stable checkpoints (a completed component, a green test set). Finish a major
  task, module or phase before publishing; then run the release gates in
  [git-and-release.md](.claude/rules/git-and-release.md). Verified milestones go **directly to
  `main`** by default. Use a **pull request** (the founder merges) for high-risk or
  security-sensitive changes, any migration, and any change to CI, scripts, guards, dependencies,
  shared files or these rules (the direct-push audit flags those after the fact — it cannot
  prevent the push — so route them through a PR), and whenever an independent review adds value.
- **A milestone push to `main` requires all of:** the release gates pass on the exact commit;
  `git fetch` shows `origin/main` equals the base SHA you recorded and is an ancestor of the
  commit (a plain fast-forward — if `main` moved unexpectedly, stop and investigate, do not
  rebase or merge over it blindly); an explicit refspec (`git push origin <sha>:refs/heads/main`).
  Afterwards verify the remote SHA, every GitHub check (`ci` and `direct-push-audit`) and a
  clean working tree, and record the milestone in the private record (`audit-output/milestones.md`
  until the `.coordination/` ledger exists). A red check after a push is
  reported with its cause; it is never waved through.
- Branch from the verified current `origin/main`: `feature/*`, `fix/*`, `chore/*`, `docs/*`
  (`hotfix/*` only for a production incident — [CONTRIBUTING.md](CONTRIBUTING.md)); Antigravity
  uses `feature/frontend/<task>`. Never commit on a local `main`: milestone commits are made on
  a task branch in its worktree and published by the explicit-refspec push above.
- One worktree per active task (`git worktree add ../Pravshi-OS-<task> -b <branch> origin/main`).
  Do not implement product changes in the primary `Pravshi-OS` worktree (it holds the agent
  rules and private files), never switch branches in a worktree you do not own, and never
  modify, prune or delete another agent's branch or worktree.
- The rule files are tracked on `main` (PR #100), so a worktree created from `origin/main` has
  them already. A worktree created before that has none: run
  `node scripts/agents/sync-worktree-rules.mjs <worktree>` from the primary worktree to give it
  checksum-verified, Git-ignored copies (`--check` verifies only; it refuses a target that
  tracks the files itself). Never edit such copies, and never run `git clean -x` in a worktree.
- Never force-push, rewrite shared or published history, auto-merge, merge your own PR, or
  deploy. Never delete or discard local commits, branches, worktrees, stashes, backup refs or
  uncommitted work without approval. Push only as §4 and the milestone workflow allow, with an
  explicit refspec.
- Stage files explicitly. Never stage `audit-output/`, `.coordination/`, scratch logs, `.env*`
  or secrets; both private paths are excluded locally in `.git/info/exclude`. Run the secret
  scan after committing (`node scripts/guards/secret-scan.mjs`; it reads HEAD).
- Assume the repository is **public** (the founder switches its visibility): every pushed line
  is world-readable.

## 6. Working together

- **Tasks.** Every piece of work has a task ID (`T-0001`, …) given by the founder or the lead,
  with its scope, one owner, the files it owns, its dependencies, risks and acceptance criteria.
  Before starting, check that no active task owns the same files; if one does, stop.
- **Coordination ledger.** Tasks, findings and decisions will be kept in a private, local
  `.coordination/` folder at the root of the primary `Pravshi-OS` worktree. **It does not exist
  yet** (planned for collaboration Phase 1); until then the founder relays handoffs between the
  agents, and each handoff names its task ID and uses the report format in §7.
- **Findings** carry an ID (`F-<task>-<n>`), a severity, `file:line`, evidence (the exact
  command and its output, or a test) and a suggested action — not an opinion to be trusted.
- **Disagreements** are answered finding by finding — AGREE, DISAGREE with evidence, or
  NEEDS-HUMAN — and never settled by silently choosing one answer. What evidence cannot settle
  goes to the founder, whose decision is recorded.
- **Review.** Every change gets an independent review of the actual diff against the actual
  base by an agent (or subagent) that did not write it. Reviewers do not edit.

## 7. Evidence and reporting

- A pending, blocked, unexpectedly skipped, interrupted or unstarted required check is **not**
  a pass; missing evidence is not a pass. A later green rerun does not erase an earlier
  failure: report both.
- Separate what was run (exact command), the evidence (output, SHAs) and hypotheses (labelled).
- Keep unexplained anomalies visible. Known: the opt-in worker end-to-end suite sometimes
  misses its 20 s start-up window — unresolved; GitHub CI does not run that suite, so a green
  CI says nothing about it.
- Every final report and handoff uses these sections, with actual SHAs, exact commands,
  evidence and remaining blockers:

  `[AGENT]` `[CONTEXT]` `[DECISION]` `[CONTRACT]` `[DEPENDENCIES]` `[FILE OWNERSHIP]` `[RISKS]`
  `[STATUS]`

## 8. Antigravity — frontend restrictions (apply from session start)

The essentials of [`.agents/rules/pravshi-frontend-only.md`](.agents/rules/pravshi-frontend-only.md),
which stays the detailed reference. Where the two differ, the stricter text wins.

- **May modify, on an assigned task only:** the frontend parts of `apps/web/src/app/` (pages, layouts,
  client components, styles), `apps/web/src/components/`, `src/modules/`, frontend assets,
  frontend-specific tests, and UI documentation when necessary.
- **Never modify (Claude-owned, §3):** `apps/web/src/app/api/**`; every `route.ts`; every file that starts
  with `'use server'`; the server-side calls in pages and layouts (`withAuthorizedDb`,
  `withPermission`, `requirePermission` — the markup around them may change, the calls may
  not); all of `src/lib/` except the shared `src/lib/utils.ts`; `drizzle/`; `scripts/db/`,
  `scripts/ci/`, `scripts/guards/`, `scripts/migrate-ws.mjs`; database schemas, migrations, RLS
  policies and connection logic; authentication, authorization and security implementation;
  the tests of backend, security and database behaviour; CI/CD and deployment configuration;
  secrets and `.env*`.
- **Database:** never connect to PostgreSQL or any database, never query Drizzle from UI
  components, never create a data-access layer, never create or run a migration, never modify
  RLS or `withAuthorizedDb()`, never bypass authorization or expose credentials.
- **Authorization belongs to the backend.** Frontend checks are UX only; never use a hardcoded
  role name (`SUPER_ADMIN`, `ADMIN`, `HR`, `SALES`, `INTERN`, `DEVELOPER`) as a security
  mechanism.
- **Missing backend:** do not build it. Report `BACKEND CONTRACT REQUIRED` with the operation,
  input, output, required permission and expected errors.
- **Shared files (§3)** — `package.json`, `pnpm-lock.yaml`, `apps/web/src/middleware.ts`, `src/env.ts`,
  `src/lib/utils.ts`, root configuration, shared contracts and validation schemas, the agent rule
  files: stop and ask the founder.
- **Scope:** implement only the requested frontend task — no backend, database,
  infrastructure, deployment or unrelated pages. If unsure whether something is frontend or
  backend, do not modify it; ask the founder.
- **Approval gates (§4) apply in full:** explicit founder approval for each push, PR, merge,
  deployment, hosted-database access, migration, billing change, repository setting, secret,
  deployment setting, dependency, extension or MCP server. Never use always-proceed or
  `--dangerously-skip-permissions`.
- **Git (§5):** work only in your own `feature/frontend/<task>` branch and worktree — never in
  the primary `Pravshi-OS` worktree or in Claude's branch or worktree, and only once its rule
  copies pass `sync-worktree-rules.mjs --check` (or the worktree tracks the rules); never push
  to `main`, force-push or merge your own PR — the milestone workflow's direct push is the
  engineering lead's, and reaches Antigravity only if the founder says so; never stage
  `audit-output/`, `.coordination/`, `.env*` or secrets.
- **Handoffs, review and reporting (§6–§7):** work only on an assigned task ID; review read-only
  and report findings with evidence; answer findings AGREE, DISAGREE with evidence, or
  NEEDS-HUMAN; missing evidence is not a pass; every handoff uses the eight-section report.
