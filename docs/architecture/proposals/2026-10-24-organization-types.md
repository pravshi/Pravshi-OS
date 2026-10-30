# Organization types and templates — design, proposals and review

**Status:** the mechanism (migration **0080**, journal idx 79 — renumbered from 0078, see R1)
is IMPLEMENTED and LOCALLY VERIFIED (merged to `main`; verified on disposable local PostgreSQL only, not Neon). Everything marked
**PROPOSAL** below is a recommendation for the founder, not an approved business decision.
Industry-specific CRM functionality (Real Estate, Education) is deferred to the agreed point
before V1 Pro Max; both types stay DISABLED until then.

Date: 2026-10-24 · Base: `main` `d8ae017` + `0077` (`17a6cbf`) + `0078` audit truncation guard
(`9d5b47e`) + `0079` rate-limit first use (`1fb38c1`), all local and unmerged

## 1. Goal and principle

One multi-tenant CRM platform, one application, one database. An organization's **type**
(Generic, Real Estate, Education, …) changes the configuration it is born with — never the code
path, the data model or the isolation rules. Types come from a controlled, extensible catalog;
each type has versioned templates; upgrades are additive.

Why not a separate application or database per industry: every tenant would need its own
migration chain, roles, backups and security review, and a fix would have to land N times. The
configuration approach keeps one RLS model and one release.

## 2. What 0080 implements (verified locally)

| Element | Implementation |
|---|---|
| Catalog | `organization_types(key, display_name, description, status ACTIVE/DISABLED)`, forced RLS, readable by `app_user`, writable by the owner only |
| Templates | `organization_type_templates(type_key, version, status DRAFT/PUBLISHED/RETIRED, definition jsonb)`; published versions immutable, undeletable, untruncatable; a CHECK validates every published definition |
| Organizations | `type_key` + `template_version` (NOT NULL, default `generic_crm` / 1, foreign keys); type fixed at creation; version only forward to a published version of the same type |
| Seeding | `seed_default_pipeline()` builds the organization's pipelines from its template; `generic_crm` v1 is the six legacy stages exactly |
| Upgrades | `upgrade_organization_template(org, version)`: adds missing pipelines only; executable by no runtime role yet (the platform role will call it) |
| Shipped types | `generic_crm` ACTIVE; `real_estate_crm`, `education_crm` DISABLED with no template |
| Backwards compatibility | existing organizations backfill to `generic_crm` v1 with no rewrite; their pipelines are untouched (proven byte-identical on upgrade) |

Evidence (as 0078, before renumbering): fresh chain and upgrade from 0077 with existing
organizations; rollback refuses while any organization is non-generic and otherwise restores a
schema identical to a fresh 0077 (8/8 order-stable fingerprints); 26 database tests. After
renumbering, as 0080 on the full local chain: fresh 0000–0080; upgrade from K = 64 with
representative data, every data table byte-equal and the schema equal to a fresh build (8/8);
the recovery ladder (roll back 0080, 0079, 0078, roll forward) twice, matching a fresh 0077 and
a fresh 0080. All on a disposable local PostgreSQL 18.6 — not Neon.

## 3. Review findings (self-review — not an independent review)

| # | Finding | Severity | Action |
|---|---|---|---|
| R1 | **Journal collision** (resolved). As 0078 it took idx 77, as did the MT-L3 migration. | High (integration) | **Renumbered to 0080 (idx 79)** in the chain `0077` deal history + org identity → `0078` MT-L3 → `0079` FU-3 → `0080` organization types. Never applied anywhere persistent, so renumbering was safe. |
| R2 | **Depends on 0077, 0078 and 0079**, none of them merged. | Medium | Merge in chain order. |
| R3 | **Stage semantics.** CRM analytics (`src/lib/analytics/crm.ts`) count leads and qualified deals **by stage name** (`NEW`, `QUALIFIED`). Any template whose stages are named otherwise shows zero leads on those dashboards. Deals, WON/LOST and sales analytics are unaffected (they use `is_won`/`is_lost` and stage ids; `legacyStageFor()` keeps `deals.stage` valid). | **High — blocks enabling Real Estate / Education** | Template definition schema v2 adds a `role` per stage (`lead`, `qualified`, `proposal`, `negotiation`, `won`, `lost`, `other`), a `pipeline_stages.role` column, and analytics read the role instead of the name. Separate approved migration. |
| R4 | Unknown type answers `23514` from the guard rather than `23503` from the foreign key. | Info | Intended (clearer message); the foreign key stays as the backstop. |
| R5 | `bootstrap_organization()` always creates `generic_crm`. | Medium | With K8 (platform admin bootstrap) the first organization is provisioned with an explicit type instead; until then generic is the only choice. |
| R6 | No module, custom-field, dashboard or type-specific role system exists, so a template cannot configure them. | Scope | §5 below; each needs its own design and approval. |

