# PRAVSHI OS — Phase 0 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the repository, database, storage, CI and deployment pipeline for PRAVSHI OS, and prove end to end that a deploy works — before any business feature exists.

**Architecture:** A single Next.js application on Vercel (`sin1`) talking to Neon Postgres (`aws-ap-southeast-1`) as a role that cannot bypass RLS, through one centralised `withAuthorizedDb()` helper that sets transaction-local identity. Phase 0 builds no features; it builds the guarantees every later phase depends on, and the CI checks that keep them true.

**Tech Stack:** Next.js 15 (App Router) · React 19 · TypeScript strict · Tailwind CSS v4 · shadcn/ui · Drizzle ORM + Drizzle Kit · `@neondatabase/serverless` · Cloudflare R2 · Vitest · Playwright · GitHub Actions · Vercel · Sentry · pnpm · Node 22 LTS

**Spec:** [`docs/superpowers/specs/2026-09-06-pravshi-os-master-blueprint.md`](../specs/2026-09-06-pravshi-os-master-blueprint.md)
Companions: [`database.md`](../../architecture/database.md) · [`security.md`](../../architecture/security.md) · [`build-plan.md`](../../architecture/build-plan.md)

---

## Global Constraints

Copied verbatim from the spec's LOCKED DECISIONS. Every task's requirements implicitly include this section.

- **Database: Neon PostgreSQL.** Do not reintroduce Supabase in any form.
- **Neon region: AWS Asia Pacific 1 — Singapore (`aws-ap-southeast-1`).** Vercel functions pin to `sin1`, not `bom1`.
- **Neon compute: scale-to-zero / autosuspend stays ENABLED.** No keep-alive job, heartbeat, cron, background worker, or synthetic query whose purpose is to keep compute awake. No minimum or always-on compute. Cold-start latency is accepted for V1. Connection handling must tolerate wake-up cleanly.
- **Authentication: Better Auth**, self-hosted, sessions in Postgres, with a provider interface left open for Google OAuth / Workspace later. *(Phase 1 — not built here.)*
- **File storage: Cloudflare R2**, private buckets, presigned URLs.
- **Runtime DB role: `app_user`** — not the schema owner, no `BYPASSRLS`.
- **RLS: `FORCE ROW LEVEL SECURITY` on every table.**
- **Auth context: `SET LOCAL app.person_id` inside a transaction only.** Never session-scoped `SET`.
- **Data access: one centralised `withAuthorizedDb()`.** No other path to Postgres.
- **Authorization posture: fail-closed.** No identity means zero rows, never all rows.
- **Phase order is fixed.** Phase 0 ships nothing user-facing.
- TypeScript `strict: true`. `any` is banned in `src/lib/db` and `src/lib/authz`.
- Node 22 LTS, pinned. pnpm as the package manager.
- No secrets in the repository, ever. `.env.example` carries names and documentation, never values.

---

## Blocking dependency

**Tasks 10, 11 and 12 require GitHub Organization Owner access on `pravshi`**, which is not yet confirmed. Tasks 1–9, 13 and 14 are unblocked and can be completed first — that is deliberate sequencing, not filler. If owner access lands earlier, Tasks 10–12 can be pulled forward without disturbing anything.

---

## File Structure

Created in Phase 0. Each file has one responsibility; nothing here is a grab-bag.

```
pravshi-os/
├── .github/
│   ├── CODEOWNERS                      review gates on drizzle/** and src/lib/{db,authz}/**
│   ├── pull_request_template.md        includes the permissions/RLS question
│   └── workflows/ci.yml                typecheck · lint · unit · guards · build
├── drizzle/
│   ├── 0000_extensions_and_schemas.sql first migration: authz schema, extensions
│   └── meta/                           Drizzle Kit journal (generated)
├── scripts/
│   ├── db/roles.sql                    app_owner / app_user / app_admin, grants
│   ├── db/prove-rls.sql                proves app_user cannot bypass RLS
│   └── guards/                         CI assertions (see Task 7)
├── src/
│   ├── app/
│   │   ├── layout.tsx                  root layout, theme, fonts
│   │   ├── page.tsx                    signed-out placeholder
│   │   ├── globals.css                 Tailwind v4 + design tokens
│   │   ├── health/route.ts             liveness. MUST NOT touch the database.
│   │   └── health/db/route.ts          DB reachability. CI and humans only.
│   ├── components/ui/                  shadcn primitives (generated)
│   ├── components/shell/
│   │   ├── app-shell.tsx               sidebar + topbar + content frame
│   │   ├── sidebar.tsx                 nav sections (permission-filtered in Phase 1)
│   │   ├── page-header.tsx             title, breadcrumb, actions slot
│   │   └── theme-toggle.tsx            light / dark / system
│   ├── components/state/
│   │   ├── empty-state.tsx             every table needs one
│   │   ├── error-state.tsx
│   │   └── loading-state.tsx
│   ├── lib/
│   │   ├── db/context.ts               AuthContext type — the Phase 1 seam
│   │   ├── db/pool.ts                  Neon pool + cold-start-aware connect
│   │   ├── db/authorized.ts            withAuthorizedDb() — the only path in
│   │   ├── db/schema.ts                Drizzle schema (empty in Phase 0)
│   │   └── storage/object-key.ts       random, non-guessable R2 object keys
│   └── env.ts                          Zod-validated environment access
├── tests/
│   ├── db/authorized.test.ts           context isolation + fail-closed
│   ├── guards/rls-enabled.test.ts      every table RLS enabled AND forced
│   ├── guards/runtime-role.test.ts     no BYPASSRLS, owns nothing
│   ├── guards/no-keepalive.test.ts     enforces the scale-to-zero decision
│   ├── guards/single-db-path.test.ts   nothing bypasses withAuthorizedDb()
│   ├── health/no-db-in-health.test.ts  /health must not import the db module
│   └── storage/object-key.test.ts
├── e2e/shell.spec.ts                   Playwright smoke: shell renders, theme toggles
├── docs/                               (already exists — spec + architecture)
├── .env.example                        every variable, documented, no values
├── .nvmrc                              22
├── drizzle.config.ts
├── vitest.config.ts
├── playwright.config.ts
└── vercel.json                         region sin1; no crons
```

---

### Task 1: Repository skeleton that builds

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `.nvmrc`, `.gitignore`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `vercel.json`

**Interfaces:**
- Consumes: nothing
- Produces: a buildable Next.js app; `pnpm build`, `pnpm typecheck` scripts used by every later task

- [ ] **Step 1: Initialise git and pin the runtime**

```bash
cd /c/Users/talar/Desktop/Pravshi-OS
git init -b main
echo "22" > .nvmrc
```

- [ ] **Step 2: Scaffold the Next.js application in place**

```bash
pnpm dlx create-next-app@latest . \
  --typescript --tailwind --eslint --app --src-dir \
  --import-alias "@/*" --use-pnpm --no-turbopack
```

Answer "yes" to overwriting nothing outside `docs/`. If it refuses because the directory is non-empty, scaffold into `.tmp-app/` and move everything except `docs/` up one level.

- [ ] **Step 3: Enforce strict TypeScript**

In `tsconfig.json`, inside `compilerOptions`:

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true
}
```

- [ ] **Step 4: Pin the Vercel region and forbid cron**

Create `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["sin1"],
  "framework": "nextjs"
}
```

No `crons` key. Task 7 adds a CI guard that fails the build if one appears without an explicit allowlist entry — because a stray cron is the most likely way scale-to-zero gets defeated by accident.

- [ ] **Step 5: Add the scripts**

In `package.json`:

```json
{
  "engines": { "node": ">=22 <23" },
  "packageManager": "pnpm@9",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "lint": "next lint",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "playwright test"
  }
}
```

- [ ] **Step 6: Record the module convention**

No modules exist yet, so create the contract rather than empty folders. Create `src/modules/README.md`:

```markdown
# Modules

One folder per business module (`sales/`, `people/`, `hiring/`, `delivery/`, `records/`).
Each contains exactly:

    actions.ts       'use server' — parse → authorize → call service → revalidate
    service.ts       business logic and data access; the only place SQL lives
    schema.ts        Zod schemas, shared with the client
    queries.ts       read helpers for Server Components
    permissions.ts   this module's permission constants

A module may depend on the core (`src/lib/**`). A module must NOT import from
another module. Adding a module must never require editing the authorization
engine — only inserting rows into the `permissions` table.

First module arrives in Phase 1.
```

- [ ] **Step 7: Verify it builds**

Run: `pnpm install && pnpm typecheck && pnpm build`
Expected: both succeed, no errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js 15 app with strict TypeScript, pinned to sin1"
```

---

### Task 2: Test harness and quality gates

**Files:**
- Create: `vitest.config.ts`, `tests/setup.ts`, `tests/harness.test.ts`, `.prettierrc`, `eslint.config.mjs` (modify)

**Interfaces:**
- Consumes: Task 1's `package.json` scripts
- Produces: `pnpm test` runs Vitest; every later task's tests hang off this

- [ ] **Step 1: Write a failing test that proves the harness runs**

Create `tests/harness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('test harness', () => {
  it('runs and can fail', () => {
    expect(1 + 1).toBe(3);
  });
});
```

- [ ] **Step 2: Install Vitest and configure it**

```bash
pnpm add -D vitest @vitejs/plugin-react vite-tsconfig-paths prettier
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000, // Neon cold starts are legitimate; see Global Constraints
  },
});
```

Create `tests/setup.ts`:

```ts
import 'dotenv/config';
```

```bash
pnpm add -D dotenv
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `pnpm test`
Expected: FAIL — `expected 2 to be 3`. This proves the harness executes rather than silently passing zero tests.

- [ ] **Step 4: Correct the test**

```ts
  it('runs and can fail', () => {
    expect(1 + 1).toBe(2);
  });
