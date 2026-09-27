'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/authz/require-permission';
import { listUsers, listPendingInvitations, suspendUser, unsuspendUser } from '@/lib/admin/users';
import { listRoles, setPersonRoles } from '@/lib/admin/roles';
import { listDepartments } from '@/lib/admin/departments';
import { createInvitation, revokeInvitation } from '@/lib/invitations/service';
import { CreateInvitationSchema, type CreateInvitationInput } from '@/lib/invitations/schema';
import { buildInviteUrl } from '@/lib/invitations/tokens';
import { env } from '@/env';

/**
 * /admin/users Server Actions.
 *
 * Every exported action's first statement awaits requirePermission() — enforced by
 * tests/guards/require-permission-first.test.ts. The page itself additionally gates on
 * users.view via requirePagePermission(); each action re-authorizes its own
 * permission, so no action is reachable with less than it needs.
 */

export async function getUsersPageData() {
  const auth = await requirePermission(await headers(), { permission: 'users.view' });
  const [users, invitations, roles, departments] = await Promise.all([
    listUsers(auth),
    listPendingInvitations(auth),
    listRoles(auth),
    // Departments the viewer may see: their own, plus every ACTIVE one when they
    // hold users.create at GLOBAL (the invite dialog places the invitee).
    listDepartments(auth),
  ]);
  return { users, invitations, roles, departments };
}

export async function inviteUserAction(input: CreateInvitationInput) {
  // minScope GLOBAL: the invitations RLS policies require scope_for('users.create')
  // = 'GLOBAL', so the breadth check denies cleanly here instead of failing at the
  // database later.
  const auth = await requirePermission(await headers(), {
    permission: 'users.create',
    minScope: 'GLOBAL',
  });
  const parsed = CreateInvitationSchema.parse(input);
  const created = await createInvitation(auth, parsed);
  revalidatePath('/admin/users');
  // The token goes back to the administrator who created it — exactly once. When
  // email delivery is unconfigured this is how the invite link reaches its recipient.
  return { inviteUrl: buildInviteUrl(env.APP_URL, created.token), email: created.email };
}

export async function revokeInvitationAction(id: string) {
  const auth = await requirePermission(await headers(), {
    permission: 'users.create',
    minScope: 'GLOBAL',
  });
  await revokeInvitation(auth, id);
  revalidatePath('/admin/users');
  return { ok: true };
}

export async function suspendUserAction(personId: string) {
  const auth = await requirePermission(await headers(), { permission: 'users.suspend' });
  await suspendUser(auth, personId);
  revalidatePath('/admin/users');
  return { ok: true };
}

export async function unsuspendUserAction(personId: string) {
  const auth = await requirePermission(await headers(), { permission: 'users.suspend' });
  await unsuspendUser(auth, personId);
  revalidatePath('/admin/users');
  return { ok: true };
}

export async function setPersonRolesAction(personId: string, roleIds: string[]) {
  const auth = await requirePermission(await headers(), {
    permission: 'roles.manage',
    minScope: 'GLOBAL',
  });
  await setPersonRoles(auth, personId, roleIds);
  revalidatePath('/admin/users');
  return { ok: true };
}
