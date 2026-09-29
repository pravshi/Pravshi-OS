'use server';

/**
 * CRM API shim — TEMPORARY, REMOVE AFTER PR #31 MERGES.
 *
 * These 15 functions carry EXACTLY the signatures the API engineer promised
 * (see the UI task contract), so every page/component below typechecks and
 * lints today. They throw at runtime until the real implementations land in
 * src/app/(app)/crm/actions.ts.
 *
 * After PR #31 merges, rewrite this file as a thin re-export:
 *
 *   export {
 *     listCompaniesAction, getCompanyAction, createCompanyAction,
 *     updateCompanyAction, deleteCompanyAction,
 *     listContactsAction, getContactAction, createContactAction,
 *     updateContactAction, deleteContactAction,
 *     listDealsAction, getDealAction, createDealAction,
 *     updateDealAction, deleteDealAction,
 *   } from './actions';
 *
 * …and delete the stub bodies below. The zod schemas in
 * src/components/crm/schemas.ts duplicate src/lib/crm/schema.ts for the same
 * reason — remove the duplicates then.
 */
import type { Company, Contact, Deal, Page, CrmResult } from '@/components/crm/types';

const CRM_API_UNAVAILABLE =
  'CRM API (PR #31) has not merged yet: src/app/(app)/crm/actions.ts is unavailable. ' +
  'This UI is compiled against the promised signatures; it will fail at runtime until #31 and migration 0031 merge.';

function unavailable(): never {
  throw new Error(CRM_API_UNAVAILABLE);
}

// ── Companies ────────────────────────────────────────────────────────────────

export async function listCompaniesAction(_input: unknown): Promise<CrmResult<Page<Company>>> {
  void _input;
  unavailable();
}

export async function getCompanyAction(_id: string): Promise<CrmResult<Company>> {
  void _id;
  unavailable();
}

export async function createCompanyAction(_input: unknown): Promise<CrmResult<Company>> {
  void _input;
  unavailable();
}

export async function updateCompanyAction(
  _id: string,
  _input: unknown,
): Promise<CrmResult<Company>> {
  void _id;
  void _input;
  unavailable();
}

export async function deleteCompanyAction(_id: string): Promise<CrmResult<void>> {
  void _id;
  unavailable();
}

// ── Contacts ─────────────────────────────────────────────────────────────────

export async function listContactsAction(_input: unknown): Promise<CrmResult<Page<Contact>>> {
  void _input;
  unavailable();
}

export async function getContactAction(_id: string): Promise<CrmResult<Contact>> {
  void _id;
  unavailable();
}

export async function createContactAction(_input: unknown): Promise<CrmResult<Contact>> {
  void _input;
  unavailable();
}

export async function updateContactAction(
  _id: string,
  _input: unknown,
): Promise<CrmResult<Contact>> {
  void _id;
  void _input;
  unavailable();
}

export async function deleteContactAction(_id: string): Promise<CrmResult<void>> {
  void _id;
  unavailable();
}

// ── Deals ────────────────────────────────────────────────────────────────────

export async function listDealsAction(_input: unknown): Promise<CrmResult<Page<Deal>>> {
  void _input;
  unavailable();
}

export async function getDealAction(_id: string): Promise<CrmResult<Deal>> {
  void _id;
  unavailable();
}

export async function createDealAction(_input: unknown): Promise<CrmResult<Deal>> {
  void _input;
  unavailable();
}

export async function updateDealAction(_id: string, _input: unknown): Promise<CrmResult<Deal>> {
  void _id;
  void _input;
  unavailable();
}

export async function deleteDealAction(_id: string): Promise<CrmResult<void>> {
  void _id;
  unavailable();
}
