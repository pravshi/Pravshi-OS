# Platform provisioning — readiness and decision register

**Status:** DECISIONS PENDING. Nothing in the platform package is implemented, and none of it may
be until the founder approves the proposal
([2026-10-16-platform-super-admin.md](./2026-10-16-platform-super-admin.md)) — ADR-007 (GOV-03)
and the proposal both say so, and each package then needs its own approval. This document does
not decide anything. It separates what is **already decided**, what **can proceed without a new
decision**, and what **is blocked on one**, and it states the first-bootstrap choice (K8) as the
decision it is.

Date: 2026-10-26 · Written against the local branches listed in §6; none is merged or deployed.

## 1. Already decided (ADR-007, 2026-10-16)

| Decision | Consequence for provisioning |
|---|---|
| **GOV-02** — one login belongs to exactly one organization in V1 | Provisioning refuses an administrator email that already has a login, with a platform-only error. A login cannot hold a person in a second organization. |
| **GOV-03** — V1 includes an audited, tightly controlled **platform** Super Admin provisioning system, a separate authority from every organization's own `SUPER_ADMIN` | The system is required for V1. Its *design* is the pending proposal. |
| **GOV-04** — trial and paid organizations share capabilities, isolation and security; plans, entitlements, billing and limits are deferred | Provisioning records no plan or tier. No code path branches on trial versus paid. |

## 2. Verified facts the design relies on (local, 2026-10-26)

| Fact | Evidence |
|---|---|
| One login ↔ one person is enforced by the schema | `people_auth_user_unique` (partial unique index on `people.auth_user_id`, `drizzle/0002`); email unique in `auth_users` |
| The organization bootstrap is a once-per-database singleton, callable only by `app_admin` / `app_owner` | `drizzle/0015` |
| Worker claims, scheduler ticks, reminders and inbound webhooks consider ACTIVE organizations only | `drizzle/0068` |
| An organization's `id` and `slug` cannot be changed by any role: a trigger refuses with 23514. The proposal's "slug changes only through an audited platform function" would therefore need a deliberate, reviewed relaxation of this trigger in P1 | migration 0077 (`organizations_identity_freeze`; `fix/deal-history-org-identity`, local, unmerged) |
| Organizations are created from a controlled **type catalog** and a versioned, immutable **template**; `generic_crm` is the only ACTIVE type; Real Estate and Education are DISABLED with no template | migration 0080 (`feature/organization-types`, local, unmerged) |
| `upgrade_organization_template()` exists and is executable by **no** runtime role; the platform login is intended as its only caller | migration 0080 |
| Tenant audit rows require an actor who is a person of the organization, so a platform administrator cannot be recorded in `audit_logs` | `audit_logs_actor_same_org` (`drizzle/0011`) — hence the separate `platform.audit_events` table in the proposal |

## 3. What can proceed without a new founder decision

| Item | Why it is safe | Status |
|---|---|---|
| A test pinning GOV-02: a login cannot hold a person in a second organization | ADR-007 lists it in GOV-02's definition of done; it asserts a rule already enforced by the schema and decides nothing | proposed as the next local change |
| This register and the K8 option analysis (§5) | Documentation only | this document |
| Keeping Real Estate and Education DISABLED; no industry-specific template | Already decided; nothing to implement | in place |

**Nothing else.** Platform identity, the `app_platform` login, the platform audit table, the
provisioning function, the lifecycle functions and the bootstrap-CLI change are all packages P1–P3
of the proposal. Building any of them now would pre-empt K1–K8.

## 4. Decision register

> **Update 2026-10-27 — [ADR-008](../adr/008-v1-platform-and-import-decisions.md):** the platform
> package stays in V1 at its minimum scope
> ([design](./2026-10-27-platform-administration-v1-minimum.md)); **K8 = yes** (platform
> administrator first); **N1 = yes**; lifecycle: suspend/reactivate in V1, archive/restore in
> V1.1. Q1 is supplied at the hosted bootstrap. K1–K7, N2, Q2–Q5 proceed on the recommended
> defaults below, pending explicit confirmation. Section 3's "nothing else may proceed" no
> longer applies to local implementation.

Each row is a question for the founder. "Recommended" repeats the 2026-10-16 proposal; it is not a
decision. "Blocks" names the first package that cannot start without the answer.

