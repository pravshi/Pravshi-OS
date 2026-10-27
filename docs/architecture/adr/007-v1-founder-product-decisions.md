# ADR-007: V1 product decisions — one organization per login, platform provisioning, one tier of capability, Sales Sheet import

Status: Accepted; amended by [ADR-008](008-v1-platform-and-import-decisions.md) (the GOV-03 and BP-06
definitions of done) | Date: 2026-10-16 | Deciders: Founder (Nani)

## Context

[ADR-006](006-v1-scope-business-os.md) fixed V1 as the multi-tenant Business OS and left five
product questions open. The founder has now decided four of them. This record states each decision
exactly, what it requires before V1 can be called complete, and what it leaves for later. ADR-006
is unchanged apart from a pointer here.

## Decisions

### GOV-02 — Organization membership

**One login belongs to exactly one organization in V1.** The existing single-organization schema
is kept unless a separately approved security finding requires otherwise.

- Today the schema enforces it: a login maps to one person (`people_auth_user_unique`) and email
  addresses are globally unique (`auth_users_email_unique`); the session resolves the person's own
  organization and a caller cannot choose another.
- Multi-organization membership (session-level active organization, organization switching) is
  **not** V1 work.
- Consequence for provisioning: an organization's first administrator must be a login that does
  not exist yet. Provisioning refuses an email address that already has a login.

**Definition of done:** the rule is documented (this record); a test pins that a login cannot hold
a person in a second organization; provisioning refuses an existing login with a platform-only
error that is never shown to tenants.

### GOV-03 — Organization provisioning

**V1 includes an audited, tightly permission-controlled platform Super Admin
organization-provisioning system.**

- It is a separate authority from every organization's own `SUPER_ADMIN` role, which stays
  organization-scoped.
- The architecture is a proposal pending founder review:
  [proposals/2026-10-16-platform-super-admin.md](../proposals/2026-10-16-platform-super-admin.md),
  which answers the open design questions K1–K10. **Nothing in it is implemented or approved until
  the founder signs off the proposal.**

**Definition of done:** the proposal is approved; a platform administrator can create, suspend,
reactivate, archive and restore organizations and appoint each organization's first
administrator; every action is permission-checked, requires a verified second factor and writes
exactly one platform audit entry in the same transaction; no platform path can read customer
business data; the proposal's acceptance tests pass in CI.

### GOV-04 — Free-trial and paid organizations

**V1 uses shared core capabilities for free-trial and paid organizations. Both receive identical
tenant isolation and security guarantees. Plan-based feature entitlements, billing and usage
limits are deferred from V1.**

- No code path may branch on trial versus paid for isolation, security, audit or data protection.
- No plan, entitlement, billing or usage-limit mechanism is built in V1.
- Existing operational safeguards that are not plan-based (the AI spend kill switch and limits,
  rate limits, schedule frequency limits) stay as they are and apply equally to every organization.

**Definition of done:** this record; no V1 feature reads a plan or tier to grant or withhold a
capability.

### BP-06 — Sales Sheet import

**Importing the Sales Sheet into the CRM is included in the V1 launch scope.**

- Requirements and acceptance criteria are a proposal pending founder review:
  [proposals/2026-10-16-sales-sheet-import.md](../proposals/2026-10-16-sales-sheet-import.md).
- The sheet's columns are not recorded anywhere in this repository. The field mapping cannot be
  finalised until the founder supplies the sheet's structure (the proposal lists the questions).

**Definition of done:** the proposal is approved and its mapping confirmed; the import runs inside
the CRM's existing permission and organization model with preview, validation, documented
duplicate matching, per-row error reporting and an audit record; the production data is imported
and verified against the source; the sheet is set read-only with a pointer to Pravshi OS, as the
build plan's migration step describes.

## Still open

- **DB-14** — which Neon projects and branches are development, staging and production, and the
  plan for moving to the new database and retiring the old one.
- The questions each proposal lists for the founder.

## Delivery sequence

Each step needs its own approval; nothing here authorises implementation.

1. Founder review of the two proposals (platform Super Admin, Sales Sheet import) and answers to
   their questions.
2. Platform identity, permissions and platform audit (the proposal's first package).
3. Organization provisioning with the first administrator.
4. Organization lifecycle (suspend, reactivate, archive, restore).
5. Sales Sheet import — independent of 2–4; can proceed as soon as its mapping is confirmed.
6. Production data import and sheet freeze, after the production migration gate (HG-2) and DB-14
   are resolved.

## Consequences

- V1 completion now includes the platform provisioning system and the Sales Sheet import; it
  excludes multi-organization membership, plans, entitlements, billing and usage limits.
- The organization `SUPER_ADMIN` role is unchanged and remains organization-scoped.
- The HR and operations blueprint remains deferred as a separate future product scope (ADR-006).
