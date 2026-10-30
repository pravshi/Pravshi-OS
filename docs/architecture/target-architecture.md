# Target architecture and redesign plan

Decisions: [ADR-009](adr/009-architecture-redesign-scope-and-locks.md) (scope, non-goals, locks)
and [ADR-010](adr/010-module-layers-and-dependency-rules.md) (layers and dependency rules).
Source: _Pravshi OS Complete Architecture Blueprint v0.1_ (founder, 29 October 2026), reconciled
with `main` at `3a8c155`. Status: Step 1 of 6. Nothing in §4 is implemented until its step is
approved and merged.

## 1. Target in one picture

```
            Entry points (composition roots)
   src/app: tenant pages · platform console · route handlers · server actions
   src/worker (Step 5): worker loop · job handlers · scheduler
                         │ may import any layer
                         ▼
   L4 tenant domain   crm · work · workflows · integrations · import · ai
                      analytics · search · admin · invitations
                         │                      Control plane: platform
                         ▼                      (imports L0–L2 only)
   L3 shared services jobs (queue core) · notifications · events
                         ▼
   L2 security        audit → auth → authz · identity
                         ▼
   L1 infrastructure  db · observability · storage
                         ▼
   L0 configuration   src/env.ts · src/lib/utils.ts
```

One web application and one worker, as today. The database, its roles, RLS policies, migrations,
routes, permissions and screens are unchanged by the redesign.

## 2. Baseline (V1, `3a8c155`, tag `v1.0.0`)

Recorded on 2026-10-30 in a cloud session, on the exact commit, before any redesign change:

| Check                                                         | Result                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`             | pass                                                                              |
| `pnpm guards`                                                  | pass (secret scan: 1,043 tracked files; workflow secret flow: 2 workflows)        |
| `pnpm build`                                                   | pass                                                                              |
| `roles.sql` + `node scripts/migrate-ws.mjs` from zero         | 88 of 88 applied; each of the five runtime and owner logins connects as itself    |
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

## 3. Gap analysis: blueprint against V1

| Blueprint area                                  | V1 today                                                                                         | Redesign action                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Trust sequence (identity → membership → authorization → data) | Built: `requirePermission()` steps 1–7; membership = person + live engagement + ACTIVE organization | Document only                      |
| Control plane vs tenant plane                   | Built: `app_platform`, schema `platform`, MFA and step-up, platform audit, no customer-data path  | Enforce in code (ADR-010 rule 2)   |
| Module boundaries and dependency rules          | Not enforced; one 13-module import cycle                                                         | Steps 2, 4, 5, 6                   |
| Schema-driven security inventory                | A guard checks forced RLS on `public` only; no data classification; no isolation-test check      | Step 3                             |
| Tenant-consistent foreign keys                  | About 48 composite `(…, org_id)` keys; about 47 single-column keys to other tables not yet reviewed | Step 3 (review and report)         |
| Worker must not trust payload tenant IDs        | Built: principal binding (0076) and job organization guards                                      | Classified and tested in Step 3    |
| Pool reuse and RLS role tests                   | Built: `tests/db/authorized.test.ts`, `tests/guards/runtime-role.test.ts`, `rls-enabled.test.ts` | Kept                               |
| Caches                                          | None                                                                                             | None needed                        |
| Files and signed links                          | No file storage (R2 deferred, ADR-006)                                                           | Out of scope                       |
| Versioned API, mobile, websites, white-label    | Not built                                                                                        | Out of scope (ADR-009 non-goals)   |
| Product registry and entitlements               | Organization types only (0080)                                                                   | Out of scope (ADR-009, C3)         |
| Workspaces and packages                         | Single application                                                                               | Out of scope until needed (ADR-009 §4) |

## 4. Steps

Each step is one branch and one draft pull request, started only on the founder's approval of
that step, merged only by the founder. Each updates the documentation it affects. Steps 2–6 touch
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
  script, the guards that name these files and the worker documentation.
- **Done when:** `src/lib/jobs` imports no L4 module; the worker starts and processes every job
  type; the opt-in worker end-to-end suite passes and its result is reported; all release gates
  pass.
- **Touches:** `src/lib/jobs`, `src/worker/` (new), `package.json` (`worker` script — a shared
  file), guards and docs that name these paths.

### Step 6 — Domain events

- Add the L3 `events` port. `crm`, `work` and `integrations` emit through it instead of calling
  `workflows` or `integrations` directly; the entry points register the subscribers. ADR-005's
  semantics are preserved and proven by the existing workflow, integration and webhook suites.
- **Done when:** the Step 2 baseline is empty — the module graph has no cycle; workflow,
  integration, notification and security suites pass unchanged; an independent security review
  finds no blocking issue; all release gates pass.
- **Touches:** `src/lib/{crm,work,integrations,workflows,events}`, `src/app` and `src/worker`
  wiring, tests, ADR-005 cross-reference.

**The plan ends here.** Workspaces and package extraction are revisited only when mobile apps or
organization websites need shared code (ADR-009 §4).

## 5. Verification protocol — every step, three independent checks

1. **Local, on the exact commit:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
   `pnpm guards`, `pnpm build`; `roles.sql` and all migrations from zero; `pnpm test` on a
   disposable CI-shaped database, compared with §2. Secret scans on `HEAD` and on the branch diff.
2. **Independent review** of the actual diff against its base by a reviewer that did not write it
   (`independent-code-reviewer`; `security-auditor` for Steps 4–6). Findings are fixed and the
   affected tests re-run.
3. **GitHub CI** on the draft pull request: every check completed and passed. A failure followed by
   a green re-run is reported with its cause.

A pending, skipped or missing check is not a pass.

## 6. Threats this plan addresses

| Threat                                                                   | Control after the plan                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| A new tenant table ships without RLS or isolation tests                  | Step 3 guard fails CI                                               |
| Foundation code silently depends on feature code (privilege paths blur)  | ADR-010 layers; Step 2 guard; Steps 4–5                             |
| The control plane gains a path into tenant modules                       | ADR-010 rule 2, enforced by the Step 2 guard                        |
| A cross-tenant reference through a single-column foreign key             | Step 3 review                                                       |
| A cross-domain change bypasses the workflow engine's authority rules     | Step 6 port keeps ADR-005 semantics, proven by the existing suites  |

## 7. Cost estimate

Measured relative to Step 1, the unit the founder can read from actual usage:

| Step | Relative to Step 1 | Why                                                                                       |
| ---- | ------------------ | ----------------------------------------------------------------------------------------- |
| 2    | about 1×           | One guard file; most of the cost is the full verification run and mutation checks         |
| 3    | about 1.5–2×       | Classifying 74 tables, a database-backed guard and a review of about 47 foreign keys            |
| 4    | about 1×           | Four small moves; full verification                                                       |
| 5    | about 1.5×         | More files and guards name the moved paths; worker end-to-end run                         |
| 6    | about 2–3×         | Behaviour-sensitive refactor of the workflow and integration emission paths; security review |

Estimates; each is revised with the measured cost of the step before it.
