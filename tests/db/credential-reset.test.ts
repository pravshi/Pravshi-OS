import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { adminResetCredential } from '@/lib/admin/credential-reset';
import type { Authorization } from '@/lib/authz/require-permission';
import type { RequestMetadata } from '@/lib/audit/log';
import {
  mkAccount,
  mkCustomRole,
  mkDept,
  mkOrg,
  mkPerson,
  ownerPool,
  roleId,
  runId,
} from '../authz/fixtures';

/**
 * Credential-reset protected-role target guard (ADR-001, security fix).
 *
 * The service authorizes the CALLER (users.edit) but must also examine the
 * TARGET: a holder of users.edit who may not manage protected roles must not
 * reset a protected-role holder's credential — the latent account takeover.
 * The target-side truth comes from public.person_holds_protected_role()
 * (migration 0030), a SECURITY DEFINER function, because app_user's RLS view of
 * the role tables is self-only and a join in the application would fail OPEN.
 *
 * Everything here is real: a real organization, real role assignments through
 * the protected-role triggers, and the real service including its audit writes.
 * The Authorization is forged only in the narrow sense the service needs — the
 * service takes auth.ctx and never re-authorizes (requirePermission() owns that
 * layer, pinned in tests/authz/).
 */

const owner = ownerPool();
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
const RUN = runId();

let org = '';
let otherOrg = '';
let dept = '';
let editor = ''; // users.edit + people.view @ GLOBAL, no roles.manage — the unprivileged actor
let saTarget = ''; // SUPER_ADMIN (flagged protected) — the protected target
let saTarget2 = ''; // second SUPER_ADMIN, granted through the app path
let capTarget = ''; // holds an UNFLAGGED role carrying roles.manage — derived protection
let empTarget = ''; // EMPLOYEE — ordinary target
let noLogin = ''; // person row with no login

const editorAccount = {} as { personId: string; email: string };
const empAccount = {} as { personId: string; email: string };
const saAccount = {} as { personId: string; email: string };

/** The service only ever touches auth.ctx. */
const asActor = (personId: string, orgId: string) =>
  ({ ctx: { personId, orgId, aal: 'aal2' } }) as unknown as Authorization;

const meta = (ip: string): RequestMetadata => ({
  requestId: randomUUID(),
  ip,
  userAgent: 'vitest credential-reset',
});

/** Owner connection carrying a named identity — how the fixtures grant protected roles. */
async function asIdentity<T>(
  personId: string,
  orgId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = await owner.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`, [
      personId,
      orgId,
    ]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r.rows as T[];
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** The guard question exactly as the service asks it, as the runtime role. */
async function guardRows(personId: string, orgId: string) {
  const c = await asUser.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`, [
      editorAccount.personId,
      org,
    ]);
    const r = await c.query<{
      target_protected: boolean;
      actor_may_manage: boolean;
    }>(
      `select public.person_holds_protected_role($1::uuid, $2::uuid) as target_protected,
              coalesce(authz.scope_for('roles.manage') = 'GLOBAL', false) as actor_may_manage`,
      [personId, orgId],
    );
    await c.query('commit');
    return r.rows[0]!;
  } finally {
    c.release();
  }
}

const auditRows = async (requestId: string) =>
  (
    await owner.query<{
      action: string;
      entity_type: string;
      entity_id: string | null;
      result: string;
      severity: string;
      actor_person_id: string;
      metadata: Record<string, unknown>;
    }>(
      `select action, entity_type, entity_id::text as entity_id, result::text as result,
              severity::text as severity, actor_person_id::text as actor_person_id, metadata
       from public.audit_logs where request_id = $1`,
      [requestId],
    )
  ).rows;

