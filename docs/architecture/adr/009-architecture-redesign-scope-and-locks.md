# ADR-009: Architecture redesign — end state, stages and locked decisions

Status: Accepted | Date: 2026-10-30 | Deciders: Founder

## Context

The founder supplied a target architecture, _Pravshi OS Complete Architecture Blueprint v0.1_
(planning draft, 29 October 2026). It describes a security-first multi-tenant platform: a control
plane and a tenant plane, independent CRM products (Real Estate, Education), shared mobile apps,
organization websites and white-label apps, a monorepo of `apps/` and `packages/`, and strict
module dependency rules. The blueprint states that it is a design baseline, not an implementation
authorization, and that it must be reconciled with the released V1 before any code changes.

A read-only audit of `main` at `3a8c155` (the V1 baseline) found:

- The security foundation the blueprint asks for largely exists: forced RLS on every `public`
  table, transaction-local identity through one data path (`withAuthorizedDb()`), a seven-step
  `requirePermission()`, separate database logins per plane (`app_user`, `app_auth`,
  `app_worker`, `app_platform`, `app_admin`, `app_owner`) and a platform console with no path to
  customer business data (ADR-008).
- **The module structure does not.** 13 of the 20 modules in `src/lib` form a single import cycle
  (`db`, `auth`, `authz`, `audit`, `observability`, `invitations`, `jobs`, `crm`, `work`,
  `workflows`, `integrations`, `notifications`, `import`). The foundation layer imports feature
  code (for example `db → auth/schema`, `observability → jobs`, `auth ↔ invitations`), and `jobs`
  is both the low-level queue and the worker's composition root. Nothing enforces module
  boundaries; ESLint restricts only `process.env`.

Because of that cycle, the blueprint's packages (`database`, `security`, `crm-core`, …) cannot be
separated as they stand: moving folders first would carry the cycle into the new layout.

## Decision

1. **The end state is the blueprint.** Pravshi OS converges on the blueprint's architecture: the
   `apps/` and `packages/` layout, the control plane and tenant plane, independent CRM product
   modules, and the delivery channels (web, shared mobile apps, organization websites,
   white-label apps). It is reached in stages; each stage below needs its own founder approval,
   and no approval extends to the next stage.
2. **Phase 1 — untangle first (Steps 1–6).** In place, inside `src/`: this record and ADR-010
   (Step 1); a module-boundary guard (Step 2); a schema-driven security inventory (Step 3);
   breaking the foundation cycles (Step 4); separating the job queue from the worker's entry point
   (Step 5); replacing the remaining domain cycles with an internal event port (Step 6). After
   Step 6 the module graph has no cycle.
3. **Phase 2 — workspace (Steps 7–8), planned.**
   - **Step 7, workspace skeleton:** pnpm workspaces; `apps/web` (the Next.js application, moved
     from the repository root and `src/app`, `src/components`, `src/hooks`, `public`) and
     `apps/worker` (the worker entry from Step 5); shared configuration; CI, CODEOWNERS and the
     agent rule files updated in the same change.
   - **Step 8, package extraction:** the modules of ADR-010 move into `packages/`, **one package
     per pull request, in dependency order** (lowest layer first), each with its own approval.
     `crm-core` holds only the CRM concepts every product shares; the other tenant capabilities
     (work, integrations, automation, imports, search, analytics, ai, admin) become their own
     packages (target-architecture.md §5).
4. **Phase 3 — products and delivery, future stages.** The product registry, the Real Estate CRM,
   the Education CRM, the shared mobile apps, organization websites and custom domains, and
   white-label apps are separate future stages. **Each needs its own ADR and its own approval**
   before any of it is built.
5. **Behaviour is preserved in Phases 1 and 2.** No step changes the database schema, a migration,
   a route, a permission, an RLS policy or a screen unless that step's approval says so. "Works as
   before" is proven per step by the verification protocol in
   [target-architecture.md](../target-architecture.md) §6, against the V1 baseline recorded there.
6. **Deployables.** `apps/web` serves the tenant workspace, the platform console and the API
   routes, and `apps/worker` runs background work — as today, which the blueprint allows. A
   further split happens only when measured need justifies it, as the blueprint itself requires.
7. **Tooling.** pnpm workspaces with the pinned pnpm 12; no Turborepo or other new build tool
   unless a later approval adds one.
8. **V1 baseline.** The V1 baseline commit `3a8c155` is marked with the annotated tag `v1.0.0`, so
   V1 can still be deployed from it while the redesign proceeds. The tag exists locally and has
   not been pushed; pushing it needs its own founder approval at the time.

## Non-goals of Phases 1 and 2

- **No product code.** Phase 3 stages are not started by Phases 1–2; they only prepare the
  structure.
- **No entitlements, plans or product registry.**
- **No multi-organization login** and no organization switching.
- **No migration, new provider, new dependency or new deployable.** If a step turns out to need
  one, it is a separate, approved change under the migration and dependency rules.
- **No hosted operation.** No hosted database, deployment, DNS, secret or repository setting.

## Blueprint parts that need a new decision record from the founder

These parts of the blueprint contradict an accepted decision. They are not built, designed in
detail or assumed by any stage until the founder records a new decision that amends the one named.

