# PRAVSHI OS

A multi-tenant business operating system — CRM, sales pipelines, work management, workflows,
background jobs, analytics, search, notifications, AI assistance and integrations — behind a
single authorization model that the database enforces, not the application layer.

**V1 scope** is this Business OS, as decided on 2026-10-16 in
[ADR-006](docs/architecture/adr/006-v1-scope-business-os.md). The original HR and operations
blueprint (people, HR documents, policies, recruitment, onboarding and offboarding) is preserved
as a deferred, separate future product scope; it is not part of V1. The V1 product decisions on
organization membership, provisioning, trial and paid tenants and the Sales Sheet import are in
[ADR-007](docs/architecture/adr/007-v1-founder-product-decisions.md), amended by
[ADR-008](docs/architecture/adr/008-v1-platform-and-import-decisions.md) (platform administration and
import decisions, and the V1 acceptance definition).

**Internal use only. No public signup exists.**

## Status: V1 — implementation complete, deployment pending founder gates

All thirteen build phases are implemented, reviewed and merged to `main`: the Phase 0
foundation (one authorized path to Postgres, row-level security the runtime role cannot
bypass, a CI pipeline that proves those properties on every pull request), CRM, sales
pipelines, work management, the workflow engine, automation and background jobs,
analytics, search and notifications, the AI foundation, the integrations platform,
security hardening, and performance/reliability hardening. The V1 decisions of
ADR-007 and ADR-008 are built on top of them: organization types, the Sales Sheet import and
the platform administrator console.

## What V1 contains

- **CRM** — companies, contacts, deals, activities and relationships; sales pipelines with
  per-pipeline settings.
- **Work management** — projects, tasks, subtasks, reminders and a personal task list, linked to
  deals.
- **Workflows, schedules and background jobs** — a workflow engine, scheduled runs, a worker
  plane with its own database login, and a dead-letter view.
- **Analytics** — CRM, sales, work and automation dashboards.
- **Search and notifications**, including per-user notification settings.
- **AI assistance** — a permission-aware assistant with usage limits; a deterministic mock
  provider unless a real one is configured.
- **Integrations** — the integrations platform and its settings.
- **Administration** — users, roles, permissions, teams, departments and the audit log; invitations,
  password reset, multi-factor authentication and login lockout.
- **Platform console** (`/platform`, ADR-008) — a separate, audited platform administrator
  authority that provisions organizations. It has its own database login (`app_platform`).
- **Sales Sheet import** — built against a representative mapping only. The real source-column
  mapping has not been supplied, so validation against the real sheet is **pending**.

One login belongs to exactly one organization (ADR-007). Authorization is enforced by the
database (forced row-level security), not by the application layer; see
[SECURITY.md](SECURITY.md).

| Area                                  | Status                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Product surface (Phases 1–10)         | Done — merged, CI green                                                 |
| Security hardening (Phase 11)         | Done — migration 0061, extended by further hardening up to 0082         |
| Performance & reliability (Phase 12)  | Done — migration 0062                                                   |
| Production readiness (Phase 13)       | Docs, runbooks and release identity done; the go-live gates remain open |
| Organization types                    | Mechanism built (migration 0080); the industry types stay disabled      |
| Platform console                      | Built — migrations 0083–0087                                            |
| Sales Sheet import                    | Built — migrations 0081 and 0088; **real-sheet validation pending**     |
| **Vercel deployment and DNS**         | **Not performed — founder gates HG-1, HG-5**                            |
| **Production migrations (0045–0088)** | **Not applied — founder gate HG-2**                                     |
| **First SUPER_ADMIN bootstrap**       | **Not performed — founder gate HG-9**                                   |
| **Platform administrator bootstrap**  | **Not performed — needs its own founder approval**                      |
| **Cloudflare R2 buckets**             | **Deferred — no file storage in V1 (ADR-006)**                          |
| **Sentry**                            | **Not configured — no DSN issued (gate HG-6)**                          |

Nothing is deployed. `os.pravshi.com` does not resolve and no Vercel project exists.
Deployment is a founder-approved act, not an engineering default: the operative gate list
is [docs/runbooks/release-checklist.md](docs/runbooks/release-checklist.md), the procedure
is [DEPLOYMENT.md](DEPLOYMENT.md), and the production migration has its own runbook,
[docs/runbooks/production-migration.md](docs/runbooks/production-migration.md).