beforeAll(async () => {
  org = await mkOrg(owner, `credreset${RUN}`);
  otherOrg = await mkOrg(owner, `credresetx${RUN}`);
  dept = await mkDept(owner, org, `CR${RUN.toUpperCase()}`);

  const editorRole = await mkCustomRole(owner, org, `CR_EDIT_${RUN.toUpperCase()}`, [
    ['users.edit', 'GLOBAL'],
    ['people.view', 'GLOBAL'],
  ]);
  const ed = await mkAccount(owner, {
    org,
    dept,
    run: RUN,
    label: 'crededitor',
    customRoles: [editorRole],
  });
  editor = ed.personId;
  editorAccount.personId = ed.personId;
  editorAccount.email = ed.email;

  // The one protected grant per org that rides the genesis branch.
  const sa = await mkAccount(owner, {
    org,
    dept,
    run: RUN,
    label: 'credsatarget',
    roles: ['SUPER_ADMIN'],
  });
  saTarget = sa.personId;
  saAccount.personId = sa.personId;
  saAccount.email = sa.email;

  const emp = await mkAccount(owner, {
    org,
    dept,
    run: RUN,
    label: 'credemptarget',
    roles: ['EMPLOYEE'],
  });
  empTarget = emp.personId;
  empAccount.personId = emp.personId;
  empAccount.email = emp.email;

  // A second SUPER_ADMIN, granted through the protected-role trigger as the
  // first SUPER_ADMIN's identity — genesis is spent, so this is the app path.
  const sa2 = await mkAccount(owner, {
    org,
    dept,
    run: RUN,
    label: 'credsatarget2',
    roles: ['EMPLOYEE'],
  });
  saTarget2 = sa2.personId;
  await asIdentity(saTarget, org, `select public.set_person_roles($1, $2::uuid[])`, [
    saTarget2,
    [await roleId(owner, org, 'SUPER_ADMIN')],
  ]);

  // Derived protection: an unflagged role carrying roles.manage. The grant rides
  // saTarget's identity because the permission trigger treats granting role
  // management as an act of role management.
  const capRole = await mkCustomRole(owner, org, `CR_CAP_${RUN.toUpperCase()}`, [
    ['users.edit', 'GLOBAL'],
  ]);
  await asIdentity(
    saTarget,
    org,
    `insert into public.role_permissions (role_id, permission_id, scope)
     select $1, p.id, 'GLOBAL'::public.access_scope from public.permissions p
     where p.key = 'roles.manage'`,
    [capRole],
  );
  const cap = await mkAccount(owner, {
    org,
    dept,
    run: RUN,
    label: 'credcaptarget',
    roles: ['EMPLOYEE'],
  });
  capTarget = cap.personId;
  await asIdentity(
    saTarget,
    org,
    `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
    [capTarget, capRole, org],
  );

  noLogin = await mkPerson(owner, org, 'No Login Person');
}, 60_000);

afterAll(async () => {
  await owner.end();
  await asUser.end();
});

describe('person_holds_protected_role() (migration 0030)', () => {
  it('is true for a flagged protected role holder', async () => {
    expect((await guardRows(saTarget, org)).target_protected).toBe(true);
    expect((await guardRows(saTarget2, org)).target_protected).toBe(true);
  });

  it('is true for derived protection — an unflagged role carrying roles.manage', async () => {
    expect((await guardRows(capTarget, org)).target_protected).toBe(true);
  });

  it('is false for ordinary people, unknown ids, and other tenants', async () => {
    expect((await guardRows(empTarget, org)).target_protected).toBe(false);
    expect((await guardRows(editor, org)).target_protected).toBe(false);
    expect((await guardRows(randomUUID(), org)).target_protected).toBe(false);
    // Same person, wrong org: no cross-tenant read.
    expect((await guardRows(saTarget, otherOrg)).target_protected).toBe(false);
  });

  it('answers the actor side from roles.manage at GLOBAL with a live engagement', async () => {
    // editor holds users.edit, not roles.manage.
    expect((await guardRows(empTarget, org)).actor_may_manage).toBe(false);
  });
});

describe('adminResetCredential target guard', () => {
  it('refuses a protected-role target for an actor who may not manage protected roles', async () => {
    const m = meta('10.9.0.1');
    await expect(adminResetCredential(asActor(editor, org), saTarget, m)).rejects.toThrow(
      /protected role/,
    );

    const rows = await auditRows(m.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.credential_reset',
      entity_type: 'person',
      entity_id: saTarget,
      result: 'DENIED',
      severity: 'HIGH',
      actor_person_id: editor,
    });
    expect(rows[0]!.metadata).toMatchObject({ reason: 'PROTECTED_ROLE_TARGET' });
  });

  it('refuses regardless of which protected role the target holds', async () => {
    await expect(
      adminResetCredential(asActor(editor, org), saTarget2, meta('10.9.0.2')),
    ).rejects.toThrow(/protected role/);
    // Derived protection counts too.
    await expect(
      adminResetCredential(asActor(editor, org), capTarget, meta('10.9.0.3')),
    ).rejects.toThrow(/protected role/);
  });

  it('keeps the existing target errors, in the existing order', async () => {
    await expect(
      adminResetCredential(asActor(editor, org), randomUUID(), meta('10.9.0.4')),
    ).rejects.toThrow('Person not found.');
    await expect(
      adminResetCredential(asActor(editor, org), noLogin, meta('10.9.0.5')),
    ).rejects.toThrow('This person has no login.');
  });

  it('still resets an ordinary target for the unprivileged actor', async () => {
    const m = meta('10.9.0.6');
    const res = await adminResetCredential(asActor(editor, org), empTarget, m);
    expect(res.email).toBe(empAccount.email);
    expect(res.resetUrl).toContain('/reset-password');
    expect(res.emailSent).toBe(false); // no Resend in test env

    const rows = await auditRows(m.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.credential_reset',
      entity_type: 'person',
      entity_id: empTarget,
      result: 'SUCCESS',
      severity: 'HIGH',
      actor_person_id: editor,
    });
  });

  it('lets a SUPER_ADMIN reset a protected-role holder', async () => {
    const m = meta('10.9.0.7');
    const res = await adminResetCredential(asActor(saTarget, org), saTarget2, m);
    expect(res.email).toBeTruthy();
    expect(res.resetUrl).toContain('/reset-password');

    const rows = await auditRows(m.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.credential_reset',
      entity_id: saTarget2,
      result: 'SUCCESS',
      severity: 'HIGH',
      actor_person_id: saTarget,
    });
  });
});