| Blueprint part                                                                                                                                                                                         | Accepted decision it contradicts                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Product registry and entitlements: product enablement and feature entitlements in the control plane (§04), entitlement as an input to every access decision (§07), the product registry (§11)       | ADR-007 GOV-04 — no V1 feature reads a plan or tier; no plan, entitlement, billing or usage limits |
| Anything that lets one login reach more than one organization: users belonging to several organizations and organization switching in the shared mobile apps (§12), org-switching flows (§15)       | ADR-007 GOV-02 — one login belongs to exactly one organization                                      |

Everything else the blueprint leaves optional (it says "evaluate", "if selected", "when
justified" or "decision pending") is not a conflict. Where Phases 1–2 rely on such an option, the
choice is stated in Decision 6 and 7 above and in the lock list below.

## Locked decisions every stage must respect

Changing any of them needs a new founder decision record.

| Lock                                                                                                                                                                                                                                                                 | Source                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| V1 is the multi-tenant Business OS; the HR blueprint is deferred and its documents are kept; V1 acceptance comes before later product work                                                                                                                           | ADR-006, AGENTS.md §1          |
| Neon PostgreSQL, Better Auth, Cloudflare R2 for any future files, the Singapore region, scale-to-zero (nothing may keep compute awake)                                                                                                                                | ADR-006 §3                     |
| `app_user` without `BYPASSRLS`; RLS enabled **and forced** on every `public` table; identity set transaction-locally; one authorized data path; fail-closed authorization                                                                                            | ADR-006 §3, AGENTS.md §5       |
| Separate logins per plane, each with its own credential and placement; no role may hold `BYPASSRLS`, `SUPERUSER`, `CREATEROLE` or `CREATEDB`                                                                                                                         | AGENTS.md §5, `roles.sql`      |
| One login, one organization                                                                                                                                                                                                                                          | ADR-007 GOV-02                 |
| Free-trial and paid organizations share capabilities and guarantees; no plans, entitlements, billing or usage limits                                                                                                                                                | ADR-007 GOV-04                 |
| Platform administration is a separate authority with no access to customer business data; suspend and reactivate in V1, archive and restore deferred                                                                                                                 | ADR-007 GOV-03, ADR-008 P-1/L1 |
| Migrations: `scripts/migrate-ws.mjs` is the only runner; order is the journal's `idx`, never time; applied files, `when` values and recorded hashes are never edited; if migration files move (Step 8), every file stays byte-identical, proven by SHA-256 before and after | AGENTS.md §5                   |
| Workflow engine semantics: post-commit emission, depth bound of 5, actions run with the trigger actor's authority, inline or queued execution                                                                                                                        | ADR-005                        |
| File ownership and approval gates: frontend files belong to Antigravity; shared and rule files, CI, scripts, guards, dependencies and migrations go through a founder-approved PR                                                                                     | AGENTS.md §3–§4                |

## File-ownership consequences of moving `src/app` and `src/components` (Step 7)

Steps 1–6 do not move these folders. Step 7 does, and it changes what the ownership rules point
at, so it carries these conditions:

- **Antigravity's work is settled first.** Every open Antigravity branch and worktree touching
  `src/app`, `src/components` or `src/hooks` is merged or paused before Step 7 starts; nothing is
  rebased or moved on its behalf (AGENTS.md §5).
- **The rule files move with the code, in the same pull request:** AGENTS.md §3 and §8, CLAUDE.md,
  `.agents/rules/pravshi-frontend-only.md` and `.claude/rules/*` name the new paths
  (`apps/web/app/**`, `apps/web/components/**`, …). Ownership itself does not change: the
  frontend stays Antigravity's, route handlers, `'use server'` files and the server-side calls
  stay Claude Code's.
- **CODEOWNERS** entries for `/src/app/` and `/src/components/` are updated to the new paths.
- **Guards that name these paths** are updated in the same change, without weakening any check:
  `require-permission-first` (its exact pre-authentication route list), `frontend-boundary-leaks`,
  `frontend-resilience`, `no-keepalive` (its allowlist) and the other tests that name `src/` paths
  (`grep -rlE "src/" tests` finds 90 files at `3a8c155`, 32 of the 56 guard files; a narrower
  search counts 89 and 30).
- **`src/middleware.ts`** moves to `apps/web` only with the founder's explicit approval: it is a
  shared file (AGENTS.md §3).
- **Antigravity reviews the move** read-only and reports findings (AGENTS.md §6) before the
  founder merges.
- `src/components/ui` becomes `packages/shared-ui` only in Step 8, under the same conditions.

## Consequences

- Phase 1 delivers enforced module boundaries, a security inventory that fails CI on an
  unclassified or unprotected table, and an acyclic module graph — without moving the application,
  the database or any public contract.
- Phase 2 then turns that graph into the blueprint's `apps/` and `packages/` layout mechanically.
- Phase 3 starts only with its own ADRs; the two parts listed above also need a decision that
  amends ADR-007.
- Every step updates the documentation it affects in the same pull request.

## Reconsider when

- A Phase 3 stage is approved and needs a structure Phases 1–2 did not provide.
- Measured load or isolation needs justify another deployable.
