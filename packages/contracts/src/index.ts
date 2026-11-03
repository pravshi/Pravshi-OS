/**
 * Pravshi OS — Shared API and Inter-app Contracts (Step 8, package 7, Layer 3).
 *
 * Public request/response schemas, money primitives, domain transfer envelopes,
 * and product contracts shared across applications, background workers, and modules.
 *
 * NOTE: Base primitives live in ./base to prevent circular dependencies.
 */

export * from './base';
export * from './crm/leads';
export * from './products/real-estate/index';