## Prerequisites

- **Node 22 LTS** (`.nvmrc` pins `22`; `package.json` requires `>=22.12 <23`)
- **pnpm 12.3.4** (pinned via `packageManager`; run `corepack enable`)
- A **Neon branch** you can connect to. Do not use `production`. See
  [DEVELOPMENT.md](DEVELOPMENT.md).

## Getting started

```bash
pnpm install
cp .env.example .env      # then fill in the values — see ENVIRONMENT.md
pnpm dev
```

Open http://localhost:3000 and sign in. On a fresh database with no users yet, the one-time
bootstrap creates the first SUPER_ADMIN — see [DEPLOYMENT.md](DEPLOYMENT.md) §7 and
[scripts/bootstrap/README.md](scripts/bootstrap/README.md).

## Documentation

| Document                           | What it covers                                                     |
| ---------------------------------- | ------------------------------------------------------------------ |
| [DEVELOPMENT.md](DEVELOPMENT.md)   | Local setup, your own Neon branch, the one rule about data access  |
| [ENVIRONMENT.md](ENVIRONMENT.md)   | Every variable, its role, and where its value is permitted to live |
| [SECURITY.md](SECURITY.md)         | Database roles, RLS, the CI guards, credential rotation            |
| [DEPLOYMENT.md](DEPLOYMENT.md)     | The future deployment procedure. Nothing here is live yet          |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Branch workflow, PR rules, what CI can and cannot enforce          |

Architecture and planning documents live in [`docs/`](docs/): the
[master blueprint](docs/superpowers/specs/2026-09-06-pravshi-os-master-blueprint.md),
[database.md](docs/architecture/database.md), [security.md](docs/architecture/security.md)
and [build-plan.md](docs/architecture/build-plan.md), and the decisions in
[`docs/architecture/adr/`](docs/architecture/adr/). The blueprint's architecture is binding;
its §32 scope and the build plan's phase list are superseded for V1 by
[ADR-006](docs/architecture/adr/006-v1-scope-business-os.md).

## Verification

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```

`pnpm test` needs a database. See [DEVELOPMENT.md](DEVELOPMENT.md) before running it.

## Phase 0 exit criteria

The plan defines eight. **Five are met; three depend on deployment, which is deferred.**

| #   | Criterion                                       | Status                          | Evidence                                                                                      |
| --- | ----------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | Placeholder live at `os.pravshi.com` over HTTPS | **Deferred** — not deployed     | No Vercel project, no DNS record                                                              |
| 2   | Deployed through the full CI pipeline           | **Deferred** — nothing deployed | CI itself is green on every PR                                                                |
| 3   | A migration applied to **production**           | **Not done, deliberately**      | Migrations have run only on CI's throwaway Postgres containers and local disposable databases |
| 4   | `app_user` cannot bypass RLS                    | **Met**                         | `tests/guards/runtime-role.test.ts`                                                           |
| 5   | Every table has RLS enabled and forced          | **Met**                         | `tests/guards/rls-enabled.test.ts`                                                            |
| 6   | Context does not leak across pooled connections | **Met**                         | `tests/db/authorized.test.ts`                                                                 |
| 7   | Nothing defeats autosuspend                     | **Met**                         | `tests/guards/no-keepalive.test.ts`; no `crons`                                               |
| 8   | `/health` does not touch the database           | **Met**                         | `tests/health/no-db-in-health.test.ts`                                                        |

Criterion 3 is achievable without any cloud provider — it is a Neon operation — but is held
until deployment readiness so the production branch stays untouched while there is no
application to serve.

### Local versus cloud

**Complete locally:** repository and tooling, database roles and RLS proof,
`withAuthorizedDb()`, health endpoints, design system and shell, CI pipeline and security
guards, storage object-key format, this documentation.

**Deferred to a future readiness phase:** Vercel project and deployment, `os.pravshi.com`
DNS and TLS, Cloudflare R2 buckets and scoped token, Sentry DSN, and the first production
migration.
