import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { requireAuthenticated } from '@/lib/authz/page';

/**
 * Work permission gates (Phase 4).
 *
 * Permission keys follow the Phase 1 naming convention (<resource>.<verb>)
 * and are already seeded in drizzle/0008_roles_and_permissions.sql — if any
 * key here ever stops matching the catalogue, reconcile this module, not the
 * pages.
 *
 * The held-set check mirrors lib/authz/nav.ts: it uses authz.has() directly
 * instead of requirePermission() so button-hiding never audits a "denial".
 * Pages still authorize server-side via requirePagePermission(), and the
 * /api/work/* routes re-authorize every mutation.
 */
export const WORK_PERMISSIONS = {
  projects: {
    view: 'projects.view',
    create: 'projects.create',
    edit: 'projects.edit',
    delete: 'projects.delete',
    manageMembers: 'projects.manage_members',
  },
  tasks: {
    view: 'tasks.view',
    create: 'tasks.create',
    edit: 'tasks.edit',
    assign: 'tasks.assign',
    delete: 'tasks.delete',
    comment: 'tasks.comment',
  },
} as const;

const ALL_WORK_PERMISSION_KEYS = [
  ...Object.values(WORK_PERMISSIONS.projects),
  ...Object.values(WORK_PERMISSIONS.tasks),
];

/** The subset of work permission keys the current user holds. Never throws for a signed-in user. */
export async function getWorkPermissions(): Promise<Set<string>> {
  const ctx = await requireAuthenticated();
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ key: string; held: boolean }>(sql`
      select v.key as key, authz.has(v.key) as held
      from (values ${sql.join(
        ALL_WORK_PERMISSION_KEYS.map((p) => sql`(${p})`),
        sql`, `,
      )}) as v(key)
    `);
    return new Set(res.rows.filter((r) => r.held).map((r) => r.key));
  });
}
