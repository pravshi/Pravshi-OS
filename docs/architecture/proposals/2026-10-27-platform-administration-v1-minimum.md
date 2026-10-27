# Platform administration for V1 — the minimum complete workflow

**Status: APPROVED DIRECTION** — [ADR-008](../adr/008-v1-platform-and-import-decisions.md), 2026-10-27.
Local implementation may proceed; every hosted step still needs its own approval. Remaining
founder inputs are listed in ADR-008 "Still open".

_Original status (superseded):_ PROPOSAL — pending founder confirmation. Not implemented. Implementation starts only
after the founder confirms this document; AGENTS.md §1 and ADR-007 (GOV-03) require an approved
design before any of it is built.

Date: 2026-10-27 · Refines [2026-10-16-platform-super-admin.md](./2026-10-16-platform-super-admin.md)
(the full design) and [2026-10-26-platform-provisioning-readiness.md](./2026-10-26-platform-provisioning-readiness.md)
(the decision register) · Written against local, unmerged branches (migrations 0077–0082).

## 1. Founder direction (2026-10-27) and what it settles

| Item | Direction | State |
|---|---|---|
| GOV-03 scope | Platform provisioning **stays in V1** | direction given; this document defines its minimum |
| K8 | The new primary's first bootstrap creates the **platform administrator** (Option A) | proposed; **confirm** |
| N1 | The platform bootstrap is **separate** from organization creation | proposed; **confirm** |
| Outside V1 | the broad architecture redesign, full CRM products (Real Estate, Education), website builder, custom app builder | direction given |

The minimum V1 workflow is: **bootstrap a platform administrator → create an organization →
choose its type where one is available → appoint the organization's first administrator.**

## 2. Scope

**In V1 (this proposal):**

1. Platform identity: administrators, permissions, the platform resolver, the `app_platform`
   database login, the platform audit trail.
2. Platform-administrator-first bootstrap (operator CLI) and break-glass recovery.
3. Organization provisioning with type selection and the first organization administrator,
   idempotent.
4. Re-issuing the first administrator's invitation while the organization has none.
5. Read-only organization list and platform audit view.
6. Platform-administrator management (invite, revoke) — K1.

**Needs a decision — L1 (lifecycle).** ADR-007's definition of done for GOV-03 also lists
suspend, reactivate, archive and restore. The minimum workflow above does not need them.
Recommendation: **suspend and reactivate in V1** (reversible, small, and the only way to stop a
misbehaving tenant without touching data; status-aware claims already exist, `drizzle/0068`);
**archive and restore in V1.1**, with ADR-007's definition of done amended accordingly. The
alternative is all four in V1 (adds session revocation and work cancellation at archive).

**Not in V1:** multi-organization membership (GOV-02), support access or impersonation (K2),
deletion (K4), plans, billing or entitlements (GOV-04), IP allow-listing (K7), dual approval
(recommended for V1.1, once a second administrator exists), organization types other than
`generic_crm` (Real Estate and Education stay DISABLED, `drizzle/0080`).

## 3. Platform-administrator-first bootstrap (K8 = A, N1 = separate)

### 3.1 What it does

`scripts/bootstrap/run.mjs --platform-admin` (operator, TTY only, `app_admin` credential, never
on a deployment host) calls `platform.bootstrap_first_admin(p_email, p_full_name,
p_setup_token_hash)`:

- `SECURITY DEFINER`, `search_path = ''`, `EXECUTE` granted to `app_admin` only; the function also
  checks `session_user in ('app_admin', 'app_owner')`, as `bootstrap_organization()` does
  (`drizzle/0015`).
- **One transaction:** write the gate row in `platform.bootstrap_state` **first**; create the
  `platform.platform_admins` row (status `PENDING_ENROLMENT`) holding every V1 platform
  permission; store the SHA-256 of a one-time setup token (expiry 60 minutes); write one
  `platform.audit_events` entry, actor `operator`, action `platform.bootstrap.first_admin`.
- No Better Auth login is created by the CLI. The administrator creates it through the setup
  page with the token, and must enrol a password **and** TOTP before the account becomes ACTIVE.
  Until then no platform action is possible (every platform request requires `aal2`).

### 3.2 Separation from organization creation (N1)

- `platform.bootstrap_state` is its own singleton. It does not read or consume
  `public.bootstrap_state`, so a database whose organization bootstrap already ran (the existing
  `Pravshi-OS-New` database) can still receive a platform administrator later.
