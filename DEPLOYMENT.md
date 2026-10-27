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
  0076; project records indicate the `production` Neon branch stopped at 0044 (October
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
| `DATABASE_URL_AUTH`                                                                        | **Yes** (`app_auth`, pooled, migrations 0072/0073 — a different URL from `DATABASE_URL`)                       | Yes      | Boot refused on Vercel; every sign-in and session check fails closed. A URL naming another login is refused by the auth pool on first use                                                                                         |
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
| `WEBHOOK_SIGNING_SECRET_<REF>`                                                             | No — no longer read                                                                                            | Yes      | Nothing: workflows and webhook jobs refuse a `signatureSecretRef`; signed deliveries use a webhook subscription's own secret                                                                                                      |
| `WORKER_WAKE_URL`                                                                          | Operationally yes (`https://<worker-host>/wake`; https required in production)                                 | No       | No wake is sent: work waits for the worker's next scheduled wake, up to `WORKER_MAX_SLEEP_MS` (2 h) — long enough for a password-reset link (valid 1 h) to expire before its email is sent                                        |
| `WORKER_WAKE_TOKEN`                                                                        | Operationally yes (≥32 chars, **identical** on the web app and the worker)                                     | Yes      | Same as above. A token that differs between the two services is refused with 401 on every wake, so it fails the same way, silently                                                                                                |
| `SCHEDULE_MIN_INTERVAL_MINUTES`                                                            | No (default 60; `0` disables)                                                                                  | No       | Default applies: schedules may not fire more often than hourly. Keep the default on Neon Free — every scheduled run wakes the database                                                                                            |
| `SCHEDULER_TICK_MS`                                                                        | Worker only, optional (default 60000)                                                                          | No       | Default applies                                                                                                                                                                                                                   |
| `WORKFLOWS_USE_QUEUE`                                                                      | **Must stay unset** until the worker is live                                                                   | No       | If set without a worker: workflow dispatches queue unexecuted                                                                                                                                                                     |
| `R2_*`                                                                                     | **Must not be provisioned for V1**                                                                             | —        | No R2 buckets exist; the variables are placeholders for deferred storage work                                                                                                                                                     |

**Preview** holds the same runtime set, with `DATABASE_URL` and `DATABASE_URL_AUTH` naming the
`staging` branch (`app_user` and `app_auth`, pooled) and a `HEALTH_CHECK_TOKEN` distinct from
production's.

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
on the snapshot branch, then apply and verify. Migrations are forward-fix only. The two
exceptions are prepared rollback scripts in `scripts/db/rollback/` (for 0073 and 0075); the
runbook says when each may be used, and each needs the founder's explicit approval for that
step. Executing the runbook requires founder approval (gate HG-2).

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
  the database). **Node 22** (`.nvmrc`): the worker runs its TypeScript through
  `--experimental-transform-types`, which newer Node releases removed — on Node 26 it does
  not start. Pin the host's Node version explicitly: on Railway set
  `RAILPACK_NODE_VERSION=22` — Railpack reads `package.json` `engines.node` (an open
  range, `>=22.12`) **before** `.nvmrc`, so without the pin it may pick a newer major.
