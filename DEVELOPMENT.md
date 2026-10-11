# Development

## Prerequisites

- **Node 22 LTS.** `.nvmrc` pins `22`; `package.json` requires `>=22.12`.
- **pnpm 12.3.4**, pinned via `packageManager`. Run `corepack enable` and let it resolve the
  pinned version rather than installing pnpm globally.
- Access to the **development** Neon project — never the production project.

```bash
git clone https://github.com/pravshi/Pravshi-OS.git
cd Pravshi-OS
corepack enable
pnpm install
cp .env.example .env
```

`pnpm install` may prompt about build scripts. `pnpm-workspace.yaml` already approves the
ones this project needs (`esbuild`, `@sentry/cli`, `unrs-resolver`); if it stops with
`ERR_PNPM_IGNORED_BUILDS`, a new dependency has introduced one and it needs a deliberate
decision, not a blanket approval.

## Get your own database branch

**Never point your local environment at production.** Development runs in its own Neon
project, separate from the production project, so no development credential can reach
production data:

```
production project       production only. Nothing automated touches it, and no
                         developer machine holds its credentials.
development project      everything else
└── default branch       provisioned: roles.sql applied, all migrations, a dev SUPER_ADMIN
    └── dev/<name>       yours, branched from the default branch
```

CI creates no Neon branches; it runs against its own throwaway Postgres container.

Create `dev/<yourname>` from the development project's default branch in the Neon console,
then set `DATABASE_URL`, `DATABASE_URL_TEST` and `DATABASE_URL_MIGRATE` to point at it.
See [ENVIRONMENT.md](ENVIRONMENT.md) for which role and endpoint each one takes.

Your branch inherits `app_owner`, `app_user` and `app_admin` from its parent, with their
passwords. If you need branch-local credentials, reset the role's password on **your**
branch — Neon scopes that to the branch and leaves the parent untouched.

Provisioning a brand-new development project from empty follows the same order as CI:
`scripts/db/roles.sql` as the project owner ([scripts/db/README.md](scripts/db/README.md)),
role passwords, every migration, then the one-time bootstrap
([scripts/bootstrap/README.md](scripts/bootstrap/README.md)).

### Neon suspends when idle, and that is deliberate

Scale-to-zero is a locked decision. Compute suspends after inactivity, so **the first query
after a pause is slow**. That is the design working, not a bug. `connectWithWake()` retries
the _connection_ — never the query — because a connection lost mid-commit is ambiguous and
replaying it can double-write.

Do not add a cron, heartbeat, warm-up or polled DB-backed endpoint to avoid the cold start.
`tests/guards/no-keepalive.test.ts` fails the build if you do.

## The one rule about data access

**Every query goes through `withAuthorizedDb()`.** There is no second path.

```ts
import { withAuthorizedDb } from '@/lib/db/authorized';

const rows = await withAuthorizedDb({ personId, orgId, aal: 'aal1' }, (tx) =>
  tx.execute(sql`select ...`),
);
```

The helper acquires a connection through `connectWithWake()`, opens a transaction, sets the
identity with transaction-scoped `set_config(..., true)`, runs your callback, and always
releases the connection.

**A query outside the helper returns zero rows, not an error.** Without the transaction
context, `current_setting('app.person_id', true)` is NULL, every RLS policy evaluates false,
and the result is empty. That is fail-closed and it is the correct failure: no identity
means no rows, never all rows.

Session-scoped `SET` is banned. Pooled connections are reused, so a session setting would
carry one person's identity into the next person's query.

`tests/guards/single-db-path.test.ts` enforces this mechanically: nothing outside
`src/lib/db/` may import the pool, and nothing may call `pool.connect()` directly.

## Testing

```bash
pnpm test          # full suite (vitest)
pnpm test <path>   # one file
pnpm test:watch
pnpm e2e           # Playwright, needs a production build first
```

Several suites need a real database and read these variables:

| Test                                | Variable               | Role        |
| ----------------------------------- | ---------------------- | ----------- |
| `tests/db/authorized.test.ts`       | `DATABASE_URL_MIGRATE` | `app_owner` |
| `tests/db/authorized.test.ts`       | `DATABASE_URL`         | `app_user`  |
| `tests/guards/rls-enabled.test.ts`  | `DATABASE_URL_MIGRATE` | `app_owner` |
| `tests/guards/runtime-role.test.ts` | `DATABASE_URL_TEST`    | `app_user`  |

Point them at **your** branch. `tests/db/authorized.test.ts` creates and drops a probe table,
so running it against a shared branch will disturb other people.

`src/env.ts` validates the environment at import time, so a missing `APP_URL` or
`DATABASE_URL` fails the suite at collection rather than inside a test.

## Migrations

Migrations run as `app_owner` against the **direct** (non-pooled) endpoint:

```bash
DATABASE_URL_MIGRATE=<your branch, app_owner, direct> pnpm exec drizzle-kit migrate
```

The ownership boundary matters:

- **`scripts/db/roles.sql`** owns roles, schemas and bootstrap privileges. It runs once per
  branch, as the Neon branch owner.
- **Drizzle migrations** own application objects: tables, indexes, constraints.

`app_owner` holds `CREATE` on the database (Drizzle's migrator issues
`CREATE SCHEMA IF NOT EXISTS` before its bookkeeping, and Postgres checks that privilege
before the `IF NOT EXISTS` short-circuit). It holds no `CREATEDB`, `CREATEROLE`, `SUPERUSER`
or `BYPASSRLS`, and `roles.sql` asserts that.

## Full local gate

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build && pnpm guards
```

This is what CI runs. Run it before opening a pull request.
