# Modules

One folder per business module (`sales/`, `people/`, `hiring/`, `delivery/`, `records/`).
Each contains exactly:

    actions.ts       'use server' — authorize → parse → call service → audit → revalidate
    service.ts       business logic and data access; the only place SQL lives
    schema.ts        Zod schemas, shared with the client
    queries.ts       read helpers for Server Components
    permissions.ts   this module's permission constants

A module may depend on the core (`src/lib/**`). A module must NOT import from
another module. Adding a module must never require editing the authorization
engine — only inserting rows into the `permissions` table.

Authorization is `src/lib/authz`, and it comes first:

- A Server Action's first statement is
  `requirePermission(new Headers(await headers()), { permission })`, and it
  returns `actionError(error)` on failure.
- A Route Handler is `export const GET = withPermission({ permission }, handler)`.
- A service takes the `Authorization` that returns — never a bare `AuthContext` —
  and does its work through `withAuthorizedDb(authorization.ctx)`.

`tests/guards/require-permission-first.test.ts` fails the build for a Route Handler
or Server Action that skips the first two.

First module arrives in Phase 1.
