# @pravshi/website-platform

Tenant website engine, custom domain registry, and public content projection platform for Pravshi OS (Blueprint §13).

## Core Capabilities

1. **Site Registry & 1:1 Tenant Binding (`src/domain/site.ts`)**:
   - RFC 1123 compliant subdomain validation with reserved namespaces (`api`, `admin`, `app`, etc.).
   - Strict 1:1 binding per tenant organization in V1.
2. **DNS Verification State Machine (`src/domain/domain-verification.ts`)**:
   - Discrete state machine: `pending` -> `verified` -> `active` (with `failed` and `revoked` safeguards).
   - Automated DNS TXT challenge token generation and verification orchestration.
3. **Draft & Published Content Engine (`src/domain/content.ts`)**:
   - Acyclic navigation tree verification.
   - Structured content blocks with monotonic version increments upon publication.
4. **Public Projection Engine & PII Filtering (`src/domain/projection.ts`)**:
   - **Zero PII Leakage Guarantee**: Strict field allowlists ensure sensitive internal data (commission splits, internal price negotiations, seller/landlord personal contacts, tenant screening records) are completely scrubbed before public web projection.
5. **Anti-Abuse & Bot Protection (`src/api/anti-abuse.ts`)**:
   - Honeypot fields to trap automated crawlers.
   - Time-gate validation to reject unnaturally fast form submissions.
   - In-memory sliding window rate limiters.
   - HTML/script tag stripping against stored and reflected XSS.
6. **Public Domain Contracts (`src/contracts/events.ts`)**:
   - `DomainVerifiedEvent`, `SitePublishedEvent`, `PublicInquiryReceivedEvent`.

## Security Boundaries & Isolation

- **Layer 4 Separation**: Sits within the tenant application ecosystem, projecting only allowlisted entities.
- **Fail-Closed Tenancy**: Administrative updates require verified `Authorization` tokens bound to `auth.ctx.orgId`.
- **Public Surface Shielding**: Edge route handlers utilize the projection engine to emit only sanitized, non-PII DTOs.
