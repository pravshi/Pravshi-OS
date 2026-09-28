import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Invitation flow integration tests — the full lifecycle against a real database.
 *
 * These tests exercise the SECURITY DEFINER functions from migrations 0018/0019
 * (accept_invitation, revoke_invitation, invitation_preview, invitation_grant_check)
 * and the integrity triggers, as the pre-authentication path actually uses them.
 * They run against the ephemeral Neon branch CI provisions (DATABASE_URL_TEST as
 * app_user, DATABASE_URL_MIGRATE as app_owner) and skip gracefully when no database
 * is configured, so a plain `pnpm test` without credentials stays green.
 *
 * No test depends on wall-clock timing or sleeps: token expiry is controlled by
 * writing expires_at directly, and the concurrent-accept test relies on the row
 * lock inside accept_invitation(), not on scheduling.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

const owner = HAS_DB ? new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE }) : null;
const asUser = HAS_DB ? new Pool({ connectionString: process.env.DATABASE_URL_TEST }) : null;

const RUN = randomBytes(4).toString('hex');

let personSeq = 0;
/**
 * people.code must satisfy the people_code_format check
 * (^[A-Z]{2,8}-[0-9]{4}-[0-9]{4,}$) — random hex segments are rejected, so codes
 * are generated as EMP-<year>-<digits>. Sequential within the run, keeping
 * (org_id, code) unique; CI provisions a fresh ephemeral branch per run.
 */
const personCode = () => {
  personSeq += 1;
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  return `EMP-2026-${rand}${String(personSeq).padStart(4, '0')}`;
};

const newToken = () => randomBytes(32).toString('hex');
const digestOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

type DbError = { code?: string; message: string };

let orgA = '';
let orgB = '';
let deptA = '';
let deptB = '';
let adminA = ''; // orgA person, holds ADMIN (users.create at GLOBAL)
let superAdminA = ''; // orgA person, holds SUPER_ADMIN (roles.manage at GLOBAL)
let roleAdminA = '';
let roleEmployeeA = '';
let roleSuperAdminA = '';
let roleAdminB = '';

