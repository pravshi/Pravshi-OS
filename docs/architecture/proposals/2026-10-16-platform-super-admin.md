# Platform Super Admin and organization provisioning — architecture proposal

**Status: SUPERSEDED — kept for the reasoning.** The V1 minimum in
[2026-10-27-platform-administration-v1-minimum.md](./2026-10-27-platform-administration-v1-minimum.md)
was approved in [ADR-008](../adr/008-v1-platform-and-import-decisions.md) and is built (migrations 0083–0087, the `/platform` console, the
`app_platform` login). Where this original proposal differs from the ADR, the ADR wins.
Date: 2026-10-16 · Baseline: `main` @ `2e2d725` · Decision context:
[ADR-007](../adr/007-v1-founder-product-decisions.md) (GOV-02, GOV-03, GOV-04)

This proposal refines the 2026-10-12 platform-administration design against the current code and
answers its open questions K1–K10. Implementation starts only after the founder approves it; each
package below then needs its own approval.

Markers: **[FACT]** verified in the repository at the baseline · **[PROPOSAL]** design choice, not
built · **[VERIFY]** to be confirmed by a test during implementation · **[FOUNDER]** needs a
founder answer.

---

## 1. Current state the design builds on

| # | Fact | Source |
|---|---|---|
| F1 | `organizations`: `id uuid default gen_random_uuid()`, `slug` (unique while live), `status ∈ {ACTIVE, SUSPENDED, ARCHIVED}`, `deleted_at`, `settings`. No lifecycle-actor columns; no lifecycle functions. | `drizzle/0002` |
| F2 | The only organization-creating path is `public.bootstrap_organization()`: a one-time, database-wide singleton, callable only when `session_user` is `app_admin` or `app_owner`. | `drizzle/0015` |
| F3 | `SUPER_ADMIN` is seeded **per organization** with organization-scoped permissions. No platform-level role, permission or table exists. | `drizzle/0008`, `drizzle/0015` |
| F4 | A session resolves to a person and **that person's** organization; the caller cannot choose an organization. One login ↔ one person ↔ one organization (GOV-02). | `drizzle/0013`, `drizzle/0073`, `src/lib/auth/session.ts` |
| F5 | `authz.is_active()` requires an ACTIVE engagement and an ACTIVE, non-deleted organization, so every tenant request of a non-ACTIVE organization is refused in the database. | `authz` helpers |
| F6 | `audit_logs.org_id` is NOT NULL and its actor must be a person of that organization, so a platform administrator cannot be recorded there. | `drizzle/0011` (`audit_logs_actor_same_org`) |
| F7 | Database logins: `app_owner` (schema owner, migrations), `app_user` (web runtime), `app_admin` (bootstrap CLI), `app_worker` (worker plane), `app_auth` (credential store). All NOBYPASSRLS. | `scripts/db/roles.sql`, `drizzle/0070`, `drizzle/0072`–`0073` |
| F8 | Worker claims, scheduler ticks, reminder claims, the retry sweep, the next-due query and inbound-webhook resolution consider **ACTIVE, non-deleted organizations only**. | `drizzle/0068` part 8 |
| F9 | The first protected-role grant in an organization passes only through the genesis branch of `may_manage_protected_roles()` (no `roles.manage` holder yet, and not on `app_user`). | `drizzle/0008`, `drizzle/0015` |
| F10 | Second factor: Better Auth TOTP; a session is `aal2` only when a factor was verified on it. Sensitive GLOBAL permissions require `aal2`. | `src/lib/auth/server.ts`, `src/lib/authz/require-permission.ts` |
| F11 | Administrator session and credential-reset actions run as definers on the `app_auth` plane and require a verified second factor. | `drizzle/0072`, `drizzle/0074` |

---

## 2. Principles

1. **A separate authority.** Platform administration is *about* organizations, not *inside* one.
   It gets its own identity, permissions, database login, functions and audit trail. The
   organization `SUPER_ADMIN` role is not widened.
