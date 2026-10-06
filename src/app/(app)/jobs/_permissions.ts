import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { requireAuthenticated } from '@/lib/authz/page';

/**
 * Jobs permission gates (Phase 6).
 *
 * Mirrors the WORKFLOW_PERMISSIONS style from ../workflows/_permissions.ts.
 * Permission keys follow the Phase 1 naming convention (<resource>.<verb>)
 * and are seeded in migration 0045 (module 'jobs') — if any key here
 * ever stops matching the catalogue, reconcile this module, not the pages.
 *
 * The held-set check uses authz.has() directly instead of requirePermission()
 * so button-hiding never audits a "denial". Pages still authorize server-side
 * via requirePagePermission(), and the /api/jobs/* + /api/schedules/* routes
 * re-authorize every mutation.
 */
export const JOB_PERMISSIONS = {
  jobs: {
    view: 'jobs.view',
    create: 'jobs.create',
    retry: 'jobs.retry',
    cancel: 'jobs.cancel',
    delete: 'jobs.delete',
  },
} as const;

const ALL_JOB_PERMISSION_KEYS = [...Object.values(JOB_PERMISSIONS.jobs)];

/** The subset of jobs permission keys the current user holds. Never throws for a signed-in user. */
export async function getJobPermissions(): Promise<Set<string>> {
  const ctx = await requireAuthenticated();
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ key: string; held: boolean }>(sql`
      select v.key as key, authz.has(v.key) as held
      from (values ${sql.join(
        ALL_JOB_PERMISSION_KEYS.map((p) => sql`(${p})`),
        sql`, `,
      )}) as v(key)
    `);
    return new Set(res.rows.filter((r) => r.held).map((r) => r.key));
  });
}