/** Run a statement as app_user with identity context, like withAuthorizedDb establishes it. */
async function inContext<T>(
  ctx: { personId?: string | null; orgId?: string | null },
  sqlText: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = await asUser!.connect();
  try {
    await c.query('begin');
    await c.query(
      `select set_config('app.person_id', $1, true), set_config('app.org_id', $2, true)`,
      [ctx.personId ?? '', ctx.orgId ?? ''],
    );
    const r = await c.query(sqlText, params);
    await c.query('commit');
    return r.rows as T[];
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Insert an invitation row directly as owner. invited_by must be a real person. */
async function makeInvitation(opts: {
  orgId: string;
  email: string;
  invitedBy: string;
  tokenHash?: string;
  personId?: string | null;
  roleIds?: string[];
  engagement?: { type: string; departmentId: string; startDate: string } | null;
  expiresAt?: string;
}): Promise<{ id: string; token: string; tokenHash: string }> {
  const token = newToken();
  const tokenHash = opts.tokenHash ?? digestOf(token);
  const code = `INV-${RUN}-${randomBytes(3).toString('hex')}`.toUpperCase();
  const eng =
    opts.engagement === null
      ? null
      : (opts.engagement ?? {
          type: 'EMPLOYEE',
          departmentId: deptA,
          startDate: '2026-09-28',
        });
  const rows = await owner!.query<{ id: string }>(
    `insert into public.invitations
       (org_id, code, email, token_hash, invited_by, expires_at,
        engagement_type, department_id, start_date, person_id)
     values ($1, $2, $3::citext, $4, $5, coalesce($6::timestamptz, now() + interval '7 days'),
             $7::public.engagement_type, $8::uuid, $9::date, $10::uuid)
     returning id`,
    [
      opts.orgId,
      code,
      opts.email,
      tokenHash,
      opts.invitedBy,
      opts.expiresAt ?? null,
      eng?.type ?? null,
      eng?.departmentId ?? null,
      eng?.startDate ?? null,
      opts.personId ?? null,
    ],
  );
  const id = rows.rows[0]!.id;
  for (const roleId of opts.roleIds ?? []) {
    await owner!.query(
      `insert into public.invitation_roles (invitation_id, role_id, org_id) values ($1, $2, $3)`,
      [id, roleId, opts.orgId],
    );
  }
  return { id, token, tokenHash };
}

async function acceptAsUser(
  tokenHash: string,
  fullName: string,
): Promise<{ person_id: string; org_id: string }> {
  const rows = await inContext<{ person_id: string; org_id: string }>(
    {},
    `select person_id, org_id from public.accept_invitation($1, $2, $3)`,
    [tokenHash, fullName, 'scrypt-test-hash'],
  );
  return rows[0]!;
}

describe.skipIf(!HAS_DB)('invitation flow integration', () => {
  beforeAll(async () => {
    // Two organizations; the trigger seeds the fourteen system roles on each.
    for (const [label, setter] of [
      ['a', (id: string) => (orgA = id)],
      ['b', (id: string) => (orgB = id)],
    ] as const) {
      const r = await owner!.query<{ id: string }>(
        `insert into public.organizations (name, slug) values ($1, $2) returning id`,
        [`Invite Int ${label} ${RUN}`, `invint-${RUN}-${label}`],
      );
      setter(r.rows[0]!.id);
    }

    const dA = await owner!.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1, 'ENG', 'Engineering') returning id`,
      [orgA],
    );
    deptA = dA.rows[0]!.id;
    const dB = await owner!.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1, 'ENG', 'Engineering') returning id`,
      [orgB],
    );
    deptB = dB.rows[0]!.id;

    const roleRows = await owner!.query<{ id: string; key: string; org_id: string }>(
      `select id, key, org_id from public.roles where org_id = any($1::uuid[]) and key = any($2)`,
      [
        [orgA, orgB],
        ['ADMIN', 'EMPLOYEE', 'SUPER_ADMIN'],
      ],
    );
    for (const r of roleRows.rows) {
      if (r.org_id === orgA && r.key === 'ADMIN') roleAdminA = r.id;
      if (r.org_id === orgA && r.key === 'EMPLOYEE') roleEmployeeA = r.id;
      if (r.org_id === orgA && r.key === 'SUPER_ADMIN') roleSuperAdminA = r.id;
      if (r.org_id === orgB && r.key === 'ADMIN') roleAdminB = r.id;
    }
    expect(roleAdminA && roleEmployeeA && roleSuperAdminA && roleAdminB).toBeTruthy();

    // Admin person in orgA: ACTIVE, with a live engagement, holding ADMIN at GLOBAL.
    // person_roles as owner hits the genesis branch (no roles.manage holder yet) only
    // for the SUPER_ADMIN grant; ADMIN is unprotected so it inserts plainly.
    const mkPerson = async (orgId: string, email: string, name: string) => {
      const p = await owner!.query<{ id: string }>(
        `insert into public.people (org_id, code, full_legal_name, work_email, person_status)
         values ($1, $2, $3, $4::citext, 'ACTIVE') returning id`,
        [orgId, personCode(), name, email],
      );
      const personId = p.rows[0]!.id;
      await owner!.query(
        `insert into public.engagements
           (org_id, person_id, engagement_type, status, department_id, start_date, is_primary)
         values ($1, $2, 'EMPLOYEE', 'ACTIVE', $3, '2026-01-05', true)`,
        [orgId, personId, orgId === orgA ? deptA : deptB],
      );
      return personId;
    };
    adminA = await mkPerson(orgA, `admin.a.${RUN}@example.test`, 'Admin A');
    superAdminA = await mkPerson(orgA, `super.a.${RUN}@example.test`, 'Super Admin A');
    await owner!.query(
      `insert into public.person_roles (person_id, role_id, org_id) values ($1, $2, $3)`,
      [adminA, roleAdminA, orgA],
    );
    await owner!.query(
      `insert into public.person_roles (person_id, role_id, org_id) values ($1, $2, $3)`,
      [superAdminA, roleSuperAdminA, orgA],
    );
  });

  afterAll(async () => {
    await owner?.end();
    await asUser?.end();
  });

  it('rejects an invitation carrying a role from another organization', async () => {
    // invitation_roles_role_same_org: the role must belong to the invitation's org.
    const inv = await makeInvitation({
      orgId: orgA,
      email: `xorg-role.${RUN}@example.test`,
      invitedBy: adminA,
    });
    await expect(
      owner!.query(
        `insert into public.invitation_roles (invitation_id, role_id, org_id) values ($1, $2, $3)`,
        [inv.id, roleAdminB, orgA],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects an invitation_roles row whose org does not match the invitation', async () => {
    // invitation_roles_invitation_same_org: (invitation_id, org_id) must resolve together.
    const inv = await makeInvitation({
      orgId: orgA,
      email: `xorg-row.${RUN}@example.test`,
      invitedBy: adminA,
    });
    await expect(
      owner!.query(
        `insert into public.invitation_roles (invitation_id, role_id, org_id) values ($1, $2, $3)`,
        [inv.id, roleEmployeeA, orgB],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects an invitation whose department belongs to another organization', async () => {
    // invitations_department_same_org: (department_id, org_id) must resolve together.
    await expect(
      makeInvitation({
        orgId: orgA,
        email: `xorg-dept.${RUN}@example.test`,
        invitedBy: adminA,
        engagement: { type: 'EMPLOYEE', departmentId: deptB, startDate: '2026-09-28' },
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('preserves a linked person\u2019s existing engagement on accept', async () => {
    const email = `linked.${RUN}@example.test`;
    const linked = await owner!.query<{ id: string }>(
      `insert into public.people (org_id, code, full_legal_name, work_email, person_status)
       values ($1, $2, 'Linked Person', $3::citext, 'ACTIVE') returning id`,
      [orgA, personCode(), email],
    );
    const personId = linked.rows[0]!.id;
    const eng = await owner!.query<{ id: string }>(
      `insert into public.engagements
         (org_id, person_id, engagement_type, status, department_id, start_date, is_primary)
       values ($1, $2, 'CONTRACTOR', 'ACTIVE', $3, '2026-02-01', true) returning id`,
      [orgA, personId, deptA],
    );
    const engagementId = eng.rows[0]!.id;

    // Engagement terms are present on the invitation but must be ignored: the person
    // already holds a live primary engagement.
    const inv = await makeInvitation({
      orgId: orgA,
      email,
      invitedBy: adminA,
      personId,
      roleIds: [roleEmployeeA],
    });
    const accepted = await acceptAsUser(inv.tokenHash, 'Linked Person');
    expect(accepted.person_id).toBe(personId);

    const engagements = await owner!.query<{ id: string; engagement_type: string }>(
      `select id, engagement_type::text from public.engagements
       where person_id = $1 and org_id = $2 and deleted_at is null`,
      [personId, orgA],
    );
    expect(engagements.rows).toHaveLength(1);
    expect(engagements.rows[0]!.id).toBe(engagementId);
    expect(engagements.rows[0]!.engagement_type).toBe('CONTRACTOR');
  });

  it('refuses to accept when a brand-new invitee has no engagement terms', async () => {
    const inv = await makeInvitation({
      orgId: orgA,
      email: `noterms.${RUN}@example.test`,
      invitedBy: adminA,
      engagement: null,
    });
    await expect(acceptAsUser(inv.tokenHash, 'No Terms')).rejects.toMatchObject({
      code: '55000',
    });
    // The invitation is still live: a failed accept must not consume it.
    const row = await owner!.query<{ accepted_at: string | null }>(
      `select accepted_at from public.invitations where id = $1`,
      [inv.id],
    );
    expect(row.rows[0]!.accepted_at).toBeNull();
  });

  it('lets exactly one of two concurrent accepts win', async () => {
    const inv = await makeInvitation({
      orgId: orgA,
      email: `race.${RUN}@example.test`,
      invitedBy: adminA,
      roleIds: [roleEmployeeA],
    });
    const attempt = () =>
      inContext<{ person_id: string }>(
        {},
        `select person_id from public.accept_invitation($1, $2, $3)`,
        [inv.tokenHash, 'Race Winner', 'scrypt-test-hash'],
      );
    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: '28000' });

    // Exactly one person row exists for the email: no duplicate account.
    const people = await owner!.query<{ id: string }>(
      `select id from public.people where org_id = $1 and work_email = $2::citext and deleted_at is null`,
      [orgA, `race.${RUN}@example.test`],
    );
    expect(people.rows).toHaveLength(1);
  });

  it('refuses to accept a revoked invitation', async () => {
    const inv = await makeInvitation({
      orgId: orgA,
      email: `revoked.${RUN}@example.test`,
      invitedBy: adminA,
      roleIds: [roleEmployeeA],
    });
    const revoked = await inContext<{ revoke_invitation: boolean }>(
      { personId: adminA, orgId: orgA },
      `select public.revoke_invitation($1::uuid)`,
      [inv.id],
    );
    expect(revoked[0]!.revoke_invitation).toBe(true);
    await expect(acceptAsUser(inv.tokenHash, 'Revoked Person')).rejects.toMatchObject({
      code: '28000',
    });
  });

  it('refuses to create an invitation carrying a protected role without roles.manage', async () => {
    // invitation_grant_check runs at creation: adminA holds ADMIN (users.create) but
    // not roles.manage, so a SUPER_ADMIN invitation must fail closed here — not later
    // at accept time with an unusable invitation in the database.
    await expect(
      inContext(
        { personId: adminA, orgId: orgA },
        `select public.invitation_grant_check($1::uuid[])`,
        [[roleSuperAdminA]],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // The holder passes the same check.
    await expect(
      inContext(
        { personId: superAdminA, orgId: orgA },
        `select public.invitation_grant_check($1::uuid[])`,
        [[roleSuperAdminA]],
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses the accept when the inviter lost roles.manage after issuing', async () => {
    // Issued while superAdminA holds SUPER_ADMIN; then the grant is removed, so the
    // acceptance-time trigger (judging the inviter's LIVE permission) must fail.
    const email = `demoted.${RUN}@example.test`;
    const invId = (
      await owner!.query<{ id: string }>(
        `insert into public.invitations
           (org_id, code, email, token_hash, invited_by, expires_at,
            engagement_type, department_id, start_date)
         values ($1, $2, $3::citext, $4, $5, now() + interval '7 days',
                 'EMPLOYEE', $6, '2026-09-28')
         returning id`,
        [orgA, `INV-${RUN}-DEMOTE`.toUpperCase(), email, digestOf(newToken()), superAdminA, deptA],
      )
    ).rows[0]!.id;
    // Bypass the creation-time guard deliberately: the test is about the accept-time
    // re-check, so the row is inserted directly as owner.
    await owner!.query(
      `insert into public.invitation_roles (invitation_id, role_id, org_id) values ($1, $2, $3)`,
      [invId, roleSuperAdminA, orgA],
    );
    const tokenHash = (
      await owner!.query<{ token_hash: string }>(
        `select token_hash from public.invitations where id = $1`,
        [invId],
      )
    ).rows[0]!.token_hash;

    // A bare delete as owner (no identity) is refused by the
    // person_roles_enforce_protection trigger: revoking a protected role requires
    // a live roles.manage holder to perform the revocation. superAdminA revokes
    // its own grant, which the trigger allows while it still holds the role.
    await inContext(
      { personId: superAdminA, orgId: orgA },
      `delete from public.person_roles where person_id = $1 and role_id = $2`,
      [superAdminA, roleSuperAdminA],
    );

    await expect(acceptAsUser(tokenHash, 'Demoted Invitee')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('refuses to remove the last live roles.manage holder', async () => {
    // set_person_roles replaces the whole assignment set; stripping SUPER_ADMIN from
    // its only holder would lock role management with no genesis path back.
    const holder = await owner!.query<{ id: string }>(
      `insert into public.people (org_id, code, full_legal_name, work_email, person_status)
       values ($1, $2, 'Last Holder', $3::citext, 'ACTIVE') returning id`,
      [orgB, personCode(), `last.holder.${RUN}@example.test`],
    );
    const holderId = holder.rows[0]!.id;
    await owner!.query(
      `insert into public.engagements
         (org_id, person_id, engagement_type, status, department_id, start_date, is_primary)
       values ($1, $2, 'EMPLOYEE', 'ACTIVE', $3, '2026-01-05', true)`,
      [orgB, holderId, deptB],
    );
    // Genesis branch: orgB has no roles.manage holder yet and we are not app_user.
    await owner!.query(
      `insert into public.person_roles (person_id, role_id, org_id) values ($1, $2, $3)`,
      [holderId, roleAdminB, orgB],
    );
    const superB = (
      await owner!.query<{ id: string }>(
        `select id from public.roles where org_id = $1 and key = 'SUPER_ADMIN'`,
        [orgB],
      )
    ).rows[0]!.id;
    await owner!.query(
      `insert into public.person_roles (person_id, role_id, org_id) values ($1, $2, $3)`,
      [holderId, superB, orgB],
    );

    await expect(
      inContext(
        { personId: holderId, orgId: orgB },
        `select public.set_person_roles($1::uuid, $2::uuid[])`,
        [holderId, [roleAdminB]],
      ),
    ).rejects.toThrow(/last roles\.manage holder/);
  });

  it('keeps login_events append-only', async () => {
    const id = await inContext<{ record_login_event: string }>(
      {},
      `select public.record_login_event($1::uuid, 'LOGIN_FAILURE', $2::citext, null, null, null, '{}')`,
      [orgA, `probe.${RUN}@example.test`],
    );
    const eventId = id[0]!.record_login_event;
    await expect(
      owner!.query(`update public.login_events set metadata = '{}' where id = $1`, [eventId]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      owner!.query(`delete from public.login_events where id = $1`, [eventId]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('writes audit and login events on accept', async () => {
    const email = `audited.${RUN}@example.test`;
    const inv = await makeInvitation({
      orgId: orgA,
      email,
      invitedBy: adminA,
      roleIds: [roleEmployeeA],
    });
    const accepted = await acceptAsUser(inv.tokenHash, 'Audited Person');

    const audit = await owner!.query<{
      action: string;
      result: string;
      actor_person_id: string;
    }>(
      `select action, result, actor_person_id from public.audit_logs
       where org_id = $1 and entity_type = 'invitation' and entity_id = $2`,
      [orgA, inv.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'invitation.accept',
      result: 'SUCCESS',
      actor_person_id: accepted.person_id,
    });

    const events = await owner!.query<{ event_type: string }>(
      `select event_type from public.login_events where org_id = $1 and email = $2::citext`,
      [orgA, email],
    );
    expect(events.rows.map((r) => r.event_type)).toContain('INVITATION_ACCEPTED');
  });

  it('answers preview without leaking token validity details', async () => {
    const inv = await makeInvitation({
      orgId: orgA,
      email: `preview.${RUN}@example.test`,
      invitedBy: adminA,
    });
    const good = await inContext<{ valid: boolean; email: string }>(
      {},
      `select valid, email from public.invitation_preview($1)`,
      [inv.tokenHash],
    );
    expect(good[0]).toMatchObject({ valid: true });

    for (const bad of [digestOf(newToken()), '0'.repeat(64)]) {
      const rows = await inContext<{ valid: boolean }>(
        {},
        `select valid from public.invitation_preview($1)`,
        [bad],
      );
      // Unknown hashes return no row at all — indistinguishable from nothing.
      expect(rows).toHaveLength(0);
    }
  });
});
