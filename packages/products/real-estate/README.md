# @pravshi/product-real-estate

Vertical real estate product package for Pravshi OS, implementing the full real estate lifecycle (property listings, multi-unit inventory, site visit verification, broker commission splits, and sales/rental transaction pipelines).

## Architectural Tier (Blueprint §06)

This package strictly adheres to the 6-tier architecture:

1. **Domain (`src/domain/`)**: Pure business logic, types, and invariants:
   - `listing.ts`: Property types, unit inventory, pricing structures, publication invariants.
   - `site-visit.ts`: Time window constraints, verification methods, feedback ratings.
   - `deal.ts`: High-value transaction safeguards, booking tokens, broker commission split math.
   - `pipeline.ts`: Sales vs Rental pipeline invariants and transition guards.
2. **Application (`src/application/`)**: Use-case orchestration:
   - `create-listing.ts`: Listing creation & validation with publish orchestration.
   - `schedule-site-visit.ts`: Scheduling & verified completion flow.
   - `manage-deal.ts`: Deal progression, booking token clearing, commission calculation.
3. **Data Access (`src/data-access/`)**: Tenant-scoped query contracts:
   - `repository.ts`: Repository interfaces requiring `Authorization` and `Tx` contexts.
4. **API (`src/api/`)**: Zod validation schemas and route contracts:
   - `schemas.ts`: Strongly typed schemas for listings, visits, tokens, splits, and queries.
5. **Contracts (`src/contracts/`)**: Cross-module interfaces and domain events:
   - `events.ts`: `ListingPublishedEvent`, `SiteVisitCompletedEvent`, `DealClosedWonEvent`.
6. **Root Interface (`src/index.ts`)**: Clean re-export of public capabilities.

## L4 Multi-Tenant Isolation Guarantees

In accordance with ADR-010 and the Pravshi OS multi-tenant isolation model:

- **Layer 4 Placement**: Sits at the L4 Tenant Domain layer.
- **Dependency Flow**: Imports downward into L0 (config/utils), L1 (infrastructure), L2 (security/authz), and L3 (shared-services/events). Never imports peer product modules (e.g. `@pravshi/product-education`) or control plane modules (`@pravshi/platform-core`).
- **Postgres Forced RLS**: All database transactions are scoped transaction-locally via `withAuthorizedDb()`. The `organizationId` is strictly stamped from the authenticated session context, ensuring absolute tenant partition.
- **Fail-Closed Semantics**: Missing or mismatched tenant credentials result in immediate query refusal or zero returned rows.
