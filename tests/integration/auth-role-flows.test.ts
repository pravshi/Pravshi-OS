/**
 * Legitimate authentication flows on the authentication plane's own login (app_auth, migrations
 * 0072/0073), driven through the real application modules and the real [...all] handler. LIVE DB.
 *
 * After 0073 the business role (app_user) holds nothing in the auth schema, so every flow here can
 * only work because the auth module runs on app_auth — the first case proves that it does. The
 * deeper suites for each flow (tests/integration/auth-journeys, auth-choke-point, auth/two-factor,
 * auth/session, the password-reset and change-password suites, invitations, bootstrap) run on the
 * same login for the same reason; this file adds the flows WP-A1 touched or that no other suite
 * drives end to end: the self-service session routes the security page uses, both rate limiters,
 * reset completion, and the administrator session actions proven by a real Better Auth session.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { AUTH_DB_READY } from '../auth-role';

const READY =
  AUTH_DB_READY && Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

// The new-password policy asks HIBP; answer with a non-matching range so no network is used.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1\n', { status: 200 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe.skipIf(!READY)('authentication flows on app_auth (0072/0073, live DB)', async () => {
  const fx = await import('../authz/fixtures');
  const { auth } = await import('@/lib/auth/server');
  const { GET: authGET, POST: authPOST } = await import('@/app/api/auth/[...all]/route');
  const { requestPasswordReset, resetPassword } = await import('@/lib/auth/password-reset');
  const { changePassword, ChangePasswordError } = await import('@/lib/auth/change-password');
  const { resolveAuthContext, currentSessionToken } = await import('@/lib/auth/session');
  const { authSessionRole } = await import('@/lib/db/auth-pool');

  const owner = fx.ownerPool();
  const RUN = fx.runId();
  const NEW_PASSWORD = 'an entirely new passphrase 4471';
  let org = '';
  let otherOrg = '';
  let dept = '';
  let otherDept = '';
  let ipSeq = 0;
  const nextIp = () => `198.18.${200 + Math.floor(Math.random() * 50)}.${(ipSeq += 1) % 250}`;
  const meta = () => ({
    requestId: randomUUID(),
    ip: nextIp(),
    userAgent: 'vitest-auth-role-flows',
  });

  const account = (label: string, extra: Partial<Parameters<typeof fx.mkAccount>[1]> = {}) =>
    fx.mkAccount(owner, { org, dept, run: RUN, label, roles: ['EMPLOYEE'], ...extra });

  const sessionsOf = async (authUserId: string) =>
    (
      await owner.query<{ id: string; token: string }>(
        `select id, token from auth.auth_sessions where user_id = $1 order by created_at`,
        [authUserId],
      )
    ).rows;

  beforeAll(async () => {
    org = await fx.mkOrg(owner, `arf-${RUN}`);
    otherOrg = await fx.mkOrg(owner, `arf-o-${RUN}`);
    dept = await fx.mkDept(owner, org, `ARF${RUN.toUpperCase()}`);
    otherDept = await fx.mkDept(owner, otherOrg, `ARO${RUN.toUpperCase()}`);
  }, 60_000);

  afterAll(async () => {
    await owner.end();
  });

  it('the auth module’s connection is app_auth — every flow below runs on it', async () => {
    expect(await authSessionRole()).toBe('app_auth');
  });

  it('sign-in succeeds with the right password and fails generically with a wrong one', async () => {
    const a = await account('arfsignin');
    expect(await resolveAuthContext(fx.headersFor(a.cookie))).toMatchObject({
      personId: a.personId,
      orgId: org,
    });
    const bad = (await auth.api.signInEmail({
      body: { email: a.email, password: 'not the password at all 1' },
      headers: new Headers({ 'x-forwarded-for': nextIp() }),
      asResponse: true,
    })) as Response;
    expect(bad.status).toBe(401);
  });

  it('a sign-out ends the session; the next lookup resolves nothing', async () => {
    const a = await account('arfsignout');
    const res = (await auth.api.signOut({
      headers: fx.headersFor(a.cookie),
      asResponse: true,
    })) as Response;
    expect(res.ok).toBe(true);
    expect(await resolveAuthContext(fx.headersFor(a.cookie))).toBeNull();
  });

  it('an MFA-enrolled session resolves at aal2', async () => {
    const a = await account('arfmfa', { mfa: true });
    expect((await resolveAuthContext(fx.headersFor(a.cookie)))?.aal).toBe('aal2');
  });

  it('password reset: uniform answer, single use, expiry, sessions revoked, lockout cleared', async () => {
    const a = await account('arfreset');
    const ip = nextIp();
    // Enumeration resistance: an unknown address gets the same answer and creates nothing.
    expect(await requestPasswordReset(`nobody.${RUN}@example.test`, ip)).toEqual({ ok: true });
    // A lockout to clear.
    for (let i = 0; i < 5; i += 1) {
      await auth.api
        .signInEmail({
          body: { email: a.email, password: 'wrong wrong wrong 1' },
          asResponse: true,
        })
        .catch(() => undefined);
    }
    expect(await requestPasswordReset(a.email, ip)).toEqual({ ok: true });
    const resetRow = (
      await owner.query<{ id: string }>(
        `select id from auth.password_resets where auth_user_id = $1 and used_at is null
          order by created_at desc limit 1`,
        [a.authUserId],
      )
    ).rows[0]!;
    const html = (
      await owner.query<{ html: string }>(
        `select c.html from public.job_email_content c join public.jobs j on j.id = c.job_id
          where j.dedup_key = $1`,
        [`pwreset:${resetRow.id}`],
      )
    ).rows[0]!.html;
    const token = /reset-password\?token=([0-9a-f]{64})/.exec(html)![1]!;

    expect(await resetPassword(token, NEW_PASSWORD, nextIp())).toEqual({ ok: true });
    // Single use.
    await expect(resetPassword(token, NEW_PASSWORD, nextIp())).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
    // Every old session is gone, the lockout is cleared, the new password signs in.
    expect(await resolveAuthContext(fx.headersFor(a.cookie))).toBeNull();
    const lock = await owner.query(`select 1 from auth.login_lockouts where auth_user_id = $1`, [
      a.authUserId,
    ]);
    expect(lock.rows).toEqual([]);
    await fx.signIn(a.email, NEW_PASSWORD);
    // The completion is recorded as a login event.
    const ev = await owner.query(
      `select 1 from public.login_events where auth_user_id = $1 and event_type = 'PASSWORD_RESET_COMPLETED'`,
      [a.authUserId],
    );
    expect(ev.rows.length).toBe(1);

    // Expiry: a fresh reset whose row has expired is refused.
    expect(await requestPasswordReset(a.email, nextIp())).toEqual({ ok: true });
    const r2 = (
      await owner.query<{ id: string }>(
        `select id from auth.password_resets where auth_user_id = $1 and used_at is null
          order by created_at desc limit 1`,
        [a.authUserId],
      )
    ).rows[0]!;
    const html2 = (
      await owner.query<{ html: string }>(
        `select c.html from public.job_email_content c join public.jobs j on j.id = c.job_id
          where j.dedup_key = $1`,
        [`pwreset:${r2.id}`],
      )
    ).rows[0]!.html;
    const token2 = /reset-password\?token=([0-9a-f]{64})/.exec(html2)![1]!;
    await owner.query(
      `update auth.password_resets set expires_at = now() - interval '1 minute' where id = $1`,
      [r2.id],
    );
    await expect(resetPassword(token2, NEW_PASSWORD + '2', nextIp())).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  }, 120_000);

  it('change password: a wrong current password is refused; other sessions end, this one stays', async () => {
    const a = await account('arfchange');
    const second = await fx.signIn(a.email);
    const h = fx.headersFor(a.cookie);
    const ctx = (await resolveAuthContext(h))!;
    const token = (await currentSessionToken(h))!;
    const base = { ctx, authUserId: a.authUserId, currentSessionToken: token, meta: meta() };
    await expect(
      changePassword({ ...base, currentPassword: 'not it at all 99', newPassword: NEW_PASSWORD }),
    ).rejects.toBeInstanceOf(ChangePasswordError);
    expect(
      await changePassword({ ...base, currentPassword: fx.PASSWORD, newPassword: NEW_PASSWORD }),
    ).toEqual({ ok: true });
    expect(await resolveAuthContext(h)).not.toBeNull();
    expect(await resolveAuthContext(fx.headersFor(second))).toBeNull();
  });

  describe('the self-service session routes the security page uses (D13)', () => {
    const call = (method: 'GET' | 'POST', path: string, cookie: string, body?: unknown) =>
      (method === 'GET' ? authGET : authPOST)(
        new Request(`http://localhost:3000/api/auth${path}`, {
          method,
          headers: {
            cookie,
            origin: 'http://localhost:3000',
            'content-type': 'application/json',
            'x-forwarded-for': nextIp(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );

    it('list-sessions lists only the caller’s own sessions', async () => {
      const a = await account('arflist');
      await fx.signIn(a.email);
      const b = await account('arflistb');
      const res = await call('GET', '/list-sessions', a.cookie);
      expect(res.status).toBe(200);
      const rows = (await res.json()) as { userId: string }[];
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([a.authUserId]));
      expect(rows.some((r) => r.userId === b.authUserId)).toBe(false);
    });

    it('revoke-session cannot end another person’s session; revoke-other-sessions keeps the current one', async () => {
      const a = await account('arfrev');
      const b = await account('arfrevb');
      const bSession = (await sessionsOf(b.authUserId))[0]!;
      const res = await call('POST', '/revoke-session', a.cookie, { token: bSession.token });
      expect(res.status).toBeLessThan(500);
      expect((await sessionsOf(b.authUserId)).map((s) => s.id)).toContain(bSession.id);

      const second = await fx.signIn(a.email);
      const r2 = await call('POST', '/revoke-other-sessions', a.cookie, {});
      expect(r2.status).toBe(200);
      expect(await resolveAuthContext(fx.headersFor(a.cookie))).not.toBeNull();
      expect(await resolveAuthContext(fx.headersFor(second))).toBeNull();
    });
  });

  it('Better Auth’s per-address sign-in limit still answers 429 (its state is on app_auth)', async () => {
    const a = await account('arfrl');
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await authPOST(
        new Request('http://localhost:3000/api/auth/sign-in/email', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://localhost:3000',
            'x-forwarded-for': ip,
          },
          body: JSON.stringify({ email: a.email, password: 'wrong wrong wrong 2' }),
        }),
      );
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  }, 60_000);

  it('the application’s own rate limit (check_rate_limit on app_auth) still refuses a burst', async () => {
    const ip = nextIp();
    const outcomes: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      outcomes.push(
        await requestPasswordReset(`burst.${RUN}.${i}@example.test`, ip).then(
          () => 'ok',
          (e: { code?: string }) => e.code ?? 'error',
        ),
      );
    }
    expect(outcomes.slice(0, 5)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(outcomes).toContain('RATE_LIMITED');
  });

  describe('administrator session actions, proven by a real Better Auth session (0072)', () => {
    it('lists and revokes a same-organization person’s sessions; refuses another organization', async () => {
      const { requirePermission } = await import('@/lib/authz/require-permission');
      const { listUserSessions, revokeAllUserSessions } = await import('@/lib/admin/sessions');
      const role = await fx.mkCustomRole(owner, org, `ARFADM${RUN.toUpperCase()}`, [
        ['sessions.revoke', 'GLOBAL'],
      ]);
      const admin = await account('arfadmin', { customRoles: [role] });
      const target = await account('arftarget');
      await fx.signIn(target.email);
      const foreign = await fx.mkAccount(owner, {
        org: otherOrg,
        dept: otherDept,
        run: RUN,
        label: 'arfforeign',
        roles: ['EMPLOYEE'],
      });

      const h = fx.headersFor(admin.cookie);
      const authz = await requirePermission(h, {
        permission: 'sessions.revoke',
        minScope: 'GLOBAL',
      });
      const token = (await currentSessionToken(h))!;

      const listed = await listUserSessions(authz, token, target.personId);
      expect(listed.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(listed)).not.toContain('token');

      await expect(listUserSessions(authz, token, foreign.personId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      await revokeAllUserSessions(authz, token, target.personId);
      expect(await sessionsOf(target.authUserId)).toEqual([]);
      expect(await resolveAuthContext(fx.headersFor(target.cookie))).toBeNull();
      // The administrator's own session is untouched.
      expect(await resolveAuthContext(h)).not.toBeNull();
    });

    it('an ordinary person’s real session is refused, whatever the application layer believed', async () => {
      const { listUserSessions } = await import('@/lib/admin/sessions');
      const nobody = await account('arfnobody');
      const target = await account('arftarget2');
      const token = (await currentSessionToken(fx.headersFor(nobody.cookie)))!;
      // An Authorization fabricated as if requirePermission had passed: the database still says no.
      const forged = {
        ctx: { personId: nobody.personId, orgId: org, aal: 'aal2' },
        meta: { requestId: randomUUID(), ip: null, userAgent: null },
      } as unknown as Parameters<typeof listUserSessions>[0];
      await expect(listUserSessions(forged, token, target.personId)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });
});
