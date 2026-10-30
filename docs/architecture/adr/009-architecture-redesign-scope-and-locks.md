# ADR-009: Architecture redesign — scope, non-goals and locked decisions

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
separated as they stand: moving folders would carry the cycle into the new layout.

## Decision

1. **Redesign in place, untangle first.** The redesign is a bounded sequence of six steps
   ([target-architecture.md](../target-architecture.md) §4): this record and ADR-010 (Step 1); a
   module-boundary guard (Step 2); a schema-driven security inventory (Step 3); breaking the
   foundation cycles (Step 4); splitting the job queue from the worker's entry point (Step 5);
   replacing the remaining domain cycles with an internal event port (Step 6). Each step is its
   own branch and pull request, approved and merged by the founder. **The plan ends after
   Step 6.**
2. **Behaviour is preserved.** No step changes the database schema, a migration, a route, a
   permission, an RLS policy or a screen unless that step's approval says so. "Works as before" is
   proven per step by the verification protocol in target-architecture.md §5, against the
   baseline recorded there.
3. **Deployables stay as they are:** one Next.js application (`src/app`: tenant workspace,
   platform console and API routes) and one worker process. The blueprint allows these to share a
   process at first; separation is logical, enforced by ADR-010.
4. **Workspaces and package extraction are out of scope.** Moving code into `apps/` and
   `packages/` (pnpm workspaces, if adopted — no Turborepo) is revisited only when mobile apps or
   organization websites need to share code with the web application. Until then the target
   module layout of ADR-010 is realised inside `src/lib`.
5. **`src/app` and `src/components` are not moved** by this plan; frontend file ownership
   (AGENTS.md §3) is unchanged.
6. **V1 baseline.** The V1 baseline commit `3a8c155` is marked with the annotated tag `v1.0.0`
   so V1 can still be deployed from it while the redesign proceeds. Pushing that tag needs its own
   founder approval at the time.

## Non-goals

- **No product code.** Real Estate CRM, Education CRM, mobile apps, organization websites, custom
  domains and white-label apps are not built. ADR-008 P-1 places them outside V1, and AGENTS.md §1
  puts V1 acceptance first. The redesign prepares the structure they will need and nothing more.
- **No entitlements.** No product registry, plan, tier, entitlement or feature flag is built, and
  no record is written for one now. ADR-007 GOV-04 stands: no V1 feature reads a plan or tier.
- **No multi-organization login.** One login belongs to exactly one organization (ADR-007
  GOV-02). No organization switching, for web or mobile.
- **No new deployable, provider, dependency or database.** No migration is required by any step;
  if one turns out to be needed it is a separate, approved change under the migration rules.
- **No hosted operation.** No hosted database, deployment, DNS, secret or repository setting is
  touched by this plan.

## Locked decisions this plan must respect

Recorded here so every step can be checked against one list. Changing any of them needs a new
founder decision record.

| Lock                                                                                                                                                                                                                                                                 | Source                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| V1 is the multi-tenant Business OS; the HR blueprint is deferred and its documents are kept                                                                                                                                                                          | ADR-006                        |
| Neon PostgreSQL, Better Auth, Cloudflare R2 for any future files, the Singapore region, scale-to-zero (nothing may keep compute awake)                                                                                                                                | ADR-006 §3                     |
| `app_user` without `BYPASSRLS`; RLS enabled **and forced** on every `public` table; identity set transaction-locally; one authorized data path; fail-closed authorization                                                                                            | ADR-006 §3, AGENTS.md §5       |
| Separate logins per plane, each with its own credential and placement; no role may hold `BYPASSRLS`, `SUPERUSER`, `CREATEROLE` or `CREATEDB`                                                                                                                         | AGENTS.md §5, `roles.sql`      |
| One login, one organization                                                                                                                                                                                                                                          | ADR-007 GOV-02                 |
| Free-trial and paid organizations share capabilities and guarantees; no plans, entitlements, billing or usage limits                                                                                                                                                | ADR-007 GOV-04                 |
| Platform administration is a separate authority with no access to customer business data; suspend and reactivate in V1, archive and restore deferred                                                                                                                 | ADR-007 GOV-03, ADR-008 P-1/L1 |
| Migrations: `scripts/migrate-ws.mjs` is the only runner; order is the journal's `idx`, never time; applied files, `when` values and recorded hashes are never edited; migration files stay byte-identical (SHA-256 checked) if they are ever moved                  | AGENTS.md §5, ADR-009 §C6      |
| Workflow engine semantics: post-commit emission, depth bound of 5, actions run with the trigger actor's authority, inline or queued execution                                                                                                                        | ADR-005                        |
| File ownership and approval gates: frontend files belong to Antigravity; shared and rule files, CI, scripts, guards, dependencies and migrations go through a founder-approved PR                                                                                     | AGENTS.md §3–§4                |

## Reconciliation with the blueprint (decisions of 2026-10-30)

| #   | Blueprint                                                     | Decision                                                                                                       |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| C1  | Finish V1 before refactoring                                  | Tag the V1 baseline (`v1.0.0` on `3a8c155`); push only on a separate approval                                  |
| C2  | Real Estate / Education CRMs, mobile, websites, white-label   | Not built; structure only                                                                                      |
| C3  | Product entitlements as an access input                       | Deferred; no record written now                                                                                |
| C4  | Organization switching                                        | Not adopted; one login, one organization                                                                       |
| C5  | RLS "evaluated per data class"; providers "to be validated"   | Not adopted: forced RLS everywhere and the ADR-006 providers stay locked                                       |
| C6  | `packages/database` owns migrations                           | Only if packages are ever extracted; files moved byte-identical and hash-checked                               |
| C7  | `apps/web` holds the UI                                       | `src/app` and `src/components` are not moved in this plan                                                      |
| C8  | Separate `api` and `platform-console` deployables             | Not adopted; one web application and one worker                                                                |

## Consequences

- The redesign delivers enforced module boundaries, a security inventory that fails CI on an
  unclassified or unprotected table, and an acyclic module graph — without moving the application,
  the database or any public contract.
- Product work, workspaces and package extraction remain future decisions, each needing its own
  record.
- Every step updates the documentation it affects in the same pull request.

## Reconsider when

- Mobile apps or organization websites need code shared with the web application (revisit
  workspaces and packages).
- V1 is accepted and a CRM product is approved (revisit C2 and C3).
- Measured load or isolation needs justify a separate deployable (revisit C8).