```

- [ ] **Step 5: Run again**

Run: `pnpm test`
Expected: PASS, 1 test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: add Vitest harness with a proven-failing-then-passing test"
```

---

### Task 3: Neon project verification, branches and database roles

**Files:**
- Create: `scripts/db/roles.sql`, `scripts/db/prove-rls.sql`

**Interfaces:**
- Consumes: nothing in the repo; the existing Neon project
- Produces: `DATABASE_URL` (app_user, pooled), `DATABASE_URL_MIGRATE` (app_owner, direct), `DATABASE_URL_TEST`; the `app_user` role every later task depends on

> This is the most important task in Phase 0. Everything downstream assumes `app_user` cannot bypass RLS. Prove it here, in SQL, before writing a line of application code.

- [ ] **Step 1: Confirm region and compute settings in the Neon console**

Verify, and record the answers in the PR description:

1. Region reads **AWS Asia Pacific 1 (Singapore)** — `aws-ap-southeast-1`.
2. **Autosuspend is ENABLED** on every branch's compute (Neon's default; do not change it).
3. **Minimum compute size is NOT pinned above the floor.** No always-on setting.

If any is wrong, stop and report before continuing — these are locked decisions, not defaults to adjust.

- [ ] **Step 2: Create the branches**

In the Neon console or CLI:

```bash
pnpm dlx neonctl branches create --name staging   --parent production
pnpm dlx neonctl branches list
```

The default branch is `production`. Developer branches follow `dev/<name>` and are created per person, not shared.

- [ ] **Step 3: Write the role definitions**

Create `scripts/db/roles.sql`:

```sql
-- Run once per branch, as the Neon-provided owner role.
-- app_owner : owns the schema. Migrations only, from CI. Never the application.
-- app_user  : the application at runtime. NOT owner. No BYPASSRLS.
-- app_admin : three audited paths only (bootstrap, provisioning, audit writer).

create role app_owner login password :'app_owner_password' nobypassrls;
create role app_user  login password :'app_user_password'  nobypassrls;
create role app_admin login password :'app_admin_password' nobypassrls;

create schema if not exists authz authorization app_owner;
alter schema public owner to app_owner;

grant usage on schema public, authz to app_user, app_admin;

-- app_user gets DML only, never DDL, and never ownership.
grant select, insert, update on all tables in schema public to app_user;
alter default privileges for role app_owner in schema public
  grant select, insert, update on tables to app_user;
alter default privileges for role app_owner in schema public
  grant usage, select on sequences to app_user;

-- Nobody rewrites history. audit_logs is created in Phase 1; this is the standing rule.
revoke create on schema public from app_user, app_admin, public;
```

- [ ] **Step 4: Apply the roles**

```bash
psql "$NEON_OWNER_URL" \
  -v app_owner_password="$APP_OWNER_PASSWORD" \
  -v app_user_password="$APP_USER_PASSWORD" \
  -v app_admin_password="$APP_ADMIN_PASSWORD" \
  -f scripts/db/roles.sql
```

- [ ] **Step 5: Write the proof that `app_user` cannot bypass RLS**

Create `scripts/db/prove-rls.sql`. Run the first half as `app_owner`, the second as `app_user`:

```sql
-- === as app_owner ===
create table public._rls_probe (id int primary key, owner_tag text not null);
alter table public._rls_probe enable row level security;
alter table public._rls_probe force  row level security;

create policy probe_select on public._rls_probe for select to app_user
using (owner_tag = current_setting('app.person_id', true));

grant select on public._rls_probe to app_user;
insert into public._rls_probe values (1, 'alice'), (2, 'bob');
```

```sql
-- === as app_user ===
-- 1. No identity set  →  MUST return 0.  This is fail-closed.
select count(*) as rows_with_no_context from public._rls_probe;

-- 2. Identity set inside a transaction  →  MUST return 1.
begin;
  select set_config('app.person_id', 'alice', true);
  select count(*) as rows_as_alice from public._rls_probe;
commit;

-- 3. Confirm the role itself cannot bypass.
select rolbypassrls from pg_roles where rolname = current_user;   -- MUST be false
select count(*) as tables_owned
from pg_class c join pg_roles r on r.oid = c.relowner
where r.rolname = current_user and c.relkind = 'r';               -- MUST be 0
```

- [ ] **Step 6: Run the proof and check every assertion**

Run both halves against the `staging` branch.
Expected, exactly:

| Check | Required result |
|---|---|
| `rows_with_no_context` | `0` |
| `rows_as_alice` | `1` |
| `rolbypassrls` | `false` |
| `tables_owned` | `0` |

If `rows_with_no_context` is `2`, the application is connecting as the owner or a bypassing role. **Stop.** Nothing else in this plan is safe until that reads `0`.

- [ ] **Step 7: Clean up the probe**

```sql
-- as app_owner
drop table public._rls_probe;
```

- [ ] **Step 8: Record the connection strings**

Store in the local `.env` (git-ignored) and later in Vercel/GitHub:

- `DATABASE_URL` — `app_user`, **pooled** endpoint (host contains `-pooler`)
- `DATABASE_URL_MIGRATE` — `app_owner`, **direct** endpoint (no `-pooler`)
- `DATABASE_URL_TEST` — `app_user` on the `staging` branch

- [ ] **Step 9: Commit**

```bash
git add scripts/db
git commit -m "feat(db): create app_owner/app_user/app_admin roles and prove app_user cannot bypass RLS"
```

---

### Task 4: Environment validation

**Files:**
- Create: `src/env.ts`, `tests/env.test.ts`, `.env.example`

**Interfaces:**
- Consumes: Task 3's connection strings
- Produces:
  - `env: RuntimeEnv` — what the deployed application may see. **`app_owner` credentials are not in it.**
  - `parseRuntimeEnv(raw)` / `parseToolingEnv(raw)` — validators for the two disjoint sets
  - `toolingEnv: ToolingEnv` — migrations and integration tests only; never imported by `src/app/`

> **Credential separation is the point of this task.** `DATABASE_URL_MIGRATE` uses `app_owner`,
> which owns the schema and is exactly what RLS does not constrain. If it ever reaches the running
> application's environment, the whole authorization model becomes advisory. The two sets are
> therefore separate schemas, not one schema with optional fields — and production **fails to boot**
> if the migration credential is present.

- [ ] **Step 1: Write the failing test**

Create `tests/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseRuntimeEnv, parseToolingEnv } from '@/env';

const POOLED = 'postgresql://u:p@ep-x-pooler.ap-southeast-1.aws.neon.tech/db';
const DIRECT = 'postgresql://u:p@ep-x.ap-southeast-1.aws.neon.tech/db';

describe('parseRuntimeEnv', () => {
  it('rejects a direct URL for the runtime connection', () => {
    expect(() =>
      parseRuntimeEnv({ DATABASE_URL: DIRECT, APP_URL: 'http://localhost:3000', NODE_ENV: 'test' }),
    ).toThrow(/DATABASE_URL must use the pooled/);
  });

  it('REFUSES TO BOOT if the migration credential is present in production', () => {
    expect(() =>
      parseRuntimeEnv({
        DATABASE_URL: POOLED,
        DATABASE_URL_MIGRATE: DIRECT,
        APP_URL: 'https://os.pravshi.com',
        NODE_ENV: 'production',
      }),
    ).toThrow(/DATABASE_URL_MIGRATE must never be present in the runtime environment/);
  });

  it('accepts a correct runtime environment', () => {
    const env = parseRuntimeEnv({
      DATABASE_URL: POOLED,
      APP_URL: 'http://localhost:3000',
      NODE_ENV: 'test',
    });
    expect(env.APP_URL).toBe('http://localhost:3000');
  });
});

describe('parseToolingEnv', () => {
  it('rejects a pooled URL for migrations', () => {
    expect(() => parseToolingEnv({ DATABASE_URL_MIGRATE: POOLED })).toThrow(
      /DATABASE_URL_MIGRATE must use the direct/,
    );
  });

  it('accepts a direct URL for migrations', () => {
    expect(parseToolingEnv({ DATABASE_URL_MIGRATE: DIRECT }).DATABASE_URL_MIGRATE).toBe(DIRECT);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test tests/env.test.ts`
Expected: FAIL — `Cannot find module '@/env'`.

- [ ] **Step 3: Implement `src/env.ts`**

```ts
import { z } from 'zod';

/**
 * RUNTIME — everything the deployed application is permitted to see.
 *
 * DATABASE_URL_MIGRATE (role app_owner) is deliberately absent. app_owner owns the
 * schema, and an owner connection is precisely what RLS does not constrain. It lives
 * in GitHub Actions and on developer machines. Never in Vercel.
 */
const runtimeSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .refine((u) => u.includes('-pooler.'), {
      message: 'DATABASE_URL must use the pooled Neon endpoint (host contains "-pooler")',
    }),
  APP_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  SENTRY_DSN: z.string().url().optional(),
});

/** TOOLING — migrations and integration tests only. Never imported from src/app. */
const toolingSchema = z.object({
  DATABASE_URL_MIGRATE: z
    .string()
    .url()
    .refine((u) => !u.includes('-pooler.'), {
      message: 'DATABASE_URL_MIGRATE must use the direct Neon endpoint (no "-pooler" in host)',
    }),
});

export type RuntimeEnv = z.infer<typeof runtimeSchema>;
export type ToolingEnv = z.infer<typeof toolingSchema>;

function fail(issues: z.ZodIssue[]): never {
  throw new Error(
    `Invalid environment:\n${issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
  );
}

