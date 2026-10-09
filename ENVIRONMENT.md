# Environment

`.env.example` carries every variable name with documentation and **no values**. Copy it to
`.env`, which is gitignored and must never be committed.

## Credential separation — the most important rule in this file

| Variable                 | Role        | Endpoint | Permitted to live in                                             |
| ------------------------ | ----------- | -------- | ---------------------------------------------------------------- |
| `DATABASE_URL`           | `app_user`  | pooled   | Vercel (all envs, when it exists) + local                        |
| `DATABASE_URL_MIGRATE`   | `app_owner` | direct   | GitHub Actions and local machines ONLY                           |
| `DATABASE_URL_TEST`      | `app_user`  | pooled   | GitHub Actions and local machines ONLY                           |
| `DATABASE_URL_BOOTSTRAP` | `app_admin` | direct   | The operator's machine ONLY — never Vercel, never GitHub Actions |

**`DATABASE_URL_BOOTSTRAP` must never leave the operator's machine.** It connects as
`app_admin`, whose one capability is creating the first SUPER_ADMIN — once per database, see
[scripts/bootstrap/README.md](scripts/bootstrap/README.md). Neither the application, the
migrations nor the test suite needs it. `src/env.ts` refuses to boot in production with it
present, and `scripts/guards/workflow-secret-flow.mjs` fails CI if any workflow so much as names
it or runs `scripts/bootstrap/` — from any source, not only from a secret.

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

| Variable                 | Required  | Notes                                                                  |
| ------------------------ | --------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`           | yes       | Must contain `-pooler` in the host; `src/env.ts` rejects a direct URL  |
| `DATABASE_URL_MIGRATE`   | tooling   | Must **not** contain `-pooler`; migrations need one real session       |
| `DATABASE_URL_TEST`      | tooling   | Integration tests. Point at your own branch, never `production`        |
| `DATABASE_URL_BOOTSTRAP` | bootstrap | `app_admin`, direct endpoint. Read only by `scripts/bootstrap/run.mjs` |

### First-run bootstrap — operator machine only

Read by `scripts/bootstrap/run.mjs`, once per database, from the process environment and then
`.env`. None of these belongs in Vercel or GitHub Actions.

| Variable                | Notes                                                                     |
| ----------------------- | ------------------------------------------------------------------------- |
| `BOOTSTRAP_ORG_NAME`    | The organization's display name                                           |
| `BOOTSTRAP_ORG_SLUG`    | Lower-case letters, digits and inner hyphens                              |
| `BOOTSTRAP_OWNER_NAME`  | The owner's full legal name                                               |
| `BOOTSTRAP_OWNER_EMAIL` | Becomes the owner's login. No email is ever compiled into the application |

`APP_URL` is also read, to build the one-time setup link; it must be `https` except for
`localhost`, because the link carries a secret.

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

### AI Foundation (Phase 9) — optional

All six variables are optional. With none set, the AI layer runs on the deterministic
mock provider and the rest of the application is unaffected. See
`docs/phase9-ai-foundation.md` for the full architecture, setup and runbook.

| Variable               | Required | Notes                                                                                         |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`          | optional | Unset or `mock` = deterministic mock provider. `openai` or `openai-compatible` = real adapter |
| `AI_MODEL`             | optional | Required when a real provider is selected; missing model = AI reports not configured          |
| `AI_API_KEY`           | optional | Server-side only, never exposed to the browser. Required when a real provider is selected     |
| `AI_BASE_URL`          | optional | Defaults to `https://api.openai.com/v1`. Point at any OpenAI-compatible endpoint              |
| `AI_TIMEOUT_MS`        | optional | Overall per-request AI budget in milliseconds (default 30000, clamped by the config layer)    |
| `AI_MAX_OUTPUT_TOKENS` | optional | Caps model output tokens per request (default set by the config layer)                        |

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
