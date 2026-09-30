import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { requireAuthenticated, requirePagePermission } from '@/lib/authz/page';

/**
 * CRM permission gates.
 *
 * Permission keys follow the Phase 1 naming convention (<resource>.<verb>);
 * the API engineer registers the CRM keys with PR #31 — if any key here does
 * not match what #31 seeds, reconcile this module, not the pages.
 *
 * The held-set check mirrors lib/authz/nav.ts: it uses authz.has() directly
 * instead of requirePermission() so button-hiding never audits a "denial".
 * Pages still authorize server-side via requirePagePermission().
 */
export const CRM_PERMISSIONS = {
  companies: {
    view: 'companies.view',
    create: 'companies.create',
    edit: 'companies.edit',
    delete: 'companies.delete',
  },
  contacts: {
    view: 'contacts.view',
    create: 'contacts.create',
    edit: 'contacts.edit',
    delete: 'contacts.delete',
  },
  deals: {
    view: 'deals.view',
    create: 'deals.create',
    edit: 'deals.edit',
    delete: 'deals.delete',
  },
} as const;

type CrmResource = keyof typeof CRM_PERMISSIONS;
export type CrmVerb = keyof (typeof CRM_PERMISSIONS)[CrmResource];

const ALL_PERMISSION_KEYS = Object.values(CRM_PERMISSIONS).flatMap((verbs) => Object.values(verbs));

/** The subset of CRM permission keys the current user holds. Never throws for a signed-in user. */
export async function getCrmPermissions(): Promise<Set<string>> {
  const ctx = await requireAuthenticated();
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ key: string; held: boolean }>(sql`
      select v.key as key, authz.has(v.key) as held
      from (values ${sql.join(
        ALL_PERMISSION_KEYS.map((p) => sql`(${p})`),
        sql`, `,
      )}) as v(key)
    `);
    return new Set(res.rows.filter((r) => r.held).map((r) => r.key));
  });
}

/** Page-level gate: redirects to /login or /access-denied when unmet. */
export async function requireCrmPagePermission(resource: CrmResource, verb: CrmVerb) {
  return requirePagePermission(CRM_PERMISSIONS[resource][verb]);
}

/** What a list/detail client component may render, derived from the held set. */
export interface CrmUiPermissions {
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export function uiPermissionsFor(held: Set<string>, resource: CrmResource): CrmUiPermissions {
  const verbs = CRM_PERMISSIONS[resource];
  return {
    canCreate: held.has(verbs.create),
    canEdit: held.has(verbs.edit),
    canDelete: held.has(verbs.delete),
  };
}