2. **No access to customer business data.** The platform plane reads organization metadata and
   changes lifecycle state; it never reads CRM, work, workflow, integration or audit rows of a
   tenant.
3. **No bypass.** No `BYPASSRLS`, no "platform mode" flag that disables policies, no function that
   returns tenant business rows to the platform plane.
4. **The database decides.** Every rule the application checks is re-checked inside the function
   that makes the change.

---

## 3. Platform administrator identity

**[PROPOSAL]**

- A platform administrator is a Better Auth login mapped to a row in `platform.platform_admins`
  (`id`, `auth_user_id` unique, `status ACTIVE | REVOKED`, `created_at`, `created_by`,
  `revoked_at`, `revoked_by`).
- **Mutual exclusion:** a login is either a platform administrator or a tenant person, never both.
  Constraint triggers on both `people` and `platform.platform_admins` refuse the second side. A
  human who also uses the product has two logins.
- **Separate resolver:** `resolvePlatformContext(session)` returns a platform administrator or
  nothing. The tenant resolver (F4) already returns nothing for a login without a person, so a
  platform session can never act in a tenant, and a tenant session can never act on the platform.
- **Separate database login:** `app_platform` (NOBYPASSRLS, owns nothing, no table privileges on
  `public` or `auth`, EXECUTE on `platform.*` functions only), reached through
  `DATABASE_URL_PLATFORM`. A tenant-plane bug running SQL as `app_user` cannot call platform
  functions; a platform-plane bug cannot read tenant tables.
- **Context, then re-derivation:** the platform wrapper sets `app.platform_admin_id`
  transaction-locally; every platform function re-derives the actor through
  `platform.current_admin()` (ACTIVE, not revoked) and never accepts the actor as a parameter.
  The target organization is always an explicit, audited input; it never becomes the actor's
  tenant context.

### How it differs from organization roles

| | Organization roles (existing) | Platform permissions (proposed) |
|---|---|---|
| Catalogue | `public.permissions` / `roles` | `platform.platform_permissions` — a separate table; no foreign key path from `public.role_permissions` |
| Holder | a person of one organization | a platform administrator (no person, no organization) |
| Scope | `GLOBAL`, `DEPARTMENT`, `TEAM`, `PROJECT`, `SELF` within one organization | held or not; the target organization is named per action |
| Effect | opens RLS-filtered business rows | opens platform functions that return metadata or change lifecycle state |
| Default | per role | least privilege: a new administrator holds `platform.organizations.view` and `platform.audit.view` only |

### Permissions

| Permission | Allows | Extra checks |
|---|---|---|
| `platform.organizations.view` | list and view organization metadata (name, slug, status, lifecycle fields, member count) | — |
| `platform.organizations.create` | provision an organization and its first administrator | idempotency key |
| `platform.organizations.assign_initial_admin` | re-issue the first administrator's invitation while the organization has no live administrator | step-up |
| `platform.organizations.suspend` / `.reactivate` | ACTIVE ↔ SUSPENDED | reason required |
| `platform.organizations.archive` / `.restore` | → ARCHIVED, ARCHIVED → SUSPENDED | step-up, typed slug confirmation, reason |
| `platform.audit.view` | read platform audit events | — |
| `platform.admins.manage` | invite, revoke and change platform administrators | step-up; K1 rules |

Every platform request requires `aal2` (§5).

---

## 4. Bootstrap and recovery of platform access

**[PROPOSAL]**

- **Bootstrap (K8):** for a new deployment, the existing TTY-only, one-time bootstrap CLI creates
  the **first platform administrator** (a login, a `platform_admins` row with every platform
  permission, and a one-time setup link to enrol a password and TOTP). It runs as `app_admin`,
  records `operator` as the actor in the platform audit, and refuses to run twice. The existing
  production organization created by the old bootstrap is left unchanged; its `SUPER_ADMIN` stays
  organization-scoped.
- **Steady state:** further platform administrators are invited by a holder of
  `platform.admins.manage` (K1).
