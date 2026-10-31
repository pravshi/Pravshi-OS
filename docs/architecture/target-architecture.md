# Target architecture and redesign plan

Decisions: [ADR-009](adr/009-architecture-redesign-scope-and-locks.md) (end state, stages,
non-goals, locks) and [ADR-010](adr/010-module-layers-and-dependency-rules.md) (layers and
dependency rules). Source: _Pravshi OS Complete Architecture Blueprint v0.1_ (founder,
29 October 2026), reconciled with `main` at `3a8c155`. Status: Phase 1, Step 1. Nothing in §4–§5
is implemented until its step is approved and merged; each step and stage needs its own approval.

## 1. End state and the way there

The end state is the blueprint's architecture:

```
Pravshi-OS/
├── apps/
│   ├── web/                  Next.js: tenant workspace + platform console + API routes
│   ├── worker/               background jobs, schedules, maintenance
│   ├── mobile-real-estate/   Phase 3, own ADR
│   └── mobile-education/     Phase 3, own ADR
├── packages/
│   ├── shared-config/  database/  observability/  security/  platform-core/
│   ├── shared-services/  contracts/  crm-core/  work/  integrations/  automation/
│   ├── imports/  search/  analytics/  ai/  admin/  shared-ui/
│   ├── products/real-estate/  products/education/          Phase 3, own ADRs
│   └── website-platform/  mobile-platform/  white-label-platform/   Phase 3, own ADRs
├── tests/  tooling/  docs/
└── infrastructure/         only when there is deployment configuration to hold (founder-only)
```

It is reached in three phases:

| Phase                         | Steps / stages                                                                                  | Changes behaviour?                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| 1 — Untangle in place         | Steps 1–6 (§4)                                                                                   | No                                     |
| 2 — Workspace                 | Step 7 workspace skeleton; Step 8 package extraction, one package per PR (§5)                    | No                                     |
| 3 — Products and delivery     | Product registry; Real Estate CRM; Education CRM; mobile apps; websites and domains; white-label (§5) | Yes — each with its own ADR and approval |

Inside every package and app, the layers and rules of ADR-010 apply:

```
   Entry points: apps/web (pages, routes, actions) · apps/worker · scripts
                         │ may import any layer
   L4 tenant domain   crm · work · workflows · integrations · import · ai
                      analytics · search · admin · invitations
                         │                      Control plane: platform
   L3 shared services jobs (queue core) · notifications · events   (imports L0–L2 only)
   L2 security        audit → auth → authz · identity
   L1 infrastructure  db · observability · storage
   L0 configuration   env · utils
```

## 2. Baseline (V1, `3a8c155`, local tag `v1.0.0`)

Recorded on 2026-10-30 in a cloud session, on the exact commit, before any redesign change:

| Check                                                         | Result                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`             | pass                                                                              |
| `pnpm guards`                                                  | pass (secret scan: 1,043 tracked files; workflow secret flow: 2 workflows)        |
| `pnpm build`                                                   | pass                                                                              |
| `roles.sql` + `node scripts/migrate-ws.mjs` from zero         | 88 of 88 applied. `roles.sql` created all six logins — `app_owner`, `app_user`, `app_admin`, `app_worker`, `app_auth`, `app_platform` — none with `SUPERUSER` or `BYPASSRLS`; the five CI connects with (all but `app_admin`, used only by the operator's bootstrap) each connected as itself |
| `pnpm test`                                                    | 268 files passed, 1 failed, 1 skipped; the failure is explained below             |
| `tests/serial/migration-runner-history.test.ts`, re-run alone | 10 passed, 1 skipped                                                              |

**Environment.** The database was a disposable local PostgreSQL **16** reached through the real
Neon driver over a local WebSocket proxy in place of CI's `wsproxy` image; CI uses PostgreSQL 18.
This is a local simulation (AGENTS.md §5) and says nothing about Neon. The one failure in the full
run was the local proxy keeping half-open sockets — and with them the runner's advisory lock —
alive after a spawned runner exited; after the proxy was fixed the suite passed alone. An earlier
attempt was invalidated when the sandbox removed the database server's access to its data
directory mid-run; it was discarded and re-run. GitHub CI on each step's pull request remains the
authoritative check.

**After Step 2** (`6c85bb2`, the module-boundary guard; same environment, 2026-10-30):

| Check                                                         | V1 baseline (`3a8c155`)          | After Step 2 (`6c85bb2`)                                                                 |
| ------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`             | pass                             | pass                                                                                      |
| `pnpm guards`                                                  | pass (1,043 files)               | pass (secret scan: 1,047 tracked files; workflow secret flow: 2 workflows)                |
| `pnpm audit --audit-level=high`                                | not recorded                     | pass (1 high, in the documented ignore list)                                              |
| `pnpm build`                                                   | pass                             | pass                                                                                      |
| Migrations from zero                                           | 88 of 88                         | 88 of 88                                                                                  |
| `pnpm test` (files)                                            | 268 passed, 1 failed, 1 skipped  | 270 passed, 0 failed, 1 skipped (271 files: the guard is new)                              |
| `pnpm test` (tests)                                            | 4,180 passed, 9 failed, 10 skipped | 4,197 passed, 0 failed, 10 skipped (4,207: the guard adds 8)                            |
| `tests/guards/module-boundaries.test.ts`                       | —                                | 8 passed; 17 baseline entries, none stale; mutation checks in the Step 2 pull request     |

