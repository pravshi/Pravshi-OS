'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/authz/require-permission';
import { listDepartments, createDepartment, archiveDepartment } from '@/lib/admin/departments';

/** /admin/departments Server Actions — authorize first, always. */

export async function getDepartmentsPageData() {
  const auth = await requirePermission(await headers(), { permission: 'departments.view' });
  return listDepartments(auth);
}

export async function createDepartmentAction(input: { code: string; name: string }) {
  const auth = await requirePermission(await headers(), { permission: 'departments.manage' });
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  if (!/^[A-Z][A-Z0-9_]{1,15}$/.test(code))
    throw new Error('Code must match ^[A-Z][A-Z0-9_]{1,15}$.');
  if (name.length === 0) throw new Error('Name is required.');
  await createDepartment(auth, { code, name });
  revalidatePath('/admin/departments');
  return { ok: true };
}

export async function archiveDepartmentAction(id: string) {
  const auth = await requirePermission(await headers(), { permission: 'departments.manage' });
  await archiveDepartment(auth, id);
  revalidatePath('/admin/departments');
  return { ok: true };
}
