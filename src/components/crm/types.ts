import type { ErrorEnvelope } from '@/lib/authz/errors';

/**
 * CRM Core shared types — re-exported from the canonical server shapes in
 * src/lib/crm/schema.ts (PR #31). The wire contract is camelCase; the database
 * keeps snake_case columns and the API translates at the boundary.
 *
 * UI-only helpers (form option lists, error-envelope handling) live here.
 */
export {
  DEAL_STAGES,
  type DealStage,
  type Company,
  type Contact,
  type Deal,
  type Page,
} from '@/lib/crm/schema';
import type { Contact } from '@/lib/crm/schema';

export const COMPANY_SIZES = ['STARTUP', 'SMB', 'MID_MARKET', 'ENTERPRISE'] as const;

export type CompanySize = (typeof COMPANY_SIZES)[number];

export type CrmResult<T> = T | ErrorEnvelope;

/** Server actions return failures as data: { error: { code, message, ... } }. */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  if (!('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return typeof error === 'object' && error !== null && 'message' in error;
}

export function contactDisplayName(c: Pick<Contact, 'firstName' | 'lastName'>): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ');
}