export function parseRuntimeEnv(raw: Record<string, unknown>): RuntimeEnv {
  // A leaked owner credential is a silent, total loss of RLS. Refuse to start.
  if (raw.NODE_ENV === 'production' && raw.DATABASE_URL_MIGRATE) {
    throw new Error(
      'DATABASE_URL_MIGRATE must never be present in the runtime environment. ' +
        'It uses app_owner, which owns the schema and is not constrained by RLS. ' +
        'Remove it from the Vercel environment.',
    );
  }
  const r = runtimeSchema.safeParse(raw);
  return r.success ? r.data : fail(r.error.issues);
}

export function parseToolingEnv(raw: Record<string, unknown>): ToolingEnv {
  const r = toolingSchema.safeParse(raw);
  return r.success ? r.data : fail(r.error.issues);
}

export const env: RuntimeEnv = parseRuntimeEnv(process.env);
```

```bash
pnpm add zod
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/env.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write `.env.example`**

```bash
# ─── Database (Neon · aws-ap-southeast-1 · Singapore) ───────────────────────
#
# CREDENTIAL SEPARATION — the most important rule in this file.
#
#   Variable               Role        Endpoint   Lives in
#   ---------------------  ----------  ---------  ------------------------------
#   DATABASE_URL           app_user    pooled     Vercel (all envs) + local
#   DATABASE_URL_MIGRATE   app_owner   direct     GitHub Actions + local ONLY
#   DATABASE_URL_TEST      app_user    pooled     GitHub Actions + local ONLY
#
# DATABASE_URL_MIGRATE MUST NEVER BE ADDED TO VERCEL. app_owner owns the schema,
# and an owner connection is exactly what RLS does not constrain. src/env.ts
# refuses to boot in production if it is present.

# Runtime connection. Role: app_user. MUST be the POOLED endpoint (-pooler in host).
# app_user has no BYPASSRLS and owns no tables — this is what makes RLS real.
DATABASE_URL=

# Migrations only. Role: app_owner. MUST be the DIRECT endpoint. NOT IN VERCEL.
DATABASE_URL_MIGRATE=

# Integration tests. Role: app_user, staging branch. NOT IN VERCEL.
DATABASE_URL_TEST=

# ─── Application ────────────────────────────────────────────────────────────
APP_URL=http://localhost:3000
NODE_ENV=development

# ─── Cloudflare R2 (private buckets; see Task 8) ────────────────────────────
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_HR=pravshi-hr
R2_BUCKET_CORPORATE=pravshi-corporate
R2_BUCKET_PROJECTS=pravshi-projects

# ─── Health checks ──────────────────────────────────────────────────────────
# Shared secret for GET /health/db, sent as the x-pravshi-health-token header.
# /health is public and database-free — point uptime monitors THERE.
# /health/db wakes suspended Neon compute, so it is gated: unset means nobody.
# Generate with: openssl rand -hex 32
HEALTH_CHECK_TOKEN=

# ─── Observability ──────────────────────────────────────────────────────────
SENTRY_DSN=
SENTRY_AUTH_TOKEN=

# ─── Phase 1 (documented now, unused in Phase 0) ────────────────────────────
# BETTER_AUTH_SECRET=
# RESEND_API_KEY=
# BOOTSTRAP_OWNER_EMAIL=
#
# NOTE: There is deliberately no keep-alive, heartbeat or min-compute setting.
# Neon scale-to-zero is a locked decision. See the spec's LOCKED DECISIONS table.
```

- [ ] **Step 6: Commit**

```bash
git add src/env.ts tests/env.test.ts .env.example
git commit -m "feat(env): add Zod-validated environment with pooled/direct endpoint enforcement"
```

---

### Task 5: Database pool with cold-start handling

**Files:**
- Create: `src/lib/db/pool.ts`, `tests/db/pool.test.ts`

**Interfaces:**
- Consumes: `env` from Task 4
- Produces: `pool: Pool`, `connectWithWake(attempt?: number): Promise<PoolClient>`, `isRetryableConnectError(e: unknown): boolean`

> `connectWithWake()` is not optional plumbing — Task 6's `withAuthorizedDb()` acquires **every**
> connection through it. Nothing else in the codebase may call `pool.connect()` directly.

- [ ] **Step 1: Write the failing test**

Create `tests/db/pool.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isRetryableConnectError } from '@/lib/db/pool';

describe('isRetryableConnectError', () => {
  it('retries the errors a Neon cold start produces', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '08006', '08001']) {
      expect(isRetryableConnectError({ code })).toBe(true);
    }
  });

  it('does not retry a constraint violation', () => {
    expect(isRetryableConnectError({ code: '23505' })).toBe(false);
  });

  it('does not retry an unknown shape', () => {
    expect(isRetryableConnectError('boom')).toBe(false);
    expect(isRetryableConnectError(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test tests/db/pool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pool**

Create `src/lib/db/pool.ts`:

```ts
import { Pool, type PoolClient } from '@neondatabase/serverless';
import { env } from '@/env';

/**
 * Neon runs with scale-to-zero (a locked decision). Compute suspends when idle,
 * so dropped connections are NORMAL, not exceptional, and the first request
 * after a suspend pays a cold start. Nothing here may keep compute awake.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  idleTimeoutMillis: 10_000,      // release early; a suspended compute kills them anyway
  connectionTimeoutMillis: 10_000, // generous: this is where the cold start is paid
  max: 5,                          // per serverless instance, not per application
});

const RETRYABLE = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  '57P01', // admin_shutdown — what a suspending compute looks like
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
]);

export function isRetryableConnectError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && RETRYABLE.has(code);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries CONNECTION ESTABLISHMENT only — never the work itself.
 * A connection lost mid-commit is ambiguous; replaying it can double-write.
 */