- **Recovery (break glass):** if every holder of `platform.admins.manage` is unavailable or has
  lost their factor, an operator holding the `app_admin` credential runs a recovery command of the
  same CLI. It revokes the affected administrator's factors and sessions and issues a one-time
  setup link, writes an `operator` audit entry with a mandatory reason, and is documented in a
  runbook that requires the founder's written approval for each use. There is no recovery path
  through the web application.
- The last holder of `platform.admins.manage` cannot be revoked or have that permission removed.

---

## 5. Authentication controls

**[PROPOSAL]**

- `aal2` on **every** platform request; TOTP enrolment at first sign-in; no `aal1` grace.
- Platform session absolute lifetime 12 hours and idle timeout 30 minutes, enforced by the
  platform resolver from the session's timestamps (tenant sessions keep their current lifetime).
- **Step-up** (a second factor verified within the last 10 minutes) for archive, restore,
  first-administrator re-issue and platform-administrator management (K3).
- Platform sign-in failures feed the existing lockout and login events, marked as platform.
- IP allow-listing: off at first (K7).
- Platform administrators can revoke all of their own sessions; revoking an administrator revokes
  their sessions in the same transaction.

---

## 6. Organization provisioning

**[PROPOSAL]** `platform.provision_organization(idempotency_key, name, slug, timezone,
admin_full_name, admin_email)` — SECURITY DEFINER, `search_path = ''`, executable by
`app_platform` only, requires `platform.organizations.create`. **One transaction:**

1. Record the request by idempotency key. The same key with the same parameters returns the stored
   result and changes nothing; the same key with different parameters is refused (409).
2. Insert the organization; the id is generated inside the function, never accepted from a
   client. The existing trigger seeds the system roles (F3).
3. Create the default department, as the bootstrap does.
4. Create the first administrator as a person **without a login**, with an ACTIVE engagement and
   the `SUPER_ADMIN` grant through the genesis branch (F9). The genesis rule is changed to name
   `app_platform` explicitly rather than relying on "not `app_user`" [VERIFY].
5. Create an invitation for that person through the existing invitation machinery. Only the token
   hash is stored; the raw link is returned once to the platform administrator and never logged.
6. Write one platform audit entry `platform.organization.provisioned`.

Every insert uses the organization id from step 2; there is no organization parameter, and the
composite foreign keys on engagements, roles and invitations re-check it.

- **GOV-02:** an administrator email that already has a login is refused with a platform-only
  error. Tenants never see it.
- **Failure:** any error rolls back everything — no organization, person or invitation. An
  `ERROR`/`DENIED` platform audit entry is written in a separate transaction.
- **Expired first-administrator invitation:** re-issue revokes the old token and issues a new one,
  only while the organization has no live administrator.
- **Defaults created:** system roles, one department, the first administrator and their
  invitation; nothing else. The AI limits fallback for an organization without a limits row is
  [VERIFY].
- **GOV-04:** provisioning records no plan or tier. Whether a trial or paid flag should exist as
  plain metadata, and whether trials should expire, is [FOUNDER] (Q2, Q3).

---

## 7. Organization lifecycle

**[PROPOSAL]** States already exist (F1). No persisted "provisioning" state is needed: provisioning
is one transaction.

```
            provision (one transaction)              suspend (reason)
   none ─────────────────────────────────▶ ACTIVE ─────────────────────▶ SUSPENDED
                                             ▲  ◀─────────────────────     │
                                             │      reactivate (reason)    │ archive (reason, step-up)
                    restore (step-up,        │                             ▼
                    within the window) ──────┴──────────────────────── ARCHIVED
                                           ACTIVE ── archive ─────────▶ ARCHIVED
```

Restore returns an organization to SUSPENDED; reactivation is a separate, deliberate step. Each
transition takes a row lock, checks the current state, requires a reason, records
`suspended_at/by/reason` or `archived_at/by/reason` (new nullable columns), and writes one platform
audit entry in the same transaction. Repeating a transition to the state already held is a no-op
without a second audit entry; an invalid transition is refused (409) with a `DENIED` entry.

### Effects of organization state

