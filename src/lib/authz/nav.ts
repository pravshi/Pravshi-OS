import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { requireAuthenticated } from './page';

/**
 * Navigation permission filtering.
 *
 * The sidebar shows a section only when the viewer holds a permission inside it.
 * This is UI rendering, not an authorization decision — so it uses authz.has()
 * directly instead of requirePermission(), which would (correctly) audit every
 * "denial" and spam the audit log on every page load. The pages themselves still
 * authorize via requirePagePermission().
 */

const NAV_PERMISSIONS = [
  'users.view',
  'users.manage',
  'roles.view',
  'roles.manage',
  'teams.view',
  'departments.view',
  'audit_logs.view',
  'companies.view',
  'contacts.view',
  'deals.view',
  'activities.view',
  'pipelines.view',
  'projects.view',
  'tasks.view',
  'workflows.view', // Phase 5 (Workflow Engine): Automations sidebar section / /workflows
  'jobs.view', // Phase 6 (Automation & Background Jobs): Automations sidebar section / /jobs
  'reports.view', // Phase 7 (Analytics & Dashboards): Analytics sidebar section / /analytics/*
  'notifications.view', // Phase 8 (Search & Notifications): Notifications sidebar entry / /notifications
] as const;

export type NavPermission = (typeof NAV_PERMISSIONS)[number];

/** The subset of nav permissions the current user holds. Never throws for a signed-in user. */
export async function heldNavPermissions(): Promise<Set<string>> {
  const ctx = await requireAuthenticated();
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ key: string; held: boolean }>(sql`
      select v.key as key, authz.has(v.key) as held
      from (values ${sql.join(
        NAV_PERMISSIONS.map((p) => sql`(${p})`),
        sql`, `,
      )}) as v(key)
    `);
    return new Set(res.rows.filter((r) => r.held).map((r) => r.key));
  });
}
