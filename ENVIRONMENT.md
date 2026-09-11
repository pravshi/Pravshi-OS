# Environment

`.env.example` carries every variable name with documentation and **no values**. Copy it to
`.env`, which is gitignored and must never be committed.

## Credential separation — the most important rule in this file

| Variable               | Role        | Endpoint | Permitted to live in                      |
| ---------------------- | ----------- | -------- | ----------------------------------------- |
| `DATABASE_URL`         | `app_user`  | pooled   | Vercel (all envs, when it exists) + local |
| `DATABASE_URL_MIGRATE` | `app_owner` | direct   | GitHub Actions and local machines ONLY    |
| `DATABASE_URL_TEST`    | `app_user`  | pooled   | GitHub Actions and local machines ONLY    |

**`DATABASE_URL_MIGRATE` must never be added to Vercel.** It uses `app_owner`, which owns the
schema and is precisely what RLS does not constrain. A deployed application holding that
credential could, through one careless import, read every row in the database with every
policy still nominally "enabled".

Three independent defences back this up:

1. `src/env.ts` refuses to boot in production if the variable is present.
2. The runtime schema does not define it, so nothing in `src/` can read it even by accident.
3. A CI guard (`scripts/guards/workflow-secret-flow.mjs`) fails the build if any workflow
   populates a `DATABASE_URL*` variable from a GitHub secret.

The `next build` phase is the one exception to rule 1: it evaluates route modules to collect
page data, and runs on developer machines and in CI where the migration credential
legitimately exists. The check therefore skips `NEXT_PHASE=phase-production-build` and stays
absolute everywhere else. Both halves are pinned by tests in `tests/env.test.ts`.

## Variables

### Database

| Variable               | Required | Notes                                                                 |
| ---------------------- | -------- | --------------------------------------------------------------------- |
| `DATABASE_URL`         | yes      | Must contain `-pooler` in the host; `src/env.ts` rejects a direct URL |
| `DATABASE_URL_MIGRATE` | tooling  | Must **not** contain `-pooler`; migrations need one real session      |
| `DATABASE_URL_TEST`    | tooling  | Integration tests. Point at your own branch, never `production`       |

### Application

| Variable             | Required | Notes                                                                                                                                   |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`            | yes      | `http://localhost:3000` locally. Validated as a URL                                                                                     |
| `NODE_ENV`           | yes      | `development` \| `test` \| `production`                                                                                                 |
| `HEALTH_CHECK_TOKEN` | optional | Minimum 32 characters. Unset means `/health/db` denies everyone — the correct fail-closed default. Generate with `openssl rand -hex 32` |

### Observability — not yet configured

| Variable             | Required     | Notes                                                                                                                                                 |
| -------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`         | optional     | No Sentry project exists yet. Leave blank                                                                                                             |
| `SENTRY_AUTH_TOKEN`  | optional     | Source-map upload. Not in use                                                                                                                         |
| `BETTER_AUTH_SECRET` | **required** | Signs Better Auth session cookies. At least 32 characters. Without it each serverless instance would generate its own and reject the others' sessions |

### Storage — not yet configured

`.env.example` also lists `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and the
three bucket names. **No R2 buckets exist and no token has been issued.** These are
placeholders for the deferred storage work.

## Blank values

A `.env` file expresses "unset" as a blank value, and dotenv loads that as `''` rather than
`undefined`. `src/env.ts` drops blanks before validating, so an optional variable left blank
in `.env.example` stays optional. Required variables are unaffected: a blank `DATABASE_URL`
still fails, now as "missing" rather than "invalid URL".

## Secret handling rules

- **Never commit `.env`.** It is gitignored; `.env.example` is the only env file that ships.
- **Never put a database URL in a GitHub Actions secret.** CI derives connection strings at
  runtime from the Neon API. The only Actions secrets are `NEON_API_KEY` and
  `NEON_PROJECT_ID`.
- **Never print a connection string.** Passwords can contain `@`, so parse URLs with a real
  URL parser rather than a regex, and report role/host/branch instead of the value.
- **Mask anything derived from a secret** in CI with `::add-mask::` before it can be echoed.
- A password that reaches a terminal, a log, or a chat transcript is compromised. Rotate it;
  see [SECURITY.md](SECURITY.md).
