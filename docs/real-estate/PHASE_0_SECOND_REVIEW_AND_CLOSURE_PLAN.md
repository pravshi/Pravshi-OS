# PRAVSHI OS — REAL ESTATE CRM
## PHASE 0: SECOND ENGINEERING REVIEW, EVIDENCE VALIDATION & P0 CLOSURE PLAN

> **Document Type:** Architecture & Security Checkpoint Report  
> **Status:** CLOSED — P0 COMPLETE (PR-RE-001 merged as #116, PR-RE-002 as #117; founder sign-off recorded 2026-11-12). This report is the historical P0 record; current status is maintained in the Master Roadmap (§6.1).  
> **Authoritative References** (Documents A and B are founder-held, external to this repository; cited by title only):  
> - Document A: *Indian Market Research, Competitive Intelligence & Complete Product-Building Blueprint* (85 pages)  
> - Document B: *Founder Review Addendum* (63 pages)  
> - Master Roadmap: `docs/real-estate/REAL_ESTATE_CRM_MASTER_ROADMAP.md`  
> - Monorepo Baseline: `main` at commit `c39180e` (PR #115) — the state this review was written against  
> **Maintainer:** Lead Engineering Architect & Product Implementation Orchestrator

---

## 1. Executive Assessment

Following your directive, an independent, rigorous second engineering review of the Phase 0 Repository Reconciliation & Readiness Audit has been executed.

### Core Verdict
1. **The Core Platform Security Model is Genuine and Enforced in Code:** The database-enforced multi-tenancy, transaction-local identity scoping ([`withAuthorizedDb()`](../../packages/database/src/authorized.ts)), connection pool role verification ([`APP_ROLE = 'app_user'`](../../packages/database/src/pool.ts#L5), [`PLATFORM_ROLE = 'app_platform'`](../../packages/database/src/platform-pool.ts#L26), [`app_worker`](../../packages/database/src/worker-pool.ts#L10)), and application-layer access gates ([`requirePermission()`](../../packages/security/src/authz/require-permission.ts)) are actively enforced and tested. However, calling the platform "production-grade" in our initial audit was premature: while the static code guards pass (518 tests), several live PostgreSQL integration tests and external penetration assessments remain pending.
2. **Scaffolding vs. Implementation Boundary Clarified:** PR #115 (`75f01d9`) introduced code skeletons across [`packages/products/real-estate`](../../packages/products/real-estate), [`packages/mobile-platform`](../../packages/mobile-platform), [`packages/website-platform`](../../packages/website-platform), and [`packages/white-label-platform`](../../packages/white-label-platform). **None of these represent working implementations.** There are zero database tables for real estate, no active domain event bindings, no live repository data-access layers, and zero user-facing screens in [`apps/web`](../../apps/web).
3. **P0 Boundaries Respected:** P0 is strictly an engineering readiness, contract freeze, and architectural reconciliation phase. It must **not** leak into implementing business workflows (P1/P2/P4).
4. **Permanent Memory Established:** The source-of-truth document [`docs/real-estate/REAL_ESTATE_CRM_MASTER_ROADMAP.md`](./REAL_ESTATE_CRM_MASTER_ROADMAP.md) records the 15-phase roadmap, 36-module classification, packaging, and risk controls. *(Correction, 2026-11-12: when this review was written the roadmap existed only as an untracked file; it was first committed to the repository with the 2026-11-12 status refresh.)*

---

## 2. Corrections to the Original Audit

Our second-pass review identified seven specific corrections to our initial findings:

| # | Topic | Original Audit Claim | Verified Reality / Correction | Impact |
|---|---|---|---|---|
| **C-1** | **M1 Lead Entity** | "Generic contacts, deals, activities exist... leads modeled as early-stage deals." | **Incorrect assumption.** In Document B §21 and §4.4, `Lead` is a distinct entity (`Lead N—1 Contact on conversion; Lead N—1 Listing`). In the existing schema (migration `0033`), `deals` requires a deal title and pipeline, and `contacts` represents already-identified persons. Forcing inbound leads into `deals` breaks RERA source attribution and deduplication queues. **Correction:** P1 must formally introduce a dedicated generic Lead domain entity in [`packages/crm-core`](../../packages/crm-core). | Major architectural alignment for P1. |
| **C-2** | **Event Count Precision** | "19 event groups in Document B §9.2." | **Clarified count:** Document B §9.2 table contains **18 table rows (functional groups)** representing **26 distinct, individual domain event names** (e.g., `inventory.hold`, `inventory.block`, `inventory.release` are 3 separate events in 1 row; `commission.accrued`, `approved`, `paid`, `clawed_back` are 4 events in 1 row). | Full precision for event port registration. |
| **C-3** | **Readiness Labeling** | Termed platform "production-grade". | **Overstated label.** Code inspection confirms strong security architecture, but live PostgreSQL isolation test suites (such as `tests/guards/runtime-role.test.ts` and `rls-enabled.test.ts`) require a live test database environment. External pen-testing and load testing are P14 gates. **Correction:** Downgraded to **"Architecture & Code-Guards Verified; Live Integration & Pen-Test Pending"**. | Honest evidence labeling. |
| **C-4** | **Initial Vertical Slice** | Included WhatsApp auto-send and round-robin assignment in first vertical slice. | **Premature scope.** Neither Meta WhatsApp Business Platform nor capacity-weighted round-robin assignment exists in code. Proposing them in the first slice would fail acceptance. **Correction:** Redefined vertical slice to use standard in-app notifications and manual/basic assignment. | Feasible, unblocked P1 kickoff slice. |
| **C-5** | **PR-RE-003 Navigation** | Proposed updating shell navigation in P0 (`PR-RE-003`). | **Premature PR.** Exposing Real Estate navigation in [`apps/web/src/components/shell/nav-items.ts`](../../apps/web/src/components/shell/nav-items.ts) before screens exist creates broken, dead links in the web client. **Correction:** Dropped `PR-RE-003` from P0. Navigation updates move to P1/P2 alongside working screens. | Prevents broken UI deployments. |
| **C-6** | **Template Model Upgrade Conflict** | Assumed templates could easily be switched. | **Database Constraint Catch:** Migration `0080` has a trigger `organizations_type_guard()`: `if new.type_key is distinct from old.type_key then raise exception 'an organization''s type is fixed once it is created'`. If T1 (Individual Agent) and T2 (Brokerage) were distinct `type_key` values, solo-to-agency upgrades would be hard-blocked by PostgreSQL. **Correction:** All 5 templates share `type_key = 'real_estate_crm'`, with template variants configured as versioned JSON definitions. | Prevents breaking tenant upgrades. |
| **C-7** | **L4-to-L4 Direct Imports** | Assumed `packages/products/real-estate` could directly call `packages/crm-core`. | **Guard Violation:** ADR-010 Rule 3 forbids L4 domain modules from importing peer L4 domain modules unless explicitly allowlisted. `product-real-estate` cannot import `crm-core` directly. **Correction:** Inter-package communication must occur exclusively via `@pravshi/contracts` (L3) or `@/lib/events` (L3). | Prevents guard test failures. |

---

## 3. Evidence-Backed Security Assessment

To prevent unsubstantiated claims, every security control is classified by verification evidence:

```
EVIDENCE CLASSIFICATION KEY:
[CIV] Code Inspection Verified: Verified by manual source code analysis and AST walking.
[AGV] Automated Guard Verified: Verified by passing static guard tests in tests/guards/*.
[RTV] Real PostgreSQL Test Verified: Verified by executing queries against an active Postgres engine.
[NPV] Not Yet Verified: Verification blocked, unstarted, or requires live infrastructure.
```

| Security Mechanism | Blueprint Requirement | Repository File & Implementation | Evidence Level | Findings & Gap Analysis |
|---|---|---|---|---|
| **Forced PostgreSQL RLS** | Forced RLS on every table in `public`; zero bypass. | Migration files `0000`–`0088`; [`tests/guards/rls-enabled.test.ts`](../../tests/guards/rls-enabled.test.ts) | **[CIV] [AGV]** | Every table created in migrations has `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. Real Postgres execution [RTV] requires live test database. |
| **Transaction-Local Identity** | Context stamped via `set_config(..., true)` per transaction; zero session leakage. | [`packages/database/src/authorized.ts`](../../packages/database/src/authorized.ts#L44-L51) | **[CIV]** | `withAuthorizedDb()` sets `app.person_id`, `app.org_id`, `app.aal` with `is_local = true`. Client is strictly released in `finally` block. |
| **Application Access Gate** | 7-step fail-closed authorization check before DB queries. | [`packages/security/src/authz/require-permission.ts`](../../packages/security/src/authz/require-permission.ts#L29-L36) | **[CIV] [AGV]** | Validates session, identity, active engagement, AAL2 MFA, held permission, minScope, and target under RLS. [`tests/guards/require-permission-first.test.ts`](../../tests/guards/require-permission-first.test.ts) passes (14 tests). |
| **Mandatory MFA Enforcement** | AAL2 required for sensitive permissions at GLOBAL scope. | [`packages/security/src/auth/mfa-enforcement.ts`](../../packages/security/src/auth/mfa-enforcement.ts); migration `0027` | **[CIV] [AGV]** | Verified in [`tests/guards/mfa-enforcement-lockout.test.ts`](../../tests/guards/mfa-enforcement-lockout.test.ts) (25 tests pass). |
| **Database Role Separation** | Strict separation of `app_user`, `app_auth`, `app_worker`, `app_platform`, `app_owner`. | [`packages/database/src/pool.ts`](../../packages/database/src/pool.ts), [`worker-pool.ts`](../../packages/database/src/worker-pool.ts), [`platform-pool.ts`](../../packages/database/src/platform-pool.ts) | **[CIV] [AGV]** | Pools execute `verify` hooks verifying `session_user` matches the declared role. Refuses to execute if role mismatches. |
| **Connection Pool Cleanup** | Sockets released early; zero cross-request contamination. | `packages/database/src/pool.ts#L58-L61` | **[CIV]** | `idleTimeoutMillis: 10_000`, `max: 5`. Pool handles scale-to-zero compute suspension. |
| **Append-Only Audit Logs** | Immutable, partitioned audit events. No edit or delete by any role. | Migration `0011_audit_logs.sql`, `0062`, `0078`; [`packages/security/src/audit/log.ts`](../../packages/security/src/audit/log.ts) | **[CIV] [AGV]** | Monthly partition triggers, `NO TRUNCATE` trigger, update/delete privileges revoked. Tested in [`tests/guards/audit-export.test.ts`](../../tests/guards/audit-export.test.ts). |
| **Platform Console Isolation** | Platform Super Admin has zero access to customer tenant tables. | Migration `0083`–`0086`; [`packages/platform-core/src/service.ts`](../../packages/platform-core/src/service.ts) | **[CIV] [AGV]** | Platform runs on separate schema and pool (`app_platform`). `tests/guards/single-db-path.test.ts` pins that only `platform-core` imports `platform-pool`. |
| **Worker Tenant Isolation** | Background jobs run under tenant-local identity or `app_worker` security definers. | [`apps/worker/src/runner.ts`](../../apps/worker/src/runner.ts), [`handlers.ts`](../../apps/worker/src/handlers.ts) | **[CIV]** | Worker queue claims jobs via `app_worker`. Jobs modifying tenant records call `withAuthorizedDb()` using the job's recorded principal. |
| **Two-Org Isolation Tests** | Every tenant table must have an automated test asserting 2-org isolation. | [`tests/guards/security-inventory.test.ts`](../../tests/guards/security-inventory.test.ts) | **[CIV] [AGV]** | Enforced by security inventory guard. 8 tables currently listed in `ISOLATION_TEST_GAPS` (shrink-only baseline). All new RE tables must have explicit isolation tests. |

---

## 4. Shared CRM Reuse vs. Real Estate Specifics Assessment

Pravshi OS already contains robust shared CRM and Work capabilities in [`packages/crm-core`](../../packages/crm-core) and [`packages/work`](../../packages/work). We must strictly avoid duplicating these:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             WHAT CRM-CORE ALREADY OWNS                           │
│  - Companies & Contacts (CRUD, composite tenant foreign keys, soft delete)        │
│  - Deals & Pipelines (pipeline stages, probability, kanban ordering, move stage) │
│  - Activities (meetings, calls, notes, email filing, timeline queries)           │
│  - Relationships (company-to-company, contact-to-contact links)                   │
├──────────────────────────────────────────────────────────────────────────────────┤
│                             WHAT WORK ALREADY OWNS                               │
│  - Work Projects & Tasks (work_projects, work_tasks, project_members)             │
│  - Task Reminders (task_reminders, schedule tracking, reminder sweeps)           │
├──────────────────────────────────────────────────────────────────────────────────┤
│                     WHAT MUST BE ADDED (REAL ESTATE DOMAIN)                      │
│  - Inventory Atom (Unit / Property / LandParcel) & Project/Tower/Floor Hierarchy │
│  - Availability State Machine (Available, Hold, Blocked, Booked, Sold) + Audit   │
│  - Site Visits (24h outcome logging rule, geo check-in, CP claim perfection)     │
│  - Deal Money Chain (Cost sheets, payment schedules, demands, UTR reconciliation)│
│  - Channel Partner Claim Protection (timestamped window, dispute evidence packs) │
│  - Tenancy & Lease Engines (rent schedules, arrears ladder, deposit settlements) │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### The Lead Problem: Deal Stage vs. Dedicated Entity
- **Finding:** In `packages/crm-core`, a `Deal` currently requires a title and defaults into `crm_pipelines`.
- **Architectural Decision for P1:** A real estate enquiry is frequently an anonymous or unverified phone number from a portal or website form before an actual contact or deal exists. Modeling Leads as early-stage Deals clutters sales pipelines with garbage contacts and violates the deduplication-merge queue workflow (Document A §12.5).
- **Recommendation:** Implement a clean `Lead` entity in `packages/crm-core` that flows:  
  `Ingest Lead -> Dedupe Check -> Assign -> Qualify -> Convert to Contact + Deal`.

---

## 5. Real Estate Domain Readiness Matrix

Classification of the 17 core Real Estate domain entities in the current repository:

| Entity | Blueprint Definition | Code Location | Classification | Implementation Gap & Action Required |
|---|---|---|---|---|
| **InventoryAtom** | Abstract commercial unit (Unit / Property / LandParcel). | None | **MISSING** | Create unified atom interface and polymorphic foreign key contract in `packages/contracts`. |
| **Property** | Standalone resale / non-project asset atom. | None | **MISSING** | Define schema with regional area units, title evidence pointers, and mandate links. |
| **LandParcel** | Plotted land parcel with survey numbers. | None | **MISSING** | Define schema supporting bigha/guntha/cent with region + conversion factor. |
| **Project** | Developer scheme, RERA number, approvals. | None | **MISSING** | Define schema with phase breakdown and RERA registration expiry tracking. |
| **Tower** | Building/tower container inside a project. | None | **MISSING** | Define schema linking Project to Units. |
| **Unit** | Physical sellable apartment/office in project. | `PropertyUnit` in `domain/listing.ts` | **Interface Only** | Convert from inline listing interface to a first-class database entity. |
| **Listing** | Marketing offer for an inventory atom. | `RealEstateListing` in `domain/listing.ts` | **Interface Only** | Separate listing from publication records; wire mandate requirements. |
| **SiteVisit** | Physical visit with mandatory 24h outcome. | `SiteVisit` in `domain/site-visit.ts` | **Interface Only** | Add 24h outcome enforcement logic, overdue queues, and geo-checkin contracts. |
| **Deal** | Commercial deal referencing 1 inventory atom. | `RealEstateDeal` in `domain/deal.ts` | **Interface Only** | Align with dual S0–S7 / P1–P9 pipeline states; connect to Booking. |
| **Booking** | First-class object with RERA §13 gate. | `BookingToken` in `domain/deal.ts` | **Interface Only** | Expand beyond token into full Booking object with cost sheet attachment and 10% gate. |
| **Payment Schedule** | Milestone lines (construction/time linked). | None | **MISSING** | Create schedule generator linked to cost sheet and milestone milestones. |
| **Demand** | Issued demand letter with RERA number. | None | **MISSING** | Create demand entity with immutable snapshots and PDF generation contracts. |
| **Receipt** | Collections record with UTR reference. | None | **MISSING** | Create receipt ledger with duplicate-UTR hard block and 3-way reconciliation states. |
| **Commission** | Slab calculations, accrual, clawbacks. | `CommissionSplit` in `domain/deal.ts` | **Interface Only** | Implement deterministic calculation snapshots and dual-control approval batches. |
| **CP Claim** | Protected lead registration window. | None | **MISSING** | Create claim entity with server-generated timestamps and dispute evidence packs. |
| **Tenancy** | Monthly rental operating record. | `RENTAL_PIPELINE_STAGES` in `pipeline.ts` | **Interface Only** | Create tenancy lifecycle entity with rent schedules and arrears ladder. |
| **Commercial Lease** | Negotiated lease terms and escalation. | None | **MISSING** | Create lease entity with lock-in, CAM, escalation, and advance renewal alerts. |

---

## 6. Database and Migration Design Corrections

When migrations are authored in P2 and P4, they must strictly follow Pravshi OS database architecture conventions:

### Mandatory Schema Invariants
1. **Composite Tenant Foreign Keys:**  
   Every foreign key pointing to a tenant entity must be composite with `org_id` to prevent cross-tenant pointer injections:
   ```sql
   -- Correct composite tenant foreign key pattern:
   foreign key (unit_id, org_id) references public.re_units (id, org_id)
   ```
2. **Forced RLS & Single App Role:**  
   ```sql
   alter table public.re_units enable row level security;
   alter table public.re_units force row level security;
   create policy re_units_tenant_isolation on public.re_units
     for all to app_user
     using (org_id = authz.org_id())
     with check (org_id = authz.org_id());
   ```
3. **One-Live-Booking Invariant:**  
   To prevent double-booking at the database level, a partial unique index must be enforced on active bookings:
   ```sql
   create unique index re_bookings_single_live_atom_idx
     on public.re_bookings (unit_id)
     where status not in ('cancelled', 'refunded');
   ```
4. **Duplicate UTR Hard Block:**  
   Duplicate banking references across reconciled payments within the same organization must fail at the database constraint level:
   ```sql
   create unique index re_receipts_reconciled_utr_idx
     on public.re_receipts (org_id, payment_reference)
     where status = 'reconciled';
   ```
5. **No Tables Created in P0:**  
   All schema creation is deferred to P2 (Inventory/Properties) and P4 (Bookings/Transactions). P0 performs zero database migrations.

---

## 7. Event and API Contract Reconciliation

### Precise Event Reconciliation
The blueprint defines **18 functional event groups** comprising **26 individual domain event types**:

```
EVENT CATALOGUE: 18 GROUPS / 26 INDIVIDUAL EVENTS
├── 1. lead.created [M1 -> M31, M32, M20]
├── 2. lead.assigned [M1 -> M22, M20, M32]
├── 3. lead.converted [M1 -> M2, M7, M32]
├── 4. consent.withdrawn [M2 -> M20, M19, M31, M32] (IMMEDIATE SUPPRESSION)
├── 5. visit.scheduled [M8 -> M20, M22, M9]
├── 6. visit.completed [M8 -> M12, M7, M22, M32]
├── 7. inventory.state_changed (3 events) [M15 -> M4, M24, M32]
│      ├── inventory.hold
│      ├── inventory.block
│      └── inventory.release
├── 8. booking.created [M24 -> M15, M26, M13, M6]
├── 9. booking.cancelled [M24 -> M15, M26, M13, M27]
├── 10. payment.received [M26 -> M27, M13, M32]
├── 11. payment.reconciled [M26 -> M27, M13, M32]
├── 12. payment.reversed [M26 -> M13, M27, M32]
├── 13. demand.issued [M26 -> M27, M20, M32]
├── 14. commission.lifecycle (4 events) [M13 -> M12, M27, M32]
│      ├── commission.accrued
│      ├── commission.approved
│      ├── commission.paid
│      └── commission.clawed_back
├── 15. cp.claim.lifecycle (3 events) [M12 -> M24, M13, M32]
│      ├── cp.claim.registered
│      ├── cp.claim.expired
│      └── cp.claim.disputed
├── 16. message.send.suppressed [M20 -> M32, M2]
├── 17. template.lifecycle (2 events) [M36 -> M31, M32, M36]
│      ├── template.applied
│      └── template.rolled_back
└── 18. audit.recorded [M36 -> M32, M36]
```

### Decoupling Rules & Avoiding L4 Cycles
- **Port Location:** Event definitions must be exported from `packages/contracts/src/events/real-estate.ts`.
- **Emission Seam:** Emitted via `@/lib/events` (`packages/shared-services/src/events/index.ts`).
- **Registration Seam:** Registered strictly in [`src/lib/composition/domain-events.ts`](../../src/lib/composition/domain-events.ts). Emitting modules never import consumer modules directly.

---

## 8. Template Engine Readiness & Packaging Architecture

### Reconciling Packaging with Migration 0080
In migration `0080_organization_types.sql`, organizations carry:
`type_key text not null default 'generic_crm'` and `template_version integer not null default 1`.

#### Safe Packaging Design
To support the 5 provisionable templates without requiring illegal cross-type migrations or breaking `organizations_type_guard()`:
1. `type_key` in `public.organizations` remains `'real_estate_crm'`.
2. The template definition schema in `public.organization_type_templates` is expanded to store:
   - `template_key`: `'T1_INDIVIDUAL'`, `'T2_BROKERAGE'`, `'T3_DEVELOPER_PRO'`, `'T4_RENTAL_LEASING'`, `'T5_CP_OWN_BIZ'`.
   - `modifiers`: Array of enabled modifiers (`['ENTERPRISE_OVERLAY']`, `['CP_COLLABORATION_PACK']`).
   - `pipelines`: S0–S7 / P1–P9 stage configurations.
   - `dashboards`: Default role dashboard mappings.
   - `rules`: Rule library references.
3. Upgrades from Solo (T1) to Brokerage (T2) are non-destructive **in-family configuration updates**, preserving all historical data and audit trails.

---

## 9. Regulatory, Statutory & Consent Risk Analysis

| Gate / Requirement | Statutory / Legal Source | CRM Enforcement Mechanism | Legal / CA Verification Status |
|---|---|---|---|
| **G-RERA-13 (10% Gate)** | RERA Act 2016, Section 13 | Hard block on demands/receipts >10% before registered Agreement for Sale. Warning at 8%. | **PENDING CA / Legal Confirmation** on state-specific "cost" definitions. |
| **G-RERA-PROJECT** | RERA Act 2016, Sections 3 & 4 | Mandatory RERA registration number before marketing or publishing units. | **Statutory invariant.** Implemented as hard validation. |
| **G-RERA-CP** | RERA Act 2016, Section 9 | Agent RERA registration number mandatory before CP activation or claim protection. | **Statutory invariant.** Implemented as hard validation. |
| **G-CONSENT** | DPDP Act 2023 & TRAI DLT | Per-lead, per-channel, per-purpose consent ledger. Immediate suppression on withdrawal. | **PENDING Gazette check** on DPDP Phase 3 commencement date (13 vs 14 May 2027). |
| **E-Sign Ban on Immovable Property** | IT Act 2000, First Schedule | E-sign workflows strictly disabled for sale deeds / agreements for sale. Physical registration only. | **Statutory invariant.** Electronic execution forbidden by law. |
| **TDS on Property (194-IA)** | Income-tax Act, Section 194-IA | 1% TDS checklist item on sales ≥ ₹50 Lakh. CRM tracks filing; does not compute liability. | **PENDING CA confirmation** on Income-tax Act 2025 renumbering. |
| **TDS on Commission (194H)** | Income-tax Act, Section 194H | Configurable rate with "Confirm with CA" banner. (2% vs 5% unresolved dispute). | **PENDING CA confirmation.** Never hardcoded. |
| **GST on Brokerage (18%)** | GST SAC 997221–997224 | 18% GST charged on brokerage fee, never on property consideration. Versioned tax table. | **PENDING CA confirmation** on input tax credit treatment. |

---

## 10. Corrected Minimum Vertical Slice (For P1 Kickoff)

Our original slice assumed non-existent WhatsApp and round-robin features. Below is the **corrected, executable minimum vertical slice** for Phase 1:

```
CORRECTED VERTICAL SLICE V0-1: INBOUND CAPTURE TO DAILY WORKLIST
┌─────────────────────────┐
│ 1. Manual / Web Ingest  │ ──► Captured with immutable source stamp ('website_form' or 'manual')
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 2. Exact Dedupe Check   │ ──► Checks phone number (E.164); matches queue for review, never auto-merge
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 3. Deterministic Assign │ ──► Direct assignment to active agent or pond (unassigned) with audit reason
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 4. In-App Notification  │ ──► System emits notification to assigned agent via existing notification bell
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 5. Daily Worklist Task  │ ──► Task auto-created in packages/work with due date and linked lead reference
└─────────────────────────┘
```

**Why This Slice is Correct:**
- Fully supported by existing platform foundations ([`packages/crm-core`](../../packages/crm-core), [`packages/work`](../../packages/work), [`packages/shared-services/src/notifications`](../../packages/shared-services/src/notifications)).
- Requires zero external provider accounts (no Meta API key or telephony trunk needed).
- Directly demonstrates multi-tenant query isolation and audit log generation.
- Gives field agents a working worklist on day one.

---

## 11. P0 Completion Checklist

To formally close Phase 0, every item below must be satisfied:

*Closure record (2026-11-12): the founder signed off Phase 0 as complete. Each item's evidence is noted
in italics.*

- [x] **P0-1: Founder Architecture Review:** Formal review and sign-off on this second review report and package boundaries.
      *Founder sign-off recorded 2026-11-12.*
- [x] **P0-2: Real Estate Domain Contract Freeze:** *Merged as PR #116 (PR-RE-001).* Core Zod schemas and TypeScript interfaces frozen in `packages/contracts/src/products/real-estate/`:
  - `InventoryAtomSchema` (`Unit` vs `Property` vs `LandParcel`).
  - `LeadCaptureSchema` and `LeadConversionSchema`.
  - `SiteVisitSchema` and `SiteVisitOutcomeSchema`.
  - `BookingSchema` with Token and RERA §13 gate state.

  *The delivered names and locations differ from this list: `InventoryAtomSchema` as named;
  `SiteVisitScheduleSchema`, `SiteVisitOutcomeInputSchema` / `SiteVisitOutcomeRecordSchema` and
  `BookingContractSchema` under `packages/contracts/src/products/real-estate/`; the lead capture
  contract is the shared `LeadCaptureInputSchema` in `packages/contracts/src/crm/leads.ts`. No
  lead-conversion schema exists yet. Closed by the founder sign-off on this basis.*
- [x] **P0-3: Domain Event Ports Registration:** *Merged as PR #117 (PR-RE-002).* Register initial RE event types in [`packages/shared-services/src/events/index.ts`](../../packages/shared-services/src/events/index.ts):
  - `lead.created`, `lead.assigned`, `lead.converted`, `visit.scheduled`, `visit.completed`.
- [x] **P0-4: Test Target Environment Verification:** Document test command using `.invalid` placeholder URLs for database-free unit test execution.
      *Closed by the founder sign-off. No separate `.invalid`-placeholder test command is documented in
      `DEVELOPMENT.md` or `docs/development/`; since this review, CI runs the database suites against a
      disposable PostgreSQL.*
- [x] **P0-5: Repository Architecture Guards Passing:** Execute `pnpm vitest run tests/guards/` confirming 100% pass on boundary and isolation guards.
      *The `ci` job's `pnpm test` run, which includes `tests/guards/`, passes on `main` (e.g. on
      `084e79f`, 2026-11-12).*

---

## 12. Revised PR Breakdown

The PR sequence is restructured to separate P0 readiness from P1 execution, and drops premature UI navigation. *(Current status of each PR: Master Roadmap §8.)*

```
REVISED PR SEQUENCE:
├── PHASE 0: READINESS & CONTRACT FREEZE
│   ├── PR-RE-001: P0 Contracts Freeze (packages/contracts, packages/products/real-estate)
│   └── PR-RE-002: P0 Domain Event Ports Registration (packages/shared-services)
│
└── PHASE 1: CORE CRM & LEAD ENGINE
    ├── PR-RE-003: Generic Lead Entity & Schema (packages/crm-core, packages/database)
    ├── PR-RE-004: Lead Capture, Dedupe Preview & Worklist Wiring (packages/crm-core, packages/work)
    └── PR-RE-005: Frontend Lead Views & Shell Navigation (apps/web, packages/shared-ui)
```

### Detailed PR Specifications

#### PR-RE-001 — P0 Contracts & Domain Schemas Freeze
- **Branch:** `feature/p0-re-contracts-freeze` (branched from `origin/main` in isolated worktree).
- **Scope:** [`packages/contracts/src/products/real-estate/`](../../packages/contracts), [`packages/products/real-estate/src/domain/`](../../packages/products/real-estate/src/domain).
- **Owner:** Lead Engineering Architect.
- **Dependencies:** None.
- **Deliverables:** Freezes `InventoryAtom`, `Lead`, `SiteVisit`, `Booking`, and `PricingStructure` Zod schemas and type definitions.
- **Tests:** Unit tests in `tests/products/real-estate.test.ts` asserting schema validations and invariant failures.
- **Risk:** Low. No database or runtime API changes.

#### PR-RE-002 — P0 Domain Event Ports Registration
- **Branch:** `feature/p0-re-domain-events` (branched from `origin/main`).
- **Scope:** [`packages/shared-services/src/events/index.ts`](../../packages/shared-services/src/events/index.ts), [`src/lib/composition/domain-events.ts`](../../src/lib/composition/domain-events.ts).
- **Owner:** Backend Specialist / Lead Architect.
- **Dependencies:** PR-RE-001.
- **Deliverables:** Adds Real Estate domain event types to `DOMAIN_WORKFLOW_EVENT_TYPES`. Verifies composition root registers without error.
- **Tests:** [`tests/guards/domain-events-wired.test.ts`](../../tests/guards/domain-events-wired.test.ts) passes.
- **Risk:** Low. Additive changes to event port unions.

---

## 13. Founder Decisions Required

Before implementation commences, the following decisions are submitted for founder determination:

1. **Approval of Phase 0 Architecture Report:** Sign off on this report and authorise PR-RE-001 creation.
   *Resolved (2026-11-12): approved; PR-RE-001 merged as #116; P0 signed off.*
2. **Dedicated Lead Entity vs. Deal Stage (C-1):** Confirm that P1 will introduce a first-class `Lead` entity in `packages/crm-core` rather than forcing leads into the existing `deals` table.
3. **Template Packaging Storage Strategy (C-6):** Approve storing template variants (T1–T5) within the JSON definition of `organization_type_templates` under `type_key = 'real_estate_crm'` to preserve migration 0080's immutability guards while allowing solo-to-agency unlock.
4. **Target Pilot Launch State (U-02 — RESOLVED & DIRECTED):** Confirmed as **Andhra Pradesh (AP RERA)** and **Telangana (Telangana RERA)**. Maharashtra is explicitly **not** selected for initial rollout. Architecture must implement a jurisdiction-aware, state-configurable regulatory engine. Statutory verification is marked PENDING.

---

## 14. Remaining Blockers

*Both resolved (2026-11-12).*

1. **Founder Review Sign-off:** We are blocked from starting PR-RE-001 until you review and formally approve this report.
   *Resolved: approved; PR-RE-001 and PR-RE-002 merged (#116, #117); P0 signed off.*
2. **Disposable Test Database Target:** Unit tests run smoothly with `.invalid` placeholder URLs, but live PostgreSQL migration and RLS integration suites require a disposable test Postgres instance.
   *Resolved: CI provisions a disposable PostgreSQL for the live migration and RLS suites.*

---

## 15. Final Recommendation

**Do not begin Phase 1 coding yet.**

The recommended path is:
1. **Founder Approval:** Review and approve this Second Engineering Review Report.
2. **Execute PR-RE-001:** Create isolated worktree for `feature/p0-re-contracts-freeze` to freeze domain schemas in `packages/contracts`.
3. **Execute PR-RE-002:** Register RE domain event types in `packages/shared-services/src/events`.
4. **Declare P0 Complete:** Mark P0 as `COMPLETED AND VERIFIED` in [`REAL_ESTATE_CRM_MASTER_ROADMAP.md`](./REAL_ESTATE_CRM_MASTER_ROADMAP.md) and transition to Phase 1.

---

*Report filed at: `docs/real-estate/PHASE_0_SECOND_REVIEW_AND_CLOSURE_PLAN.md`*  
*Status (2026-11-12): Closed — the recommended path above was followed (PR-RE-001 → #116, PR-RE-002 → #117) and P0 was signed off by the founder. Phase 1 status is tracked in the Master Roadmap §6.1.*

