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
};

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

export type AccessScope = 'GLOBAL' | 'DEPARTMENT' | 'TEAM' | 'PROJECT' | 'SELF';

export type RoleGrant = {
  permissionKey: string;
  scope: AccessScope;
};

export type RoleWithGrants = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isProtected: boolean;
  grants: RoleGrant[];
};

/**
 * Every role with its full grant set (permission key → scope), for the editable
 * grid. Answers roles.manage — the grid is a management surface, not a catalogue.
 */
export async function listRolesWithGrants(auth: Authorization): Promise<RoleWithGrants[]> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<RoleWithGrants>(sql`
      select
        r.id,
        r.code,
        r.name,
        r.description,
        public.role_is_protected(r.id) as "isProtected",
        coalesce(
          (select jsonb_agg(
             jsonb_build_object('permissionKey', p.key, 'scope', rp.scope::text)
             order by p.key
           )
           from public.role_permissions rp
           join public.permissions p on p.id = rp.permission_id
           where rp.role_id = r.id),
          '[]'::jsonb
        ) as grants
      from public.roles r
      where r.org_id = ${auth.ctx.orgId}::uuid
        and r.deleted_at is null
        and r.status = 'ACTIVE'
      order by r.code
    `);
    return res.rows;
  });
}

export type PermissionCatalogEntry = {
  key: string;
  resource: string;
  action: string;
  module: string;
  description: string | null;
  isSensitive: boolean;
};

/** The full permission catalogue, shared by every organization. */
export async function listPermissionCatalogue(
  auth: Authorization,
): Promise<PermissionCatalogEntry[]> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<PermissionCatalogEntry>(sql`
      select key, resource, action, module, description, is_sensitive as "isSensitive"
      from public.permissions
      order by module, key
    `);
    return res.rows;
  });
}

export type GrantInput = {
  permissionKey: string;
  scope: AccessScope;
};

const VALID_SCOPES: ReadonlySet<string> = new Set([
  'GLOBAL',
  'DEPARTMENT',
  'TEAM',
  'PROJECT',
  'SELF',
]);

/**
 * Replace one role's whole permission-grant set. The database function enforces
 * the safety rails (protected-role rule, last roles.manage holder).
 */
export async function setRolePermissions(
  auth: Authorization,
  roleId: string,
  grants: GrantInput[],
): Promise<void> {
  for (const g of grants) {
    if (!VALID_SCOPES.has(g.scope)) throw new Error(`Invalid scope: ${g.scope}`);
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.[a-z][a-z0-9_]*$/.test(g.permissionKey)) {
      throw new Error(`Invalid permission key: ${g.permissionKey}`);
    }
  }
  const seen = new Set(grants.map((g) => g.permissionKey));
  if (seen.size !== grants.length) throw new Error('Duplicate permission grants.');
  await withAuthorizedDb(auth.ctx, async (tx) => {
    await tx.execute(sql`
      select public.set_role_permissions(
        ${roleId}::uuid,
        ${JSON.stringify(grants.map((g) => ({ permission: g.permissionKey, scope: g.scope })))}::jsonb
      )
    `);
  });
}
