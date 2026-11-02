/**
 * @pravshi/product-education
 *
 * Education & Admissions Product Engine for Pravshi OS (Blueprint §06).
 * Follows the strict 6-tier architecture:
 * 1. domain (Pure business rules, types, and invariants)
 * 2. application (Orchestration and use cases)
 * 3. data-access (Tenant-scoped interfaces & query contracts)
 * 4. api (Schema validations and route handler contracts)
 * 5. contracts (Public events and cross-module interfaces)
 * 6. root exports
 */

export * from './domain';
export * from './application';
export * from './data-access';
export * from './api';
export * from './contracts';
