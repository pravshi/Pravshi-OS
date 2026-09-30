'use server';

import { z } from 'zod';
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
import {
  listActivities,
  getActivity,
  createActivity,
  updateActivity,
  deleteActivity,
} from '@/lib/crm/activities';

/** Boundary UUID check (A3): malformed ids fail before PostgreSQL ever sees them. */
const uuid = z.string().uuid();

/**
 * /crm Server Actions — authorize first, always.
 *
 * Each action takes untrusted `input: unknown`; the service layer validates it with
 * zod before any database access. Input shapes are the Create/Update inputs from
 * src/lib/crm/schema.ts; list inputs are { search?, limit?, offset? } (contacts also
 * accept an optional companyId; deals also accept optional stage, companyId,
 * contactId). Failures return the actionError() envelope.
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
    return await getCompany(authorization, uuid.parse(id));
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
    return await updateCompany(authorization, uuid.parse(id), input);
  } catch (error) {
    return actionError(error);
  }
}

export async function deleteCompanyAction(id: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'companies.delete',
    });
    await deleteCompany(authorization, uuid.parse(id));
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
    return await getContact(authorization, uuid.parse(id));
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
    return await updateContact(authorization, uuid.parse(id), input);
  } catch (error) {
    return actionError(error);
  }
}

export async function deleteContactAction(id: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'contacts.delete',
    });
    await deleteContact(authorization, uuid.parse(id));
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
    return await getDeal(authorization, uuid.parse(id));
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
    return await updateDeal(authorization, uuid.parse(id), input);
  } catch (error) {
    return actionError(error);
  }
}

export async function deleteDealAction(id: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'deals.delete',
    });
    await deleteDeal(authorization, uuid.parse(id));
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

// ── Activities ───────────────────────────────────────────────────────────────────
// (Phase 2 Track B). Reads gate on activities.view, creates on .create, updates
// on .edit, deletes on .delete — the same authorize-first shape as every other
// CRM action above.

export async function listActivitiesAction(input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'activities.view',
    });
    return await listActivities(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function getActivityAction(id: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'activities.view',
    });
    return await getActivity(authorization, uuid.parse(id));
  } catch (error) {
    return actionError(error);
  }
}

export async function createActivityAction(input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'activities.create',
    });
    return await createActivity(authorization, input);
  } catch (error) {
    return actionError(error);
  }
}

export async function updateActivityAction(id: string, input: unknown) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'activities.edit',
    });
    return await updateActivity(authorization, uuid.parse(id), input);
  } catch (error) {
    return actionError(error);
  }
}

export async function deleteActivityAction(id: string) {
  try {
    const authorization = await requirePermission(await headers(), {
      permission: 'activities.delete',
    });
    await deleteActivity(authorization, uuid.parse(id));
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}
