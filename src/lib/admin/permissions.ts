import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { Authorization } from '@/lib/authz/require-permission';
import type { AccessScope } from './roles';

/**
 * Permission access review. Read-only: which roles in this organization hold each
 * catalogue permission, and at which scope. Answers roles.manage or users.manage —
 * both are legitimate reviewers of who can do what.
 */

export type PermissionHolder = {
  roleCode: string;
  roleName: string;
  scope: AccessScope;
};

export type PermissionWithHolders = {
  key: string;
  resource: string;
  action: string;
  module: string;
  description: string | null;
  isSensitive: boolean;
  holders: PermissionHolder[];
};

export async function listPermissionsWithHolders(
  auth: Authorization,
): Promise<PermissionWithHolders[]> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<PermissionWithHolders>(sql`
      select
        p.key,
        p.resource,
        p.action,
        p.module,
        p.description,
        p.is_sensitive as "isSensitive",
        coalesce(
          (select jsonb_agg(
             jsonb_build_object(
               'roleCode', r.key,
               'roleName', r.name,
               'scope', rp.scope::text
             )
             order by r.key
           )
           from public.role_permissions rp
           join public.roles r on r.id = rp.role_id
           where rp.permission_id = p.id
             and r.org_id = ${auth.ctx.orgId}::uuid
             and r.deleted_at is null
             and r.status = 'ACTIVE'),
          '[]'::jsonb
        ) as holders
      from public.permissions p
      order by p.module, p.key
    `);
    return res.rows;
  });
}
