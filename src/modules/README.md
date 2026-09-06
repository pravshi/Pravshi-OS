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