## 4. PROPOSAL — Real Estate and Education templates

Grounding: the CRM as built (companies, contacts, deals, activities, pipelines with custom stages
since 0037) and the V1 scope (ADR-006: the multi-tenant Business OS, CRM pipelines). Nothing in the
repository describes industry stages, so the stages below are **recommendations to review**, not
requirements found in the documents. They stay DISABLED until approved **and** R3 is implemented.

### 4.1 `real_estate_crm` v1 — PROPOSAL

| Pipeline | Stage | Probability | Role (schema v2) | Terminal |
|---|---|---|---|---|
| **Property Sales** (default) | New Enquiry | 10 | lead | |
| | Qualified Buyer | 20 | qualified | |
| | Site Visit Scheduled | 35 | proposal | |
| | Site Visit Done | 50 | proposal | |
| | Negotiation | 70 | negotiation | |
| | Booking / Token Received | 85 | negotiation | |
| | Registered (Won) | 100 | won | won |
| | Lost | 0 | lost | lost |
| **Rentals** | Enquiry | 10 | lead | |
| | Viewing | 40 | proposal | |
| | Application | 60 | negotiation | |
| | Agreement Signed (Won) | 100 | won | won |
| | Lost | 0 | lost | lost |

### 4.2 `education_crm` v1 — PROPOSAL

| Pipeline | Stage | Probability | Role (schema v2) | Terminal |
|---|---|---|---|---|
| **Admissions** (default) | Enquiry | 10 | lead | |
| | Counselling Done | 25 | qualified | |
| | Application Submitted | 40 | proposal | |
| | Documents Verified | 55 | proposal | |
| | Offer Made | 75 | negotiation | |
| | Enrolled / Fee Paid (Won) | 100 | won | won |
| | Lost / Not Joining | 0 | lost | lost |

Open questions for the founder: the stage names your teams actually use; whether Rentals is in
scope; whether Education needs a separate "Deferred" outcome; currency and default probabilities.

## 5. Type-specific configuration matrix — what exists, what is proposed

| Configuration | Generic CRM | Real Estate (PROPOSAL) | Education (PROPOSAL) | Status of the mechanism |
|---|---|---|---|---|
| Pipelines and stages | 1 pipeline, legacy six | §4.1 | §4.2 | **Implemented** (0080) |
| Stage roles for analytics | implicit (legacy names) | explicit roles | explicit roles | **Not implemented** (R3, schema v2) |
| Modules enabled | all current modules | CRM, work, workflows, analytics | CRM, work, workflows, analytics | **Not implemented** — no module system exists; navigation is permission-driven |
| Custom fields | none | e.g. property type, budget, location (PROPOSAL) | e.g. programme, intake, guardian (PROPOSAL) | **Not implemented** — no custom-field system exists |
| Dashboards | current CRM/sales analytics | role-based funnel | role-based funnel | **Partly** — analytics exist; type-specific dashboards need R3 |
| Roles | 14 system roles (0008) | same 14 (PROPOSAL: no new roles in V1) | same 14 | **Implemented** generically; type-specific roles not proposed for V1 |
| Workflows | none seeded | none seeded (PROPOSAL) | none seeded | Workflow engine exists; template-seeded workflows not implemented |

Recommendation: ship V1 with the pipeline/stage mechanism (0080) plus schema v2 stage roles (R3);
treat modules and custom fields as a separately designed post-V1 package. Enabling Real Estate or
Education before R3 would give those tenants empty lead dashboards.

## 6. Tenant isolation and safety (unchanged rules)

Catalog and templates hold no tenant data. Every seeded pipeline and stage carries the
organization's id and is subject to the existing forced RLS and composite foreign keys (tested:
two organizations from one template share no pipeline or stage row; `app_user` in one organization
sees none of another's). Template writes are owner-only; no runtime role can change an
organization's type or upgrade it.

## 7. Next steps (each needs its approval)

1. Review and merge 0077, then 0078, 0079 and 0080, in that order (all committed locally; each
   push, PR and merge needs its approval).
2. Approve or edit the §4 proposals.
3. Design and implement schema v2 stage roles (R3) — migration, analytics change, tests.
4. Enable a type only after its template is published and R3 is in place.
