import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { requireAuthenticated } from '@/lib/authz/page';

/**
 * Display gating for the integrations settings surface (Phase 10,
 * Wave G; contract §4.8) — the can-use-ai.ts pattern.
 *
 * The settings page passes the returned flags to the manager components
 * to decide which controls to RENDER. This is never an authorization
 * decision: it reads authz.has('integrations.view' / 'integrations.manage')
 * directly, so rendering never audits a "denial", and every /api/integrations
 * route independently enforces its permission via withPermission() plus
 * the 0056/0057 RLS policies. Hiding a control grants nothing; showing
 * one proves nothing.
 */
export interface IntegrationsAccess {
  readonly canView: boolean;
  readonly canManage: boolean;
}

export async function getIntegrationsAccess(): Promise<IntegrationsAccess> {
  const ctx = await requireAuthenticated();
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ canView: boolean; canManage: boolean }>(sql`
      select authz.has('integrations.view') as "canView",
             authz.has('integrations.manage') as "canManage"
    `);
    const row = res.rows[0];
    return { canView: row?.canView ?? false, canManage: row?.canManage ?? false };
  });
}