- **Environment:** parity with the web app. Required — validated at boot, and the process
  refuses to start without them: `DATABASE_URL` (the **pooled** endpoint; the host
  contains `-pooler.`), `DATABASE_URL_WORKER` (pooled, role **`app_worker`**, migration
  0070 — the worker checks at start that it authenticates as `app_worker` and exits
  otherwise), `APP_URL`, `NODE_ENV`, `BETTER_AUTH_SECRET`. `DATABASE_URL_WORKER` is the
  one variable the worker holds that the web app must not: every worker-plane operation
  (claims, retries, reaping, reminders, scheduler ticks, maintenance, protected email content,
  webhook signing secrets) is executable by `app_worker` only, and `src/env.ts` refuses it on
  Vercel. Workflow actions still run as their real person over `DATABASE_URL`.
  **The worker must NOT hold `DATABASE_URL_AUTH`** (the web app's authentication login,
  `app_auth`, migrations 0072/0073): it never authenticates anyone, and it refuses to start when
  that variable is present.
  **Order with migration 0070:** create the role first (`scripts/db/roles.sql`, then its
  password), then deploy the worker and apply 0070 in either order — whichever lands first,
  claims are refused until both are in place and queued work waits; nothing is lost. (`HEALTH_CHECK_TOKEN`
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
- **Organizations that are not ACTIVE (migration 0068):** the worker does not claim the
  jobs of a suspended, archived or deleted organization, does not retry its failed jobs,
  fire its reminders or schedules, and does not wake for them; its inbound webhook
  endpoints answer with the ordinary rejection. The work is left in place, not cancelled,
  and resumes on its own once the organization is ACTIVE again; overdue reminders and
  schedules then fire once, late, as after worker downtime. A job already running when the
  organization is suspended is not interrupted: steps that go through the organization's
  own permissions fail (the organization is no longer active), the job is marked failed
  and, while it has attempts left, retried after reactivation; a job whose worker dies is
  still recovered.
- **Idle cost — low-cost mode (WP-W, the default):** Neon Free suspends compute only after
  5 minutes without a query and gives a project 100 CU-hours a month; spending them
  suspends **every** compute in the project, production included, until the next billing
  period. A worker that polls every 10 s keeps compute awake permanently (~182 CU-hours a
  month at 0.25 CU), so by default the worker **deep-sleeps**: after
  `WORKER_ACTIVE_WINDOW_MS` (60 s) with nothing to do it asks the database when work next
  falls due (`public.worker_next_due_at()`, migration 0066) and sends no query at all
  until then — capped at `WORKER_MAX_SLEEP_MS` (2 h). While it sleeps it holds no database
  connection. The web app wakes it right after committing new work (`POST /wake` with
  `WORKER_WAKE_TOKEN`; see below), and every wake runs the reap, retry, reminder,
  scheduler and maintenance passes at once. `WORKER_IDLE_MODE=poll` restores always-on
  polling for a paid database plan. What each feature experiences in low-cost mode
  (measured end to end in `tests/e2e-worker/low-cost-worker.e2e.test.ts`):

  | Work                                                                  | When it runs                                                                                                                                                                                                        |
  | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Password-reset email, notifications, webhooks, email jobs             | Seconds after the commit (measured: 0.8 s from wake to finished job)                                                                                                                                                |
  | …if the wake signal is lost (network failure while the worker sleeps) | At the next scheduled wake — at most `WORKER_MAX_SLEEP_MS` (2 h) later. Never lost: the job is in Postgres. A worker that restarts drains waiting work at once, so this needs a wake to fail while the worker is up |
  | Task reminders                                                        | At the reminder time (measured: 0.6 s late)                                                                                                                                                                         |
  | Scheduled automations                                                 | At the scheduled time (measured: 0.3 s late); schedules may not fire more often than hourly by default (`SCHEDULE_MIN_INTERVAL_MINUTES`)                                                                            |
  | Webhook / job retries                                                 | At their back-off time                                                                                                                                                                                              |
  | Work that fell due while the worker was down                          | Immediately after it starts (measured: 5 s including start-up)                                                                                                                                                      |
  | Audit-log partitions and retention                                    | At start-up and on wakes, at most hourly and at least every `WORKER_MAX_SLEEP_MS`                                                                                                                                   |

  **Known rare failure — password reset.** A reset link is valid for **1 hour**
  (`authz.request_password_reset`, migration 0024); the safety wake is **2 hours** by
  deliberate choice (a shorter cap costs roughly 13 more CU-hours a month). So if the wake
  signal for a reset request is lost while the worker is up and asleep — a network failure
  between the web app and the worker — the email can go out after its link has expired. The
  user sees "link expired" and requests a new one, which sends a fresh wake. Nothing is lost
  or leaked; the cost is one extra request. Watch for `[jobs] worker wake failed` warnings
  in the web app's logs: they mark exactly these windows.

  **Estimated compute** (worker's share, 0.25 CU fixed size): about 6.5 minutes of awake
  database per idle safety wake (60 s active + Neon's 5-minute suspend delay) × 12 a day
  ≈ 10 CU-hours a month, plus a few minutes per reminder or scheduled run outside working
  hours. The worker logs a daily `[jobs] worker db-wake estimate` and an error line when
  its month-to-date estimate passes 70% and 90% of `WORKER_DB_BUDGET_CU_HOURS` — an
  estimate of its own share only; the Neon console stays the source of truth.

- **Wake endpoint:** with `WORKER_WAKE_TOKEN` set the worker listens on `PORT`:
  `POST /wake` (header `x-pravshi-worker-token`; 202, no body read, no database touched,
  capped at 60 accepted wakes and 30 refused attempts a minute) and `GET /healthz`
  (unauthenticated, no database: 200 `ok`, 200 `degraded`, or 503 `stalled` — see
  [Worker liveness](#worker-liveness-rel-11) before wiring it to anything that restarts the
  worker). The web app
  needs `WORKER_WAKE_URL` (`https://<worker-host>/wake`) and the same token. Without the
  pair the worker still works; work just waits for its next scheduled wake. If the worker
  is down or refuses a wake, each web instance stops sending wakes for 30 s, so an outage
  costs one 1 s timeout per instance per 30 s rather than one per request.
- **Crash recovery:** a job whose worker dies mid-flight is recovered automatically —
  stale claims are reaped when a worker starts and periodically while it runs (Phase 12,
  F-12-02), returning the job to the queue under the normal retry policy. No operator
  action is needed.
- **Scheduler:** cron-like schedules are turned into jobs inside the same process (60 s
  tick). Ticks are serialised across instances by a Postgres advisory lock and
  dedup-keyed by scheduled window, so running more than one worker process never
  double-fires a schedule.
- **Database maintenance** (migration 0065): at startup and then at most hourly (in
  low-cost mode: on wakes, and at least every `WORKER_MAX_SLEEP_MS`), the worker keeps
  `audit_logs` partitioned twelve months ahead and deletes rows past their retention
  period, at most 5,000 per table per pass. **Without a running worker, nothing extends the
  audit-log partitions** — there is no default partition, so roughly a year after the last
  extension every write that produces an audit entry fails. The worker logs
  `[jobs] db maintenance` with per-table counts each pass, and
  `[jobs] audit partition window ends soon` as an error once fewer than 60 days remain —
  route that line to someone who reads it. Retention periods (fixed in the migration):

  | Data                                                  | Deleted after                                  |
  | ----------------------------------------------------- | ---------------------------------------------- |
  | Succeeded/cancelled jobs and their webhook deliveries | 90 days (dead-letter and failed jobs are kept) |
  | Notifications                                         | 90 days after being read; 365 days if unread   |
  | Finished workflow executions (and their steps)        | 180 days after finishing                       |
  | Processed inbound webhook events                      | 90 days                                        |
  | AI usage records                                      | 400 days                                       |
  | Expired sessions and verification tokens              | 7 days after expiry                            |
  | Expired password-reset tokens                         | 30 days after expiry                           |
  | Login lockouts and rate-limit windows                 | 1 day after they end                           |
  | Audit log, login events, and all business records     | **Never**                                      |

- **Liveness check:** two parts, both operator-run. (1) _Process:_ the supervisor reports
  the worker running, and `GET /healthz` on the wake endpoint answers 200. (2) _Claiming:_
  ring `POST /wake` and confirm a `[worker] deep sleep` line follows within about a minute;
  with database access, an executing worker also refreshes its job's heartbeat every 15 s:

  ```sql
  select max(heartbeat_at) from public.jobs where heartbeat_at is not null;
  ```

  The deployment checklist below carries "worker running and claiming" as a gate item;
  both parts must be verified, not assumed.

### Worker liveness (REL-11)

A job's lease renewal (every 15 s) proves the worker **process** is alive, not that its loop
is getting anywhere: a handler that never returns keeps renewing its lease, so the reaper never
frees the job and nothing else notices. The worker therefore runs an in-process watchdog
(`src/lib/jobs/liveness.ts`). Before every wait the loop says what it waits for; a deep or
idle sleep is held to the exact length it chose, a pass or a job to the budget below. The
watchdog reads only a monotonic clock — **no database query, ever** (a health check that
touched the database would keep Neon awake; `tests/guards/no-keepalive.test.ts` enforces
this) — and calls the loop **stalled** after two consecutive overdue checks, 15 s apart.

`GET /healthz` on the wake endpoint answers with one word and nothing else:

| Answer         | Meaning                                                                                                                                                                     | Restart helps?                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 200 `ok`       | the loop is making progress                                                                                                                                                 | —                              |
| 200 `degraded` | the database is not answering, or due work a full pass did not clear (a pass that keeps failing, a job type this worker does not take): the loop is backing off as designed | No                             |
| 503 `stalled`  | a wait has run past its allowance: the loop is stuck                                                                                                                        | Possibly — read the logs first |
| no answer      | the process or its event loop is blocked or gone                                                                                                                            | Yes                            |

Transitions are logged once each — `[worker] liveness: stalled|degraded|ok` with the phase,
how far overdue, the job **type** (never its id or payload) and the degraded reasons — and a
blocked event loop is logged after the fact as `[worker] liveness: event loop was blocked`.
On a graceful shutdown the worker logs `[worker] liveness summary`, the longest wait per phase:
the figures to compare the budgets with.

- **`WORKER_PASS_STALL_MS`** — a sweep, reap, claim, next-due lookup or scheduler tick.
  Default 300000 (5 min). Evidence: connection establishment is bounded (`worker-pool.ts`:
  10 s timeout × 4 attempts + 1.75 s back-off ≈ 41.75 s); on local CI-shaped Postgres the
  longest pass took 57 ms and the longest scheduler tick 390 ms (3 runs). Uncertainty: there is
  no statement timeout, so a query has no upper bound; not measured on Neon (cold starts) or
  at production volume.
- **`WORKER_MAINTENANCE_STALL_MS`** — partitions and retention. Default 900000 (15 min).
  Evidence: retention deletes at most 5000 rows per target per pass (`maintenance.ts`); locally
  the longest pass took 142 ms. Uncertainty: its duration at production volume is unknown.
- **`WORKER_JOB_STALL_MS`** — one job. Default 900000 (15 min) — a **chosen** value, not a
  derived bound, because no handler has a total deadline. A webhook makes at most 3 requests
  (2 redirects), each with a socket **inactivity** timeout of at most 30 s (`types.ts` caps
  `timeoutMs` at 30000; `handlers.ts` uses `req.setTimeout`), so an endpoint that keeps
  trickling bytes can hold a job — and the one-job-at-a-time loop — indefinitely (pre-existing;
  the watchdog now reports it; flagged for a security review). An email goes through the
  Resend SDK, which passes no abort signal, so only Node's fetch default timers bound it, and
  they are idle timers too. `workflow_run`, `scheduled_trigger`, `notification` and `cleanup`
  are database-only (workflow actions enqueue jobs; at most 20 actions). 15 minutes is far
  beyond a healthy external call and short enough to surface a hung one within the hour.
  Uncertainty: not measured — no job ran in the local measurement.
- **`WORKER_STALL_GRACE_MS`** — added to every allowance. Default 60000: the reaper's own
  staleness threshold, and above the worst-case connection establishment.

A stall is therefore reported, at the earliest, budget + grace + up to two 15 s checks after a
wait began. Every value is configurable on the worker host; raise a budget if the summary shows
legitimate waits approaching it, and record why.

**What it does not do.** It never aborts a job, never exits and changes no retry, reap or
dead-letter behaviour. Restarting is a human decision, and **the platform's restart-on-failure
behaviour has not been verified** for any worker host (OPS-02). Before letting a platform
restart the worker on a 503, know this **known gap** (pinned by
`tests/serial/worker-stalled-job-reclaim.test.ts`). A **graceful** restart (SIGTERM) aborts
the job, waits 30 s for a handler that ignores the abort, then releases its claim: the job is
`pending` again with `attempts` **unchanged** (`jobs_release_claim`, 0050). A **hard** stop
(SIGKILL, a crash, an out-of-memory kill, or a platform grace period under 30 s) leaves the
lease to lapse; the reaper then returns the job with `attempts + 1` and never dead-letters
(0049). Either way the next worker claims it again, because the claim ignores `attempts`
(0068) — so a job that hangs on **every** attempt is retried for as long as something keeps
restarting the worker, and graceful restarts do not even count the attempts. A job that fails
(throws) is bounded: it dead-letters at `max_attempts`. Closing the gap needs the release and
reap paths (or the claim) to respect `max_attempts` — a migration, separately approved. Until
then, alert a human — point an uptime monitor at `/healthz` (REL-10) — rather than restarting
automatically, and cancel a job that stalls twice (incident-response runbook).

In `WORKER_IDLE_MODE=poll` there is no wake endpoint: the log lines are the only signal there,
and the scheduler's own interval timer is outside the watchdog.

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
- [ ] Production and Preview `DATABASE_URL_AUTH` use `app_auth` on the **pooled** endpoint, and
      `DATABASE_URL_AUTH` is absent from the worker host
- [ ] Preview points at `staging`, not `production`
- [ ] `vercel.json` still declares `sin1` and no `crons`
- [ ] CI green on the commit being deployed
- [ ] `HEALTH_CHECK_TOKEN` set, 32+ characters, different per environment
- [ ] Worker running and claiming on its always-on host — process supervised, env parity
      confirmed, claim heartbeat fresh (see [The worker plane](#the-worker-plane))
- [ ] Worker host runs **Node 22** (`RAILPACK_NODE_VERSION=22` on Railway); its start-up log
      shows `[worker] starting … idleMode=deep-sleep … wakeEndpoint=on`
- [ ] `WORKER_WAKE_TOKEN` set on **both** the web app and the worker, **identical**, 32+
      characters; `WORKER_WAKE_URL` on the web app is `https://<worker-host>/wake`
- [ ] `GET https://<worker-host>/healthz` answers 200 `ok` (no auth, no database); an uptime
      monitor alerts a human on a 503 or a timeout, and whether the host also restarts on it
      is a recorded decision ([Worker liveness](#worker-liveness-rel-11))
- [ ] A test wake is accepted: `POST /wake` with the token answers 202 and a
      `[worker] deep sleep` line follows within about a minute; without the token it answers 401
- [ ] `SCHEDULE_MIN_INTERVAL_MINUTES` left at its default (60) while on Neon Free
