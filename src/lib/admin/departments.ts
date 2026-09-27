import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { Authorization } from '@/lib/authz/require-permission';

/** Department administration. Mutations are departments.manage; listing is departments.view. */

export type Department = {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  status: string;
  memberCount: number;
}

export async function listDepartments(auth: Authorization): Promise<Department[]> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Department>(sql`
      select
        d.id,
        d.code,
        d.name,
        d.parent_id as "parentId",
        d.status,
        coalesce(
          (select count(distinct e.person_id)::int
           from public.engagements e
           where e.department_id = d.id
             and e.org_id = d.org_id
             and e.deleted_at is null
             and e.status in ('ACTIVE', 'PRE_ONBOARDING')),
          0
        ) as "memberCount"
      from public.departments d
      where d.org_id = ${auth.ctx.orgId}::uuid
        and d.deleted_at is null
      order by d.name
    `);
    return res.rows;
  });
}

export async function createDepartment(
  auth: Authorization,
  input: { code: string; name: string; parentId?: string },
): Promise<void> {
  await withAuthorizedDb(auth.ctx, async (tx) => {
    await tx.execute(sql`
      insert into public.departments (org_id, code, name, parent_id)
      values (
        ${auth.ctx.orgId}::uuid,
        ${input.code},
        ${input.name},
        ${input.parentId ?? null}::uuid
      )
    `);
  });
}

export async function archiveDepartment(auth: Authorization, id: string): Promise<void> {
  await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      update public.departments
      set status = 'ARCHIVED', updated_at = now()
      where id = ${id}::uuid
        and org_id = ${auth.ctx.orgId}::uuid
        and deleted_at is null
        and status = 'ACTIVE'
      returning id
    `);
    if (!res.rows[0]) throw new Error('Department not found or already archived.');
  });
}
