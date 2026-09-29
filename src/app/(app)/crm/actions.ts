'use server';

import { headers } from 'next/headers';
import { requirePermission } from '@/lib/authz/require-permission';
import { actionError } from '@/lib/authz/http';
import {
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
  deleteCompany,
} from '@/lib/crm/companies';
import {
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
} from '@/lib/crm/contacts';
import { listDeals, getDeal, createDeal, updateDeal, deleteDeal } from '@/lib/crm/deals';

/**
 * /crm Server Actions — authorize first, always.
 *
 * Each action takes untrusted `input: unknown`; the service layer validates it with
 * zod before any database access. Input shapes are the Create/Update inputs from
 * src/lib/crm/schema.ts; list inputs are { search?, limit?, offset? } (deals also
 * accept an optional stage). Failures return the actionError() envelope.
 */

// ── Companies ────────────────────────────────────────────────────────────────────

export async function listCompaniesAction(input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'companies.view',
    });
    return await listCompanies(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function getCompanyAction(id: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'companies.view',
    });
    return await getCompany(authorization, id);
  } catch (error) {
    return actionError(error);
  }
}

export async function createCompanyAction(input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'companies.create',
    });
    return await createCompany(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function updateCompanyAction(id: string, input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'companies.edit',
    });
    return await updateCompany(authorization, id, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function deleteCompanyAction(id: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'companies.edit',
    });
    await deleteCompany(authorization, id);
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

// ── Contacts ─────────────────────────────────────────────────────────────────────

export async function listContactsAction(input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'contacts.view',
    });
    return await listContacts(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function getContactAction(id: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'contacts.view',
    });
    return await getContact(authorization, id);
  } catch (error) {
    return actionError(error);
  }
}

export async function createContactAction(input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'contacts.create',
    });
    return await createContact(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function updateContactAction(id: string, input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'contacts.edit',
    });
    return await updateContact(authorization, id, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function deleteContactAction(id: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'contacts.edit',
    });
    await deleteContact(authorization, id);
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

// ── Deals ────────────────────────────────────────────────────────────────────────

export async function listDealsAction(input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'deals.view',
    });
    return await listDeals(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function getDealAction(id: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'deals.view',
    });
    return await getDeal(authorization, id);
  } catch (error) {
    return actionError(error);
  }
}

export async function createDealAction(input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'deals.create',
    });
    return await createDeal(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function updateDealAction(id: string, input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'deals.edit',
    });
    return await updateDeal(authorization, id, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function deleteDealAction(id: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'deals.edit',
    });
    await deleteDeal(authorization, id);
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}
