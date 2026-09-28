'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/authz/require-permission';
import {
  listRolesWithGrants,
  listPermissionCatalogue,
  setRolePermissions,
  type GrantInput,
} from '@/lib/admin/roles';

/** /admin/roles Server Actions — authorize first, always. */

export async function getRoleGridData() {
  const auth = await requirePermission(await headers(), { permission: 'roles.manage' });
  const [roles, catalogue] = await Promise.all([
    listRolesWithGrants(auth),
    listPermissionCatalogue(auth),
  ]);
  return { roles, catalogue };
}

export async function saveRolePermissionsAction(roleId: string, grants: GrantInput[]) {
  const auth = await requirePermission(await headers(), {
    permission: 'roles.manage',
    minScope: 'GLOBAL',
  });
  await setRolePermissions(auth, roleId, grants);
  revalidatePath('/admin/roles');
  revalidatePath('/admin/permissions');
  return { ok: true };
}
