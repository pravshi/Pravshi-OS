# @pravshi/product-education

Vertical education and academic management product package for Pravshi OS, providing end-to-end higher education admissions pipelines, curriculum and intake scheduling, applicant document verification, fee schedules, and student matriculation.

## Architectural Tier (Blueprint §06)

Adheres to the standardized 6-tier architecture:

1. **Domain (`src/domain/`)**: Pure business logic, types, and invariants:
   - `program.ts`: Programs, course catalogs, academic years, and intake capacity constraints.
   - `applicant.ts`: Multi-stage applicant lifecycle, counselling notes, and document verification rules.
   - `student.ts`: Student matriculation, enrollment status, attendance tracking, and installment fee schedules.
   - `admissions-pipeline.ts`: Discrete stage machine enforcing mandatory document checks before offers.
2. **Application (`src/application/`)**: Use-case orchestration:
   - `register-applicant.ts`: Validates capacity and intake deadlines before creating applicants.
   - `process-application.ts`: Advances applicant stages, checks verified credentials, emits events.
   - `enroll-student.ts`: Matriculation orchestration, fee schedule verification, and batch count management.
3. **Data Access (`src/data-access/`)**: Tenant-scoped query contracts:
   - `repository.ts`: Tenant-bound interfaces for programs, applicants, and students.
4. **API (`src/api/`)**: Zod validation schemas and route contracts:
   - `schemas.ts`: Strict input validation for programs, intakes, applications, and documents.
5. **Contracts (`src/contracts/`)**: Cross-module interfaces and domain events:
   - `events.ts`: `ApplicationSubmittedEvent`, `StudentEnrolledEvent`.
6. **Root Interface (`src/index.ts`)**: Re-exports all domain, application, data-access, api, and contract modules.

## L4 Multi-Tenant Isolation Guarantees

- **Layer 4 Placement**: Sits at the L4 Tenant Domain layer under ADR-010.
- **Dependency Flow**: Imports downward into L0 (config/utils), L1 (infrastructure), L2 (security/authz), and L3 (shared-services/events). Never imports peer product modules (e.g. `@pravshi/product-real-estate`) or control plane modules (`@pravshi/platform-core`).
- **Postgres Forced RLS**: All database transactions are scoped transaction-locally via `withAuthorizedDb()`. The `organizationId` is strictly stamped from the authenticated session context (`auth.ctx.orgId`), ensuring absolute isolation across tenants.
- **Fail-Closed Semantics**: Unauthenticated or unauthorized context results in immediate query refusal or zero returned rows.