An earlier full run on `6c85bb2` failed one test, `tests/serial/audit-partition-lock-order.test.ts`
("retry exhaustion under a lock held throughout": a lock-table sample saw
`organizations:ShareRowExclusiveLock` held during a back-off). It failed the same way on the
untouched V1 tree `3a8c155` in that environment, and the code between the two commits differs only
in documentation — so it is not caused by Step 2. That cluster had been restarted after an unclean
shutdown of the session's container; on a newly initialised cluster the test passed twice alone and
the full run above passed. The cause of the failure on the restarted cluster is **unexplained**;
it is recorded here, not waved through, and GitHub CI (PostgreSQL 18) on the pull request remains
the authoritative check.

**After Steps 3 and 4.** Step 3 (`3c3f04d`, merged as `9bf9d63`, the security inventory) was
recorded in pull request #105; it is repeated here so §2 stays the single record. Step 4 is the
foundation-cycles change (four moves, ADR-010); same environment, newly initialised cluster:

| Check                                                    | Step 3 (`3c3f04d`)                  | Step 4                                                                                          |
| -------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`        | pass                                | pass                                                                                            |
| `pnpm guards`                                             | pass (1,049 files)                  | pass (secret scan 1,051 tracked files; workflow secret flow 2 workflows)                        |
| `pnpm audit --audit-level=high`                           | pass                                | pass (documented ignores only)                                                                  |
| `pnpm build`                                              | pass                                | pass — the route list (63 pages, 99 route handlers, `/_not-found`, middleware) is identical     |
| Migrations from zero                                      | 88 of 88                            | 88 of 88; the 88 migration files, the journal and the 14 rollback scripts are byte-identical    |
| `pnpm test` (files)                                       | 271 passed, 0 failed, 1 skipped     | 271 passed, 0 failed, 1 skipped (272 files)                                                     |
| `pnpm test` (tests)                                       | 4,209 passed, 0 failed, 10 skipped  | 4,210 passed, 0 failed, 10 skipped (4,220: one new guard test, `single-db-path`, review F-S4-1) |
| Module-boundary baseline                                  | 17 entries                          | 13 entries — the four foundation entries removed, none added                                    |

**After Step 5** (queue/worker split; same environment, newly initialised cluster; base `7317406`):

| Check                                                    | Step 4 (`09c4102`)                 | Step 5                                                                                              |
| -------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`        | pass                               | pass (lint: no warnings)                                                                            |
| `pnpm guards`                                             | pass (1,051 files)                 | pass (secret scan clean; workflow secret flow 2 workflows)                                          |
| `pnpm audit --audit-level=high`                           | pass                               | pass (documented ignores only)                                                                      |
| `pnpm build`                                              | pass                               | pass — the route list (63 pages, 99 route handlers, `/_not-found`, middleware) is identical         |
| Migrations from zero                                      | 88 of 88                           | 88 of 88; the 88 migration files, the journal and the 14 rollback scripts are byte-identical        |
| `pnpm test` (files)                                       | 271 passed, 0 failed, 1 skipped    | 272 passed, 0 failed, 1 skipped (273 files: one new test file)                                      |
| `pnpm test` (tests)                                       | 4,210 passed, 0 failed, 10 skipped | 4,213 passed, 0 failed, 10 skipped (4,223: the 3 tests of `handler-registry-wiring`)                |
| Worker end-to-end suite (opt-in, `WPW_E2E=1`)             | not run                            | 7 of 7 passed in three runs on separate throwaway databases; one further attempt failed at setup (see below) |
| Module-boundary baseline                                  | 13 entries                         | 8 entries — the four `jobs` rule-5 entries and the `jobs`↔`notifications` cycle entry removed, none added |

