# Deployment

## Current state: V1 built, nothing deployed yet

**The application is complete; the deployment has not happened.** All thirteen build phases
are implemented and merged to `main`, and this procedure is written and ready to execute.
What remains is a set of founder decisions and operator acts — the human gates HG-1…HG-9
in [docs/runbooks/release-checklist.md](docs/runbooks/release-checklist.md). No agent
performs those steps; this document prepares them.

As of the V1 release:

- **No Vercel project exists.** The application has never been deployed.
- **`os.pravshi.com` does not resolve.** No DNS record has been created.
- **The production database is behind the code.** The repository journal runs to migration
  0064; project records indicate the `production` Neon branch stopped at 0044 (October
  2026), but the exact journal state is recorded nowhere and must be verified read-only
  before anything is applied — that is step 0 of the
  [production migration runbook](docs/runbooks/production-migration.md). Migrations have
  otherwise run only in CI, against an ephemeral Postgres container created per run.
- **No Cloudflare R2 bucket exists**, and no R2 API token has been issued. The `R2_*`
  variables are placeholders for deferred storage work — do not provision them for V1.
- **Sentry is not configured** and no DSN has been issued (gate HG-6).

What _is_ real today: the repository, the CI pipeline (green on `main`), the Neon
`production` branch with its roles and RLS, and the `vercel.json` configuration that a
future deployment will consume. The `staging` branch the topology below names **no longer
exists**; recreating it is part of enabling Preview deployments. Development runs against
a separate Neon project, never against the production project.

## What already exists