- One-way coupling: once the platform bootstrap has run in a database,
  `public.bootstrap_organization()` refuses (`42501`, "organizations are provisioned by the
  platform"). Every organization in that database is then created through provisioning, with its
  audit entry. The reverse does not hold: an organization bootstrap never blocks the platform
  bootstrap.

### 3.3 Security controls

| Control | Rule |
|---|---|
| Who may run it | `app_admin` login only (CLI on the operator's machine); refused for `app_user`, `app_worker`, `app_auth`, `app_platform` |
| Once per database | the gate row is the first write; a concurrent attempt waits on it and then fails |
| Secrets | only the token digest reaches the database; the plaintext is printed once to the operator's TTY, never logged |
| Login separation | a login is a platform administrator **or** a tenant person, never both (constraint triggers on both tables); the setup email must not already have a login |
| Factor | TOTP enrolment is part of setup; no `aal1` grace |
| Sessions | 12 h absolute, 30 min idle, enforced by the platform resolver |
| Step-up | a factor verified in the last 10 minutes for administrator management and first-administrator re-issue (K3) |

### 3.4 Idempotency and recovery

| Situation | Behaviour |
|---|---|
| CLI fails before commit | everything rolls back, the gate included; safe to re-run |
| CLI succeeded, operator re-runs | refused: the gate exists |
| Setup token expired before enrolment | `run.mjs --reissue-platform-setup` (operator): only while the administrator is `PENDING_ENROLMENT`; revokes the old digest, issues a new one, one `operator` audit entry |
| The only administrator lost their factor | break-glass `run.mjs --recover-platform-admin` (operator): mandatory reason, the founder's written approval recorded in the run record, revokes the administrator's factors and sessions, issues a setup token, one `operator` audit entry. No recovery through the web application |
| A compromised administrator | revoked by another holder of `platform.admins.manage` (step-up); sessions revoked in the same transaction. The last holder cannot be revoked |

## 4. Organization provisioning (with type and first administrator)

`platform.provision_organization(p_idempotency_key, p_name, p_slug, p_timezone, p_type_key,
p_admin_full_name, p_admin_email)` — `SECURITY DEFINER`, `search_path = ''`, `EXECUTE` for
`app_platform` only, requires `platform.organizations.create`; the actor is re-derived inside
(`platform.current_admin()`), never a parameter.

**One transaction:**

1. Idempotency: the key and a hash of the parameters are recorded. Same key + same parameters →
   the stored result, nothing written, no second audit entry. Same key + different parameters →
   refused (409). The raw invitation link is returned **only** by the first call; a retry gets
   the organization id and a "re-issue the invitation" pointer.
2. Organization: id generated inside; `type_key` must be an ACTIVE type (today only
   `generic_crm`); `template_version` = that type's latest published version. The 0080 trigger
   re-checks both and seeds the template's pipelines; system roles are seeded by the existing
   trigger.
3. Default department, as the bootstrap creates it.
4. First administrator: a person without a login, an ACTIVE engagement, `SUPER_ADMIN` through the
   protected-role genesis branch.
5. Invitation for that person through the existing machinery (`drizzle/0018`): only the token
   hash is stored.
6. One `platform.audit_events` entry `platform.organization.provisioned` (actor, target
   organization, type, request id, idempotency key; no token).

**Refusals:** an administrator email that already has a login (GOV-02) — platform-only error,
never shown to tenants; a slug in use; an inactive or unknown type. Any failure rolls back
everything; a `DENIED`/`ERROR` audit entry is written in a separate transaction.

**Genesis rule tightening (required):** `may_manage_protected_roles()` today admits the genesis
grant for any `session_user <> 'app_user'` (`drizzle/0008`). It becomes an explicit list —
`app_admin`, `app_owner`, `app_platform`. Today `app_worker` and `app_auth` also pass the test,
unreachable only because they hold no write privilege on the role tables.

## 5. Authorization (V1 permission set)

| Permission | Allows | Extra |
|---|---|---|
| `platform.organizations.view` | list and view organization metadata (name, slug, type, status, created, member count) | — |
| `platform.organizations.create` | provision (§4) | idempotency key |
| `platform.organizations.assign_initial_admin` | re-issue the first administrator's invitation while none is live | step-up |
| `platform.organizations.suspend` / `.reactivate` | only if L1 includes them | reason required |
| `platform.audit.view` | read platform audit events | — |
| `platform.admins.manage` | invite and revoke platform administrators | step-up; never self; never the last holder |

A new administrator invited later holds `view` permissions only until granted more. Separate
catalogue (`platform.platform_permissions`), no path from `public.role_permissions`.
`app_platform` holds EXECUTE on `platform.*` functions and **no** privilege on any `public` or
`auth` table; `app_user`, `app_worker`, `app_auth` hold no EXECUTE on `platform.*`.

## 6. Audit

`platform.audit_events`, append-only, written only by definers; actor type `platform_admin`,
`operator` or `system`, derived, never a parameter; `SUCCESS` in the same transaction as the
change, exactly once per idempotency key; `DENIED`/`ERROR` in a separate transaction; never a
password, token or request body; no runtime login may insert, update, delete or truncate it.
Retention: never removed automatically (K5 proposes at least 7 years). Organization
administrators see the events about their own organization (K6).

## 7. Acceptance tests (must pass before V1)

1. Platform bootstrap: once per database; refused for every runtime login; a failed run leaves
   nothing; independent of the organization bootstrap in both orders; after it,
   `bootstrap_organization()` refuses.
2. Setup: no platform action before password + TOTP; the token is single use and expires.
3. A login cannot be both a platform administrator and a person.
4. `aal1`, idle and expired platform sessions refused; step-up enforced where listed.
5. A tenant session of any role, `SUPER_ADMIN` included, gets 404 on every platform route and no
   platform function runs; a platform session resolves to no tenant identity.
6. Catalogue: grants exactly as in §5; `app_platform` has no table privilege and no BYPASSRLS.
7. Provisioning: same key twice → one organization, person, invitation and audit entry;
   different parameters → 409; injected failure → nothing left and one `ERROR` entry; an inactive
   type, a used slug and an existing login are refused.
8. The new organization has the system roles, one department, the template's pipelines, the first
   administrator (ACTIVE, `SUPER_ADMIN`) and an invitation that cannot be accepted elsewhere.
9. The genesis grant is refused for `app_worker` and `app_auth`.
10. No secret in any audit entry or log; runtime logins cannot write or truncate platform audit.
11. The existing suite passes unchanged.

## 8. Delivery

| Package | Content | Owner |
|---|---|---|
| P1 | platform schema, `app_platform` login (roles.sql), permissions, resolver and wrapper, audit, bootstrap and recovery CLI modes, read-only list, genesis tightening | Claude Code |
| P2 | provisioning with type and first administrator, idempotency, invitation re-issue, platform API routes | Claude Code |
| P1-UI / P2-UI | the platform console pages (setup, organization list, provisioning form, audit view) | **founder assigns** — frontend is Antigravity's by default (AGENTS.md §3) |
| L1 | suspend / reactivate (if confirmed) | Claude Code |

Shared files the founder approves when touched: `src/env.ts` (`DATABASE_URL_PLATFORM`),
`package.json` (none expected), the agent rules (none). Hosted steps (creating `app_platform`
on Neon, migrations, the first bootstrap) each need their own approval.

## 9. Decisions requested

**Decided by ADR-008 (2026-10-27):** this design as the V1 direction; K8 = platform administrator
first; N1 = separate singleton with the one-way coupling of §3.2; L1 = suspend and reactivate in
V1, archive and restore in V1.1. Still open: Q1 (supplied at the hosted bootstrap), the console
pages' owner, and confirmation of the remaining defaults below — implementation proceeds on them.

| # | Decision | Recommendation |
|---|---|---|
| — | Confirm this proposal as the V1 design | — |
| K8, N1 | Platform administrator first; separate singleton, one-way coupling (§3.2) | confirm |
| L1 | Lifecycle in V1 | suspend/reactivate in V1; archive/restore in V1.1 (amend ADR-007) |
| Q1 | The first platform administrator (name, email) | founder input |
| K1, K3 | Administrator management with step-up; dual approval | yes; dual approval in V1.1 |
| K5 / Q4 | Platform audit retention | ≥ 7 years, never automatic |
| K6 / Q5 | Same application, own `app_platform` login; tenants see events about themselves | yes |
| N2 | Type chosen at provisioning, ACTIVE types only | yes |
| K2, K7, Q2, Q3 | No support access; no allow-list; no trial/paid label; manual lifecycle only | accept defaults |
| UI | Who builds the console pages | founder assigns |

Once confirmed, the decisions are recorded as ADR-008 (ADR-007 stays as written; ADR-008
amends its GOV-03 definition of done if L1 narrows it).