The worker end-to-end suite was run four times. Runs 1 and 2 (before the review fixes) and run 4
(on the final tree) each passed 7 of 7, with the worker's first log line within about 0.9 s of
launch against the suite's 20 s window; the known start-up flake did not occur. Run 3 failed at
setup (all 7 tests "not run") because rebuilding the disposable cluster for the final full-suite
run had dropped the E2E database and regenerated the role passwords: a fault of the test
environment, reported here rather than discarded. The worker also started from `src/worker/runner.ts`
through the unchanged `pnpm worker` script on Node 22.22.0 (`.nvmrc` 22) as `app_worker`, ran every
loop phase and shut down gracefully. Seven of the eight job types have a registered handler and
each is exercised by its tests; `retry` is a job type with no handler on `main` either — retries
are the retry sweeper's job (`src/worker/retry-sweeper.ts`) — and is pinned as such.

**After Step 6** (domain events; same environment, newly initialised cluster; base `06c3458`):

| Check                                                    | Step 5                             | Step 6                                                                                              |
| -------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`        | pass                               | pass (lint: no warnings)                                                                            |
| `pnpm audit --audit-level=high`                           | pass                               | pass (documented ignores only)                                                                      |
| `pnpm build`                                              | pass                               | pass — the route list (symbol and path of all 163 entries) is identical to `main`'s                 |
| Migrations from zero                                      | 88 of 88                           | 88 of 88; no file under `drizzle/` or `scripts/db/` is in the diff                                  |
| `pnpm test` (files)                                       | 272 passed, 0 failed, 1 skipped    | 274 passed, 0 failed, 1 skipped (275 files: two new test files)                                     |
| `pnpm test` (tests)                                       | 4,213 passed, 0 failed, 10 skipped | 4,232 passed, 0 failed, 10 skipped (4,242: new port, wiring and boundary self-tests)                |
| Worker end-to-end suite (opt-in, `WPW_E2E=1`)             | 7 of 7 passed                      | 7 of 7 passed in one run (Node 22.22.0, throwaway database); a single run, not repeated             |
| Real `next start` probe                                   | —                                  | both event ports are functions after start-up (see the note below)                                  |
| Module-boundary baseline                                  | 8 entries                          | 0 entries — the five remaining edges removed, none added; the module graph has no cycle             |

**Start-up hook location.** With a `src/` folder, Next 15.5 loads `src/instrumentation.ts` and
ignores a root-level `instrumentation.ts`: a build with the root file emits no
`.next/server/instrumentation.js`, and a real `next start` showed both ports unregistered. (This
also means the root file's Sentry initialisation has never run on `main`; that is unchanged here
and is a separate decision.) Step 6 therefore wires the web app from a new `src/instrumentation.ts`
and leaves the root file as it was. With it, a build emits `instrumentation.js`, the route list is
unchanged (163 entries), and a `next start` process shows both ports registered once start-up
completes.

**After Step 7** (workspace skeleton; same environment, newly initialised cluster; base `7bc91d9`):

| Check                                                    | Step 6                             | Step 7                                                                                              |
| -------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`        | pass                               | pass (`pnpm lint` is now `eslint` over the three source roots)                                      |
| `pnpm build`                                              | pass                               | pass from the workspace root — the route list (163 entries) is identical to `main`'s                |
| Migrations from zero                                      | 88 of 88                           | 88 of 88; no file under `drizzle/` or `scripts/db/` is in the diff                                  |
| `pnpm test` (files)                                       | 274 passed, 0 failed, 1 skipped    | 275 passed, 0 failed, 1 skipped (276 files)                                                         |
| `pnpm test` (tests)                                       | 4,232 passed, 0 failed, 10 skipped | 4,239 passed, 0 failed, 10 skipped (4,249: the workspace-root mapping test, the workspace-roots guard and four protected paths) |
| Worker end-to-end suite (opt-in, `WPW_E2E=1`)             | 7 of 7 (one run)                   | 7 of 7 in two runs (Node 22.22.0), the worker started from `apps/worker/src/runner.ts`              |
| Real `next start` from `apps/web`                         | both ports registered              | both ports registered after start-up                                                                |
| Module-boundary baseline                                  | 0 entries                          | 0 entries; the guard maps the three physical roots to the logical paths                             |

