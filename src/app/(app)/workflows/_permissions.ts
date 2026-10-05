import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { requireAuthenticated } from '@/lib/authz/page';

/**
 * Workflow permission gates (Phase 5).
 *
 * Mirrors the WORK_PERMISSIONS style from src/app/(app)/work/_permissions.ts.
 * Permission keys follow the Phase 1 naming convention (<resource>.<verb>)
 * and are seeded in migration 0044 (module 'workflow') — if any key here
 * ever stops matching the catalogue, reconcile this module, not the pages.
 *
 * The held-set check uses authz.has() directly instead of requirePermission()
 * so button-hiding never audits a "denial". Pages still authorize server-side
 * via requirePagePermission(), and the /api/workflows/* routes re-authorize
 * every mutation.
 */
export const WORKFLOW_PERMISSIONS = {
  workflows: {
    view: 'workflows.view',
    create: 'workflows.create',
    edit: 'workflows.edit',
    delete: 'workflows.delete',
    activate: 'workflows.activate',
    execute: 'workflows.execute',
  },
} as const;

const ALL_WORKFLOW_PERMISSION_KEYS = [...Object.values(WORKFLOW_PERMISSIONS.workflows)];

/** The subset of workflow permission keys the current user holds. Never throws for a signed-in user. */
export async function getWorkflowPermissions(): Promise<Set<string>> {
  const ctx = await requireAuthenticated();
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ key: string; held: boolean }>(sql`
      select v.key as key, authz.has(v.key) as held
      from (values ${sql.join(
        ALL_WORKFLOW_PERMISSION_KEYS.map((p) => sql`(${p})`),
        sql`, `,
      )}) as v(key)
    `);
    return new Set(res.rows.filter((r) => r.held).map((r) => r.key));
  });
}