`vercel.json` is committed and correct:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["sin1"],
  "framework": "nextjs"
}
```

`sin1` (Singapore) is deliberate — it co-locates functions with the Neon database in
`aws-ap-southeast-1`. There is no `crons` key, and there must never be one: a cron would
defeat Neon's scale-to-zero, and `tests/guards/no-keepalive.test.ts` fails the build if one
appears.

## Branch and environment model

```
feature/*  ->  PR  ->  main
```

`main` is the integration branch and the intended production branch. There is no `develop`
branch in the current solo-founder workflow.

The database topology that a deployment would map onto:

```
production          Vercel Production would use this, as app_user, pooled
└── staging         Vercel Preview would use this, as app_user, pooled
                    (does not exist yet — must be created before Preview is enabled)
```

CI does not use Neon at all: each run starts its own throwaway Postgres container. See
CONTRIBUTING.md, "Databases in CI".

## Future deployment procedure

Each step below is **unperformed**. Credentials required: a Vercel token, and a Cloudflare
API token scoped to `Zone:DNS:Edit` on `pravshi.com` only.

### 1. Create and link the Vercel project

Link the project to `https://github.com/pravshi/Pravshi-OS.git`, with `main` as the
production branch. Confirm the region resolves to `sin1` from `vercel.json`.

### 2. Set environment variables per environment

This table is the production inventory from `src/env.ts` — the enforcing source. If this
table and `src/env.ts` ever disagree, `src/env.ts` is right and this table is the bug.

| Variable                                                                                   | Required in prod                                                                                               | Secret   | If unset/mis-set in production                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                             | **Yes** (`production` branch, `app_user`, pooled)                                                              | Yes      | Boot failure (schema/refine)                                                                                                                                                                                                      |
| `APP_URL`                                                                                  | **Yes** (`https://os.pravshi.com`)                                                                             | No       | Boot failure; links/inbound URLs wrong                                                                                                                                                                                            |
| `NODE_ENV`                                                                                 | **Yes** (`production`, platform-set)                                                                           | No       | Boot refusal logic disarmed                                                                                                                                                                                                       |
| `BETTER_AUTH_SECRET`                                                                       | **Yes** (≥32 chars, fresh for prod)                                                                            | Yes      | Boot failure — sessions impossible                                                                                                                                                                                                |
| `HEALTH_CHECK_TOKEN`                                                                       | Operationally yes (≥32, per-env distinct)                                                                      | Yes      | `/health/db` denies everyone (fail-closed; the smoke pack's DB check is impossible)                                                                                                                                               |
| `SENTRY_DSN`                                                                               | Operationally yes (HG-6)                                                                                       | No       | Error reporting silently disabled                                                                                                                                                                                                 |
| `NEXT_PUBLIC_SENTRY_DSN`                                                                   | With HG-6 (browser reporting)                                                                                  | No       | No browser error capture                                                                                                                                                                                                          |
| `SENTRY_AUTH_TOKEN`                                                                        | Build-time only, optional                                                                                      | Yes      | No source-map upload (symbols unreadable). Not currently wired — deferred production setup                                                                                                                                        |
| `RESEND_API_KEY`                                                                           | Operationally yes                                                                                              | Yes      | Invitation mail not sent (the endpoint returns the link to the admin instead), and password-reset email jobs dead-letter (`EMAIL_PROVIDER_UNCONFIGURED`). The reset page answers identically either way, so nothing visibly fails |
| `EMAIL_FROM`                                                                               | With `RESEND_API_KEY` (verified domain)                                                                        | No       | Invitation mail not sent; every email job, password reset included, dead-letters (`EMAIL_FROM_UNCONFIGURED`)                                                                                                                      |
| `EMAIL_PROVIDER` + `EMAIL_PROVIDER_API_KEY`                                                | No — unset means Resend whenever `RESEND_API_KEY` is set; `EMAIL_PROVIDER_API_KEY` gives job email its own key | Key: yes | An explicit `EMAIL_PROVIDER` other than `resend` makes email jobs dead-letter (`EMAIL_PROVIDER_NOT_IMPLEMENTED`, non-retryable)                                                                                                   |
| `INTEGRATIONS_ENCRYPTION_KEY`                                                              | For Tier V integrations (base64, exactly 32 bytes)                                                             | Yes      | Vault credentials NOT_CONFIGURED (typed, UI-honest)                                                                                                                                                                               |
| `AI_PROVIDER`/`AI_MODEL`/`AI_API_KEY`/`AI_BASE_URL`/`AI_TIMEOUT_MS`/`AI_MAX_OUTPUT_TOKENS` | No (the mock is the honest default)                                                                            | Key: yes | AI runs on the deterministic mock — a _product_ decision for go-live, not a defect                                                                                                                                                |
| `WEBHOOK_SIGNING_SECRET_<REF>`                                                             | Per configured delivery ref                                                                                    | Yes      | That delivery refuses to send (by design)                                                                                                                                                                                         |
| `SCHEDULER_TICK_MS`                                                                        | Worker only, optional (default 60000)                                                                          | No       | Default applies                                                                                                                                                                                                                   |
| `WORKFLOWS_USE_QUEUE`                                                                      | **Must stay unset** until the worker is live                                                                   | No       | If set without a worker: workflow dispatches queue unexecuted                                                                                                                                                                     |
| `R2_*`                                                                                     | **Must not be provisioned for V1**                                                                             | —        | No R2 buckets exist; the variables are placeholders for deferred storage work                                                                                                                                                     |

**Preview** holds the same runtime set, with `DATABASE_URL` naming the `staging` branch
(`app_user`, pooled) and a `HEALTH_CHECK_TOKEN` distinct from production's.

**Must be absent from every Vercel environment:** `DATABASE_URL_MIGRATE`,
`DATABASE_URL_BOOTSTRAP`, every `BOOTSTRAP_*` setting, `NEON_API_KEY`, `NEON_OWNER_URL`,
`APP_OWNER_PASSWORD`, `APP_USER_PASSWORD`, `APP_ADMIN_PASSWORD`. This is enforced, not
just policy: in production the application **refuses to boot** if `DATABASE_URL_MIGRATE`
or `DATABASE_URL_BOOTSTRAP` is present (`src/env.ts`, skipped only during `next build`).
See [ENVIRONMENT.md](ENVIRONMENT.md) for why the migration credential in particular is
fatal.

Then verify the owner credential is genuinely absent rather than assumed absent, by listing
the environment and confirming no `DATABASE_URL_MIGRATE` entry exists.

### 3. DNS

**Cloudflare is authoritative for `pravshi.com`** — confirmed by nameserver lookup
(`chip.ns.cloudflare.com`, `mira.ns.cloudflare.com`). Records added at the registrar instead
would silently do nothing.

| Type    | Name | Value                  | TTL | Proxy                     |
| ------- | ---- | ---------------------- | --- | ------------------------- |
| `CNAME` | `os` | `cname.vercel-dns.com` | 300 | **DNS only — grey cloud** |

Grey cloud is required: Vercel issues the certificate itself, and proxying blocks that unless
Cloudflare origin certificates and SSL mode Full (strict) are configured as well. Do not touch
the apex `pravshi.com` or any unrelated record.

### 4. Add the domain in Vercel and verify

Confirm DNS resolves to Vercel, the TLS certificate is active, and `GET /health` returns 200
with a valid certificate.

### 5. Confirm the deployed app reaches the database

- **Unauthenticated** `GET /health/db` must return **404**. It must not wake compute.
- **Authenticated** with the `x-pravshi-health-token` header must return
  `{"status":"ok","wake_ms":<n>}`.

A large `wake_ms` on the first call is the cold start working as designed. Note the value,
then **do not poll it again** — `/health/db` wakes suspended compute, which is exactly why it
is token-gated. Point uptime monitors at `/health`, which is public and touches nothing.

### 6. Migrations

Migrations are **never run by the Vercel runtime**. They run from an operator machine, as
`app_owner` against the direct endpoint. The deployed application holds only `app_user`
and could not run one even if asked.

Applying the pending chain to production is its own gated procedure — **do not improvise
it from this page.** Follow
[docs/runbooks/production-migration.md](docs/runbooks/production-migration.md): verify the
current production journal state read-only, freeze and snapshot, rehearse the full chain
on the snapshot branch, then apply and verify. Migrations are forward-fix only — no
down-migrations exist in this repository. Executing the runbook requires founder approval
(gate HG-2).

### 7. Bootstrap the first SUPER_ADMIN — once

**Unperformed (gate HG-9).** The `/setup` page that completes the one-time link exists
(`src/app/setup/`) — what remains is the operator act, with a human at the keyboard: the
link expires 60 minutes after it is printed and cannot be re-issued, so the bootstrap is
run only when that human is ready to complete it immediately.

From the operator's machine, never from CI or Vercel, following
[scripts/bootstrap/README.md](scripts/bootstrap/README.md):

1. Confirm `0015_bootstrap` is applied to `production`.
2. Set `app_admin`'s password on `production` and compose `DATABASE_URL_BOOTSTRAP` (direct
   endpoint) in the local `.env` — confirm it names `production`, because bootstrap cannot be
   undone.
3. Run `node scripts/bootstrap/run.mjs` in an interactive terminal.
4. Open the printed link, set the password, sign in, and enrol TOTP.

## The worker plane

Everything asynchronous in Pravshi OS — notifications, task reminders, email delivery
(including **password-reset email**), outbound webhooks, workflow runs, scheduled
triggers — executes in a separate long-running worker process (`src/lib/jobs/runner.ts`),
not in the web app. **A deployment that starts only the web app
is silently broken:** every one of those surfaces stalls, with no signal in the UI. The
worker is a required part of the deployment, not an add-on. (Phase 12, F-12-11.)

- **Host:** any always-on Node host (a small VM or a container service) — explicitly
  **not** Vercel functions. The worker is a long-running loop; Vercel's scale-to-zero model
  is the opposite of what it needs. _Where_ it runs is a Phase 13 deployment decision
  (human gate HG-8); this section contracts what any host must provide.
- **Command:** `pnpm worker` (`pnpm worker --help` prints usage without touching env or
  the database).
- **Environment:** parity with the web app. Required — validated at boot, and the process
  refuses to start without them: `DATABASE_URL` (the **pooled** endpoint; the host
  contains `-pooler.`), `APP_URL`, `NODE_ENV`, `BETTER_AUTH_SECRET`. (`HEALTH_CHECK_TOKEN`
  is optional in `src/env.ts` — unset means `/health/db` denies everyone; set it on the
  web app, and the worker does not depend on it.) Because the worker executes the email, webhook and AI handlers, it also needs the web
  app's integration and AI variables (`INTEGRATIONS_ENCRYPTION_KEY`, the email provider
  key, `AI_*`) wherever those features are configured. Optional: `SCHEDULER_TICK_MS`
  (scheduler tick interval, default 60000) and `HOSTNAME` (part of the worker id). The
  migration and bootstrap credentials listed in step 2 must **not** be present here either —
  the worker connects as `app_user`, exactly like the web app.
- **Supervision:** the process runs until SIGTERM/SIGINT and shuts down gracefully — it
  stops claiming, drains the in-flight job for up to 30 s, then releases the claim without
  burning an attempt. Run it under a supervisor (systemd, Docker, or the container
  platform) that restarts it on non-zero exit.
- **Capacity contract:** one worker process executes **one job at a time**. Throughput per
  process ≈ 3600 ÷ mean job seconds (jobs/hour); scaling means adding processes — claims
  use `FOR UPDATE SKIP LOCKED`, so two processes never execute the same job. This is a
  deliberate V1 contract, recorded with its reasoning in
  [docs/phase12-performance.md](docs/phase12-performance.md).
- **Idle cost:** an idle worker polls for work — every 1 s at first, backing off to a 10 s
  ceiling while the queue stays empty (Phase 12, F-12-04) — plus a scheduler tick every
  60 s. While any worker runs, Neon compute stays awake; that is the accepted price of the
  async plane, and a reason not to multiply worker processes casually.
- **Crash recovery:** a job whose worker dies mid-flight is recovered automatically —
  stale claims are reaped when a worker starts and periodically while it runs (Phase 12,
  F-12-02), returning the job to the queue under the normal retry policy. No operator
  action is needed.
- **Scheduler:** cron-like schedules are turned into jobs inside the same process (60 s
  tick). Ticks are serialised across instances by a Postgres advisory lock and
  dedup-keyed by scheduled window, so running more than one worker process never
  double-fires a schedule.
- **Liveness check:** two parts, both operator-run. (1) _Process:_ the supervisor reports
  the worker running. (2) _Claiming:_ with database access, confirm claim heartbeats are
  fresh — an executing worker refreshes its job's heartbeat every 15 s:

  ```sql
  select max(heartbeat_at) from public.jobs where heartbeat_at is not null;
  ```

  The deployment checklist below carries "worker running and claiming" as a gate item;
  both parts must be verified, not assumed.

## Rollback

- **Application:** redeploy the previous Vercel build.
- **Database:** create a Neon branch from a timestamp before the change and repoint. Neon's
  history retention on the current plan is 6 hours, so this is a short window — treat it as a
  fast-response tool, not a backup strategy (see [Backup and restore](#backup-and-restore)).

## Backup and restore

**Current truth — the interim posture is that there is no backup strategy yet.** The only
recovery mechanism that exists today is the rollback above: a Neon branch from a timestamp
inside the current plan's **6-hour** history-retention window. There is no scheduled
backup, no point-in-time recovery beyond that window, no restore drill has ever been run,
and no RPO/RTO has been set. This section records the procedure Phase 12 contracts
(F-12-10) and the decision it waits on; executing any of it against production is
Phase 13, post-approval.

**Decision required before production data exists — Phase 13 human gate HG-7.** This is
Nani's decision, not an engineering default:

- Choose the mechanism: upgrade Neon's retention / point-in-time recovery, **or**
  scheduled logical backups of the production branch to object storage, **or** both.
- Set **RPO** (how much data loss is acceptable, expressed in time) and **RTO** (how long
  a restore may take). The mechanism choice follows from those numbers, not the reverse.
- Record the decision, the RPO/RTO and the backup schedule in this section when made.

**Restore drill** — the procedure the decision activates. One completed drill is part of
the HG-7 gate:

1. Restore the chosen backup into a **new Neon branch** — never over the live branch.
2. Point a preview deployment (or a local build) at the restored branch, as `app_user`.
3. Verify: sign-in works, tenant data reads correctly, the token-gated `/health/db`
   returns ok, and a spot-check of recent records matches the backup's timestamp.
4. Record the drill date, the backup used, and the elapsed restore time — the first real
   RTO measurement — in this section.

Until HG-7 is decided and one drill has run, a production go-live carries an explicitly
unmitigated data-loss risk: **a failure older than 6 hours is unrecoverable.**

## Deployment checklist

Before any deployment, confirm:

- [ ] Repository is still private
- [ ] `DATABASE_URL_MIGRATE` absent from every Vercel environment
- [ ] `DATABASE_URL_BOOTSTRAP` and every `BOOTSTRAP_*` setting absent from Vercel and GitHub
      Actions
- [ ] No Neon owner or admin credential in Vercel
- [ ] Production `DATABASE_URL` uses `app_user` on the **pooled** endpoint
- [ ] Preview points at `staging`, not `production`
- [ ] `vercel.json` still declares `sin1` and no `crons`
- [ ] CI green on the commit being deployed
- [ ] `HEALTH_CHECK_TOKEN` set, 32+ characters, different per environment
- [ ] Worker running and claiming on its always-on host — process supervised, env parity
      confirmed, claim heartbeat fresh (see [The worker plane](#the-worker-plane))