**V1 tag.** `v1.0.0` (annotated) marks `3a8c155` so V1 can be deployed from it while the redesign
proceeds. It exists locally only; pushing it needs the founder's approval at the time.

## 3. Gap analysis: blueprint against V1

| Blueprint area                                  | V1 today                                                                                         | Where it is addressed                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Trust sequence (identity → membership → authorization → data) | Built: `requirePermission()` steps 1–7; membership = person + live engagement + ACTIVE organization | Document only                             |
| Control plane vs tenant plane                   | Built: `app_platform`, schema `platform`, MFA and step-up, platform audit, no customer-data path  | Enforced in code: ADR-010 rule 2, Step 2  |
| Module boundaries and dependency rules          | Not enforced; one 13-module import cycle                                                         | Steps 2, 4, 5, 6                          |
| Schema-driven security inventory                | A guard checks forced RLS on `public` only; no data classification; no isolation-test check      | Step 3                                    |
| Tenant-consistent foreign keys                  | About 48 composite `(…, org_id)` keys; about 47 single-column keys to other tables not yet reviewed | Step 3 (review and report)             |
| Worker must not trust payload tenant IDs        | Built: principal binding (0076) and job organization guards                                      | Classified and tested in Step 3           |
| Pool reuse and RLS role tests                   | Built: `tests/db/authorized.test.ts`, `tests/guards/runtime-role.test.ts`, `rls-enabled.test.ts` | Kept                                      |
| `apps/` and `packages/` layout                  | Single application                                                                               | Steps 7 and 8                             |
| Test and tooling layout (`tests/…`, `tooling/`) | Tests by module; guards in `scripts/guards` and `tests/guards`                                   | Step 8 (last two pull requests)           |
| Caches                                          | None                                                                                             | None needed until one is added            |
| Files and signed links                          | No file storage (R2 for future files, ADR-006)                                                   | Phase 3, with the stage that needs files  |
| Versioned API for external clients              | `/api/...`, unversioned                                                                          | Phase 3, with the mobile and website stages |
| Product registry and entitlements               | Organization types only (0080)                                                                   | Phase 3; needs a decision amending ADR-007 GOV-04 |
| Real Estate / Education CRM, mobile, websites, white-label | Not built                                                                             | Phase 3, each with its own ADR            |
| Multiple organizations per login                | Not allowed                                                                                      | Only after a decision amending ADR-007 GOV-02 |

## 4. Phase 1 — untangle in place (Steps 1–6)

Each step is one branch and one draft pull request, started only on the founder's approval of that
step, merged only by the founder, and updates the documentation it affects. Steps 2–6 touch
protected paths and therefore always go through a pull request.

### Step 1 — Decisions and this specification (this pull request)

ADR-009, ADR-010 and this document. Documentation only.

### Step 2 — Module-boundary guard

- Add `tests/guards/module-boundaries.test.ts` as specified in ADR-010 "Enforcement": the import
  graph of `src/`, the module-to-layer map, rules 1–3, 5 and 7, cycle detection, and a baseline of
  today's violations that may only shrink.
- **Done when:** the guard passes on the branch; adding a forbidden import, a new cycle or an
  unmapped module makes it fail (mutation checks recorded in the PR); removing a baseline entry's
  cause without removing the entry makes it fail; all release gates pass.
- **Touches:** `tests/guards/` only. No application code.

### Step 3 — Schema-driven security inventory

- Add a classification of every table — platform, tenant-owned, public projection, global
  reference, operational — kept beside the schema, and a database-backed guard that fails when a
  table is unclassified; a tenant-owned table lacks `org_id`, enabled and forced RLS or policies
  for the roles that use it; or a tenant-owned table appears in no two-organization isolation test.
