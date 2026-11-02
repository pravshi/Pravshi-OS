/**
 * @pravshi/website-platform
 *
 * Public Website Engine & Custom Domain Platform for Pravshi OS (Blueprint §13).
 *
 * Provides:
 * - 1:1 tenant site binding & subdomain management
 * - DNS verification state machines (TXT/CNAME challenges)
 * - Safe CMS content modeling with draft/published state
 * - Strict public projection engine filtering PII & internal financial data
 * - Edge anti-abuse defenses (honeypots, rate limiters, time-gates, sanitizers)
 * - Public domain events for publishing and inbound lead ingestion
 */

export * from './domain';
export * from './application';
export * from './api';
export * from './contracts';