| Concern | SUSPENDED | ARCHIVED |
|---|---|---|
| Tenant API and pages | Refused in the database (F5). | Same. |
| Sign-in | [VERIFY] whether session creation is refused or the session is created and every request refused; either way nothing is reachable. The implementation adds a test and, if needed, refuses session creation. | Same. |
| Existing sessions | Kept but useless; reactivation restores access at once. | **Revoked** for every member, through an `app_auth` definer called by the lifecycle function. |
| Queued jobs, schedules, reminders | Not claimed (F8); they stay pending and resume on reactivation. | Pending work is cancelled with reason `ORG_ARCHIVED` and kept for audit. |
| Outbound webhooks and email | Not sent (they are jobs). | Not sent; subscriptions deactivated. |
| Inbound webhooks | Rejected with the uniform rejection (F8). | Same. |
| Integration credentials | Kept, unusable. | Kept, encrypted. |
| Data | Untouched. | Untouched; unreachable through the application; restorable within the window. |
| Deletion | Not available. | Not available in V1 (K4). |

A job already running when suspension commits finishes; the worker learns of the change on its
next claim. This is accepted and documented.

---

## 8. Platform audit

**[PROPOSAL]** A separate table, `platform.audit_events`, because tenant audit rows require a person
of the organization (F6).

- Columns: id, time (`clock_timestamp`), actor type (`platform_admin`, `system`, `operator`), actor
  id and email snapshot (derived, never a parameter), action (`platform.<entity>.<verb>`), result
  (`SUCCESS`, `DENIED`, `ERROR`), reason code, target organization, target type and id, request id,
  idempotency key, allow-listed `before`/`after`/`metadata`, client address, user agent.
- **Atomicity:** `SUCCESS` entries are written by the platform function in the same transaction
  as the change. `DENIED`/`ERROR` entries are written by the wrapper in a separate transaction,
  because the failing transaction rolls back.
- **Exactly once:** a unique key on (action, idempotency key) for `SUCCESS` rows; a retry returns
  the stored result without a new entry.
- **Integrity:** no INSERT, UPDATE, DELETE or TRUNCATE privilege for any runtime login; writes only
  through definers; append-only triggers; TRUNCATE revoked from the schema owner on both audit
  tables, with a statement-level trigger as a backstop.
- **Never stored:** passwords, tokens (including invitation tokens), keys, request bodies.
- **Visibility (K6):** platform administrators with `platform.audit.view` see all platform events;
  an organization's administrators see platform events about their own organization, read-only.
- **Retention (K5):** never removed by automatic retention; partitioned monthly like `audit_logs`.

---

## 9. Separation from customer data

- `app_platform` holds no privilege on any `public` or `auth` table. Platform functions return
  organization metadata only.
- No impersonation and no support access in V1 (K2). If a later release needs support access, the
  only acceptable shape is an organization-administrator-approved, time-boxed, read-only temporary
  person in that organization, visible to its administrators and audited in both trails — never an
  RLS bypass.
- A platform session on any tenant route resolves to no identity; a tenant session on any platform
  route is refused (404) before any platform function runs.

---

## 10. Database, migration and deployment implications

- **New objects (additive):** schema `platform` (administrators, permissions, grants, provisioning
  requests, audit events), the `app_platform` login, organization lifecycle columns (nullable),
  lifecycle and provisioning functions, an immutability trigger on `organizations.id` (and slug
  changes only through an audited platform function), audit TRUNCATE revocation.
- **Changed:** the genesis branch of the protected-role rule names `app_platform` explicitly; the
  bootstrap CLI gains the first-platform-administrator mode.
- **Unchanged:** every tenant RLS policy, `authz.*` helper, and the tenant session model.
- **Roles file:** `app_platform` is created by `scripts/db/roles.sql`, with the same membership rules
  and checks as `app_worker` and `app_auth`. Running it on Neon is an operator step under the
  production-migration runbook and depends on DB-14.
- **Configuration:** `DATABASE_URL_PLATFORM`, validated in `src/env.ts`, present only where the
  platform console runs.