- Review the single-column foreign keys between tenant tables and report each as safe (the
  referenced table's RLS or a trigger keeps the organization consistent) or as a finding. Findings
  are reported, not fixed here: a fix would be a migration with its own approval.
- **Done when:** the guard passes; adding an unclassified or unprotected test table makes it fail;
  the foreign-key review is in the PR; all release gates pass.
- **Touches:** `tests/guards/` and a classification file; no migration.

### Step 4 — Break the foundation cycles

- Move the Better Auth table definitions so `db` no longer imports `auth`; move the worker-process
  flag (`jobs/process-context`) into `observability`; move `auth/client-address` below `audit`;
  move the invitation token, schema and error pieces both sides share so `auth` no longer imports
  `invitations`.
- **Done when:** L0–L2 import nothing from L3, L4 or the control plane; the Step 2 baseline shrinks
  accordingly; behaviour is unchanged (full suite at baseline); all release gates pass.
- **Touches:** `src/lib/{db,auth,audit,observability,invitations,jobs}` and their tests.

### Step 5 — Separate the queue from the worker

- Keep the queue core in `src/lib/jobs` (types, enqueue, wake, retry policy); move the worker
  entry, job handlers, scheduler and maintenance to `src/worker/`; update the `pnpm worker`
  script, `scripts/worker-loader.mjs` and `scripts/worker-alias-hooks.mjs` (which name the
  entrypoint and resolve the `@/` alias for it), the guards that name these files, and the worker
  documentation, including the worker command and entrypoint in DEPLOYMENT.md ("The worker
  plane": `pnpm worker`, `src/lib/jobs/runner.ts`).
- **Ownership:** `src/worker/` is new and not listed in AGENTS.md §3. The step adds it to Claude
  Code's files there (as `src/lib/**` and the worker plane are today). AGENTS.md is a rule file,
  so this needs the founder's explicit approval and goes in the same pull request.
- **Done when:** `src/lib/jobs` imports no L4 module; the worker starts and processes every job
  type; the opt-in worker end-to-end suite passes and its result is reported; all release gates
  pass.
- **Touches:** `src/lib/jobs`, `src/worker/` (new), `package.json` (`worker` script — a shared
  file), `scripts/worker-loader.mjs`, `scripts/worker-alias-hooks.mjs` (protected path), AGENTS.md
  §3 (rule file), DEPLOYMENT.md, and the guards and docs that name these paths.
- **Result (implemented):** decided file by file from the import graph.
  - _Stay in `src/lib/jobs` (queue core):_ `types`, `queue`, `wake`, `retry`, `audit`, `cron`,
    `schedule-policy`, and two new small modules — `handler-registry` and `wake-token`. `cron` and
    `audit` stay although the plan listed them for the worker: `queue.ts`, `schedule-policy.ts`,
    `workflows` and `src/app` import them, and moving them would have made an L4 module import the
    worker.
  - _Moved to `src/worker/`:_ `runner`, `handlers`, `workflow-jobs`, `reminder-sweep`,
    `retry-sweeper`, `scheduler`, `maintenance`, `liveness`, `worker`, `usage-estimate`,
    `wake-latch`, `wake-server`.
  - _Three cuts so no L4 module needs the worker:_ the handler registry out of `worker.ts` (so the
    Sales Sheet import registers its handler without importing the worker); the static webhook-URL
    (SSRF) guard out of `handlers.ts` into `integrations/webhook-url-guard.ts` (it validates
    subscription URLs, so integrations owns it); the wake-token header constant out of
    `wake-server.ts` into a zero-import module (the wake endpoint sits on the database-free
    liveness path whose import list a guard pins). Each cut is verbatim.
  - _`scripts/worker-alias-hooks.mjs` needed no change:_ it maps `@/` to `src/` generically;
    `scripts/worker-loader.mjs` changed in a comment only.

### Step 6 — Domain events

- Add the L3 `events` port. `crm`, `work` and `integrations` emit through it instead of calling
  `workflows` or `integrations` directly; the entry points register the subscribers. ADR-005's
  semantics are preserved and proven by the existing workflow, integration and webhook suites.
- **Done when:** the Step 2 baseline is empty — the module graph has no cycle; workflow,
  integration, notification and security suites pass unchanged; an independent security review
  finds no blocking issue; all release gates pass.
- **Touches:** `src/lib/{crm,work,integrations,workflows,events}`, `src/app` and `src/worker`
  wiring, tests, ADR-005 cross-reference.
- **Result (Step 6):** two typed ports in `src/lib/events` (`dispatchWorkflowEvent`,
  `emitIntegrationEvent`) with the signatures the call sites already used, so each of the 15 call
  sites changed by its import line only. `src/lib/composition/domain-events.ts` registers the real
  subscribers; `src/instrumentation.ts` (nodejs branch) and `src/worker/runner.ts` load it, and
  `tests/guards/domain-events-wired.test.ts` pins both. The registry lives on `globalThis`, so
  separate Next bundles share it; an emission with no subscriber is logged and reported on every
  occurrence and never throws. The boundary baseline is empty. Results are in §2.

## 5. Phase 2 — workspace (Steps 7–8), then Phase 3

### Step 7 — Workspace skeleton (planned; needs its own approval)

- pnpm workspaces with the pinned pnpm 12 (no new build tool). `apps/web` receives the Next.js
  application (`src/app`, `src/components`, `src/hooks`, `src/middleware.ts` — a shared file
  that needs the founder's approval to move or change (AGENTS.md §3) — `public/`, the
  Next, Sentry, PostCSS and component configuration); `apps/worker` receives `src/worker/`. Shared
  TypeScript, ESLint, Prettier and Vitest configuration move to the root workspace. CI, CODEOWNERS,
  `vercel.json` (project root) and the agent rule files are updated in the same change.
- Preconditions and ownership conditions: ADR-009 "File-ownership consequences" — Antigravity's
  open work settled first, rule files and CODEOWNERS moved with the code, path-pinning guards
  updated without weakening, Antigravity's read-only review before merge. The path-pinning
  surface is large: `grep -rlE "src/" tests` finds 90 test files at `3a8c155`, 32 of them among
  the 56 files in `tests/guards/` (a narrower search counts 89 and 30); each is updated in this
  step.
- **V1 deployment and the Vercel root directory.** The plan assumes **V1 is deployed before
  Step 7**, from the `v1.0.0` tag with the Vercel project's root directory at the repository root
  (no Vercel project exists today). Step 7 then changes the root directory to `apps/web` — a
  deployment setting, which is founder-only (AGENTS.md §3) and is changed by the founder when
  Step 7 merges. If V1 is not yet deployed when Step 7 is approved, the founder chooses at that
  approval between deploying V1 from the tag first or creating the Vercel project directly with
  `apps/web` as its root.
- **Done when:** all release gates pass from the workspace root; `pnpm build` produces the same
  routes as the baseline; the worker starts from `apps/worker`; CI is green.
- **Result (Step 7):** see ADR-009's "Step 7 result" amendment for the layout and the one
  deviation (`apps/web` keeps its own `src/`). 373 files were renamed without change; about 100
  files changed path strings, among them the guards that name `src/` paths, which now read all
  three source roots (a guard that walks `src` alone would have silently checked less). Results
  are in §2.

### Step 8 — Package extraction (planned; one pull request and one approval per package)

In dependency order, lowest first. The mapping is proposed here and confirmed in each package's
approval.

| Order | Package           | Receives                                                                                                   |
| ----- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| 1     | `shared-config`   | TypeScript, ESLint, Prettier and Vitest base configuration                                                 |
| 2     | `database`        | `src/lib/db`, `drizzle/`, `scripts/db/`, `scripts/migrate-ws.mjs` — every migration file byte-identical, SHA-256 checked before and after; runbook paths updated in the same PR |
| 3     | `observability`   | `src/lib/observability`                                                                                    |
| 4     | `security`        | `src/lib/{audit,auth,authz,identity}`                                                                      |
| 5     | `platform-core`   | `src/lib/platform` (control plane)                                                                         |
| 6     | `shared-services` | L3: `jobs` queue core, `notifications`, `events` (not in the blueprint sketch; an implemented responsibility, which the blueprint allows) |
| 7     | `contracts`       | Request and response schemas that are public contracts between apps                                        |
| 8     | `crm-core`        | Only the CRM concepts every CRM product shares: companies, contacts, relationships and activities from `src/lib/crm`. Whether deals and pipelines are shared or belong to a product is decided in this package's approval |
| 9     | `work`            | `src/lib/work`: projects, tasks, reminders                                                                 |
| 10    | `integrations`    | `src/lib/integrations`: connections, outbound webhooks, inbound endpoints, credential vault                |
| 11    | `automation`      | `src/lib/workflows`: the workflow engine, triggers, conditions, actions (depends on `crm-core`, `work`, `integrations`) |
| 12    | `imports`         | `src/lib/import`: the Sales Sheet import (depends on `crm-core`)                                           |
| 13    | `search`          | `src/lib/search`                                                                                           |
| 14    | `analytics`       | `src/lib/analytics` (depends on `work`)                                                                    |
| 15    | `ai`              | `src/lib/ai` (depends on `crm-core`, `work`)                                                               |
| 16    | `admin`           | Tenant administration: `src/lib/admin` and `src/lib/invitations`                                           |
| 17    | `shared-ui`       | `src/components/ui` (Antigravity-owned; same conditions as Step 7)                                         |
| 18–19 | `tooling/`, `tests/` | Guards and CI scripts to `tooling/`; tests regrouped into the blueprint's classes                       |

The order follows ADR-010's permitted edges, so every package depends only on packages extracted
before it. A package is created only for a module with an implemented responsibility and a stable
public surface (blueprint §05); two modules may stay together if their approval finds no stable
interface between them.

Each extraction: boundary guard green with package dependencies checked; all release gates; CI.

### Phase 3 — products and delivery (future; each needs its own ADR and approval)

Product registry · Real Estate CRM · Education CRM · shared mobile apps · organization websites and
custom domains · white-label apps. The product registry and entitlements, and anything letting one
login reach several organizations, first need a decision amending ADR-007 (ADR-009, "Blueprint
parts that need a new decision record"). Product stages also follow V1 acceptance (AGENTS.md §1).

## 6. Verification protocol — every step, three independent checks

1. **Local, on the exact commit:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
   `pnpm guards`, `pnpm build`; `roles.sql` and all migrations from zero; `pnpm test` on a
   disposable CI-shaped database, compared with §2. Secret scans on `HEAD` and on the branch diff.
2. **Independent review** of the actual diff against its base by a reviewer that did not write it
   (`independent-code-reviewer`; `security-auditor` for Steps 4–8 where security code moves;
   `database-migration-auditor` for the `database` package).
3. **GitHub CI** on the draft pull request: every check completed and passed. A failure followed by
   a green re-run is reported with its cause.

A pending, skipped or missing check is not a pass.

## 7. Threats this plan addresses

| Threat                                                                   | Control after the plan                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| A new tenant table ships without RLS or isolation tests                  | Step 3 guard fails CI                                               |
| Foundation code silently depends on feature code (privilege paths blur)  | ADR-010 layers; Step 2 guard; Steps 4–5                             |
| The control plane gains a path into tenant modules                       | ADR-010 rule 2, enforced by the Step 2 guard, then by package boundaries |
| A cross-tenant reference through a single-column foreign key             | Step 3 review                                                       |
| A cross-domain change bypasses the workflow engine's authority rules     | Step 6 port keeps ADR-005 semantics, proven by the existing suites  |
| A migration file changes when it moves                                   | Step 8 byte-identity check against the journal's recorded hashes    |

## 8. Cost estimate, stage by stage

Relative to Step 1 (including this amendment), whose actual cost the founder reads from usage.
Phases 1–2 are estimated from measured work; Phase 3 figures are low-confidence orders of
magnitude, replaced by a real estimate in each stage's ADR.

| Stage                                   | Relative to Step 1 | Basis                                                                 |
| --------------------------------------- | ------------------ | --------------------------------------------------------------------- |
| Step 2 — boundary guard                 | about 1×           | One guard file; full verification and mutation checks                 |
| Step 3 — security inventory             | 1.5–2×             | Classifying 74 tables, a database-backed guard, about 47 foreign keys |
| Step 4 — foundation cycles              | about 1×           | Four small moves                                                      |
| Step 5 — queue vs worker                | about 1.5×         | Worker paths named by guards and docs; worker end-to-end run          |
| Step 6 — domain events                  | 2–3×               | Behaviour-sensitive refactor; security review                         |
| **Phase 1 total**                       | **7–8.5×**         |                                                                       |
| Step 7 — workspace skeleton             | 4–5×               | Moves the Next.js app; configs, CI, rule files, about 90 path-pinning test files |
| Step 8 — package extraction (19 PRs)    | 18–25×             | About 1× each; `database`, `security`, `crm-core` and `automation` 1.5–2× |
| **Phase 2 total**                       | **22–30×**         |                                                                       |
| Product registry (after ADR-007 amendment) | 3–5×            | Low confidence                                                        |
| Real Estate CRM; Education CRM          | 20–40× each        | Low confidence; depends on the product ADR's scope                    |
| Shared mobile app (per product)         | 20–40× each        | Low confidence; store accounts and signing are founder actions        |
| Organization websites and domains       | 15–30×             | Low confidence                                                        |
| White-label apps                        | 10–20×             | Low confidence                                                        |

Each estimate is revised with the measured cost of the step before it.
