import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { Authorization } from '@/lib/authz/require-permission';

/**
 * Role administration. listRoles answers roles.view; setPersonRoles is called only
 * after the route authorized roles.manage at GLOBAL scope, and the database
 * re-validates protected roles against the actor's live permission inside
 * set_person_roles() (migration 0021) plus the protected-role trigger (0008).
 */

export type RoleWithPermissions = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isProtected: boolean;
  permissions: string[];
  holderCount: number;
}

export async function listRoles(auth: Authorization): Promise<RoleWithPermissions[]> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<RoleWithPermissions>(sql`
      select
        r.id,
        r.code,
        r.name,
        r.description,
        public.role_is_protected(r.id) as "isProtected",
        coalesce(
          (select array_agg(p.key order by p.key)
           from public.role_permissions rp
           join public.permissions p on p.id = rp.permission_id
           where rp.role_id = r.id),
          '{}'
        ) as permissions,
        coalesce(
          (select count(*)::int
           from public.person_roles pr
           where pr.role_id = r.id
             and pr.org_id = r.org_id
             and (pr.expires_at is null or pr.expires_at > now())),
          0
        ) as "holderCount"
      from public.roles r
      where r.org_id = ${auth.ctx.orgId}::uuid
        and r.deleted_at is null
        and r.status = 'ACTIVE'
      order by r.code
    `);
    return res.rows;
  });
}

/** Replace one person's whole role set. The function enforces the safety rails. */
export async function setPersonRoles(
  auth: Authorization,
  personId: string,
  roleIds: string[],
): Promise<void> {
  await withAuthorizedDb(auth.ctx, async (tx) => {
    await tx.execute(sql`
      select public.set_person_roles(${personId}::uuid, ${roleIds}::uuid[])
    `);
  });
}
