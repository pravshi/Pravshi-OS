'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requirePermission } from '@/lib/authz/require-permission';
import { isAuthorizationError } from '@/lib/authz/errors';
import { listPermissionsWithHolders } from '@/lib/admin/permissions';

/** /admin/permissions Server Actions — authorize first, always. */

export async function getPermissionsPageData() {
  // roles.manage OR users.manage: both are legitimate reviewers of who can do what.
  // The first statement still authorizes unconditionally; a denied roles.manage
  // falls back to users.manage, and a double denial lands on /access-denied.
  const auth = await requirePermission(await headers(), { permission: 'roles.manage' }).catch(
    async (e) => {
      if (!isAuthorizationError(e)) throw e;
      try {
        return await requirePermission(await headers(), { permission: 'users.manage' });
      } catch (e2) {
        if (isAuthorizationError(e2)) redirect('/access-denied');
        throw e2;
      }
    },
  );
  return listPermissionsWithHolders(auth);
}