export async function connectWithWake(attempt = 0): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch (e) {
    if (attempt >= 3 || !isRetryableConnectError(e)) throw e;
    await sleep(250 * 2 ** attempt); // 250ms, 500ms, 1s
    return connectWithWake(attempt + 1);
  }
}
```

```bash
pnpm add @neondatabase/serverless drizzle-orm
pnpm add -D drizzle-kit
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/db/pool.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/pool.ts tests/db/pool.test.ts
git commit -m "feat(db): add Neon pool with cold-start-aware connect retry"
```

---

### Task 6: `withAuthorizedDb()` — the only path to Postgres

**Files:**
- Create: `src/lib/db/context.ts`, `src/lib/db/authorized.ts`, `src/lib/db/schema.ts`, `drizzle.config.ts`, `drizzle/0000_extensions_and_schemas.sql`, `tests/db/authorized.test.ts`

**Interfaces:**
- Consumes: `connectWithWake` (Task 5). **Not `pool` directly** — the cold-start retry lives on the
  connection path, so bypassing it would make the first request after a suspend fail instead of wake.
- Produces:
  - `type Aal = 'aal1' | 'aal2'`
  - `interface AuthContext { personId: string; orgId: string; aal: Aal }`
  - `type Tx` — the transaction handle passed to callbacks
  - `withAuthorizedDb<T>(ctx: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T>`

  Phase 1 supplies `AuthContext` from the Better Auth session. Phase 0 builds the seam and tests it with a synthetic context.

- [ ] **Step 1: Write the failing integration test**

Create `tests/db/authorized.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { pool } from '@/lib/db/pool';

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB   = '22222222-2222-2222-2222-222222222222';
const ORG   = '33333333-3333-3333-3333-333333333333';

// Owner-level setup runs on the migrate connection, not the app connection.
beforeAll(async () => {
  const { Pool } = await import('@neondatabase/serverless');
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  await owner.query(`
    create table if not exists public._ctx_probe (
      id uuid primary key default gen_random_uuid(),
      org_id uuid not null,
      owner_person_id uuid not null
    );
    alter table public._ctx_probe enable row level security;
    alter table public._ctx_probe force  row level security;
    drop policy if exists ctx_probe_select on public._ctx_probe;
    create policy ctx_probe_select on public._ctx_probe for select to app_user
      using (org_id = nullif(current_setting('app.org_id', true), '')::uuid
         and owner_person_id = nullif(current_setting('app.person_id', true), '')::uuid);
    grant select on public._ctx_probe to app_user;
    truncate public._ctx_probe;
    insert into public._ctx_probe (org_id, owner_person_id)
      values ('${ORG}', '${ALICE}'), ('${ORG}', '${BOB}');
  `);
  await owner.end();
});

afterAll(async () => {
  const { Pool } = await import('@neondatabase/serverless');
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  await owner.query('drop table if exists public._ctx_probe;');
  await owner.end();
  await pool.end();
});

describe('withAuthorizedDb', () => {
  it('returns only the rows belonging to the context person', async () => {
    const rows = await withAuthorizedDb(
      { personId: ALICE, orgId: ORG, aal: 'aal1' },
      (tx) => tx.execute(sql`select owner_person_id from public._ctx_probe`),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.owner_person_id).toBe(ALICE);
  });

  it('does not leak context to a query outside the helper — fail closed', async () => {
    const direct = await pool.query('select count(*)::int as n from public._ctx_probe');
    expect(direct.rows[0]?.n).toBe(0);
  });

  it('isolates two contexts used back to back on the same pool', async () => {
    const a = await withAuthorizedDb({ personId: ALICE, orgId: ORG, aal: 'aal1' },
      (tx) => tx.execute(sql`select owner_person_id from public._ctx_probe`));
    const b = await withAuthorizedDb({ personId: BOB, orgId: ORG, aal: 'aal1' },
      (tx) => tx.execute(sql`select owner_person_id from public._ctx_probe`));
    expect(a.rows[0]?.owner_person_id).toBe(ALICE);
    expect(b.rows[0]?.owner_person_id).toBe(BOB);
  });

  it('releases the connection back to the pool on every call', async () => {
    // pool max is 5. If release() is missing, the sixth call hangs and this times out.
    for (let i = 0; i < 12; i++) {
      await withAuthorizedDb({ personId: ALICE, orgId: ORG, aal: 'aal1' },
        (tx) => tx.execute(sql`select 1`));
    }
    expect(true).toBe(true);
  });

  it('rolls back the context when the callback throws', async () => {
    await expect(
      withAuthorizedDb({ personId: ALICE, orgId: ORG, aal: 'aal1' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await pool.query(`select current_setting('app.person_id', true) as p`);
    expect(after.rows[0]?.p ?? '').toBe('');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test tests/db/authorized.test.ts`
Expected: FAIL — `Cannot find module '@/lib/db/authorized'`.

- [ ] **Step 3: Define the context type**

Create `src/lib/db/context.ts`:

```ts
/** Authentication assurance level. 'aal2' means MFA was satisfied this session. */
export type Aal = 'aal1' | 'aal2';

/**
 * The identity a database transaction runs under.
 * Phase 1 derives this from the Better Auth session; Phase 0 constructs it in tests.
 */
export interface AuthContext {
  personId: string;
  orgId: string;
  aal: Aal;
}
```

- [ ] **Step 4: Implement the helper**

Create `src/lib/db/authorized.ts`:

```ts
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { connectWithWake } from './pool';
import type { AuthContext } from './context';

type DrizzleClient = ReturnType<typeof drizzle>;

/** The transaction handle handed to every callback. Exported so callers can type helpers. */
export type Tx = Parameters<Parameters<DrizzleClient['transaction']>[0]>[0];

/**
 * THE ONLY PATH TO POSTGRES.
 *
 * The sequence is fixed and each step exists for a reason:
 *
 *   connection establishment  → via connectWithWake(), which retries ONLY the
 *                               connect, because a suspended Neon compute is
 *                               expected rather than exceptional
 *   transaction               → SET LOCAL is transaction-scoped, so there must
 *                               be a transaction for identity to live in
 *   SET LOCAL identity        → never session-scoped SET: pooled connections are
 *                               reused, and a session setting would carry one
 *                               person's identity into the next person's query
 *   callback                  → the caller's work, run under that identity
 *   commit / rollback         → automatic; the context dies with the transaction
 *
 * Two absolutes:
 *
 *   1. The business work is NEVER retried. A connection lost mid-transaction was
 *      rolled back, but one lost mid-COMMIT is genuinely ambiguous, and replaying
 *      it can double-write. Retries belong on the connect, and nowhere else.
 *   2. No query runs outside this helper. Without context, current_setting()
 *      returns NULL, every policy evaluates false, and the query returns zero
 *      rows — fail-closed, which is the correct failure.
 */
export async function withAuthorizedDb<T>(
  ctx: AuthContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await connectWithWake();
  try {
    const db = drizzle(client);
    return await db.transaction(async (tx) => {
      await tx.execute(sql`
        select
          set_config('app.person_id', ${ctx.personId}, true),
          set_config('app.org_id',    ${ctx.orgId},    true),
          set_config('app.aal',       ${ctx.aal},      true)
      `);
      return fn(tx);
    });
  } finally {
    // Always returned, including after a rollback. A leaked connection exhausts
    // the pool after `max` requests and the app hangs with no error.
    client.release();
  }
}
```

- [ ] **Step 5: Add the empty Drizzle schema and config**

Create `src/lib/db/schema.ts`:

```ts
// Business tables arrive in Phase 1. Kept deliberately empty so Drizzle Kit has
// a target and the migration pipeline is proven before it carries anything.
export {};
```

Create `drizzle.config.ts`:

```ts
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL_MIGRATE! },
  // RLS policies, functions, grants and triggers are hand-written SQL appended
  // to these migration files. They are never modelled in Drizzle.
} satisfies Config;
```

Create `drizzle/0000_extensions_and_schemas.sql`:

```sql
create schema if not exists authz;
comment on schema authz is
  'Authorization helper functions. Every RLS policy is written in terms of these. Phase 1 populates it.';
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test tests/db/authorized.test.ts`
Expected: PASS, 5 tests. The isolation and release tests are the ones that matter — they prove context does not leak across pooled connections, which is threat T-21.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db drizzle drizzle.config.ts tests/db/authorized.test.ts
git commit -m "feat(db): add withAuthorizedDb() with SET LOCAL context and fail-closed isolation tests"
```

---

### Task 7: CI guard checks

**Files:**
- Create: `tests/guards/rls-enabled.test.ts`, `tests/guards/runtime-role.test.ts`, `tests/guards/no-keepalive.test.ts`

**Interfaces:**
- Consumes: `DATABASE_URL_TEST`, `DATABASE_URL_MIGRATE`
- Produces: four assertions that run on every PR and keep the locked decisions true

- [ ] **Step 1: Write the RLS guard**

Create `tests/guards/rls-enabled.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

describe('every table in public has RLS enabled AND forced', () => {
  it('finds no unprotected table', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
    const { rows } = await pool.query<{ relname: string; enabled: boolean; forced: boolean }>(`
      select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname not like '\\_%'          -- probe tables from tests
        and c.relname <> '__drizzle_migrations'
        and (not c.relrowsecurity or not c.relforcerowsecurity)
    `);
    await pool.end();
    expect(rows, `Unprotected tables: ${rows.map((r) => r.relname).join(', ')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the runtime-role guard**

Create `tests/guards/runtime-role.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

describe('the runtime role cannot defeat RLS', () => {
  it('has no BYPASSRLS and owns no tables', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
    const role = await pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
    );
    const owned = await pool.query<{ n: number }>(`
      select count(*)::int as n
      from pg_class c join pg_roles r on r.oid = c.relowner
      where r.rolname = current_user and c.relkind = 'r'
    `);
    await pool.end();

    expect(role.rows[0]?.rolbypassrls, 'runtime role must not have BYPASSRLS').toBe(false);
    expect(role.rows[0]?.rolsuper, 'runtime role must not be superuser').toBe(false);
    expect(owned.rows[0]?.n, 'runtime role must own no tables').toBe(0);
  });
});
```

- [ ] **Step 3: Write the scale-to-zero guard**

Create `tests/guards/no-keepalive.test.ts`:

```ts
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Neon scale-to-zero is a locked decision. Nothing may keep compute awake.
 * This guard catches the two ways it gets defeated by accident.
 */
describe('nothing defeats Neon autosuspend', () => {
  it('declares no cron jobs in vercel.json', () => {
    const cfg = JSON.parse(readFileSync('vercel.json', 'utf8')) as Record<string, unknown>;
    expect(cfg.crons, 'Adding a cron requires a founder decision — see LOCKED DECISIONS').toBeUndefined();
  });

  it('has no keep-alive, heartbeat or warmup code', () => {
    const hits = execSync(
      `git grep -lEi "keep-?alive|heartbeat|warm-?up|prevent.*(idle|suspend)|setInterval.*(query|pool)" -- src scripts || true`,
      { encoding: 'utf8' },
    ).trim();
    expect(hits, `Possible keep-alive found in:\n${hits}`).toBe('');
  });

  it('keeps /health free of database access', () => {
    const health = readFileSync('src/app/health/route.ts', 'utf8');
    expect(health).not.toMatch(/lib\/db/);
    expect(existsSync('src/app/health/db/route.ts')).toBe(true);
  });
});
```

- [ ] **Step 4: Write the single-database-path guard**

`withAuthorizedDb()` is only "the only path to Postgres" if nothing bypasses it. Make that
mechanical. Create `tests/guards/single-db-path.test.ts`:

```ts
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const grep = (args: string) => execSync(`git grep ${args} || true`, { encoding: 'utf8' }).trim();

describe('there is exactly one path to Postgres', () => {
  it('nothing calls pool.connect() outside src/lib/db/pool.ts', () => {
    const hits = grep(`-l "pool.connect(" -- src ":!src/lib/db/pool.ts"`);
    expect(hits, `Direct pool.connect() bypasses cold-start retry, in:\n${hits}`).toBe('');
  });

  it('nothing outside the db module imports the pool', () => {
    const hits = grep(
      `-lE "from '@/lib/db/pool'" -- src ":!src/lib/db/*" ":!src/app/health/db/route.ts"`,
    );
    expect(hits, `Unexpected pool import — use withAuthorizedDb(), in:\n${hits}`).toBe('');
  });
});
```

`/health/db` is the one legitimate exception: it deliberately checks connectivity without an
identity, and holds no query of its own.

- [ ] **Step 5: Run all four**

Run: `pnpm test tests/guards`
Expected: the first, second and fourth PASS. The third FAILS on the missing `/health` route —
that is Task 8.

- [ ] **Step 6: Commit**

```bash
git add tests/guards
git commit -m "test(guards): assert RLS forced, runtime role cannot bypass, one DB path, and autosuspend intact"
```

---

### Task 8: Health endpoints

**Files:**
- Create: `src/app/health/route.ts`, `src/app/health/db/route.ts`, `tests/health/no-db-in-health.test.ts`

**Interfaces:**
- Consumes: `connectWithWake` (Task 5)
- Produces: `GET /health` (no DB) and `GET /health/db` (DB, deliberately not for monitors)

- [ ] **Step 1: Write the failing tests**

Create `tests/health/no-db-in-health.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('/health', () => {
  it('never touches the database — an uptime monitor must not become a keep-alive', () => {
    const src = readFileSync('src/app/health/route.ts', 'utf8');
    expect(src).not.toMatch(/from ['"]@\/lib\/db/);
    expect(src).not.toMatch(/neondatabase/);
  });

  it('documents that /health/db is not for monitors and requires a token', () => {
    const src = readFileSync('src/app/health/db/route.ts', 'utf8');
    expect(src).toMatch(/not for uptime monitors/i);
    expect(src).toMatch(/x-pravshi-health-token/);
  });
});
```

Create `tests/health/health-db-auth.test.ts` — the test that actually matters, because it proves an
anonymous caller cannot wake suspended compute:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/pool', () => ({
  connectWithWake: vi.fn(async () => {
    throw new Error('the database must not be touched by an unauthorised caller');
  }),
}));

vi.mock('@/env', () => ({
  env: { HEALTH_CHECK_TOKEN: 'a'.repeat(32), NODE_ENV: 'test' },
}));

beforeEach(() => vi.clearAllMocks());

async function call(headers: Record<string, string> = {}) {
  const { GET } = await import('@/app/health/db/route');
  return GET(new Request('http://localhost/health/db', { headers }));
}

describe('/health/db authorisation', () => {
  it('returns 404 with no token, and never opens a connection', async () => {
    const res = await call();
    expect(res.status).toBe(404);
    const { connectWithWake } = await import('@/lib/db/pool');
    expect(connectWithWake).not.toHaveBeenCalled();
  });

  it('returns 404 with a wrong token, and never opens a connection', async () => {
    const res = await call({ 'x-pravshi-health-token': 'b'.repeat(32) });
    expect(res.status).toBe(404);
    const { connectWithWake } = await import('@/lib/db/pool');
    expect(connectWithWake).not.toHaveBeenCalled();
  });

  it('returns 404 with a token of the right value but wrong length', async () => {
    const res = await call({ 'x-pravshi-health-token': 'a'.repeat(31) });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test tests/health`
Expected: FAIL — `ENOENT: no such file or directory, open 'src/app/health/route.ts'`.

- [ ] **Step 3: Implement both routes**

Create `src/app/health/route.ts`:

```ts
export const dynamic = 'force-dynamic';

/**
 * Liveness only. MUST NOT touch the database.
 *
 * Neon runs with scale-to-zero. An uptime monitor polling a DB-backed health
 * check every 60s would hold compute open around the clock and nobody would
 * notice until the bill arrived. Point monitors here.
 */
export function GET() {
  return Response.json({ status: 'ok', at: new Date().toISOString() });
}
```

Create `src/app/health/db/route.ts`:

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { connectWithWake } from '@/lib/db/pool';
import { env } from '@/env';

export const dynamic = 'force-dynamic';

/**
 * Database reachability. For CI and humans — NOT FOR UPTIME MONITORS.
 *
 * Every successful call wakes suspended compute, so this endpoint is gated by a
 * shared secret in the `x-pravshi-health-token` header. Without it, an anonymous
 * caller on the internet could hold Neon awake around the clock simply by curling
 * this path in a loop — defeating the locked scale-to-zero decision from outside
 * the codebase, where none of our guards would see it.
 *
 * Point uptime monitors at /health instead. It is public and touches nothing.
 */
function authorized(req: Request): boolean {
  const configured = env.HEALTH_CHECK_TOKEN;
  if (!configured) return false; // unset means nobody — fail closed
  const presented = req.headers.get('x-pravshi-health-token');
  if (!presented) return false;
  // Hash both first: timingSafeEqual requires equal lengths, and comparing
  // digests avoids leaking the token's length through an early return.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(configured).digest();
  return timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  // AUTHORISE BEFORE TOUCHING THE DATABASE. This ordering is the entire control:
  // checking afterwards would still wake the compute for every anonymous caller.
  if (!authorized(req)) {
    // 404, not 401 — consistent with the spec's rule that we do not confirm the
    // existence of things the caller is not entitled to reach.
    return new Response(null, { status: 404 });
  }

  const started = Date.now();
  try {
    const client = await connectWithWake();
    try {
      await client.query('select 1');
    } finally {
      client.release();
    }
    return Response.json({ status: 'ok', wake_ms: Date.now() - started });
  } catch (e) {
    // Detail goes to observability. The caller gets nothing: database and
    // infrastructure errors name hosts, roles, versions and topology, and a
    // health endpoint is exactly where an attacker looks for them first.
    Sentry.captureException(e, { tags: { route: 'health/db' } });
    console.error('[health/db] database check failed', e);
    return Response.json({ status: 'error' }, { status: 503 });
  }
}
```

Add the token to the runtime schema in `src/env.ts` — optional, because an unset token means the
endpoint denies everyone, which is the correct fail-closed default and keeps local development
working without ceremony:

```ts
  HEALTH_CHECK_TOKEN: z.string().min(32).optional(),
```

Generate a value with `openssl rand -hex 32`.

- [ ] **Step 4: Run the health and guard tests**

Run: `pnpm test tests/health tests/guards`
Expected: PASS, all tests including the previously failing autosuspend guard and the three
`/health/db` authorisation cases.

- [ ] **Step 5: Commit**

```bash
git add src/app/health src/env.ts tests/health
git commit -m "feat(health): public DB-free liveness, plus a token-gated DB check that fails closed"
```

---

### Task 9: Design system foundation and application shell

**Files:**
- Create: `src/app/globals.css` (modify), `src/components/shell/app-shell.tsx`, `src/components/shell/sidebar.tsx`, `src/components/shell/page-header.tsx`, `src/components/shell/theme-toggle.tsx`, `src/components/state/empty-state.tsx`, `src/components/state/error-state.tsx`, `src/components/state/loading-state.tsx`, `src/app/page.tsx` (modify), `e2e/shell.spec.ts`, `playwright.config.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `<AppShell>`, `<PageHeader>`, `<EmptyState>`, `<ErrorState>`, `<LoadingState>` — used by every page from Phase 1 onward

- [ ] **Step 1: Install shadcn/ui and the primitives Phase 1 needs**

```bash
pnpm dlx shadcn@latest init -d
pnpm dlx shadcn@latest add button input label table dialog dropdown-menu \
  badge card separator sheet skeleton sonner tabs avatar
pnpm add next-themes lucide-react
```

- [ ] **Step 2: Define the design tokens**

In `src/app/globals.css`, after `@import "tailwindcss";`:

```css
@theme {
  --font-sans: "Inter var", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;

  /* Neutrals carry a slight blue-green bias so they read as chosen, not default. */
  --color-ground: oklch(98.2% 0.003 195);
  --color-surface: oklch(100% 0 0);
  --color-ink: oklch(21% 0.012 195);
  --color-ink-muted: oklch(48% 0.010 195);
  --color-rule: oklch(90% 0.006 195);

  --color-brand: oklch(48% 0.086 192);        /* PRAVSHI accent */
  --color-brand-soft: oklch(94% 0.024 192);

  /* Semantic — separate from the accent, never colour alone (a11y). */
  --color-ok: oklch(52% 0.112 152);
  --color-warn: oklch(60% 0.128 75);
  --color-danger: oklch(52% 0.170 27);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-ground: oklch(17% 0.010 195);
    --color-surface: oklch(21% 0.012 195);
    --color-ink: oklch(94% 0.006 195);
    --color-ink-muted: oklch(70% 0.010 195);
    --color-rule: oklch(30% 0.012 195);
    --color-brand: oklch(72% 0.086 192);
    --color-brand-soft: oklch(28% 0.038 192);
  }
}
```

- [ ] **Step 3: Build the shell**

Create `src/components/shell/app-shell.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Sidebar } from './sidebar';
import { ThemeToggle } from './theme-toggle';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar />
      <div className="flex min-w-0 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-rule px-6">
          <span className="text-sm text-ink-muted">PRAVSHI OS</span>
          <ThemeToggle />
        </header>
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
```

Create `src/components/shell/sidebar.tsx`:

```tsx
import Link from 'next/link';

/**
 * Sections render only when the viewer holds a permission inside them.
 * Phase 0 has no permissions yet, so the list is static and Home-only —
 * Phase 1 replaces this with permission filtering.
 */
const SECTIONS = [{ label: 'Home', href: '/' }] as const;

export function Sidebar() {
  return (
    <nav className="hidden border-r border-rule bg-surface p-4 md:block" aria-label="Main">
      <div className="mb-6 text-xs font-semibold uppercase tracking-widest text-brand">PRAVSHI</div>
      <ul className="flex flex-col gap-1">
        {SECTIONS.map((s) => (
          <li key={s.href}>
            <Link href={s.href} className="block rounded px-3 py-2 text-sm hover:bg-brand-soft">
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

Create `src/components/state/empty-state.tsx`:

```tsx
import type { ReactNode } from 'react';

/** Every table gets one. An empty state must say what to do next, not just "no data". */
export function EmptyState({
  title, description, action,
}: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded border border-dashed border-rule p-12 text-center">
      <p className="font-medium">{title}</p>
      <p className="max-w-prose text-sm text-ink-muted">{description}</p>
      {action}
    </div>
  );
}
```

Create `src/components/shell/page-header.tsx`:

```tsx
import type { ReactNode } from 'react';

export function PageHeader({
  title, description, actions,
}: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
        {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  );
}
```

Create `src/components/shell/theme-toggle.tsx`. **The accessible names here are asserted by the
Playwright test in Step 4 — `aria-label="Theme"` and the item label `Dark` must match exactly:**

```tsx
'use client';

import { useTheme } from 'next-themes';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ThemeToggle() {
  const { setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Theme">
          <Sun className="h-4 w-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <Sun className="mr-2 h-4 w-4" aria-hidden />Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <Moon className="mr-2 h-4 w-4" aria-hidden />Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <Monitor className="mr-2 h-4 w-4" aria-hidden />System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

Wire the provider in `src/app/layout.tsx` — `attribute="data-theme"` is what makes the test's
`html[data-theme="dark"]` assertion true:

```tsx
import { ThemeProvider } from 'next-themes';
import { AppShell } from '@/components/shell/app-shell';
import './globals.css';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-ground text-ink antialiased">
        <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem>
          <AppShell>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
```

Create `src/components/state/error-state.tsx`:

```tsx
export function ErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div role="alert" className="rounded border border-danger/40 bg-danger/5 p-6">
      <p className="font-medium text-danger">{title}</p>
      {detail ? <p className="mt-1 text-sm text-ink-muted">{detail}</p> : null}
    </div>
  );
}
```

Create `src/components/state/loading-state.tsx`:

```tsx
import { Skeleton } from '@/components/ui/skeleton';

export function LoadingState({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Write the Playwright smoke test**

Create `e2e/shell.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('the shell renders and the theme toggles', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByText('PRAVSHI OS')).toBeVisible();

  await page.getByRole('button', { name: /theme/i }).click();
  await page.getByRole('menuitem', { name: /dark/i }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('health responds without touching the database', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: 'ok' });
});
```

```bash
pnpm add -D @playwright/test && pnpm exec playwright install chromium
```

- [ ] **Step 5: Run it**

Run: `pnpm build && pnpm e2e`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/components src/app e2e playwright.config.ts
git commit -m "feat(ui): add design tokens, app shell, state primitives and a smoke test"
```

---

### Task 10: GitHub organisation and repository *(BLOCKED — needs Owner access)*

**Files:**
- Create: `.github/CODEOWNERS`, `.github/pull_request_template.md`

**Interfaces:**
- Consumes: Tasks 1–9 committed locally
- Produces: the `pravshi/pravshi-os` remote every later task pushes to

- [ ] **Step 1: Confirm Owner access before starting**

Either your account holds Owner on `pravshi`, or `prasanthnaidu0987@gmail.com` performs Steps 2–6. Verify:

```bash
gh api orgs/pravshi/memberships/$(gh api user --jq .login) --jq .role
```

Expected: `admin`. If it says `member`, stop — Steps 2–6 cannot be done.

- [ ] **Step 2: Create the private repository and push**

```bash
gh repo create pravshi/pravshi-os --private --source=. --remote=origin --push
git checkout -b develop && git push -u origin develop
```

- [ ] **Step 3: Write CODEOWNERS**

Create `.github/CODEOWNERS`:

```
# Two directories where a mistake is a breach, not a bug.
/drizzle/            @pravshi/maintainers
/src/lib/db/         @pravshi/maintainers
/src/lib/authz/      @pravshi/maintainers
/tests/guards/       @pravshi/maintainers
/.github/workflows/  @pravshi/maintainers
```

- [ ] **Step 4: Write the pull request template**

Create `.github/pull_request_template.md`:

```markdown
## What changed

## Does this change permissions, RLS policies, or database roles?
- [ ] No
- [ ] Yes — and these tests prove the new behaviour:

## Does this add anything that could keep Neon compute awake?
(cron, scheduled job, background worker, polled DB-backed endpoint)
- [ ] No
- [ ] Yes — and here is the founder decision authorising it:

## Verification
- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass locally
```

- [ ] **Step 5: Create teams and branch protection**

```bash
for t in maintainers developers vibecoders reviewers; do
  gh api -X POST orgs/pravshi/teams -f name="$t" -f privacy=closed
done

# main — production. Admins are subject to the gates like everyone else.
gh api -X PUT repos/pravshi/pravshi-os/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["ci"] },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true,
    "dismiss_stale_reviews": true,
    "bypass_pull_request_allowances": { "users": [], "teams": [], "apps": [] }
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON

# develop — integration. Same gates, but no second human required to merge.
gh api -X PUT repos/pravshi/pravshi-os/branches/develop/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["ci"] },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "require_code_owner_reviews": false,
    "bypass_pull_request_allowances": { "users": [], "teams": [], "apps": [] }
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

**No intern is added to a team with admin rights.**

> **`enforce_admins: true` on both branches, as requested — with one consequence you should decide
> on deliberately rather than discover.**
>
> There is no technical obstacle. There is an operational one: with `enforce_admins: true` **and**
> `required_approving_review_count: 1`, an administrator cannot merge their own pull request. On
> `main` that is the entire point — production changes get a second pair of eyes, and the second
> organisation account provides them. Applying the same setting to `develop` would mean **you cannot
> merge your own day-to-day work without someone else clicking approve**, which for a solo builder
> stops being a security control and starts being a reason to switch protection off.
>
> So `develop` keeps `enforce_admins: true`, required CI, no force-push and no deletion — every
> mechanical gate — but requires zero approvals. Nothing reaches `main` unreviewed either way.
>
> **Break-glass:** if protection must ever be lifted, disabling it is recorded in the organisation
> audit log. Treat it as a two-person, documented action, written up in `INCIDENT-RESPONSE.md` in
> Phase 8. Never a routine unblock.

- [ ] **Step 6: Enable scanning and create environments**

In repository settings: enable **secret scanning with push protection**, **Dependabot alerts and security updates**, and **CodeQL**. Create the `staging` and `production` environments, with **required reviewers** on `production`.

- [ ] **Step 7: Verify push protection — by configuration first, and never against this repository**

The obvious test — commit a credential-shaped string to `pravshi-os` and see whether the push is
blocked — is the wrong test twice over:

- **It can report a false failure.** AWS's `AKIAIOSFODNN7EXAMPLE` is a *published documentation
  example*. Scanners commonly ignore known example values precisely because they appear in docs, so
  a push that succeeds would prove nothing about whether protection works.
- **It fails unsafely.** If protection is misconfigured, the string is now in `pravshi-os` history
  permanently, and removing it means rewriting history on a repository that is meant to be
  protected from exactly that.

**7a — Assert the configuration.** This is the primary evidence: it is authoritative, zero-risk, and
repeatable.

```bash
gh api repos/pravshi/pravshi-os \
  --jq '.security_and_analysis | {
        secret_scanning: .secret_scanning.status,
        push_protection: .secret_scanning_push_protection.status,
        non_provider_patterns: .secret_scanning_non_provider_patterns.status
      }'
```

Expected: every field reads `enabled`. Capture the output in the PR. If `push_protection` is
`disabled`, enable it in Settings → Code security, or with
`gh api -X PATCH repos/pravshi/pravshi-os -F security_and_analysis[secret_scanning_push_protection][status]=enabled`,
then re-run.

**7b — Confirm the behaviour, in a disposable repository.** Optional but worth doing once, so you
have seen the block message and know what a developer will hit.

```bash
gh repo create pravshi/push-protection-probe --private --confirm
git clone https://github.com/pravshi/push-protection-probe /tmp/pp && cd /tmp/pp
gh api repos/pravshi/push-protection-probe \
  -X PATCH -F security_and_analysis[secret_scanning_push_protection][status]=enabled
```

For the test value, take a **currently supported pattern** from GitHub's secret scanning
"supported patterns" documentation and construct a syntactically valid, non-functional value of that
format. Do not hardcode one here: the supported-pattern list changes over time, and a stale choice
produces a false negative that reads as "protection is broken".

```bash
printf 'token = "<pattern-shaped test value>"\n' > probe.txt
git add probe.txt && git commit -m "probe" && git push
```

Expected: the push is **rejected**, and the output names the detected secret type and offers a bypass
URL. Then destroy the evidence along with the repository:

```bash
cd / && rm -rf /tmp/pp
gh repo delete pravshi/push-protection-probe --yes
```

Because the probe never touches `pravshi-os`, an unexpected result costs you a throwaway repository
rather than a permanent entry in the history of the repository you are trying to protect.

- [ ] **Step 8: Commit**

```bash
git add .github
git commit -m "chore(ci): add CODEOWNERS and PR template with permissions and autosuspend gates"
```

---

### Task 11: CI pipeline *(BLOCKED on Task 10)*

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: every `pnpm` script and the guard tests
- Produces: the `ci` status check that branch protection requires

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  pull_request:
  push: { branches: [main, develop] }

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile

      # An ephemeral Neon branch per PR. Migration review stops being an act of faith.
      - name: Create Neon branch
        id: neon
        uses: neondatabase/create-branch-action@v5
        with:
          project_id: ${{ secrets.NEON_PROJECT_ID }}
          branch_name: ci/pr-${{ github.event.number || github.run_id }}
          api_key: ${{ secrets.NEON_API_KEY }}

      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm exec drizzle-kit migrate
        env:
          DATABASE_URL_MIGRATE: ${{ steps.neon.outputs.db_url }}
      - run: pnpm test
        env:
          DATABASE_URL: ${{ steps.neon.outputs.db_url_pooled }}
          DATABASE_URL_TEST: ${{ steps.neon.outputs.db_url_pooled }}
          DATABASE_URL_MIGRATE: ${{ steps.neon.outputs.db_url }}
      - run: pnpm build

  cleanup:
    needs: ci
    if: always() && github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: neondatabase/delete-branch-action@v3
        with:
          project_id: ${{ secrets.NEON_PROJECT_ID }}
          branch: ci/pr-${{ github.event.number }}
          api_key: ${{ secrets.NEON_API_KEY }}
```

- [ ] **Step 2: Add the Actions secrets**

```bash
gh secret set NEON_API_KEY --repo pravshi/pravshi-os
gh secret set NEON_PROJECT_ID --repo pravshi/pravshi-os
```

- [ ] **Step 3: Open a throwaway PR and confirm CI runs green**

Expected: all steps pass; the ephemeral branch is created and then deleted.

- [ ] **Step 4: Confirm CI can fail correctly**

Temporarily add a table without RLS in a scratch migration and push.
Expected: `tests/guards/rls-enabled.test.ts` **FAILS** and blocks the merge. Then revert.

> A guard nobody has watched fail is a guard nobody knows works.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add pipeline with ephemeral Neon branch per PR and security guards"
```

---

### Task 12: Vercel project, environments and DNS *(BLOCKED on Task 10)*

**Files:**
- Modify: `vercel.json` (already correct from Task 1)

**Interfaces:**
- Consumes: the GitHub repository
- Produces: `https://os.pravshi.com` serving the Phase 0 placeholder

- [ ] **Step 1: Create and link the project**

```bash
pnpm dlx vercel link
pnpm dlx vercel git connect
```

Confirm the region reads `sin1` — co-located with Neon Singapore.

- [ ] **Step 2: Set environment variables per environment**

> **`DATABASE_URL_MIGRATE` is deliberately absent from this list and must never be added.**
> It uses `app_owner`, which owns the schema and is therefore not constrained by RLS. A deployed
> application holding that credential could — through one careless import — read every row in the
> database with every policy still nominally "enabled". Migration credentials live in GitHub
> Actions and on developer machines. Nowhere else.

```bash
for e in production preview development; do
  pnpm dlx vercel env add DATABASE_URL "$e"     # app_user, POOLED
  pnpm dlx vercel env add APP_URL "$e"
  pnpm dlx vercel env add SENTRY_DSN "$e"
  pnpm dlx vercel env add NEXT_PUBLIC_SENTRY_DSN "$e"
  pnpm dlx vercel env add HEALTH_CHECK_TOKEN "$e"
done
```

Production values come from the `production` Neon branch; preview from `staging`.

- [ ] **Step 2a: Verify the owner credential is absent from every Vercel environment**

```bash
pnpm dlx vercel env ls | grep -i "DATABASE_URL_MIGRATE" && echo "FAIL" || echo "PASS: not present"
```

Expected: `PASS: not present`. If it appears, remove it immediately with
`pnpm dlx vercel env rm DATABASE_URL_MIGRATE <environment>` and rotate the `app_owner` password,
because it has been stored somewhere it was never meant to be.

Two independent defences back this up: `src/env.ts` refuses to boot in production if the variable
is present (Task 4), and the runtime schema does not define it, so nothing in `src/` can read it
even by accident.

- [ ] **Step 3: Determine which service is authoritative for DNS**

```bash
nslookup -type=NS pravshi.com
```

- `*.ns.cloudflare.com` → records go in **Cloudflare**. Adding them at GoDaddy does nothing at all, silently.
- `*.domaincontrol.com` → records go in **GoDaddy**.

Record which, in the PR description.

- [ ] **Step 4: Add the CNAME**

| Type | Name | Value | TTL | Proxy |
|---|---|---|---|---|
| `CNAME` | `os` | `cname.vercel-dns.com` | 300 | **DNS only — grey cloud** |

Grey cloud is required: Vercel issues the certificate itself, and proxying blocks that unless you also configure Cloudflare origin certificates with SSL mode Full (strict). Do not touch the apex `pravshi.com`.

- [ ] **Step 5: Add the domain in Vercel and verify**

```bash
pnpm dlx vercel domains add os.pravshi.com
dig os.pravshi.com
curl -sI https://os.pravshi.com/health
```

Expected: `dig` resolves to Vercel; `curl` returns `200` with a valid certificate.

- [ ] **Step 6: Confirm the deployed app reaches the database**

```bash
# Unauthenticated — must NOT reach the database.
curl -s -o /dev/null -w "%{http_code}\n" https://os.pravshi.com/health/db

# Authenticated — the intentional, occasional check.
curl -s -H "x-pravshi-health-token: $HEALTH_CHECK_TOKEN" https://os.pravshi.com/health/db
```

Expected: `404` for the unauthenticated call, and `{"status":"ok","wake_ms":<n>}` for the
authenticated one. A larger `wake_ms` on the first call is the cold start working as designed — note
the value in the PR, then **do not poll it again**.

---

### Task 13: Error monitoring

**Files:**
- Create: `sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation.ts`, `src/app/global-error.tsx`

**Interfaces:**
- Consumes: `SENTRY_DSN` from Task 4
- Produces: errors reaching Sentry from server and client

- [ ] **Step 1: Install and configure**

```bash
pnpm add @sentry/nextjs
pnpm dlx @sentry/wizard@latest -i nextjs
```

- [ ] **Step 2: Route the server and edge DSN through the env abstraction**

The global contract is that application code reads configuration through `src/env.ts`, never
`process.env`. Server-side Sentry can honour it, so it does. In `sentry.server.config.ts` (and
identically in `sentry.edge.config.ts`):

```ts
import * as Sentry from '@sentry/nextjs';
import { env } from '@/env';

Sentry.init({
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  // PRAVSHI OS holds employee personal data. Never let it ride along on an error.
  sendDefaultPii: false,
  beforeSend(event) {
    delete event.request?.cookies;
    if (event.request?.headers) {
      delete event.request.headers.authorization;
      delete event.request.headers.cookie;
    }
    return event;
  },
});
```

- [ ] **Step 2a: Document the one exception the framework forces**

The **client** bundle cannot use the abstraction, and this is a genuine constraint rather than a
convenience. Next.js inlines `process.env.NEXT_PUBLIC_*` by **textual substitution at build time**;
a value reached through a function is not statically analysable, so it is replaced with `undefined`
and Sentry silently never initialises in the browser.

Write `sentry.client.config.ts` with the exception stated in the file itself:

```ts
import * as Sentry from '@sentry/nextjs';

/**
 * THE ONE INTENTIONAL EXCEPTION to the "no process.env outside src/env.ts" rule.
 *
 * Next.js replaces the literal text `process.env.NEXT_PUBLIC_SENTRY_DSN` at build
 * time. Reading it through src/env.ts would defeat that substitution and leave the
 * browser SDK uninitialised — failing silently, which is the worst kind.
 *
 * Scope of the exception: this file only, this variable only, and only because it
 * is a NEXT_PUBLIC_ value that is already shipped to the browser. No secret may
 * ever be read this way. See ENVIRONMENT.md.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});
```

- [ ] **Step 2b: Make the rule mechanical, not aspirational**

Add to `eslint.config.mjs` so the contract is enforced rather than remembered:

```js
{
  files: ['src/**/*.{ts,tsx}'],
  ignores: ['src/env.ts'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "MemberExpression[object.name='process'][property.name='env']",
        message:
          'Read configuration through src/env.ts, not process.env. ' +
          'The only exception is sentry.client.config.ts — see ENVIRONMENT.md.',
      },
    ],
  },
}
```

The Sentry config files sit at the repository root, outside `src/`, so the rule does not fight
them — and the exception is now written in three places that must agree: the file, the lint
message, and `ENVIRONMENT.md`.

Add both variables to `.env.example`:

```bash
SENTRY_DSN=                  # server + edge, read via src/env.ts
NEXT_PUBLIC_SENTRY_DSN=      # browser only; inlined at build time (documented exception)
```

- [ ] **Step 3: Prove an error arrives**

Add a temporary route that throws, deploy to preview, hit it, and confirm the event appears in Sentry. Then delete the route.

- [ ] **Step 4: Commit**

```bash
git add sentry.*.config.ts instrumentation.ts src/app/global-error.tsx
git commit -m "feat(observability): add Sentry with PII scrubbing"
```

---

### Task 14: Cloudflare R2 buckets and object keys

**Files:**
- Create: `src/lib/storage/object-key.ts`, `tests/storage/object-key.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `objectKey(input: ObjectKeyInput): string` — used by the document module in Phase 5

> Phase 0 creates the buckets and the key format only. Uploads, presigning and the download route
> are Phase 5. Creating the buckets now means Phase 5 starts against private storage that already
> exists rather than discovering a public-bucket mistake late.

- [ ] **Step 1: Write the failing test**

Create `tests/storage/object-key.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { objectKey } from '@/lib/storage/object-key';

const base = {
  orgId: '33333333-3333-3333-3333-333333333333',
  documentId: '44444444-4444-4444-4444-444444444444',
  versionNo: 1,
};

describe('objectKey', () => {
  it('namespaces by org, document and version', () => {
    expect(objectKey(base)).toMatch(
      /^33333333-3333-3333-3333-333333333333\/44444444-4444-4444-4444-444444444444\/1\/[0-9a-f-]{36}$/,
    );
  });

  it('never embeds the file name — a filename is metadata, not an address', () => {
    const key = objectKey({ ...base, fileName: 'rahul-offer-letter.pdf' });
    expect(key).not.toContain('rahul');
    expect(key).not.toContain('.pdf');
  });

  it('produces a different key every call, so keys are not guessable', () => {
    expect(objectKey(base)).not.toBe(objectKey(base));
  });

  it('rejects a non-positive version', () => {
    expect(() => objectKey({ ...base, versionNo: 0 })).toThrow(/versionNo/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test tests/storage`
Expected: FAIL — `Cannot find module '@/lib/storage/object-key'`.

- [ ] **Step 3: Implement it**

Create `src/lib/storage/object-key.ts`:

```ts
import { randomUUID } from 'node:crypto';

export interface ObjectKeyInput {
  orgId: string;
  documentId: string;
  versionNo: number;
  /** Accepted for call-site convenience and deliberately ignored — see below. */
  fileName?: string;
}

/**
 * Builds a random, non-guessable R2 object key.
 *
 * The file name is never part of the key. Keys are addresses; a leaked address
 * must reveal nothing about the document, and must be useless without a
 * presigned signature. The display name lives in `document_versions.file_name`.
 */
export function objectKey({ orgId, documentId, versionNo }: ObjectKeyInput): string {
  if (!Number.isInteger(versionNo) || versionNo < 1) {
    throw new Error(`objectKey: versionNo must be a positive integer, got ${versionNo}`);
  }
  return `${orgId}/${documentId}/${versionNo}/${randomUUID()}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/storage`
Expected: PASS, 4 tests.

- [ ] **Step 5: Create the buckets**

```bash
pnpm dlx wrangler r2 bucket create pravshi-hr
pnpm dlx wrangler r2 bucket create pravshi-corporate
pnpm dlx wrangler r2 bucket create pravshi-projects
pnpm dlx wrangler r2 bucket list
```

**Do not** attach a public development URL or a custom domain to any of them. R2 buckets are private
by default; the mistake to avoid is enabling public access "just to test an upload" and forgetting.

- [ ] **Step 6: Verify public access is disabled by CONFIGURATION, not by guessing a URL**

A 404 from a guessed `r2.dev` address proves nothing — it is equally consistent with a public bucket
and a wrong URL. Read the actual settings instead:

```bash
for b in pravshi-hr pravshi-corporate pravshi-projects; do
  echo "── $b"
  pnpm dlx wrangler r2 bucket dev-url get "$b"    # managed public URL
  pnpm dlx wrangler r2 bucket domain list "$b"    # custom public domains
done
```

Expected for **every** bucket: the development URL reports **disabled**, and the custom-domain list
is **empty**. If your wrangler version names these subcommands differently, run
`pnpm dlx wrangler r2 bucket --help` and use the equivalents — the requirement is the evidence, not
the command. The dashboard equivalent is R2 → bucket → Settings → Public Access, which must read
"Not allowed" with no connected domains.

Paste the output into the PR. **A screenshot or transcript showing "disabled" and an empty domain
list for all three buckets is the evidence.**

- [ ] **Step 7: Create a scoped API token**

Cloudflare dashboard → R2 → Manage API Tokens → Create token:

- Permission: **Object Read & Write**
- Scope: **Apply to specific buckets only** → the three buckets above. **Never account-wide.**
- TTL: no expiry for V1; record the token's creation date for the quarterly access review.

Store as `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.

- [ ] **Step 8: Prove the token scope is actually enforced**

A token that *claims* to be scoped and a token that *is* scoped look identical in the dashboard.
Test it against a bucket deliberately left out of scope:

```bash
pnpm dlx wrangler r2 bucket create pravshi-scope-probe    # NOT in the token's scope

AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID \
AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY \
aws s3 ls "s3://pravshi-scope-probe" \
  --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
```

Expected: **`AccessDenied`.** If it lists successfully, the token is broader than intended — delete
it, create a properly scoped one, and repeat.

```bash
pnpm dlx wrangler r2 bucket delete pravshi-scope-probe
```

- [ ] **Step 9: Prove an unauthenticated request cannot retrieve a real object**

Put an object using credentials, then try to fetch it without any:

```bash
echo "phase-0 probe" > /tmp/probe.txt
pnpm dlx wrangler r2 object put pravshi-hr/_probe.txt --file=/tmp/probe.txt --remote

# No credentials, no signature — the path an attacker with a leaked key name would take.
curl -sS -o /dev/null -w "%{http_code}\n" \
  "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com/pravshi-hr/_probe.txt"

pnpm dlx wrangler r2 object delete pravshi-hr/_probe.txt --remote
```

Expected: **401 or 403.** A `200` means the object is world-readable — stop everything and fix the
bucket's public access before continuing. This is the assertion that actually matters, because it
tests retrieval of an object known to exist.

- [ ] **Step 10: Commit**

```bash
git add src/lib/storage tests/storage
git commit -m "feat(storage): add non-guessable R2 object keys and create private buckets"
```

---

### Task 15: Documentation and Phase 0 exit verification

**Files:**
- Create: `README.md`, `DEVELOPMENT.md`, `DEPLOYMENT.md`, `ENVIRONMENT.md`, `SECURITY.md`, `CONTRIBUTING.md`

**Interfaces:**
- Consumes: everything above
- Produces: a repository a second engineer can pick up

- [ ] **Step 1: Write the documentation set**

Each file links to the spec rather than restating it — one source of truth. Required sections:

| File | Must contain |
|---|---|
| `README.md` | What PRAVSHI OS is (2 sentences) · prerequisites (Node 22, pnpm 9, a Neon dev branch) · `pnpm install && pnpm dev` · links to the spec, database.md, security.md, build-plan.md · the sentence "Internal use only. No public signup exists." |
| `DEVELOPMENT.md` | Creating your own `dev/<name>` Neon branch · seeding it · `pnpm test` needs `DATABASE_URL_TEST` · **the rule: every query goes through `withAuthorizedDb()`** · why a query outside it returns zero rows · that Neon suspends when idle and the first request is slow **by design** |
| `DEPLOYMENT.md` | The `develop` → staging → `main` → production path · the manual approval gate · how migrations run · the DNS record and why it is grey-clouded · rollback (redeploy the previous Vercel build; restore by branching Neon from a timestamp) |
| `ENVIRONMENT.md` | Every variable in `.env.example`: what it is, which database role it uses, pooled vs direct, and **where its value is permitted to live**. Must carry the credential-separation table verbatim, and state plainly that `DATABASE_URL_MIGRATE` (`app_owner`) is never added to Vercel and why. Must also document the single `process.env` exception — `NEXT_PUBLIC_SENTRY_DSN` in `sentry.client.config.ts` — and why the framework forces it |
| `SECURITY.md` | The three database roles and which environment holds each credential · why `app_user` has no `BYPASSRLS` · why the deployed application never holds `app_owner` · the four CI guards (`rls-enabled`, `runtime-role`, `no-keepalive`, `single-db-path`) and what each proves · that admins are subject to branch protection and how break-glass is handled · how to report a security problem, to whom, and the expected response time |
| `CONTRIBUTING.md` | Branch naming (`feature/*`, `fix/*`, `chore/*`) · the PR checklist · CODEOWNERS gates on `drizzle/**` and `src/lib/{db,authz}/**` · **no cron or keep-alive without a founder decision** |

- [ ] **Step 2: Run the full Phase 0 verification**

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm e2e
curl -sI https://os.pravshi.com/health
curl -s  https://os.pravshi.com/health/db
```

- [ ] **Step 3: Confirm every exit criterion, with evidence**

| # | Criterion | Evidence required |
|---|---|---|
| 1 | Placeholder live at `os.pravshi.com` over HTTPS | `curl -I` shows 200 + valid cert |
| 2 | Deployed through the full CI pipeline | Green `ci` run linked in the PR |
| 3 | A migration applied to production | `__drizzle_migrations` contains `0000` |
| 4 | `app_user` cannot bypass RLS | `tests/guards/runtime-role.test.ts` green |
| 5 | Every table has RLS enabled and forced | `tests/guards/rls-enabled.test.ts` green |
| 6 | Context does not leak across pooled connections | `tests/db/authorized.test.ts` green |
| 7 | Nothing defeats autosuspend | `tests/guards/no-keepalive.test.ts` green; no `crons` in `vercel.json` |
| 8 | `/health` does not touch the database | `tests/health/no-db-in-health.test.ts` green |
| 9 | Errors reach Sentry | Screenshot of the test event |
| 10 | Secret scanning and push protection are active | `gh api repos/pravshi/pravshi-os --jq .security_and_analysis` reports `enabled` for secret scanning and push protection (Task 10 Step 7a); no probe was ever pushed to this repository |
| 11 | Branch protection active on `main` and `develop` | `gh api .../protection` output |
| 12 | Neon region and autosuspend confirmed | Console screenshot from Task 3 Step 1 |
| 13 | R2 buckets exist | `wrangler r2 bucket list` shows all three |
| 14 | Object keys leak no filename | `tests/storage/object-key.test.ts` green |
| 14a | **`/health/db` cannot be woken by an anonymous caller** | `tests/health/health-db-auth.test.ts` green; deployed unauthenticated `curl` returns 404 without a connection being opened |
| 14b | **`/health/db` leaks no infrastructure detail on failure** | Failure path returns `{"status":"error"}` with 503; the exception reaches Sentry, not the caller |
| 15 | **`DATABASE_URL_MIGRATE` is absent from every Vercel environment** | `vercel env ls` shows it in none, plus the production boot-refusal test green |
| 16 | **Admins are subject to branch protection** | `gh api repos/pravshi/pravshi-os/branches/{main,develop}/protection --jq .enforce_admins.enabled` returns `true` for both |
| 17 | **R2 public access disabled by configuration** | Per bucket: development URL reports disabled, custom-domain list empty |
| 18 | **R2 token scope is enforced** | An out-of-scope bucket returns `AccessDenied` with the production credentials |
| 19 | **Unauthenticated retrieval of a known object fails** | Unsigned `GET` of an uploaded probe returns 401/403, never 200 |
| 20 | **Nothing bypasses `withAuthorizedDb()`** | `tests/guards/single-db-path.test.ts` green; connection-release test green |

- [ ] **Step 4: Commit and open the Phase 0 PR**

```bash
git add -A
git commit -m "docs: add README, DEVELOPMENT, DEPLOYMENT, ENVIRONMENT, SECURITY, CONTRIBUTING"
gh pr create --base main --head develop --title "Phase 0 — Foundation" --body-file docs/phase-0-evidence.md
```

---

## Phase 0 is complete when

All twenty exit criteria have evidence, and **not before**. Phase 1 (Identity & Access Core) then starts against a repository where the security guarantees are already mechanically enforced rather than merely intended.

## What Phase 0 deliberately does not build

No authentication, no users, no permissions, no business tables, no dashboards. `src/lib/db/schema.ts` is empty on purpose. The point of this phase is that the first time you deploy is not also the first time you discover DNS, environment variables, database roles and migrations are broken.
