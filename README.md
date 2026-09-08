# PRAVSHI OS

Internal operations platform for PRAVSHI. It exists to run the company's own HR, projects
and corporate records behind a single authorization model that the database enforces, not
the application layer.

**Internal use only. No public signup exists.**

## Status: Phase 0 (foundation), partially complete

Phase 0 ships nothing user-facing. It builds the guarantees every later phase depends on:
one authorized path to Postgres, row-level security the runtime role cannot bypass, a CI
pipeline that proves those properties on every pull request, and the documentation you are
reading.

| Area                              | Status                                            |
| --------------------------------- | ------------------------------------------------- |
| Repository, tooling, test harness | Done                                              |
| Neon database, roles, RLS proof   | Done — `production` and `staging` branches exist  |
| `withAuthorizedDb()` data path    | Done                                              |
| Health endpoints                  | Done                                              |
| Design system and app shell       | Done                                              |
| GitHub org, teams, CODEOWNERS     | Done, within GitHub Free limits                   |
| CI pipeline + security guards     | Done — green on every PR                          |
| Storage object-key format         | Done                                              |
| Documentation                     | This set                                          |
| **Vercel deployment and DNS**     | **Deferred by founder decision — not configured** |
| **Cloudflare R2 buckets**         | **Deferred — no buckets exist**                   |
| **Sentry**                        | **Not configured — no DSN issued**                |

Nothing is deployed. `os.pravshi.com` does not resolve, no Vercel project exists, and no
migration has been applied to the production database. See [DEPLOYMENT.md](DEPLOYMENT.md)
for the procedure that will be followed when deployment happens.

## Prerequisites

- **Node 22 LTS** (`.nvmrc` pins `22`; `package.json` requires `>=22.12`)
- **pnpm 12.3.4** (pinned via `packageManager`; run `corepack enable`)
- A **Neon branch** you can connect to. Do not use `production`. See
  [DEVELOPMENT.md](DEVELOPMENT.md).

## Getting started

```bash
pnpm install
cp .env.example .env      # then fill in the values — see ENVIRONMENT.md
pnpm dev
```

Open http://localhost:3000. The Phase 0 placeholder renders the application shell; there is
no feature behind it yet.

## Documentation

| Document                           | What it covers                                                     |
| ---------------------------------- | ------------------------------------------------------------------ |
| [DEVELOPMENT.md](DEVELOPMENT.md)   | Local setup, your own Neon branch, the one rule about data access  |
| [ENVIRONMENT.md](ENVIRONMENT.md)   | Every variable, its role, and where its value is permitted to live |
| [SECURITY.md](SECURITY.md)         | Database roles, RLS, the CI guards, credential rotation            |
| [DEPLOYMENT.md](DEPLOYMENT.md)     | The future deployment procedure. Nothing here is live yet          |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Branch workflow, PR rules, what CI can and cannot enforce          |

Architecture and planning documents live in [`docs/`](docs/): the
[master blueprint](docs/superpowers/specs/2026-09-06-pravshi-os-master-blueprint.md), the
[Phase 0 plan](docs/superpowers/plans/2026-09-06-phase-0-foundation.md),
[database.md](docs/architecture/database.md), [security.md](docs/architecture/security.md)
and [build-plan.md](docs/architecture/build-plan.md).

## Verification

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```

`pnpm test` needs a database. See [DEVELOPMENT.md](DEVELOPMENT.md) before running it.

## Phase 0 exit criteria

The plan defines eight. **Five are met; three depend on deployment, which is deferred.**

| #   | Criterion                                       | Status                          | Evidence                                          |
| --- | ----------------------------------------------- | ------------------------------- | ------------------------------------------------- |
| 1   | Placeholder live at `os.pravshi.com` over HTTPS | **Deferred** — not deployed     | No Vercel project, no DNS record                  |
| 2   | Deployed through the full CI pipeline           | **Deferred** — nothing deployed | CI itself is green on every PR                    |
| 3   | A migration applied to **production**           | **Not done, deliberately**      | Migrations have run only on ephemeral CI branches |
| 4   | `app_user` cannot bypass RLS                    | **Met**                         | `tests/guards/runtime-role.test.ts`               |
| 5   | Every table has RLS enabled and forced          | **Met**                         | `tests/guards/rls-enabled.test.ts`                |
| 6   | Context does not leak across pooled connections | **Met**                         | `tests/db/authorized.test.ts`                     |
| 7   | Nothing defeats autosuspend                     | **Met**                         | `tests/guards/no-keepalive.test.ts`; no `crons`   |
| 8   | `/health` does not touch the database           | **Met**                         | `tests/health/no-db-in-health.test.ts`            |

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