| # | Question | Recommended (proposal) | Blocks | If decided differently |
|---|---|---|---|---|
| **K8** | Is the **first platform administrator** — not an organization — what the new primary's one bootstrap creates? | Yes, for new deployments | The new primary database's first initialization (see §5) | See §5 |
| K1 | May platform administrators manage other platform administrators? | Yes: holders of `platform.admins.manage` only, with step-up; never their own record; never the last holder | P1 admin management | "No": administrators are managed only by an operator database procedure |
| K2 | Support access to customer business data? | **No**, not in V1 | nothing (the safe default) | "Yes" is the largest risk and needs its own audited design |
| K3 | Step-up / dual approval for sensitive actions? | Step-up for archive, restore, admin management, first-admin re-issue; dual approval once two platform admins exist | P1 / P3 | Without step-up, a stolen platform session could archive tenants |
| K4 | Archive semantics and window? | Reversible within 90 days; **no deletion in V1** | P3 | Deletion needs a written retention and recovery policy first |
| K5 | Platform audit retention? | At least 7 years for lifecycle and admin events; never removed automatically | P1 audit table | Shorter weakens accountability |
| K6 | Customer visibility of platform events; same application or separate deployment? | Org admins see events about their own organization; same application first, on its own database login (`app_platform`) | P1 deployment and `DATABASE_URL_PLATFORM` | A separate deployment from day one adds hosting and secrets work |
| K7 | IP allow-list for the platform console? | Off at first | nothing | On requires a stable office or VPN egress |
| Q1 | Who are the first platform administrators; should dual approval start as soon as a second exists? | — (founder input) | P1 bootstrap | — |
| Q2 | Trial/paid label as plain metadata, or nothing in V1 (GOV-04)? | — (founder input) | P2 | — |
| Q3 | Do free trials end automatically, or are all lifecycle changes manual? | — (founder input) | P3 | — |
| Q4 | Is 90 days the right archive-restore window and 7 years the right audit retention? | — (founder input) | P1 / P3 | — |
| Q5 | Platform console in the same application, or separate from the start? | Same application | P1 | — |
| **N1** | *New.* Must the platform administrator's bootstrap be **independent of the organization-bootstrap singleton**, so that choosing "organization first" for the new primary never forecloses adding a platform administrator later? | Yes — design P1's first-administrator mode so it is not consumed by the organization bootstrap | P1 design; and the K8 choice | If it is the same singleton, K8 becomes irreversible for that database (§5) |
| **N2** | *New.* Is `type_key` a provisioning input chosen by the platform administrator (from ACTIVE types only)? | Yes: `generic_crm` is the only choice until a type is approved and enabled | P2 | A fixed type per organization would need a later migration path |

Decided: K9 (one login, one organization — GOV-02) and K10 (status-aware claims already exist in
`drizzle/0068`).

## 5. K8 — the first bootstrap workflow

The new primary is planned as a **fresh database** (`pravshi` in `Pravshi-OS-New`), initialized
once. The organization bootstrap (`drizzle/0015`) is a **once-per-database singleton and
immutable**: what it creates cannot be redone in that database.

| | **Option A** — platform administrator first (K8 = yes) | **Option B** — the founder's organization first, as today (K8 = no) |
|---|---|---|
| The one bootstrap creates | the first **platform administrator** | the founder's **organization** and its first `SUPER_ADMIN` (always `generic_crm`) |
| The founder's organization is created by | the platform administrator, through `platform.provision_organization(...)`, choosing its **type** | the bootstrap itself |
| Must exist before the new primary can be initialized | P1 (identity, `app_platform`, platform audit, bootstrap CLI mode) **and P2** (provisioning), each **reviewed and rehearsed** | nothing new: migrations + roles + the existing bootstrap |
| Earliest the database can be initialized | after P1 and P2 are built, reviewed and rehearsed | as soon as DB-14 and the migration/roles approvals are done |
| Later platform administration | native | added by a later P1; **only possible if N1 = yes** (the platform administrator's bootstrap is not the consumed singleton) |
| Cost of a wrong choice | initializing early with the wrong shape is not reversible in that database; recovery is a fresh database | the founder's organization can never start as a non-generic type, and a second path (bootstrap + provisioning) must coexist |
| Who is exposed to the delay | the whole V1 timeline waits on the platform package | only the platform package waits |

**What the choice does not change:** the existing `Pravshi-OS-New` / `neondb` production database
is already bootstrapped and is left unchanged either way; organization types, templates and
tenant isolation work identically under both options.

**Recommendation in the proposal:** Option A for new deployments. **Not decided.** If the founder
wants the new primary live sooner, Option B with N1 = yes keeps Option A's destination reachable
without a second database. Either way the choice is permanent for the database it is made in, so
it should be made before the first hosted initialization and recorded as an ADR.

## 6. Dependencies on other work (all local, unmerged)

| Needed by provisioning | Where it is |
|---|---|
| Organization identity freeze; migration 0077 | `fix/deal-history-org-identity` `17a6cbf` |
| Organization types and templates; migration 0080 | `feature/organization-types` `1d5738e` (stacked on 0077–0079) |
| Database-target test guard (so tests never touch a hosted database) | `fix/test-db-target-guard` `674deba` |
| Hosted prerequisites: DB-14 (which projects/branches are which; the move to the new primary), production-migration gate HG-2, running `scripts/db/roles.sql` for the new `app_platform` login | founder approvals; none requested yet |

## 7. Approval gates still open for this area

- Approval of the platform proposal, or of changes to it (the K/Q answers above).
- A decision on K8 and N1 before the new primary is initialized.
- Each of P1, P2, P3 separately, once the proposal is approved.
- Any hosted database, role or migration action (DB-14, HG-2) — none has been taken.
