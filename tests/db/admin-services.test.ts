import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import type { Authorization } from '@/lib/authz/require-permission';
import { listPendingInvitations, listUsers } from '@/lib/admin/users';
import { listPermissionCatalogue, listRoles, listRolesWithGrants } from '@/lib/admin/roles';
import { listPermissionsWithHolders } from '@/lib/admin/permissions';
import { queryAuditLogs, queryLoginEvents } from '@/lib/admin/audit';
import { countAuditExportRows, streamAuditExportBatches } from '@/lib/admin/audit-export';

/**
 * P0-2 regression: the admin service SQL referenced columns that do not exist
 * (people.full_name, roles.code) and compared the audit_result enum to text
 * without a cast — the whole admin UI 500'd on main. These tests execute the
 * actual queries against a real database so a renamed column breaks a test,
 * not production.
 *
 * Fixtures are seeded through the owner connection; every assertion runs the
 * service itself through withAuthorizedDb() as the runtime role (app_user),
 * under the transaction identity of a SUPER_ADMIN person.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL });

const RUN = Math.random().toString(36).slice(2, 8);
const ADMIN_NAME = `P0 Admin ${RUN}`;
const MEMBER_NAME = `P0 Member ${RUN}`;

let orgId = '';
let adminId = '';
let memberId = '';

const authFor = (personId: string): Authorization =>
  ({
    ctx: { personId, orgId, aal: 'aal2' as const },
    permission: 'users.view',
    scope: 'GLOBAL',
    aal: 'aal2',
    requestId: randomUUID(),
    meta: {},
  }) as unknown as Authorization;

const mkPerson = async (name: string): Promise<string> => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      orgId,
    ])
  ).rows[0]!.c;
  const { rows } = await owner.query<{ id: string }>(
    `insert into public.people (org_id, code, full_legal_name, person_status)
     values ($1, $2, $3, 'ACTIVE'::public.person_status) returning id`,
    [orgId, code, name],
  );
  return rows[0]!.id;
};

const roleId = async (key: string): Promise<string> =>
  (
    await owner.query<{ id: string }>(`select id from public.roles where org_id=$1 and key=$2`, [
      orgId,
      key,
    ])
  ).rows[0]!.id;

/** Run a statement as the runtime role under a named identity, like the app does. */
async function inContext(personId: string, queryText: string, params: unknown[] = []) {
  const c = await asUser.connect();
  try {
    await c.query('begin');
    await c.query(
      `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true), set_config('app.aal','aal2',true)`,
      [personId, orgId],
    );
    const r = await c.query(queryText, params);
    await c.query('commit');
    return r.rows;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  const { rows: orgRows } = await owner.query<{ id: string }>(
    `insert into public.organizations (name, slug) values ($1, $2) returning id`,
    [`P0 Admin Fix ${RUN}`, `p0-admin-fix-${RUN}`.toLowerCase()],
  );
  orgId = orgRows[0]!.id;
  // organizations_seed_system_roles() trigger seeds SUPER_ADMIN/ADMIN/… per org.

  const { rows: deptRows } = await owner.query<{ id: string }>(
    `insert into public.departments (org_id, code, name) values ($1, 'ENG', 'Engineering') returning id`,
    [orgId],
  );
  const deptId = deptRows[0]!.id;

  adminId = await mkPerson(ADMIN_NAME);
  memberId = await mkPerson(MEMBER_NAME);

  for (const personId of [adminId, memberId]) {
    await owner.query(
      `insert into public.engagements
         (org_id, person_id, department_id, engagement_type, status, start_date)
       values ($1, $2, $3, 'EMPLOYEE', 'ACTIVE'::public.engagement_status, current_date)`,
      [orgId, personId, deptId],
    );
  }
  await owner.query(
    `insert into public.person_roles (person_id, role_id, org_id)
     values ($1, $2, $3), ($4, $5, $3), ($1, $5, $3)`,
    [adminId, await roleId('SUPER_ADMIN'), orgId, memberId, await roleId('EMPLOYEE')],
  );

  // A pending invitation from the admin, granting EMPLOYEE.
  const invCode = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'INV','2026') c`, [
      orgId,
    ])
  ).rows[0]!.c;
  const { rows: invRows } = await owner.query<{ id: string }>(
    `insert into public.invitations
       (org_id, code, email, token_hash, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, now() + interval '7 days') returning id`,
    [
      orgId,
      invCode,
      `invitee-${RUN}@example.com`,
      randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      adminId,
    ],
  );
  await owner.query(
    `insert into public.invitation_roles (invitation_id, role_id, org_id)
     values ($1, $2, $3)`,
    [invRows[0]!.id, await roleId('EMPLOYEE'), orgId],
  );

  // Audit rows with mixed results, written as the app writes them.
  await inContext(
    adminId,
    `select public.write_audit_log('users.view','person','SUCCESS'::public.audit_result)`,
  );
  await inContext(
    adminId,
    `select public.write_audit_log('users.view','person','DENIED'::public.audit_result)`,
  );
  await inContext(
    adminId,
    `select public.write_audit_log('roles.manage','role','SUCCESS'::public.audit_result)`,
  );

  await owner.query(
    `insert into public.login_events (org_id, event_type, email)
     values ($1, 'LOGIN_SUCCESS', $2)`,
    [orgId, `admin-${RUN}@example.com`],
  );
}, 60_000);

afterAll(async () => {
  await owner.end();
  await asUser.end();
});

describe('admin user service (P0-2: people.full_legal_name, roles.key)', () => {
  it('listUsers returns fullName from full_legal_name with role keys', async () => {
    const rows = await listUsers(authFor(adminId));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const admin = rows.find((r) => r.id === adminId)!;
    expect(admin.fullName).toBe(ADMIN_NAME);
    expect(admin.roles).toEqual(['EMPLOYEE', 'SUPER_ADMIN']);
    const member = rows.find((r) => r.id === memberId)!;
    expect(member.fullName).toBe(MEMBER_NAME);
    // person_roles_select_self: a caller sees only their own assignments, so the
    // member's roles are RLS-invisible to the admin, not a query bug.
    expect(member.roles).toEqual([]);
  });

  it('listPendingInvitations resolves the inviter name from full_legal_name', async () => {
    const rows = await listPendingInvitations(authFor(adminId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.inviterName).toBe(ADMIN_NAME);
    expect(rows[0]!.roles).toContain('EMPLOYEE');
  });
});

describe('admin role service (P0-2: roles.key as code)', () => {
  it('listRoles returns role keys under the code property', async () => {
    const rows = await listRoles(authFor(adminId));
    const sa = rows.find((r) => r.code === 'SUPER_ADMIN');
    expect(sa).toBeDefined();
    expect(sa!.holderCount).toBeGreaterThanOrEqual(1);
    expect(sa!.permissions.length).toBeGreaterThan(0);
    expect(sa!.permissions).toContain('users.view');
    // SUPER_ADMIN carries roles.manage at GLOBAL → protected by capability.
    expect(sa!.isProtected).toBe(true);
    const emp = rows.find((r) => r.code === 'EMPLOYEE');
    expect(emp).toBeDefined();
    expect(emp!.isProtected).toBe(false);
  });

  it('listRolesWithGrants returns grant keys', async () => {
    const rows = await listRolesWithGrants(authFor(adminId));
    const sa = rows.find((r) => r.code === 'SUPER_ADMIN');
    expect(sa).toBeDefined();
    expect(sa!.grants.length).toBeGreaterThan(0);
    expect(sa!.grants.map((g) => g.permissionKey)).toContain('users.view');
  });

  it('listPermissionCatalogue runs', async () => {
    const rows = await listPermissionCatalogue(authFor(adminId));
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('admin permission service (P0-2: roles.key in holder JSON)', () => {
  it('listPermissionsWithHolders names holding roles by key', async () => {
    const rows = await listPermissionsWithHolders(authFor(adminId));
    const usersView = rows.find((r) => r.key === 'users.view')!;
    expect(usersView).toBeDefined();
    expect(usersView.holders.map((h) => h.roleCode)).toContain('SUPER_ADMIN');
  });
});

describe('admin audit service (P0-2: audit_result::text cast)', () => {
  it('queryAuditLogs filters on result without a type error', async () => {
    const all = await queryAuditLogs(authFor(adminId));
    expect(all.length).toBeGreaterThanOrEqual(3);

    const ok = await queryAuditLogs(authFor(adminId), { result: 'SUCCESS' });
    expect(ok.length).toBeGreaterThanOrEqual(2);
    expect(ok.every((r) => r.result === 'SUCCESS')).toBe(true);

    const denied = await queryAuditLogs(authFor(adminId), { result: 'DENIED' });
    expect(denied.length).toBe(1);
    expect(denied.every((r) => r.result === 'DENIED')).toBe(true);
  });

  it('queryLoginEvents runs', async () => {
    const rows = await queryLoginEvents(authFor(adminId));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.eventType).toBe('LOGIN_SUCCESS');
  });
});

describe('admin audit export service (P0-2: audit_result::text cast)', () => {
  it('countAuditExportRows filters on result', async () => {
    expect(await countAuditExportRows(authFor(adminId), {})).toBeGreaterThanOrEqual(3);
    expect(
      await countAuditExportRows(authFor(adminId), { result: 'SUCCESS' }),
    ).toBeGreaterThanOrEqual(2);
    expect(await countAuditExportRows(authFor(adminId), { result: 'DENIED' })).toBe(1);
  });

  it('streamAuditExportBatches pages filtered rows', async () => {
    const seen: string[] = [];
    const outcome = await streamAuditExportBatches(
      authFor(adminId),
      { result: 'DENIED' },
      (batch) => {
        seen.push(...batch.map((r) => r.result));
      },
    );
    expect(outcome.rows).toBe(1);
    expect(outcome.truncated).toBe(false);
    expect(seen.every((r) => r === 'DENIED')).toBe(true);
  });
});
