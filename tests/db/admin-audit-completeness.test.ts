/**
 * Multi-tenant audit WP-T1 (MT-H3) — every department, team and session-revocation
 * administration action records EXACTLY ONE correct audit entry, committed with the change.
 *
 * Before 0067 none of these actions wrote any entry. For each action this file proves:
 *   - exactly one new audit row for the organization (an org-wide count before/after, so a
 *     stray second entry — e.g. one per member row — would fail the test);
 *   - the row's action, entity, organization, actor (derived by the database, not passed),
 *     result SUCCESS, request id, and before/after/metadata;
 *   - a refused action (not found, foreign person, already archived) writes NO entry and
 *     changes nothing.
 *
 * Department/team functions are called the way the services call them: as app_user inside
 * one transaction carrying the admin's identity and the request id (app.request_id).
 * Session revocation is driven through the real service (src/lib/admin/sessions.ts).
 *
 * Gated behind DB_READY; runs in CI against the ephemeral Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import type { Authorization } from '@/lib/authz/require-permission';

import { DB_READY, mkOrg, mkPerson, mkRoleFor, RUN, sqlstateOf } from '../workflows/helpers';
import { seedSession } from '../auth-role';

type AuditRow = {
  action: string;
  entity_type: string;
  entity_id: string | null;
  org_id: string;
  actor_person_id: string | null;
  request_id: string | null;
  result: string;
  severity: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
};

describe.skipIf(!DB_READY)('admin audit completeness (live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  const appUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
  let orgId = '';
  let otherOrgId = '';
  let actor = '';
  let memberA = '';
  let memberB = '';
  let memberC = '';
  let foreigner = '';

  beforeAll(async () => {
    if (!DB_READY) return;
    orgId = await mkOrg(owner, `audit-t1-${RUN}`);
    otherOrgId = await mkOrg(owner, `audit-t1-other-${RUN}`);
    actor = await mkPerson(owner, orgId, `Admin ${RUN}`);
    await mkRoleFor(owner, orgId, actor, `t1_admin_${RUN}`, ['people.view']);
    memberA = await mkPerson(owner, orgId, `Member A ${RUN}`);
    memberB = await mkPerson(owner, orgId, `Member B ${RUN}`);
    memberC = await mkPerson(owner, orgId, `Member C ${RUN}`);
    foreigner = await mkPerson(owner, otherOrgId, `Foreigner ${RUN}`);
  }, 90_000);

  afterAll(async () => {
    if (!DB_READY) return;
    await owner.end();
    await appUser.end();
  });

  /** One transaction as app_user with the admin's identity and a request id — the service shape. */
  async function asAdmin<T extends Record<string, unknown>>(
    requestId: string,
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const c = await appUser.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id', $1, true), set_config('app.org_id', $2, true),
                set_config('app.request_id', $3, true)`,
        [actor, orgId, requestId],
      );
      const res = await c.query<T>(text, params);
      await c.query('commit');
      return res.rows;
    } catch (error) {
      await c.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }

  const orgAuditCount = async () =>
    Number(
      (
        await owner.query<{ n: string }>(
          `select count(*)::text n from public.audit_logs where org_id = $1`,
          [orgId],
        )
      ).rows[0]!.n,
    );

  /** Runs `act`, asserts exactly one new org audit row, and returns it. */
  async function exactlyOneEntry(act: () => Promise<unknown>): Promise<AuditRow> {
    const before = await orgAuditCount();
    const startedAt = new Date();
    await act();
    expect(await orgAuditCount(), 'exactly one new audit entry for the organization').toBe(
      before + 1,
    );
    const { rows } = await owner.query<AuditRow>(
      `select action, entity_type, entity_id, org_id, actor_person_id, request_id, result::text,
              severity, before, after, metadata
       from public.audit_logs
       where org_id = $1 and occurred_at >= $2
       order by occurred_at desc limit 1`,
      [orgId, new Date(startedAt.getTime() - 1000)],
    );
    return rows[0]!;
  }

  function expectAttribution(row: AuditRow, requestId: string) {
    expect(row.org_id).toBe(orgId);
    expect(row.actor_person_id).toBe(actor);
    expect(row.result).toBe('SUCCESS');
    expect(row.request_id).toBe(requestId);
  }

  // ── departments ───────────────────────────────────────────────────────────

  let departmentId = '';

  it('create_department → one department.created entry', async () => {
    const requestId = randomUUID();
    const code = `T1${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`.slice(0, 16);
    const row = await exactlyOneEntry(async () => {
      const [r] = await asAdmin<{ id: string }>(
        requestId,
        `select public.create_department($1, $2, null) as id`,
        [code, 'Audit Dept'],
      );
      departmentId = r!.id;
    });
    expectAttribution(row, requestId);
    expect(row.action).toBe('department.created');
    expect(row.entity_type).toBe('department');
    expect(row.entity_id).toBe(departmentId);
    expect(row.after).toMatchObject({ code, name: 'Audit Dept', parent_id: null });
  });

  // ── teams ─────────────────────────────────────────────────────────────────

  let teamId = '';

  it('create_team → one team.created entry', async () => {
    const requestId = randomUUID();
    const row = await exactlyOneEntry(async () => {
      const [r] = await asAdmin<{ id: string }>(
        requestId,
        `select public.create_team($1, $2, $3) as id`,
        [departmentId, 'Audit Team', memberA],
      );
      teamId = r!.id;
    });
    expectAttribution(row, requestId);
    expect(row).toMatchObject({ action: 'team.created', entity_type: 'team', entity_id: teamId });
    expect(row.after).toMatchObject({
      department_id: departmentId,
      name: 'Audit Team',
      lead_person_id: memberA,
    });
  });

  it('update_team → one team.updated entry with before and after', async () => {
    const requestId = randomUUID();
    const row = await exactlyOneEntry(() =>
      asAdmin(requestId, `select public.update_team($1, $2, $3)`, [teamId, 'Renamed', memberB]),
    );
    expectAttribution(row, requestId);
    expect(row).toMatchObject({ action: 'team.updated', entity_id: teamId });
    expect(row.before).toMatchObject({ name: 'Audit Team', lead_person_id: memberA });
    expect(row.after).toMatchObject({ name: 'Renamed', lead_person_id: memberB });
  });

  it('set_team_members → ONE team.members_changed entry per call, however many rows change', async () => {
    const first = randomUUID();
    const row1 = await exactlyOneEntry(() =>
      asAdmin(first, `select public.set_team_members($1, $2::uuid[])`, [
        teamId,
        [memberA, memberB],
      ]),
    );
    expectAttribution(row1, first);
    expect(row1).toMatchObject({ action: 'team.members_changed', entity_id: teamId });
    expect(row1.before).toEqual({ person_ids: [] });
    expect((row1.after!.person_ids as string[]).sort()).toEqual([memberA, memberB].sort());
    expect(row1.metadata).toMatchObject({ added: 2, removed: 0 });

    const second = randomUUID();
    const row2 = await exactlyOneEntry(() =>
      asAdmin(second, `select public.set_team_members($1, $2::uuid[])`, [
        teamId,
        [memberB, memberC],
      ]),
    );
    expectAttribution(row2, second);
    expect((row2.before!.person_ids as string[]).sort()).toEqual([memberA, memberB].sort());
    expect((row2.after!.person_ids as string[]).sort()).toEqual([memberB, memberC].sort());
    expect(row2.metadata).toMatchObject({ added: 1, removed: 1 });
  });

  it('set_team_members with a person from another org is refused and writes no entry', async () => {
    const before = await orgAuditCount();
    expect(
      await sqlstateOf(
        asAdmin(randomUUID(), `select public.set_team_members($1, $2::uuid[])`, [
          teamId,
          [memberB, foreigner],
        ]),
      ),
    ).toBe('P0001');
    expect(await orgAuditCount()).toBe(before);
  });

  it('archive_team → ONE team.archived entry, not one per ended membership', async () => {
    const requestId = randomUUID();
    const row = await exactlyOneEntry(() =>
      asAdmin(requestId, `select public.archive_team($1)`, [teamId]),
    );
    expectAttribution(row, requestId);
    expect(row).toMatchObject({ action: 'team.archived', entity_id: teamId });
    expect(row.metadata).toMatchObject({ memberships_ended: 2 });
  });

  it('archive_department → one department.archived entry; archiving again is refused and writes none', async () => {
    const requestId = randomUUID();
    const row = await exactlyOneEntry(() =>
      asAdmin(requestId, `select public.archive_department($1)`, [departmentId]),
    );
    expectAttribution(row, requestId);
    expect(row).toMatchObject({ action: 'department.archived', entity_id: departmentId });
    expect(row.before).toEqual({ status: 'ACTIVE' });
    expect(row.after).toEqual({ status: 'ARCHIVED' });

    const before = await orgAuditCount();
    expect(
      await sqlstateOf(
        asAdmin(randomUUID(), `select public.archive_department($1)`, [departmentId]),
      ),
    ).toBe('P0001');
    expect(await orgAuditCount()).toBe(before);
  });

  it('a missing or malformed request id still records the entry, with request_id NULL', async () => {
    const row = await exactlyOneEntry(() =>
      asAdmin('not-a-uuid', `select public.create_department($1, $2, null)`, [
        `T1B${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`.slice(0, 16),
        'No Request Id',
      ]),
    );
    expect(row.request_id).toBeNull();
    expect(row.actor_person_id).toBe(actor);
  });

  // ── session revocation (through the real service) ─────────────────────────

  describe('session revocation', () => {
    let target = '';
    let loginId = '';
    // Since 0072 the database proves the administrator from their own session token
    // (authz.admin_session_action): the actor holds a live session and sessions.revoke at GLOBAL.
    let actorToken = '';

    const authFor = (requestId: string): Authorization =>
      ({
        ctx: { personId: actor, orgId, aal: 'aal1' },
        permission: 'sessions.revoke',
        scope: 'GLOBAL',
        aal: 'aal1',
        requestId,
        meta: { requestId, ip: '203.0.113.7', userAgent: 'vitest' },
      }) as unknown as Authorization;

    const seedSessions = async (n: number) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const { rows } = await owner.query<{ id: string }>(
          `insert into auth.auth_sessions (user_id, token, expires_at)
           values ($1, $2, now() + interval '1 day') returning id`,
          [loginId, `tok-${RUN}-${randomUUID()}`],
        );
        ids.push(rows[0]!.id);
      }
      return ids;
    };
    const liveSessions = async () =>
      Number(
        (
          await owner.query<{ n: string }>(
            `select count(*)::text n from auth.auth_sessions where user_id = $1`,
            [loginId],
          )
        ).rows[0]!.n,
      );

    beforeAll(async () => {
      if (!DB_READY) return;
      target = await mkPerson(owner, orgId, `Session Target ${RUN}`);
      loginId = (
        await owner.query<{ id: string }>(
          `insert into auth.auth_users (name, email) values ($1, $2) returning id`,
          [`Target ${RUN}`, `t1.target.${RUN}@example.test`],
        )
      ).rows[0]!.id;
      await owner.query(`update public.people set auth_user_id = $1 where id = $2`, [
        loginId,
        target,
      ]);
      await mkRoleFor(owner, orgId, actor, `t1_sessions_${RUN}`, ['sessions.revoke']);
      actorToken = (await seedSession(owner, actor)).token;
    }, 60_000);

    it('revoke one session → one session.revoked entry, and the session is gone', async () => {
      const { revokeUserSession } = await import('@/lib/admin/sessions');
      const [keep, revoke] = await seedSessions(2);
      const requestId = randomUUID();
      const row = await exactlyOneEntry(() =>
        revokeUserSession(authFor(requestId), actorToken, target, revoke!),
      );
      expectAttribution(row, requestId);
      expect(row).toMatchObject({
        action: 'session.revoked',
        entity_type: 'person',
        entity_id: target,
        severity: 'HIGH',
      });
      expect(row.metadata).toMatchObject({ scope: 'one', sessions_revoked: 1, session_id: revoke });
      const { rows } = await owner.query(`select id from auth.auth_sessions where user_id = $1`, [
        loginId,
      ]);
      expect(rows.map((r: { id: string }) => r.id)).toEqual([keep]);
    });

    it('revoking a session that does not exist fails and writes no entry', async () => {
      const { revokeUserSession } = await import('@/lib/admin/sessions');
      const before = await orgAuditCount();
      await expect(
        revokeUserSession(authFor(randomUUID()), actorToken, target, randomUUID()),
      ).rejects.toThrow(/Session not found/);
      expect(await orgAuditCount()).toBe(before);
    });

    it('revoke all → one session.revoked_all entry, every session gone, revocation stamped', async () => {
      const { revokeAllUserSessions } = await import('@/lib/admin/sessions');
      await seedSessions(2);
      const live = await liveSessions();
      expect(live).toBeGreaterThanOrEqual(2);
      const requestId = randomUUID();
      const row = await exactlyOneEntry(() =>
        revokeAllUserSessions(authFor(requestId), actorToken, target),
      );
      expectAttribution(row, requestId);
      expect(row).toMatchObject({ action: 'session.revoked_all', entity_id: target });
      expect(row.metadata).toMatchObject({ scope: 'all', sessions_revoked: live });
      expect(await liveSessions()).toBe(0);
      const { rows } = await owner.query<{ stamped: boolean }>(
        `select sessions_revoked_at is not null as stamped from public.people where id = $1`,
        [target],
      );
      expect(rows[0]!.stamped).toBe(true);
    });
  });
});