- **Rollback:** each migration is additive and forward-fixable; a prepared rollback script is
  required only for the genesis-rule change.

---

## 11. Failure handling and recovery

| Failure | Behaviour |
|---|---|
| Provisioning fails at any step | Whole transaction rolls back; one `ERROR` audit entry; safe to retry with the same key. |
| Network failure after commit, client retries | Same key returns the stored result; no second organization or audit entry. |
| Invitation never accepted | Re-issue (step-up) while no live administrator exists. |
| Lifecycle call raced by another administrator | Row lock serialises; the loser sees the new state and gets 409 or a no-op. |
| Platform database login misconfigured | The platform console refuses to start or answers 503; the tenant application is unaffected. |
| All platform administrators locked out | Break-glass recovery (§4). |
| Suspended organization never reactivated | Its work stays pending (not lost); archive cancels it with a reason. |

---

## 12. Threat model

| # | Threat | Control | Test |
|---|---|---|---|
| T1 | A tenant user reaches another organization's data | Unchanged: organization derived from the person; forced RLS everywhere | Existing RLS matrices + a two-organization HTTP test |
| T2 | Organization-id substitution on platform calls | The target organization is data, authorised by a platform permission and audited; never a tenant context | Platform call on a missing organization → 404, no `SUCCESS` entry |
| T3 | An organization `SUPER_ADMIN` escalates to platform authority | Separate permission catalogue; mutual exclusion of logins; `app_user` has no EXECUTE on platform functions | Catalogue test; tenant session on `/api/platform/**` → 404; `app_user` EXECUTE check |
| T4 | Stolen platform administrator credentials | `aal2` always; short sessions; step-up; least privilege; every action audited; no tenant data reachable | `aal1`, expired and idle sessions refused; step-up enforced |
| T5 | Unauthorised provisioning or lifecycle change | Per-action permission; state machine in the function; idempotency; reason required | Per-transition allowed / denied / invalid tests |
| T6 | Tenant-context forgery (a client-supplied organization id, header or claim) | The tenant context comes only from the session; platform functions never set `app.org_id` or `app.person_id` | Requests carrying a foreign organization id change nothing |
| T7 | Audit omitted, duplicated, forged or erased | Same-transaction `SUCCESS` entries; unique idempotency key; definer-only writes; append-only; no TRUNCATE | Exactly-one-entry tests; runtime logins cannot write or truncate |
| T8 | Secrets leak into logs or audit | Invitation links returned once and never logged; allow-listed audit payloads | Guard test: no token in logs or audit |
| T9 | A suspended or archived organization's background work runs | Status-aware claims (F8); archive cancels pending work | Suspended organization's due job is not claimed |
| T10 | Break-glass recovery abused | CLI only, owner credential, mandatory reason, founder approval, `operator` audit entry | Recovery writes exactly one `operator` entry; refused without a reason |

---

## 13. Acceptance tests (proposed; none exists yet)

All on disposable databases, as the current suite does.

1. A tenant session of any role, including an organization `SUPER_ADMIN`, gets 404 on every
   `/api/platform/**` route, and no platform function runs.
2. Catalogue: `app_user`, `app_worker`, `app_auth` hold no EXECUTE on `platform.*`; `app_platform`
   holds no privilege on any `public` or `auth` table and no `BYPASSRLS`.
3. A login cannot be both a platform administrator and a person (either insert fails).
4. `aal1`, expired (> 12 h) and idle (> 30 min) platform sessions are refused; high-risk actions
   without step-up are refused.
5. Provisioning twice with the same key and parameters yields one organization, one person, one
   invitation and one `SUCCESS` entry; different parameters → 409, nothing written; a slug
   collision or an injected failure leaves nothing behind and one `ERROR` entry.
6. A new organization has exactly the seeded system roles, one department and the first
   administrator with an ACTIVE engagement and `SUPER_ADMIN`; its invitation cannot be accepted
   into another organization; an existing login is refused (GOV-02).
7. Every valid lifecycle transition succeeds once with one entry carrying actor, reason, target and
   request id; invalid transitions → 409 + `DENIED`.
