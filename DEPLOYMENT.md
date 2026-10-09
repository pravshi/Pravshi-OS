# Deployment

## Nothing is deployed yet

**This document describes a future procedure, not the current state.** As of Phase 0:

- **No Vercel project exists.** The application has never been deployed.
- **`os.pravshi.com` does not resolve.** No DNS record has been created.
- **No migration has been applied to the `production` Neon branch.** Migrations have run only
  on ephemeral CI branches, which are destroyed at the end of each run.
- **No Cloudflare R2 bucket exists**, and no R2 API token has been issued.
- **Sentry is not configured** and no DSN has been issued.

Production deployment was **deferred by founder decision**: the application will be built and
validated locally first, then deployed as a separate readiness phase. Nothing in the
architecture was changed to compensate for that deferral.

What _is_ real today: the repository, the CI pipeline, the Neon `production` and `staging`
branches with their roles and RLS, and the `vercel.json` configuration that a future
deployment will consume.

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

| Vercel environment | Variable             | Value                                   |
| ------------------ | -------------------- | --------------------------------------- |
| Production         | `DATABASE_URL`       | `production` branch, `app_user`, pooled |
| Production         | `APP_URL`            | `https://os.pravshi.com`                |
| Production         | `HEALTH_CHECK_TOKEN` | 32+ chars, generated fresh              |
| Preview            | `DATABASE_URL`       | `staging` branch, `app_user`, pooled    |
| Preview            | `APP_URL`            | the preview URL                         |
| Preview            | `HEALTH_CHECK_TOKEN` | a different value from production       |

**Never add to Vercel:** `DATABASE_URL_MIGRATE`, `DATABASE_URL_BOOTSTRAP`, `NEON_OWNER_URL`,
`APP_OWNER_PASSWORD`, `APP_USER_PASSWORD`, `APP_ADMIN_PASSWORD`, `NEON_API_KEY`, or any
`BOOTSTRAP_*` setting. See
[ENVIRONMENT.md](ENVIRONMENT.md) for why the migration credential in particular is fatal.

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

Migrations are **never run by the Vercel runtime**. They run from CI or a developer machine,
as `app_owner` against the direct endpoint. The deployed application holds only `app_user`
and could not run one even if asked.

### 7. Bootstrap the first SUPER_ADMIN — once

**Unperformed, and blocked on frontend work:** the `/setup` page that completes the one-time
link does not exist yet. Do not bootstrap production until it does, because the link expires
60 minutes after it is printed and cannot be re-issued.

From the operator's machine, never from CI or Vercel, following
[scripts/bootstrap/README.md](scripts/bootstrap/README.md):

1. Confirm `0015_bootstrap` is applied to `production`.
2. Set `app_admin`'s password on `production` and compose `DATABASE_URL_BOOTSTRAP` (direct
   endpoint) in the local `.env` — confirm it names `production`, because bootstrap cannot be
   undone.
3. Run `node scripts/bootstrap/run.mjs` in an interactive terminal.
4. Open the printed link, set the password, sign in, and enrol TOTP.

## The worker plane

Everything asynchronous in Pravshi OS — notifications, email delivery, outbound webhooks,
workflow runs, scheduled triggers — executes in a separate long-running worker process
(`src/lib/jobs/runner.ts`), not in the web app. **A deployment that starts only the web app
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
  contains `-pooler.`), `APP_URL`, `NODE_ENV`, `BETTER_AUTH_SECRET`, `HEALTH_CHECK_TOKEN`.
  Because the worker executes the email, webhook and AI handlers, it also needs the web
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
