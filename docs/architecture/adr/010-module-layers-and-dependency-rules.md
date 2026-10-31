# ADR-010: Module layers and dependency rules

Status: Accepted | Date: 2026-10-30 | Deciders: Founder

## Context

ADR-009 makes enforced module boundaries the core of the architecture redesign. Today nothing
enforces them. A full import graph of `src/` at `3a8c155` (static `import … from`, re-exports,
relative paths and dynamic `import()` all resolved) shows:

- 13 of the 20 modules in `src/lib` form one strongly connected component: `db`, `auth`, `authz`,
  `audit`, `observability`, `invitations`, `jobs`, `crm`, `work`, `workflows`, `integrations`,
  `notifications`, `import`.
- The edges that pull the foundation into that cycle are few and specific:

  | Edge                           | Where                                                            |
  | ------------------------------ | ---------------------------------------------------------------- |
  | `db → auth` — **removed, Step 4** | `src/lib/db/auth-client.ts` imported `@/lib/auth/schema`; the definitions now live in `src/lib/db/auth-schema.ts` |
  | `observability → jobs` — **removed, Step 4** | `src/lib/observability/report.ts` imported `jobs/process-context`; the flag now lives in `src/lib/observability/process-context.ts` |
  | `audit → auth` — **removed, Step 4** | `src/lib/audit/log.ts` imported `auth/client-address`; the trusted-header logic now lives in `src/lib/observability/client-address.ts` (Better Auth's option stays in `src/lib/auth/better-auth-ip.ts`) |
  | `auth → invitations` — **removed, Step 4** | `src/lib/auth/invitations.ts` imported the token hash, accept schema and `InvitationError` from `invitations`; they now live in `src/lib/auth/invitation-contract.ts`, which `invitations` imports (a permitted downward edge) |
  | `jobs → domain modules` — **removed, Step 5** | the worker entry (`runner.ts`, `handlers.ts`, `workflow-jobs.ts`, `reminder-sweep.ts`) lived in `src/lib/jobs`; it now lives in `src/worker/`, and `src/lib/jobs` imports no L4 module |
  | `crm, work, integrations ↔ workflows` | event emission and workflow actions call each other directly |
  | `crm → integrations`           | `src/lib/crm/deals.ts` and `src/lib/crm/pipelines.ts` call `emitIntegrationEvent` (`integrations/fanout`) |
  | `work → integrations`          | `src/lib/work/tasks.ts` calls `emitIntegrationEvent` (`integrations/fanout`) |

  Step 4 removed the first four edges (the boundary guard's baseline went from 17 entries to 13)
  and Step 5 the `jobs` edge (13 to 8). Step 6 removes the last three rows:
  `crm → workflows`, `work → workflows`, `integrations → workflows`, `crm → integrations` and
  `work → integrations` all become emissions through the `events` port (rule 4).

- `platform`, `admin`, `search`, `analytics`, `ai`, `identity` and `storage` are imported by no
  other `src/lib` module; nothing in `src/lib` imports `src/app` or `src/components`.

## Decision

### Layers

Every module in `src/lib` (and `src/env.ts`) belongs to exactly one layer. A module may import
only from **its own layer or a lower one**, and the module graph must have **no cycle**, inside a
layer or across layers.

| Layer                       | Modules                                                                                              | Purpose                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| L0 Configuration            | `src/env.ts`, `src/lib/utils.ts`                                                                     | Validated environment; tiny shared helpers                                                  |
| L1 Infrastructure           | `db`, `observability`, `storage`                                                                     | Database clients and pools, error reporting and logging, storage key format                 |
| L2 Security and identity    | `audit`, `auth`, `authz`, `identity`                                                                 | Audit writer, authentication planes, authorization, identity helpers                        |
| L3 Shared services          | `jobs` (queue core), `notifications`, `events` (new, Step 6)                                         | Enqueue and job types, notification delivery, the internal domain-event port                |
| L4 Tenant domain modules    | `crm`, `work`, `workflows`, `integrations`, `import`, `ai`, `analytics`, `search`, `admin`, `invitations` | Tenant business capabilities and tenant administration                                 |
| Control plane               | `platform`                                                                                           | Platform administration (ADR-008); may import L0–L2 only                                    |
| Entry points                | `src/app` (pages, layouts, route handlers, server actions), the worker entry, `scripts/`             | Composition roots: wire modules together; may import any layer                             |

Order inside L2: `audit` is the lowest (it may not import `auth` or `authz`), then `auth`, then
`authz`. `identity` imports L1 only.

### Rules

1. **Downward only.** No import from a lower layer to a higher one, and no cycle between modules.
   Static, relative, re-exported and dynamic imports all count.
2. **The control plane is separate.** `platform` imports L0–L2 only. No tenant module imports
   `platform`.
3. **Domain modules depend on each other only along these edges:** `workflows → crm`,
   `workflows → work`, `workflows → integrations` (workflow actions call the owning service),
   `ai → crm`, `ai → work` (read context), `analytics → work`, `import → crm`. Any other L4 → L4
   edge needs an amendment to this record.
4. **Reactions go through events.** A domain module that must cause work in another (a deal
   change triggering workflows or outbound webhooks, a task change fanning out to integrations, an
   inbound webhook starting a workflow) emits through
   the L3 `events` port. Subscribers are registered by the entry points. The port keeps ADR-005's
   semantics: emission after commit, the depth bound of 5, actions with the trigger actor's
   authority, inline or queued execution.
5. **The queue is not the worker.** `jobs` (L3) holds the queue core: job types, enqueue, wake,
   retry policy. Job handlers and the worker's entry point import domain modules, so they live in
   the worker entry (`src/worker/`), not in `src/lib/jobs`. The queue core keeps what both sides
   need: the handler registry (`handler-registry.ts`), so a domain module that owns a job type
   registers its handler without importing the worker, and the cron and audit helpers that
   `queue.ts`, `workflows` and `src/app` already use. The worker imports the queue core downward;
   the queue never imports the worker (the boundary guard enforces both).
6. **Database access rules are unchanged.** `withAuthorizedDb()` remains the only business-data
   path; the `app_auth`, `app_worker` and `app_platform` pools remain restricted to their planes
   exactly as `tests/guards/single-db-path.test.ts` enforces today.
7. **Public surface (`src/lib` only).** A `src/lib` module is imported through its public files. A
   file in `src/lib` whose name starts with `_` or that sits under an `internal/` folder may be
   imported only by files of the same `src/lib` module. The rule does not apply to `src/app`: it
   is an entry point, not a module, and its `_`-prefixed files and folders (`_components/`,
   `_actions.ts`, `_permissions.ts`, `_types.ts` and others) are Next.js-private route-segment
   files whose sharing is governed by the frontend rules, not by this record.
8. **Tests and scripts are entry points.** They may import any layer; the rules apply to `src/`.

### Enforcement

- Step 2 adds `tests/guards/module-boundaries.test.ts`. It builds the import graph of `src/`
  (static, relative, re-exported and dynamic imports), maps each file to a module and layer, and
  fails CI on any edge that breaks rules 1–3, 5 or 7 (rule 7 checked for `src/lib` only), or on any
  cycle.
- The violations that exist on the day the guard lands are listed in the guard as a **baseline**.
  The baseline may only shrink: a new violation, or a baseline entry that no longer exists, fails
  the guard. Steps 4–6 remove the entries; after Step 6 the baseline is empty.
- A module that is not mapped to a layer fails the guard, so a new module cannot avoid the rules.

## Consequences

- The cycle is removed in three bounded steps (target-architecture.md §4) without moving the
  application or changing behaviour.
- When packages are extracted (ADR-009 Step 8, one package per pull request in dependency order),
  each layer already has an acyclic public surface, so extraction is a mechanical move. The layers
  and rules here carry over unchanged to `packages/`; the boundary guard then also checks package
  dependencies.
- Adding a domain module or an L4 → L4 edge becomes a reviewed decision instead of an accident.

## Reconsider when

- A new CRM product module is approved: it joins L4 with no edge to another product module, and
  shares code only through L0–L3.
- A rule blocks a legitimate design that an event or a lower-layer helper cannot express.
