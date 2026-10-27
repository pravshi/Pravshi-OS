# ADR-008: V1 platform administration and Sales Sheet import — decisions and amended acceptance

Status: Accepted (direction) | Date: 2026-10-27 | Deciders: Founder (Nani)
Amends: [ADR-007](007-v1-founder-product-decisions.md) — the definitions of done of GOV-03 and
BP-06. ADR-007's decisions stand; where the two disagree on what V1 must deliver, this record
governs.

## Context

ADR-007 put platform provisioning (GOV-03) and the Sales Sheet import (BP-06) in V1, but left
their designs as proposals. Its GOV-03 definition of done required suspend, reactivate, archive
and restore; the founder's minimum for V1 does not include archive and restore. That conflict
(decision L1) had to be resolved before ADR-007 can be published as the acceptance definition.
The designs are
[2026-10-27-platform-administration-v1-minimum.md](../proposals/2026-10-27-platform-administration-v1-minimum.md)
and
[2026-10-27-sales-sheet-import-policies.md](../proposals/2026-10-27-sales-sheet-import-policies.md).

## Decisions

### P-1 — Platform administration stays in V1, at its minimum complete scope

V1 includes: a platform administrator identity separate from every organization; provisioning
an organization with its type (ACTIVE types only) and its first administrator; re-issuing that
administrator's setup link; administrator management; suspend and reactivate; the platform
audit trail. Outside V1: the broad architecture redesign, full CRM products (Real Estate,
Education), website builder, custom app builder, support access, deletion, billing and plans.

### P-2 — Platform-administrator-first bootstrap, independent of organization creation (K8, N1)

A new database's one-time bootstrap creates the first **platform administrator**, through its own
singleton (`platform.bootstrap_state`). It never consumes the organization bootstrap. Once it has
run, `bootstrap_organization()` refuses in that database; an existing organization bootstrap
never blocks it. The first administrator's name and email are founder inputs, supplied at the
time of the (separately approved) hosted bootstrap; none is recorded in the repository.

### L1 — Organization lifecycle in V1

**Suspend and reactivate are required in V1. Archive and restore are deferred to V1.1.**

### I-1 — `crm.import` (Q8)

Only holders of the explicit organization permission `crm.import` may import; it is seeded to
`SUPER_ADMIN` and `ADMIN` at GLOBAL only. Every import operation is scoped to the holder's own
organization in the database (forced RLS) and in the job that commits it. The importer is
recorded on the import, on every record it creates and in every import audit entry.

### I-2 — Duplicates (E14)

Possible duplicates are resolved per company and per contact key, never per row; after each
resolution the remaining preview is recalculated deterministically, and confirmation is bound to
that exact revision. An import never silently creates a duplicate of a record the preview
identified.

### I-3 — Retention (Q7)

Proposed: import metadata and row-level results are kept 90 days; audit history follows audit
retention, separately. A tested cleanup design is prepared; **no destructive cleanup is enabled
until the retention rules and their exclusions are approved** (a later decision record).

### I-4 — Workflows (E9)

Imported deals trigger no workflows by default. Any future opt-in must be explicit per import and
covered by tests before it is offered.

## Amended acceptance (supersedes ADR-007's GOV-03 and BP-06 "Definition of done")

**GOV-03 / P-1 — done when:** the platform design above is implemented; a platform administrator
can be bootstrapped (P-2), can provision an organization with its type and first administrator,
re-issue that administrator's setup link, manage platform administrators, and suspend and
reactivate organizations; every platform action is permission-checked, requires a verified second
factor (and step-up where the design says so) and writes exactly one platform audit entry in the
same transaction; no platform path can read customer business data; the design's acceptance tests
pass in CI. Archive and restore are **not** required for V1.

**BP-06 — done when:** ADR-007's conditions hold (approved mapping from the real sheet; preview,
validation, documented duplicate matching, per-row errors, audit; production data imported and
verified; sheet frozen), **and** I-1, I-2 and I-4 are implemented and tested. I-3 requires an
approved retention decision before any cleanup is enabled.

**Not changed:** GOV-02, GOV-04, and the rest of ADR-007.

## Still open (founder inputs — V1 cannot be accepted without them)

- The real Sales Sheet: file, columns and formats (BP-06; requirements proposal §7).
- The first platform administrator's name and email (needed only at the hosted bootstrap).
- Approval of the retention rules and exclusions (I-3) before any cleanup runs.
- Confirmation of the platform design's remaining defaults: administrator management with
  step-up (K1, K3), audit retention of at least 7 years (K5), console in the same application
  (K6/Q5), type chosen at provisioning (N2), no support access, no IP allow-list, no trial/paid
  label, manual lifecycle only (K2, K7, Q2, Q3). Implementation proceeds on these defaults; each
  is reversible before release.
- Who builds the platform console pages (frontend ownership, AGENTS.md §3).

## Consequences

- V1 acceptance is governed by ADR-007 as amended here; nothing may claim V1 complete while the
  open items above are unresolved.
- Archive/restore, retention cleanup, and the workflow opt-in are V1.1 or later unless a new
  record says otherwise.
- The platform design moves from "proposal" to "approved direction": local implementation may
  start; every hosted step (roles, migrations, bootstrap) still needs its own approval.
