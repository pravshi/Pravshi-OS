'use server';

import { headers } from 'next/headers';
import { requirePermission } from '@/lib/authz/require-permission';
import { listRoles } from '@/lib/admin/roles';

/** /admin/roles Server Actions — authorize first, always. */

export async function getRolesPageData() {
  const auth = await requirePermission(await headers(), { permission: 'roles.view' });
  return listRoles(auth);
}
