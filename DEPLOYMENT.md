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

## Rollback

- **Application:** redeploy the previous Vercel build.
- **Database:** create a Neon branch from a timestamp before the change and repoint. Neon's
  history retention on the current plan is 6 hours, so this is a short window — treat it as a
  fast-response tool, not a backup strategy.

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
