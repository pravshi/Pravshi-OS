import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { Authorization } from '@/lib/authz/require-permission';

/**
 * Admin user management. Every function takes the Authorization that
 * requirePermission() issued — the route or Server Action authorized first, the
 * service never re-decides. Audit entries are written by the database triggers
 * (migration 0012), not by hand.
 */

export type AdminUser = {
  id: string;
  fullName: string | null;
  email: string;
  status: string;
  hasLogin: boolean;
  suspended: boolean;
  roles: string[];
};

export async function listUsers(auth: Authorization): Promise<AdminUser[]> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<AdminUser>(sql`
      select
        p.id,
        p.full_name as "fullName",
        p.work_email as email,
        p.person_status as status,
        (p.auth_user_id is not null) as "hasLogin",
        (p.person_status <> 'ACTIVE') as suspended,
        coalesce(
          (select array_agg(r.code order by r.code)
           from public.person_roles pr
           join public.roles r on r.id = pr.role_id
           where pr.person_id = p.id
             and pr.org_id = p.org_id
             and (pr.expires_at is null or pr.expires_at > now())
             and r.deleted_at is null),
          '{}'
        ) as roles
      from public.people p
      where p.org_id = ${auth.ctx.orgId}::uuid
        and p.deleted_at is null
      order by p.full_name nulls last, p.work_email
    `);
    return res.rows;
  });
}

export type PendingInvitation = {
  id: string;
  email: string;
  expiresAt: Date;
  createdAt: Date;
  inviterName: string | null;
  roles: string[];
};

export async function listPendingInvitations(auth: Authorization): Promise<PendingInvitation[]> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<PendingInvitation>(sql`
      select
        i.id,
        i.email,
        i.expires_at as "expiresAt",
        i.created_at as "createdAt",
        (select p.full_name from public.people p where p.id = i.invited_by) as "inviterName",
        coalesce(
          (select array_agg(r.code order by r.code)
           from public.invitation_roles ir
           join public.roles r on r.id = ir.role_id
           where ir.invitation_id = i.id),
          '{}'
        ) as roles
      from public.invitations i
      where i.org_id = ${auth.ctx.orgId}::uuid
        and i.accepted_at is null
        and i.revoked_at is null
        and i.expires_at > now()
      order by i.created_at desc
    `);
    return res.rows;
  });
}

/**
 * Suspend a login: the person can no longer authenticate (resolve_auth_identity
 * requires ACTIVE), and every existing session dies now via sessions_revoked_at.
 * Refuses self-suspension — locking yourself out mid-click helps nobody.
 */
export async function suspendUser(auth: Authorization, personId: string): Promise<void> {
  if (personId === auth.ctx.personId) {
    throw new Error('You cannot suspend your own account.');
  }
  await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      update public.people
      set person_status = 'INACTIVE',
          sessions_revoked_at = now(),
          updated_at = now()
      where id = ${personId}::uuid
        and org_id = ${auth.ctx.orgId}::uuid
        and deleted_at is null
        and person_status = 'ACTIVE'
      returning id
    `);
    if (!res.rows[0]) throw new Error('Person not found or not active.');
  });
}

/** Restore a suspended login. The old sessions stay dead — only new logins work. */
export async function unsuspendUser(auth: Authorization, personId: string): Promise<void> {
  await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      update public.people
      set person_status = 'ACTIVE',
          updated_at = now()
      where id = ${personId}::uuid
        and org_id = ${auth.ctx.orgId}::uuid
        and deleted_at is null
        and person_status = 'INACTIVE'
      returning id
    `);
    if (!res.rows[0]) throw new Error('Person not found or not suspended.');
  });
}