8. After suspension: members' next request is refused; due jobs, schedules and reminders are not
   claimed; inbound webhooks are rejected; after reactivation they resume.
9. After archive: every member session is revoked; pending work is cancelled with a reason; restore
   returns the organization to SUSPENDED.
10. No platform endpoint returns a business row; a platform session on tenant routes resolves to
    no identity.
11. Platform audit entries contain no token or secret; runtime logins cannot insert, update,
    delete or truncate either audit table.
12. The full existing suite passes; organization `SUPER_ADMIN` and ordinary users behave exactly as
    before.

---

## 14. Answers to the open design questions

| # | Question | Recommendation | Security reasoning |
|---|---|---|---|
| K1 | May platform administrators manage other platform administrators? | Yes, only holders of `platform.admins.manage`, with step-up; never their own record; never the last holder. | Avoids a database-only administration process while containing the blast radius of one compromised account. |
| K2 | Is support access to customer business data needed? | **No**, not in V1. | It is the largest risk and has no stated requirement; §9 records the only acceptable future shape. |
| K3 | Re-authentication and dual approval for sensitive actions? | Step-up for archive, restore, administrator management and first-administrator re-issue. Dual approval for archive and administrator management once two or more platform administrators exist. | A stolen session alone cannot perform an irreversible-looking action; dual approval waits until a second person exists so the system cannot lock itself. |
| K4 | Archive and data-retention semantics? | Archive is reversible within a window (recommend 90 days); **no deletion in V1** until a written retention and recovery policy is approved. | Irreversible deletion without a policy is unsafe; data stays restorable. |
| K5 | Platform audit retention? | At least 7 years for lifecycle and administrator-management events; never removed by automatic retention. | Accountability for low-volume, high-impact actions. |
| K6 | Customer visibility of platform events; separate deployment? | Organization administrators see platform events about their own organization. Platform console in the same application at first, on its own database login; a separate deployment later if required. | Transparency about suspension and provisioning; the separate login already isolates privilege. |
| K7 | IP allow-list for the platform console? | Off at first; enable once a stable office or VPN egress exists. | Avoids lock-out; `aal2`, short sessions and step-up carry the load. |
| K8 | Bootstrap the first platform administrator instead of an organization? | Yes for new deployments; the existing production organization is left unchanged. | Retires the singleton organization bootstrap without touching live data. |
| K9 | Multi-organization membership in the first provisioning release? | **No** — decided by GOV-02: one login, one organization in V1; provisioning refuses an existing login. | Keeps the session model unchanged under provisioning. |
| K10 | Where do status-aware worker claims belong? | **Already done** in `drizzle/0068` (F8); the lifecycle package adds archive-time cancellation only. | Avoids a second rewrite of the claim functions. |

### Questions for the founder

- **Q1.** Who are the first platform administrators, and should dual approval start as soon as a
  second one exists (K3)?
- **Q2.** Should an organization carry a trial/paid label as plain metadata (no effect on
  capability), or nothing at all in V1 (GOV-04)?
- **Q3.** Should free trials end automatically (for example, suspension after a period), or are all
  lifecycle changes manual in V1?
- **Q4.** Is 90 days the right archive-restore window (K4), and is 7 years the right platform audit
  retention (K5)?
- **Q5.** Should the platform console live in the same application (recommended) or a separate
  deployment from the start (K6)?

---

## 15. Packages and order

| Package | Content | Depends on |
|---|---|---|
| P1 | Platform identity, permissions, resolver and wrapper, `app_platform`, platform audit table, bootstrap-first-administrator CLI and break-glass recovery, read-only organization list, audit TRUNCATE revocation, organization-id immutability | Founder approval of this proposal; DB-14 for any non-local database |
| P2 | Provisioning with the first administrator and invitation, idempotency | P1 |
| P3 | Lifecycle transitions, archive-time session revocation and work cancellation, customer-visible platform events | P2 |
| — | Every production migration | Separate HG-2 approval through the production-migration runbook |
