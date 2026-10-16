---
paths:
  - 'src/**'
  - 'drizzle/**'
  - 'tests/guards/**'
  - 'tests/db/**'
  - 'tests/authz/**'
  - 'scripts/db/**'
---

# Multi-tenant security and authorization

Reference: [SECURITY.md](../../SECURITY.md) and
[docs/architecture/security.md](../../docs/architecture/security.md). The database enforces the
model; application checks come first but never replace it.

## Invariants — never weaken

- **One path to Postgres:** `withAuthorizedDb()` (`src/lib/db/authorized.ts`) sets identity
  transaction-locally (`SET LOCAL`) and is the only way application code queries the database
  (`tests/guards/single-db-path.test.ts`). Worker-plane and auth-plane code use their own
  dedicated pools and logins; do not route one plane's work through another's login.
- **Forced RLS everywhere:** every `public` table has RLS enabled and forced
  (`tests/guards/rls-enabled.test.ts`); every INSERT/UPDATE policy checks `org_id`. A new table
  ships with its policies and a two-organization test in the same migration PR.
- **Organization comes from the session**, never from a request body, header, URL or file. A
  record of another organization is `NOT_FOUND`, never `FORBIDDEN` (no existence leak).
- **Permission first:** route handlers use `withPermission()`; server actions await
  `requirePermission()` before any work (`tests/guards/require-permission-first.test.ts`).
  Frontend role checks are UX only.
- **Fail closed:** missing context, an unknown state or an error means refusal or zero rows.
- **Principals are the caller:** columns that decide whose authority work runs under
  (`jobs.enqueued_by`, `schedules.created_by`, …) are bound to `authz.person_id()` in the
  database (migration 0076). Do not add a code path that sets them from input.
- **SECURITY DEFINER functions** set `search_path = ''`, re-derive the actor and organization
  inside, take no actor/organization parameter they trust, and are granted to the narrowest login.
- **Audit:** mutations write their audit entry in the same transaction; audit tables are
  append-only. Never log or store tokens, passwords, invitation links or connection strings.
- **Platform administration** (provisioning, lifecycle) is a separate authority from an
  organization's `SUPER_ADMIN`; build it only from an approved design, with no access to
  customer business data and no RLS bypass.

## When you change security-relevant code

- Add forbidden-case tests: another organization, a missing permission, a forged identity or
  principal, an inactive person, and the failure path. Prove them with a mutation check.
- Ask the `security-auditor` agent for an independent review before the PR.
- Never treat "no known exploit" as proof of safety; state what was and was not tested.
