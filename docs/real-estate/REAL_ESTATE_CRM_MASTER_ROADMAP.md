# PRAVSHI OS — REAL ESTATE CRM
## MASTER DEVELOPMENT ROADMAP, PHASE EXECUTION & PROJECT MEMORY

> **Document Type:** Source of Truth & Permanent Project Memory  
> **Status:** PHASE 0 COMPLETE (founder sign-off recorded 2026-11-12) / PHASE 1 IN PROGRESS  
> **Authority Documents** (founder-held, external to this repository; cited by title only):  
> 1. **Document A:** *Pravshi OS — Real Estate CRM: Indian Market Research, Competitive Intelligence & Complete Product-Building Blueprint* (85 pages, dated 2026-11-03)  
> 2. **Document B:** *Pravshi OS Real Estate CRM — Founder Review Addendum* (63 pages, dated 2026-11-03)  
> **Core Positioning:** Neutral, WhatsApp-first system of record for Indian real-estate deals — **ONE DEDUPED LEAD. ONE UNIT. ONE MONEY TRAIL.**  
> **Repository Baseline:** `main` at commit `084e79f` (PR #119 merged, 2026-11-12). The audit in §6 was taken at `c39180e` (PR #115) and is kept as the historical baseline; §6.1 records what has changed since.

---

## 1. Product Scope & Final Packaging Architecture

Pravshi OS Real Estate CRM is a multi-tenant, configurable real-estate business operating platform built inside the Pravshi OS monorepo. It serves solo property agents, brokerage firms, developers/builders, rental & leasing operators, channel partner firms, and multi-branch enterprise real estate groups.

### Packaging Structure (Document B §2 — Authoritative)
The product consists of **5 Provisionable Templates**, **1 Governance Modifier (Overlay)**, and **1 Capability Modifier (Pack)** on a single shared codebase:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              PRAVSHI OS SHARED ENGINE                                  │
│           (platform-core, security, database, crm-core, work, shared-services)         │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                       PRODUCTS / REAL-ESTATE DOMAIN LAYER                              │
│       (inventory atoms, project/tower/unit hierarchy, RERA gates, cost sheets, etc.)   │
├───────────────────────────────┬────────────────────────────────────────────────────────┤
│     PROVISIONABLE TEMPLATES   │                       MODIFIERS                        │
│  T1: Individual Agent         │  Modifier A: Enterprise Governance Overlay             │
│  T2: Brokerage                │              (Switchable over T2, T3, T4; never solo)  │
│  T3: Developer Pro            │  Modifier B: Channel Partner Collaboration Pack        │
│  T4: Rental & Leasing         │              (Full on T3, Basic on T2; never solo)     │
│  T5: Channel Partner (Own-Biz)│                                                        │
└───────────────────────────────┴────────────────────────────────────────────────────────┘
```

#### The 5 Provisionable Templates
1. **T1 — Individual Agent (Persona A — Solo Agent):** Leads, contacts, listings, visits, WhatsApp shared inbox, follow-up tasks, basic dashboards, offline-first mobile, day-7 checklist. (Retired "Broker Lite" name survives solely as T2's Starter preset). Default Tier: **Starter (₹999/mo)**.
2. **T2 — Brokerage (Persona B — Agency):** Everything in T1 + teams, assignment engines, lead-ownership protection, pond queue, multi-user permissions, branch management, workflow automations library, manager dashboards, concierge import. Houses internal desk configurations: Residential Sales, Commercial, Land & Plot. Default Tier: **Business (₹2,499/mo)**.
3. **T3 — Developer Pro (Persona D — Builder / Developer):** Everything in T2 + Project → Tower → Floor → Unit hierarchy, interactive unit grid, hold/block/release state machine with audit, dynamic cost sheets, booking → payment milestones → collections ledger, RERA §13 gate enforcement, demand letters, CP management + payout accruals, approval chains, custom fields. Default Tier: **Pro (₹4,999/mo)**.
4. **T4 — Rental & Leasing (Rental-first firms / Desks):** Tenancy lifecycle, rent schedules, arrears ladder, owner statements, renewals queue, move-in/out checklists, deposit tracking; commercial leasing terms as module variant (M17). Default Tier: **Business (₹2,499/mo)**.
5. **T5 — Channel Partner — Own-Business (Persona C, Face 1):** A CP firm operating its own business, managing its own leads, builder relationships, agent team, visits, and payout statements as an independent tenant. Default Tier: **Business (₹2,499/mo)**.

#### The Modifiers
- **Modifier A — Enterprise Governance Overlay (Persona E):** Multi-branch hierarchy, central administration, cross-branch consolidated reporting, audit and export governance, template upgrade approval chains, role builder, custom objects, SSO, sandbox, white-label customer portal. Switchable over T2, T3, or T4. Never a standalone signup. Default Tier: **Enterprise (Custom, quote-led)**.
- **Modifier B — CP Collaboration Pack (Persona C, Face 2):** Hosted external user access inside a developer's organization. Scoped access: own registered claims, protection window visibility, visits, bookings, payout statements, dispute submission. Full on T3, Basic on T2. Never a standalone signup. Default Tier: **Pro Max (₹9,999/mo)**.

### Pricing Ladder & Gating Principles (Hypotheses Pending Pilot Validation)
- **Ladder (per org/month + 18% GST):** Starter ₹999 (1 staff seat), Business ₹2,499 (up to 5 seats, +₹499/extra), Pro ₹4,999 (up to 15 seats, +₹399/extra), Pro Max ₹9,999 (up to 30 seats, +₹299/extra), Enterprise Custom.
- **Core Principle:** Gate by depth and scale (seats, branches, approval depth, AI credits, API limits), **NEVER by core workflow**. Leads, properties, visits, WhatsApp inbox, mobile, ownership protection, dedupe, dashboards, and export exist in every tier.
- **CP Seats Invariant:** Flat / unlimited restricted-role seats across all tiers with CP features. Restricted-role seats are never charged as full staff seats.

---

## 2. Master Roadmap — All 15 Phases (P0–P14)

| Phase | Phase Name | Primary Objective & Modules | Dependencies | Est. (Weeks) | Status | Delivery Gate |
|---|---|---|---|---|---|---|
| **P0** | **Foundation & Readiness** | Tenant isolation at query layer, append-only audit, contracts freeze, logging, template-data scaffolding. (No RE workflows). | Shared Platform | 4–7 (±40%) | **COMPLETE** (PR #116, #117; founder sign-off 2026-11-12) | Internal Gate |
| **P1** | **Core CRM** | Generic CRM lineage: M1, M2, M21, M22. Ingestion, dedupe preview, round-robin/territory assignment, activity timeline, worklist. | P0 | 6–10 (±40%) | **IN PROGRESS** (database foundation merged: PR #118; see §6.1) | Internal → Pilot |
| **P2** | **Real Estate Domain** | Property & inventory foundations: M3, M4, M5, M15. Inventory atom, project hierarchy, unit grid, availability state machine, area units. | P1 | 7–11 (±40%) | **NOT STARTED** | Pilot (Inventory) |
| **P3** | **Template Engine & Gallery** | Template provisioning engine: M36 depth. Versioned immutable templates, preview, validate, apply, rollback, T1 & T2 initial set. | P1 + P2 | 6–9 (±40%) | **NOT STARTED** | Pilot (Day-7 Gate) |
| **P4** | **Sales & Transactions** | Deal & money chain: M6, M7, M12, M13, M24, M26, M27. Dual pipelines (S/P), cost sheets, RERA §13 gate, payment schedules, demands, CP accruals. | P0→P1→P2→P4 (Strict Spine) | 10–16 (±40%) | **NOT STARTED** | Pilot (Finance Sign-off) |
| **P5** | **Team & Org Management** | Hierarchy & governance: M10, M11, M36. Branch/team hierarchy, 17 default roles, field masking, export gating, exit handover, pond. | P1 | 7–11 (±40%) | **NOT STARTED** | Pilot → General |
| **P6** | **Communication** | WhatsApp-first inbox: M20, M21, M35. Shared inbox, Meta template categories & cost warnings, consent ledger, telephony logging. | P1 | 8–13 (±60%) | **NOT STARTED** | Pilot → General |
| **P7** | **Marketing** | Demand & source truth: M18, M19, M35. Campaign spend, portal intake checklists (no scraping), website forms, recorded-spend ROI. | P1 + P6 | 5–8 (±60%) | **NOT STARTED** | Pilot → General |
| **P8** | **Automation** | Auditable workflow automation: M31, A1–A16 catalogue. Rules engine, execution log, cadences, stale recycling, bulk guardrails. | P1 + P6 | 6–9 (±40%) | **NOT STARTED** | Pilot → General |
| **P9** | **Analytics** | Role dashboards & metrics: M32, §19 catalogue. 8 role dashboards, frozen metric definitions, descriptive forecasting v1. | Event contracts (P1–P8) | 6–10 (±40%) | **NOT STARTED** | Pilot → General |
| **P10** | **Integrations** | Provider-specific adapters: M35. Portals (webhook/email only), payment tracking, accounting (Tally sync), non-excluded e-sign. | Adapter Contract | 8–13 (±60%) | **NOT STARTED** | Per-Provider Rollout |
| **P11** | **Mobile** | Field-agent app: Android first, iOS second. Offline-first daily worklist, site visits, outcome capture, camera, sync queue. | API Contracts (P1–P4) | 9–14 (±40%) | **NOT STARTED** | Android Pilot → General |
| **P12** | **AI Assistance** | Permission-scoped, human-approved AI: M33. NL queries, conversation summaries, message drafting, match suggestions, copilot. | P1–P6 Data + Consent | 8–12 (±60%) | **NOT STARTED** | Opt-in Feature Rollout |
| **P13** | **Enterprise** | Multi-branch enterprise depth: M36, Overlay. White-label customer portal, custom domains, SSO, sandbox, advanced audit. | P5 + P8 + P10 | 10–15 (±40%) | **NOT STARTED** | Enterprise Tier Gate |
| **P14** | **Production Hardening** | Final release gate: Pen-testing, load testing, backup/restore drills, legal/CA review closure, runbooks. No new features. | All Shipped Phases | 4–6 (±40%) | **NOT STARTED** | General Production Gate |

---

## 3. Module Classification & Ownership Architecture (M1–M36)

Per Document B §3 and Master §25, all 36 modules are strictly classified into **20 Shared-Primary** and **16 Real-Estate-Primary**:

| Module ID & Name | Primary Class | Shared? | RE-Specific? | Configurable? | External? | Future Parts? | Target Package Location |
|---|---|---|---|---|---|---|---|
| **M1: Lead Management** | Shared | ● | ◐ | ● | ◐ | ◐ | `packages/crm-core` |
| **M2: Contact & Customer Management** | Shared | ● | ◐ | ● | ○ | ○ | `packages/crm-core` |
| **M3: Property Inventory Management** | RE-Specific | ◐ | ● | ● | ◐ | ○ | `packages/products/real-estate` |
| **M4: Property Listings** | RE-Specific | ○ | ● | ● | ● | ○ | `packages/products/real-estate` |
| **M5: Project Management** | RE-Specific | ○ | ● | ● | ○ | ○ | `packages/products/real-estate` |
| **M6: Sales Pipeline** | Shared | ● | ◐ | ● | ○ | ○ | `packages/crm-core` |
| **M7: Deal & Transaction Management** | Shared | ● | ◐ | ● | ○ | ○ | `packages/crm-core` |
| **M8: Site Visit Management** | RE-Specific | ◐ | ● | ● | ◐ | ○ | `packages/products/real-estate` |
| **M9: Appointment Management** | Shared | ● | ◐ | ● | ◐ | ○ | `packages/crm-core` / `shared-services` |
| **M10: Broker & Agent Management** | RE-Specific | ◐ | ● | ● | ○ | ○ | `packages/products/real-estate` |
| **M11: Team Management** | Shared | ● | ◐ | ● | ○ | ○ | `packages/admin` / `crm-core` |
| **M12: Channel Partner Management** | RE-Specific | ○ | ● | ● | ○ | ○ | `packages/products/real-estate` |
| **M13: Commission & Brokerage Management** | RE-Specific | ○ | ● | ● | ○ | ○ | `packages/products/real-estate` |
| **M14: Builder & Developer Management** | RE-Specific | ○ | ● | ● | ○ | ○ | `packages/products/real-estate` |
| **M15: Unit & Inventory Management** | RE-Specific | ○ | ● | ● | ○ | ○ | `packages/products/real-estate` |
| **M16: Rental Management** | RE-Specific | ○ | ● | ● | ○ | ○ | `packages/products/real-estate` |
| **M17: Commercial Leasing** | RE-Specific | ○ | ● | ● | ○ | ○ | `packages/products/real-estate` |
| **M18: Marketing Management** | Shared | ● | ◐ | ● | ◐ | ○ | `packages/crm-core` |
| **M19: Campaign Management** | Shared | ● | ◐ | ● | ◐ | ○ | `packages/crm-core` |
| **M20: WhatsApp & Communication** | Shared | ● | ◐ | ● | ● | ○ | `packages/shared-services` |
| **M21: Call & Activity Management** | Shared | ● | ◐ | ● | ◐ | ○ | `packages/crm-core` |
| **M22: Task & Follow-up Management** | Shared | ● | ◐ | ● | ○ | ○ | `packages/work` |
| **M23: Document Management** | Shared | ● | ◐ | ● | ◐ | ○ | `packages/shared-services` |
| **M24: Booking Management** | RE-Specific | ○ | ● | ● | ○ | ○ | `packages/products/real-estate` |
| **M25: Customer Onboarding** | RE-Specific | ◐ | ● | ● | ○ | ○ | `packages/products/real-estate` |
| **M26: Payment Tracking** | RE-Specific | ○ | ● | ● | ◐ | ○ | `packages/products/real-estate` |
| **M27: Invoice & Receipt Management** | RE-Specific | ◐ | ● | ● | ◐ | ○ | `packages/products/real-estate` |
| **M28: Agreement & Contract Tracking** | RE-Specific | ◐ | ● | ● | ◐ | ○ | `packages/products/real-estate` |
| **M29: Customer Support** | Shared | ● | ◐ | ● | ○ | ○ | `packages/crm-core` |
| **M30: Complaint & Service Request** | Shared | ● | ◐ | ● | ○ | ○ | `packages/crm-core` |
| **M31: Workflow Automation** | Shared | ● | ◐ | ● | ○ | ◐ | `packages/automation` |
| **M32: Reporting & Analytics** | Shared | ● | ◐ | ● | ○ | ◐ | `packages/analytics` |
| **M33: AI Assistant** | Shared | ● | ◐ | ● | ● | ◐ | `packages/ai` |
| **M34: Import & Export** | Shared | ● | ○ | ● | ○ | ○ | `packages/imports` |
| **M35: Integrations** | Shared | ● | ◐ | ● | ● | ○ | `packages/integrations` |
| **M36: Administration & Configuration**| Shared | ● | ◐ | ● | ○ | ◐ | `packages/admin` / `platform-core` |

---

## 4. Release Milestones & Scope Boundaries

### MVP Release Boundary ("Useful to a Real Indian Real Estate Business")
- **Phases Included:** P0 + P1 + P2 + P3 (partial: T1 & T2) + P4 (core: deals, bookings, cost sheets, §13 gate, basic payments, CP-lite) + P5 (core: basic RBAC, ownership protection) + P6 (core: WhatsApp inbox + templates + consent) + P8 (core: assignment, reminders, stale discipline).
- **Templates Shipped:** T1 (Individual Agent) & T2 (Brokerage).
- **Exit Criteria:**
  1. Live lead source connected (webhook/website form).
  2. WhatsApp connected with approved templates & category cost warnings.
  3. Site visits booked & logged through the system (24h outcome discipline).
  4. Daily worklist active for every agent.
  5. One booking flows end-to-end: Token → Cost Sheet → Schedule → Demand → Receipt without spreadsheets.
  6. Day-7 onboarding gate passed in a real pilot organisation.
  7. Multi-tenant isolation verified with zero cross-tenant leakage.

### V1 Release Boundary ("Sellable Product")
- **Incremental Scope:** P3 remainder (T3, T4, T5 gallery + modifiers), P4 remainder (full commissions, clawback), P5 remainder (full branch hierarchy), P6 remainder, P7 (campaigns & portal checklists), P8 remainder (full automation library), P9 (8 role dashboards, frozen metric catalogue), P10-lite (core adapters), P11 (Android field app + offline sync), P14-lite (release hardening).
- **Exit Criteria:** Full 5-template gallery sellable at published pricing; Brokerage, Developer Pro, and Rental sellable; metered WhatsApp; complete role-based dashboard suite; zero per-customer engineering for standard onboarding.

### V1 Pro Release Boundary ("Differentiation Depth")
- **Incremental Scope:** P10 remainder (full adapter suite), P11 (iOS app + offline hardening), P12 (partial: first-release AI set), P9 (descriptive forecasting depth), Full CP Collaboration Pack (dispute evidence packs, payout batches, dual control).

### Enterprise Release Boundary ("Top Tier")
- **Incremental Scope:** P13 (multi-branch enterprise hierarchy, white-label customer portal, custom domains, SSO, sandbox, retention extensions, advanced reporting/APIs), P12 remainder, P14 remainder (full external pen-testing, drills, legal sign-offs).

---

## 5. Architectural Invariants & Cross-Module Rules

1. **G-CONSENT (Consent Before Send):** No automated message (WhatsApp, SMS, Email) may be dispatched without an active per-channel, per-purpose consent record. Withdrawal immediately suppresses in-flight and future sends with audit logging.
2. **G-REG-GATE (Jurisdiction-Aware Statutory Advance Gate):** Cumulative collections on a developer booking prior to a registered Agreement for Sale are governed by state-specific regulatory rules evaluated at runtime. Under no circumstances are statutory percentages or warning thresholds (such as 8% advisory / 10% hard block) hardcoded as universal business logic. Every rule must evaluate against the active jurisdiction (`IN-AP`, `IN-TG`, etc.) with its verified legal reference, effective date, and configured enforcement behaviour (`hard_block`, `warning`, `advisory`, `disabled`). Overrides require documented, audited legal exception.
3. **G-RERA-PROJECT / G-RERA-CP:** Marketing or publishing a project requires a valid RERA registration number; activating a Channel Partner requires a verified RERA agent license.
4. **G-MONEY-TRACK (Track, Never Hold):** Pravshi OS records demands, receipts, schedules, invoices, and commissions. It never holds customer money, never operates an escrow, and never acts as a payment executor.
5. **One-Live-Booking Invariant:** Exactly one live booking per inventory atom at any time. A hold is advisory; a booking is the hard lock. Double-booking attempts return a named conflict (409) and open a resolution task.
6. **Single Ownership & Audited Reassignment:** Every lead and deal has exactly one owner at a time. Ownership changes require a reason and preserve commission-split rights.
7. **Absolute Tenant Partition:** Query-level scoping enforced via PostgreSQL Forced RLS and `withAuthorizedDb()`. Cross-tenant search, joins, recent items, or contact merging are strictly impossible.
8. **E-Sign Immovable Property Exclusion:** Under the First Schedule of the Information Technology Act, 2000, contracts for the sale or conveyance of immovable property cannot be electronically executed. E-sign actions are strictly banned on sale deeds and agreements for sale.

### 5.1 Jurisdiction-Aware Compliance Configuration Architecture

**Founder Decision (2026-11-03):** Initial target markets are confirmed as **Andhra Pradesh (AP RERA)** and **Telangana (Telangana RERA)**. **Maharashtra is NOT selected for initial rollout.**

#### Architectural Invariants:
1. **Jurisdiction Independence:** Support Andhra Pradesh (`IN-AP`) and Telangana (`IN-TG`) as independently configurable regulatory jurisdictions. Never assume identical rules, circulars, fee schedules, or thresholds apply across both states.
2. **Decoupled Architecture:** Keep regulatory compliance configurations strictly decoupled from generic Real Estate CRM business logic and core entities.
3. **Six State-Specific Regulatory Domains:**
   - **Project Registration & Verification:** State RERA project registration number formatting, validity checks, and phase-level sub-registrations.
   - **Agent/Broker Registration & Verification:** AP/Telangana broker registration number formatting, validity verification, and mandatory CP onboarding checks.
   - **Required Statutory Documents:** State-mandated document checklists (e.g., sanctioned plan, encumbrance certificate, proforma agreement for sale, RERA certificate).
   - **Booking & Advance Payment Checks:** Statutory advance caps prior to agreement registration, payment milestone definitions, and demand letter requirements.
   - **Mandatory Disclosures:** State-mandated carpet area definitions, title disclosures, and public registration citations on listings and brochures.
   - **Compliance Alerts & Expiry Tracking:** RERA quarterly return alerts, project completion date tracking, and broker license renewal triggers.
4. **Mandatory 7-Attribute Schema for Every Regulatory Rule:**
   - `jurisdiction`: ISO-based state identifier (e.g., `'IN-AP'`, `'IN-TG'`).
   - `rule_identifier`: Canonical string identifier (e.g., `'RERA-ADVANCE-LIMIT'`, `'RERA-AGENT-REG'`).
   - `source_reference`: Official statute, rule, government order, or circular citation.
   - `effective_date`: Valid-from ISO date.
   - `verification_status`: Status indicator (`'PENDING_LEGAL_VERIFICATION'`, `'VERIFIED_LEGAL_COUNSEL'`, `'NOT_APPLICABLE'`).
   - `applicable_workflow`: Targeted workflow key (`'project_publish'`, `'agent_onboarding'`, `'booking_advance'`, `'agreement_generation'`, `'demand_issuance'`, `'commission_disbursement'`).
   - `enforcement_behavior`: Configurable execution mode (`'hard_block'`, `'warning'`, `'advisory'`, `'disabled'`).
5. **Pilot Strategy & Verification Gate:** Andhra Pradesh and Telangana are treated as independent initial launch targets. Decoupled configuration enables either state to onboard pilot customers without waiting for simultaneous multi-state launch. **Statutory enforcement remains in `advisory` or `warning` mode until verified against official state RERA gazettes/rules and signed off by qualified legal counsel.**
6. **National Extensibility:** Schema is extensible for additional Indian states in future phases without schema migration or domain entity redesign.

---

## 6. Current Implementation Audit & Reconciliation Status

*Audit baseline established on 2026-11-03 against repository commit `c39180e`.*

| Domain Area | Current Repository State | Gap / Finding | P0 Action Required |
|---|---|---|---|
| **Git & Worktrees** | Clean working tree on `main` (`c39180e`). | Feature branches exist for earlier platform work; `feature/phase-3-scaffolding` recently merged. | Follow milestone workflow: branch from `origin/main` to `feature/frontend/<task>` or task branches in isolated worktrees. |
| **Database Schema** | 89 migrations (`0000` to `0088`). Core CRM tables (`companies`, `contacts`, `deals`, `activities`, `pipelines`) exist in `public`. | **Zero real estate tables exist** in SQL migrations. `packages/database/src/schema.ts` is empty (raw SQL migration approach). Migration 0080 has `real_estate_crm` disabled. | Create database design specification for P2/P4 tables; extend template registry in P3. (No schema changes in P0). |
| **Real Estate Package** | Scaffolding in `packages/products/real-estate` (domain models for listing, deal, site visit, pipeline; interfaces in data-access; zod schemas; 3 events). | **Scaffolding only.** Lacks Project/Tower/Unit hierarchy, cost sheets, RERA gates, CP claims, tenancy/leasing models. Has no concrete database implementation. | Keep scaffolding isolated at L4; freeze domain entity contracts during P0. |
| **Contracts Package** | `packages/contracts` contains only base envelopes (`PaginationQuery`, `ApiSuccessResponse`, `ApiErrorResponse`). | No domain event schemas or resource-level request/response contracts for Real Estate. | Define and freeze Real Estate cross-module event schemas and API contracts in `packages/contracts`. |
| **Domain Events** | `packages/shared-services/src/events/index.ts` has generic CRM/Work events wired to workflow engine. | Missing all Real Estate domain events (18 groups, 26 individual events: `lead.*`, `visit.*`, `inventory.*`, `booking.*`, `payment.*`, `commission.*`, `cp.claim.*`). | Register Real Estate event ports and subscribers in shared services and composition roots. |
| **Security & Tenancy** | Robust L2 platform: forced RLS, `withAuthorizedDb()`, `requirePermission()`, AAL2 MFA enforcement, session isolation. | Standard 14 system roles exist; Real Estate's 17 role definitions (R1–R17) and permissions do not exist in the database. | Author Real Estate permission keys and role definitions as configuration sets. |
| **Web Application** | `apps/web/src/app` contains generic CRM (`/crm/*`), work (`/work/*`), admin, analytics, workflows, jobs. | **Zero real estate pages or components.** Navigation (`nav-items.ts`) has no real estate workspaces. | Design UI/UX architecture and workspace routing for Real Estate command centre and pipelines. |
| **Mobile Platform** | `packages/mobile-platform` and `apps/mobile` scaffolded with offline queue, secure enclave, dynamic theming. | Scaffolding only; lacks field-agent worklist, visit outcome logging, camera listing capture. | Mobile field contracts to be aligned with P1/P2/P11. |
| **Website & White-Label** | `packages/website-platform` and `packages/white-label-platform` scaffolded with projection/PII filters and theme compilers. | Platforms scaffolded, but no real estate listing projection or portal implementations. | Ready for P7 and P13 consumption. |

---

### 6.1 Status Update — 2026-11-12 (`main` at `084e79f`)

What has merged since the §6 baseline, from the Git history of `main`:

| PR | Merged | Delivered | Evidence on `main` |
|---|---|---|---|
| #116 — PR-RE-001 (P0 contracts freeze) | 2026-11-03 | Real Estate contract schemas, including multi-jurisdiction compliance schemas; the first shared CRM lead contract | `packages/contracts/src/products/real-estate/` (`compliance`, `inventory`, `jurisdiction`, `leads`, `transactions`, `visits`); `packages/contracts/src/crm/leads.ts`; `tests/products/real-estate-contracts.test.ts` |
| #117 — PR-RE-002 (P0 domain event ports) | 2026-11-03 | Real Estate domain event ports, canonical event identity, event-type dedup isolation | `packages/contracts/src/products/real-estate/events.ts`; `packages/shared-services/src/events/real-estate.ts`; `tests/products/real-estate-events.test.ts`, `tests/events/real-estate-workflow-safety.test.ts` |
| #118 — PR-P1-01 (P1 database foundation) | 2026-11-12 | Migration `0089_crm_leads_and_lineage`: shared-CRM lead tables (`crm_leads`, assignment history and cursors, lead tasks, dedup candidates, attribution corrections, attribution-policy ledger) with forced RLS, the governed attribution workflow and its rollback; shared CRM contracts (revised `leads`, new `tasks` and `attribution`) | `packages/database/drizzle/0089_crm_leads_and_lineage.sql`; `packages/database/src/schema.ts`; `packages/contracts/src/crm/`; tests under `tests/tenant-isolation/` and `tests/migration/` |
| #119 — test reliability | 2026-11-12 | Race-narrowed observer for the audit-partition lock-order test (test-only) | `tests/serial/audit-partition-lock-order.test.ts` |

Status of the §6 findings:

- **Database schema:** no longer "zero lead tables". 0089 adds the shared-CRM lead foundation — it is
  generic CRM (P1), not Real Estate domain tables (those remain P2/P4). Besides the tables above it
  creates an operational table (`crm_statement_identity`) and alters `contacts` (merge lineage) and
  `activities` (`logged_at`, lead support). `packages/database/src/schema.ts` is no longer empty: #118
  added Drizzle definitions for the six main lead tables (not for the policy ledger or
  `crm_statement_identity`). The repository records 0089 as never applied to a persistent
  database; applying it requires the per-database approvals and the checks in
  `docs/runbooks/production-migration.md`.
- **Contracts package:** no longer base envelopes only — the Real Estate contracts (#116/#117) and the
  shared CRM contracts (`leads` from #116, revised by #118; `tasks` and `attribution` from #118) are
  present.
- **Domain events:** Real Estate event ports registered (#117).
- **Real Estate package, web application, mobile, website and white-label:** unchanged since §6 — still
  scaffolding, with no Real Estate screens or navigation.
- **Lead service layer:** `packages/crm-core` has no lead services yet; #118 delivered the database and
  contract layers only.

## 7. Open Decisions & Founder Review Gates

1. **U-01 (Hypothetical Pricing Ladder):** Confirm whether Starter ₹999, Business ₹2,499, Pro ₹4,999, Pro Max ₹9,999, Enterprise Custom remain approved hypotheses for pilot benchmarking.
2. **U-02 (Target State Selection — RESOLVED & DIRECTED):**
   - **Confirmed Target States:** **Andhra Pradesh (AP RERA)** and **Telangana (Telangana RERA)**.
   - **Maharashtra:** Explicitly **NOT** selected for initial rollout.
   - **State-Specific Legal Verification:** **PENDING** qualified legal/CA review for both AP and Telangana statutory circulars, fee rules, and mandatory agreement provisions.
   - **Regulatory Configuration Architecture:** **REQUIRED** — jurisdiction-aware, state-configurable engine with 7-field rule contract.
   - **Pilot Launch Sequence:** **FOUNDER DECISION PENDING** (whether AP, Telangana, or both launch in parallel for the initial pilot cohort).
3. **U-03 (Pilot Cohort Recruitment):** Confirm recruitment plan for 3–5 pilot customers (1 solo broker, 1 small agency, 1 developer, 1 CP network).
4. **U-04 (WhatsApp Provider Route):** Direct Meta Cloud API vs Business Solution Provider (AiSensy / Gupshup / Interakt) for initial pilot rollout.
5. **U-07 (Engineering Team Size & Seniority):** Calendar delivery dates cannot be committed until team resourcing is finalized; roadmap currently expressed in team-week ranges (±40%).
6. **U-09 (Legal & CA Verification Checklist):** Close verification on DPDP Gazette effective date, TDS 194H rate (2% vs 5%), GST SAC classification for brokerage, RERA §13 state-specific cost definition, and IT Act First Schedule e-sign exclusions.
7. **P0 Report Approval Gate — RESOLVED:** The founder approved the Phase 0 reports and signed off P0 as complete (recorded 2026-11-12).
8. **Founder gates on the P1 attribution and lead foundation (set by the founder with PR #118):**
   - Before attribution-correction workflows are exposed to users, and before the related
     invitation/permission workflows are enabled: the open security findings from the PR #118
     reviews, which are recorded privately, must be resolved and independently reviewed.
   - Before user-facing high-risk attribution operations are activated: a **step-up MFA screen**
     (fresh second-factor sign-in) must exist; the database refuses those operations without it.
   - Applying 0089 to any persistent database needs separate founder approval per database.

---

## 8. Revised PR Execution Sequence

Detailed architecture and evidence analysis recorded in [PHASE_0_SECOND_REVIEW_AND_CLOSURE_PLAN.md](./PHASE_0_SECOND_REVIEW_AND_CLOSURE_PLAN.md).

```
REVISED PR SEQUENCE (status as of 2026-11-12):
├── PHASE 0: READINESS & CONTRACT FREEZE                                    [COMPLETE]
│   ├── PR-RE-001: P0 Contracts Freeze (packages/contracts, packages/products/real-estate)
│   │              → merged as #116
│   └── PR-RE-002: P0 Domain Event Ports Registration (packages/shared-services)
│                  → merged as #117
│
└── PHASE 1: CORE CRM & LEAD ENGINE                                         [IN PROGRESS]
    ├── PR-RE-003: Generic Lead Entity & Schema (packages/crm-core, packages/database)
    │              → database and contract layers delivered as PR-P1-01 (#118, migration 0089);
    │                the packages/crm-core service layer is not yet built
    ├── PR-RE-004: Lead Capture, Dedupe Preview & Worklist Wiring (packages/crm-core, packages/work)
    │              → not started
    └── PR-RE-005: Frontend Lead Views & Shell Navigation (apps/web, packages/shared-ui)
                   → not started
```

Naming note: the database foundation was tracked in engineering as **PR-P1-01** rather than
PR-RE-003, because the lead tables are shared CRM (P1, `packages/database`), not Real Estate domain
tables. The next engineering step is tracked as **PR-P1-02** and has not started; its scope is to be
confirmed against PR-RE-003 (service layer) and PR-RE-004 before work begins.

---

*Last Updated: 2026-11-12 (status refresh against `main` at `084e79f`; original 2026-11-03) | Maintainer: Lead Engineering Architect & Implementation Orchestrator*

