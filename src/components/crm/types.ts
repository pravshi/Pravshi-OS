import type { ErrorEnvelope } from '@/lib/authz/errors';

/**
 * CRM Core shared types.
 *
 * These mirror the Phase 2 contract (migration 0031 + the API engineer's
 * server-action signatures). After PR #31 merges, the canonical shapes live in
 * src/lib/crm/schema.ts — reconcile these against those and delete this file's
 * duplicates (see src/app/(app)/crm/_api.ts).
 */

export const DEAL_STAGES = ['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'] as const;

export type DealStage = (typeof DEAL_STAGES)[number];

export const COMPANY_SIZES = ['STARTUP', 'SMB', 'MID_MARKET', 'ENTERPRISE'] as const;

export type CompanySize = (typeof COMPANY_SIZES)[number];

export interface Company {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size: CompanySize | null;
  website: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country_code: string;
  owner_person_id: string;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  company_id: string | null;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  department: string | null;
  owner_person_id: string;
  created_at: string;
  updated_at: string;
}

export interface Deal {
  id: string;
  title: string;
  company_id: string | null;
  contact_id: string | null;
  /** numeric(19,4) arrives as a string over the action boundary. */
  value: string | null;
  currency: string;
  stage: DealStage;
  probability: number | null;
  expected_close_date: string | null;
  closed_at: string | null;
  owner_person_id: string;
  created_at: string;
  updated_at: string;
}

export interface Page<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
}

export type CrmResult<T> = T | ErrorEnvelope;

/** Server actions return failures as data: { error: { code, message, ... } }. */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  if (!('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return typeof error === 'object' && error !== null && 'message' in error;
}

export function contactDisplayName(c: Pick<Contact, 'first_name' | 'last_name'>): string {
  return [c.first_name, c.last_name].filter(Boolean).join(' ');
}
