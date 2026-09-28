'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/authz/require-permission';
import {
  listTeams,
  listPeopleOptions,
  createTeam,
  updateTeam,
  archiveTeam,
  setTeamMembers,
} from '@/lib/admin/teams';
import { listDepartments } from '@/lib/admin/departments';

/** /admin/teams Server Actions — authorize first, always. */

export async function getTeamsPageData() {
  const auth = await requirePermission(await headers(), { permission: 'teams.view' });
  const [teams, departments, people] = await Promise.all([
    listTeams(auth),
    listDepartments(auth),
    listPeopleOptions(auth),
  ]);
  return { teams, departments, people };
}

export async function createTeamAction(input: {
  departmentId: string;
  name: string;
  leadPersonId: string | null;
}) {
  const auth = await requirePermission(await headers(), { permission: 'teams.manage' });
  if (!input.departmentId) throw new Error('A department is required.');
  await createTeam(auth, input);
  revalidatePath('/admin/teams');
  return { ok: true };
}

export async function updateTeamAction(
  id: string,
  input: { name: string; leadPersonId: string | null },
) {
  const auth = await requirePermission(await headers(), { permission: 'teams.manage' });
  await updateTeam(auth, id, input);
  revalidatePath('/admin/teams');
  return { ok: true };
}

export async function archiveTeamAction(id: string) {
  const auth = await requirePermission(await headers(), { permission: 'teams.manage' });
  await archiveTeam(auth, id);
  revalidatePath('/admin/teams');
  return { ok: true };
}

export async function setTeamMembersAction(teamId: string, personIds: string[]) {
  const auth = await requirePermission(await headers(), { permission: 'teams.manage' });
  await setTeamMembers(auth, teamId, personIds);
  revalidatePath('/admin/teams');
  return { ok: true };
}
