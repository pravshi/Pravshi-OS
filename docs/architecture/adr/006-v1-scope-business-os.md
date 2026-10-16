# ADR-006: V1 scope is the multi-tenant Business OS; the HR blueprint is a deferred product scope

Status: Accepted | Date: 2026-10-16 | Deciders: Founder (Nani)

## Context

Two documents defined two different V1 releases:

- The [master blueprint](../../superpowers/specs/2026-09-06-pravshi-os-master-blueprint.md) §32 and
  the [build plan](../build-plan.md), ratified on 2026-09-06, define V1 as an internal HR and
  operations platform: people and engagements, HR documents in private storage, policies and
  acknowledgement, recruitment, onboarding and offboarding, role-aware dashboards. They list AI,
  analytics beyond dashboard counters, global search, email notifications beyond invites and
  integrations as **not** V1.
- What was built across thirteen phases and recorded as `1.0.0` in [CHANGELOG.md](../../../CHANGELOG.md)
  is a multi-tenant business operating system: CRM, sales pipelines, work management, the workflow
  engine, background jobs and schedules, analytics, global search, notifications, the AI
  foundation and the integrations platform, on the same identity, permission and row-level
  security foundation. None of the HR modules was built.

No recorded decision reconciled the two, so whether V1 was complete could not be judged.

## Decision

1. **Pravshi OS V1 is the multi-tenant Business OS (Option B).** Its scope is the functionality
   already built and recorded in `CHANGELOG.md` `1.0.0` and later entries: authentication and
   sessions; organizations, users, roles and permissions; CRM, pipelines and business records;
   work management, jobs, workflows, schedules and background processing; dashboards, analytics,
   search and notifications; integrations, outbound webhooks and secure credential storage; AI with
   permission-aware context building and access controls; administration, tenant lifecycle, audit
   trails and operational tooling.
2. **The 2026-09-06 HR and operations scope is deferred as a separate future product scope.** It is
   not part of V1's acceptance criteria. The blueprint and build plan are preserved unchanged
   apart from a pointer to this record; their HR modules (people directory and employment
   details, HR documents and private storage, policies and acknowledgement, recruitment,
   onboarding and offboarding) will need their own specification and approval when that product
   is taken up. Build-plan items outside the HR scope that were not built (for example the
   role-specific dashboards and the task-view extras) are not V1 acceptance criteria either; they
   may be prioritised as Business OS work.
3. **The blueprint's architecture remains binding.** Its locked decisions (Neon PostgreSQL, Better
   Auth, Cloudflare R2 for any future file storage, `app_user` without `BYPASSRLS`, FORCE row-level
   security everywhere, transaction-local identity, a single authorized data path, fail-closed
   authorization, the Singapore region, scale-to-zero compute), its permission, audit and
   security model, and its testing strategy apply to V1. Only §32's scope list and the build plan's
   phase list are superseded for V1.
4. **Nothing already built is removed** because of this decision, and **V1 is not declared complete**
   by it. Completion is judged requirement by requirement, with evidence.

## Not decided here (open founder decisions)

> **Update 2026-10-16:** GOV-02, GOV-03, GOV-04 and the Sales Sheet import were decided in
> [ADR-007](007-v1-founder-product-decisions.md). DB-14 remains open. The list below is kept as
> it was recorded.

This record deliberately leaves these open; no design that depends on them may be implemented until
each is decided and recorded:

- **GOV-02** — whether one login may belong to more than one organization (today the schema
  enforces one).
- **GOV-03** — how organizations are created and administered (a platform administrator, or
  operator-run provisioning for the pilot).
- **GOV-04** — whether tenant tiers such as free trial and paid exist in V1, and how they differ.
- **DB-14** — which Neon projects and branches are development, staging and production, and the
  plan for moving to the new database and retiring the old one.
- **Sales Sheet import** — whether importing the existing sales spreadsheet into the CRM, and
  setting the sheet read-only (the build plan's Phase 3 migration), is part of the V1 launch. It is
  a CRM data import, not part of the deferred HR scope.

## Consequences

- `README.md` describes V1 as the Business OS and points here; the blueprint and build plan carry a
  header note pointing here.
- V1 completion treats every built feature as in scope and every HR-blueprint item as deferred,
  not missing.
- A future HR product starts from the preserved blueprint and build plan, re-specified against the
  system as it then exists.
