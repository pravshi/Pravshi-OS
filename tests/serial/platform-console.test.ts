import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from '@neondatabase/serverless';
import { DB_READY } from '../workflows/helpers';

/**
 * The platform console end to end (ADR-008): the operator CLI, the setup links, sign-in and
 * TOTP enrolment, the platform gate, and every console API route — against a database of its
 * own, through the real route handlers, the real Better Auth instance and the real app_platform
 * and app_auth logins.
 *
 * ISOLATION. The platform bootstrap runs once per database and closes the organization
 * bootstrap there, and tests/serial/platform-identity.test.ts bootstraps its own database. So
 * this suite takes a third, empty database — DATABASE_URL_CONSOLE_TEST (owner URL), provisioned
 * by CI like pravshi_platform_test — migrates it from zero with the real runner, and points the
 * application's own URLs (DATABASE_URL, DATABASE_URL_AUTH, DATABASE_URL_PLATFORM) at it, with
 * only the database name changed, BEFORE the application modules are imported. It restores
 * them afterwards.
 *
 * THE OPERATOR. No app_admin login exists in CI or locally (by design, as for 0015). The CLI's
 * own statements run unchanged over an app_owner connection — the functions admit app_admin
 * and app_owner — and only the CLI's session-role probe is answered by the wrapper below. That
 * probe, and the CLI's refusals, are covered by tests/bootstrap/platform-cli.test.ts.
 */
const ISOLATED_URL = process.env.DATABASE_URL_CONSOLE_TEST;
const ENABLED =
  DB_READY &&
  !!ISOLATED_URL &&
  !!process.env.DATABASE_URL_PLATFORM &&
  !!process.env.DATABASE_URL_AUTH &&
  !!process.env.APP_URL;

describe.runIf(DB_READY && !!process.env.CI)('platform console tests: CI provisioning', () => {
  it('provides the isolated console database', () => {
    expect(ISOLATED_URL, 'DATABASE_URL_CONSOLE_TEST').toBeTruthy();
  });
});

const onDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

// ── TOTP, implemented independently (RFC 6238), as in tests/integration/auth-journeys ──────
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32Decode = (input: string): Buffer => {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};
const totpAt = (secret: string, offsetSteps = 0): string => {
  const counter = Math.floor(Date.now() / 1000 / 30) + offsetSteps;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
};

const cookieFrom = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';', 1)[0]!)
    .join('; ');

type Handler = (req: Request) => Promise<Response> | Response;

describe.skipIf(!ENABLED)('platform console (isolated live database)', () => {
  const dbName = ISOLATED_URL ? new URL(ISOLATED_URL).pathname.slice(1) : '';
  const owner = new Pool({ connectionString: ISOLATED_URL, max: 2 });
  owner.on('error', () => undefined);
  const saved: Record<string, string | undefined> = {};
  const ORIGIN = process.env.APP_URL ? new URL(process.env.APP_URL).origin : '';
  const RUN = randomUUID().slice(0, 8);
  const PASSWORD = `Platform!Console-${RUN}-pass`;
  const ORG_ADMIN_PASSWORD = `Org!Admin-${RUN}-pass`;
  const FIRST_EMAIL = `first.${RUN}@platform.example`;

  // Application modules, imported only after the URLs point at the isolated database.
  let routes: Record<string, Record<string, Handler>> = {};
  let cli: typeof import('../../scripts/bootstrap/platform.mjs');

  let ipSeq = 10;
  const nextIp = () => `203.0.113.${(ipSeq += 1)}`;

  const call = async (
    route: string,
    method: 'GET' | 'POST',
    opts: {
      path?: string;
      cookie?: string;
      body?: unknown;
      origin?: string | null;
      ip?: string;
    } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const headers: Record<string, string> = {
      'x-forwarded-for': opts.ip ?? nextIp(),
      'user-agent': 'vitest-platform-console',
    };
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.origin !== null && method === 'POST') headers.origin = opts.origin ?? ORIGIN;
    const res = await routes[route]![method]!(
      new Request(`${ORIGIN}${opts.path ?? route}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
    );
    return {
      status: res.status,
      body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>,
    };
  };

  /** Mediated sign-in (+ TOTP when the login has a factor): the session cookie. */
  const signIn = async (email: string, password: string, secret?: string): Promise<string> => {
    const ip = nextIp();
    const login = await routes['/api/auth/login']!.POST!(
      new Request(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, origin: ORIGIN },
        body: JSON.stringify({ email, password }),
      }),
    );
    expect(login.status, 'sign-in').toBe(200);
    const body = (await login.json()) as { twoFactorRedirect?: boolean };
    if (!body.twoFactorRedirect) return cookieFrom(login);
    expect(secret, 'a factor is enrolled, so a secret is needed').toBeTruthy();
    const verify = await routes['/api/auth/mfa/verify']!.POST!(
      new Request(`${ORIGIN}/api/auth/mfa/verify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': ip,
          origin: ORIGIN,
          cookie: cookieFrom(login),
        },
        body: JSON.stringify({ code: totpAt(secret!), email, method: 'totp' }),
      }),
    );
    expect(verify.status, 'TOTP verification').toBe(200);
    return cookieFrom(verify);
  };

  /** The CLI's real statements over an app_owner connection (see the header). */
  class OperatorClient {
    private readonly c = new Client({ connectionString: ISOLATED_URL });
    connect() {
      return this.c.connect();
    }
    query(text: string, params?: unknown[]) {
      if (text === 'select session_user::text as role') {
        return Promise.resolve({ rows: [{ role: 'app_admin' }] });
      }
      return this.c.query(text, params);
    }
    end() {
      return this.c.end();
    }
  }
  const operator = async (command: string, flags: Record<string, string>) => {
    let link = '';
    await cli.runPlatformOperation(
      {
        command,
        databaseUrl: new URL('postgresql://unused@localhost/unused'),
        appOrigin: ORIGIN,
        email: flags.email!,
        name: flags.name ?? null,
        reason: flags.reason ?? null,
      },
      {
        deliver: ({ link: l }: { link: string }) => {
          link = l;
        },
        Client: OperatorClient as never,
      },
    );
    return link;
  };
  const tokenOf = (link: string) => new URL(link).hash.replace(/^#token=/, '');
  const auditRows = async () =>
    (
      await owner.query<{ action: string; result: string; reason_code: string | null }>(
        `select action, result, reason_code from platform.audit_events order by occurred_at, id`,
      )
    ).rows;

  beforeAll(async () => {
    const sharedDb = new URL(process.env.DATABASE_URL_MIGRATE ?? 'postgresql://x/none').pathname;
    expect(`/${dbName}`, 'the isolated database must not be the shared one').not.toBe(sharedDb);
    const tables = await owner.query<{ n: number }>(
      `select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'platform', 'drizzle') and c.relkind = 'r'`,
    );
    expect(tables.rows[0]!.n, 'the isolated database must be empty').toBe(0);
    const run = spawnSync(process.execPath, ['scripts/migrate-ws.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL_MIGRATE: ISOLATED_URL },
      encoding: 'utf8',
    });
    expect(run.status, 'migrating the isolated database').toBe(0);

    for (const k of ['DATABASE_URL', 'DATABASE_URL_AUTH', 'DATABASE_URL_PLATFORM']) {
      saved[k] = process.env[k];
      process.env[k] = onDb(process.env[k]!, dbName);
    }
    routes = {
      '/api/auth/login': await import('@/app/api/auth/login/route'),
      '/api/auth/mfa/verify': await import('@/app/api/auth/mfa/verify/route'),
      '/api/platform/setup/complete': await import('@/app/api/platform/setup/complete/route'),
      '/api/setup/organization/complete':
        await import('@/app/api/setup/organization/complete/route'),
      '/api/platform/me': await import('@/app/api/platform/me/route'),
      '/api/platform/organizations': await import('@/app/api/platform/organizations/route'),
      '/api/platform/organization-types':
        await import('@/app/api/platform/organization-types/route'),
      suspend: await import('@/app/api/platform/organizations/[orgId]/suspend/route'),
      reactivate: await import('@/app/api/platform/organizations/[orgId]/reactivate/route'),
      reissue: await import('@/app/api/platform/organizations/[orgId]/admin-setup/route'),
      '/api/platform/admins': await import('@/app/api/platform/admins/route'),
      revoke: await import('@/app/api/platform/admins/[adminId]/revoke/route'),
      '/api/platform/audit': await import('@/app/api/platform/audit/route'),
    } as unknown as Record<string, Record<string, Handler>>;
    cli = await import('../../scripts/bootstrap/platform.mjs');
  }, 300_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await owner.end();
  });

  // Shared across the journey, in order.
  let firstAdminSecret = '';
  let adminCookie = '';
  let orgId = '';
  let orgSetupToken = '';
  let orgAdminEmail = '';

  it('the operator bootstraps the first administrator; the setup link sets a password, once', async () => {
    const link = await operator('first-admin', {
      email: FIRST_EMAIL,
      name: 'First Platform Admin',
    });
    expect(link.startsWith(`${ORIGIN}/platform/setup#token=`)).toBe(true);
    const token = tokenOf(link);

    // The organization path does not accept a platform token.
    const wrongPath = await call('/api/setup/organization/complete', 'POST', {
      body: { token, password: PASSWORD },
    });
    expect(wrongPath).toMatchObject({ status: 400, body: { error: 'SETUP_TOKEN_INVALID' } });

    const done = await call('/api/platform/setup/complete', 'POST', {
      body: { token, password: PASSWORD },
    });
    expect(done).toMatchObject({ status: 200, body: { status: 'COMPLETED' } });
    const replay = await call('/api/platform/setup/complete', 'POST', {
      body: { token, password: PASSWORD },
    });
    expect(replay).toMatchObject({ status: 400, body: { error: 'SETUP_TOKEN_INVALID' } });
    // Cross-site POSTs are refused before anything else.
    const crossSite = await call('/api/platform/setup/complete', 'POST', {
      body: { token, password: PASSWORD },
      origin: 'https://evil.example',
    });
    expect(crossSite.status).toBe(403);

    // A second bootstrap is refused by the database, whoever asks.
    await expect(
      operator('first-admin', { email: `second.${RUN}@platform.example`, name: 'X' }),
    ).rejects.toMatchObject({
      code: '55000',
    });
  });

  it('without a second factor the administrator can do nothing; enrolment and a new sign-in open the console', async () => {
    const noSession = await call('/api/platform/me', 'GET');
    expect(noSession).toMatchObject({ status: 401, body: { error: 'UNAUTHENTICATED' } });

    const aal1 = await signIn(FIRST_EMAIL, PASSWORD);
    const refused = await call('/api/platform/me', 'GET', { cookie: aal1 });
    expect(refused).toMatchObject({ status: 403, body: { error: 'MFA_REQUIRED' } });
    const refusedList = await call('/api/platform/organizations', 'GET', { cookie: aal1 });
    expect(refusedList.status).toBe(403);

    const { auth } = await import('@/lib/auth/server');
    const enabled = await auth.api.enableTwoFactor({
      body: { password: PASSWORD },
      headers: new Headers({ cookie: aal1 }),
    });
    if (enabled.method !== 'totp') throw new Error('expected a TOTP enrolment');
    firstAdminSecret = new URL(enabled.totpURI).searchParams.get('secret')!;
    const verified = (await auth.api.verifyTOTP({
      body: { code: totpAt(firstAdminSecret) },
      headers: new Headers({ cookie: aal1 }),
      asResponse: true,
    })) as Response;
    expect(verified.ok).toBe(true);

    adminCookie = await signIn(FIRST_EMAIL, PASSWORD, firstAdminSecret);
    const me = await call('/api/platform/me', 'GET', { cookie: adminCookie });
    expect(me.status).toBe(200);
    const admin = me.body.admin as { email: string; permissions: string[] };
    expect(admin.email).toBe(FIRST_EMAIL);
    expect(admin.permissions).toHaveLength(7);
    expect(me.body.sessionFresh).toBe(true);
  });

  it('provisions an organization of a published type; a retry replays without a second organization or link', async () => {
    const types = await call('/api/platform/organization-types', 'GET', { cookie: adminCookie });
    expect(types.status).toBe(200);
    const list = types.body.types as { typeKey: string }[];
    expect(list.length).toBeGreaterThan(0);

    orgAdminEmail = `founder.${RUN}@tenant.example`;
    const request = {
      idempotencyKey: `console-${RUN}-1`,
      name: `Console Org ${RUN}`,
      slug: `console-${RUN}`,
      timezone: 'Asia/Kolkata',
      typeKey: list[0]!.typeKey,
      adminFullName: 'Tenant Founder',
      adminEmail: orgAdminEmail,
    };
    const invalid = await call('/api/platform/organizations', 'POST', {
      cookie: adminCookie,
      body: { ...request, slug: 'Not A Slug' },
    });
    expect(invalid).toMatchObject({ status: 400, body: { error: 'INVALID_INPUT', field: 'slug' } });

    const created = await call('/api/platform/organizations', 'POST', {
      cookie: adminCookie,
      body: request,
    });
    expect(created.status).toBe(201);
    orgId = created.body.orgId as string;
    const link = created.body.setupLink as string;
    expect(link.startsWith(`${ORIGIN}/setup/organization#token=`)).toBe(true);
    orgSetupToken = tokenOf(link);

    const replay = await call('/api/platform/organizations', 'POST', {
      cookie: adminCookie,
      body: request,
    });
    expect(replay).toMatchObject({ status: 200, body: { replayed: true, orgId } });
    expect(replay.body.setupLink).toBeUndefined();
    const conflict = await call('/api/platform/organizations', 'POST', {
      cookie: adminCookie,
      body: { ...request, name: 'Different' },
    });
    expect(conflict).toMatchObject({ status: 409, body: { error: 'CONFLICT' } });

    const orgs = await call('/api/platform/organizations', 'GET', { cookie: adminCookie });
    const mine = (
      orgs.body.organizations as {
        orgId: string;
        firstAdminSetupPending: boolean;
        status: string;
      }[]
    ).filter((o) => o.orgId === orgId);
    expect(mine).toEqual([
      expect.objectContaining({ status: 'ACTIVE', firstAdminSetupPending: true }),
    ]);
    expect(
      (
        await owner.query(`select count(*)::int n from public.organizations where slug = $1`, [
          request.slug,
        ])
      ).rows[0],
    ).toEqual({ n: 1 });
  });

  it('a re-issued setup link replaces the old one; the first administrator completes setup and signs in as a tenant user', async () => {
    const reissued = await call('reissue', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${orgId}/admin-setup`,
    });
    expect(reissued.status).toBe(200);
    const oldToken = orgSetupToken;
    orgSetupToken = tokenOf(reissued.body.setupLink as string);

    const stale = await call('/api/setup/organization/complete', 'POST', {
      body: { token: oldToken, password: ORG_ADMIN_PASSWORD },
    });
    expect(stale).toMatchObject({ status: 400, body: { error: 'SETUP_TOKEN_INVALID' } });
    // Not valid on the platform path either.
    const wrongPath = await call('/api/platform/setup/complete', 'POST', {
      body: { token: orgSetupToken, password: ORG_ADMIN_PASSWORD },
    });
    expect(wrongPath).toMatchObject({ status: 400, body: { error: 'SETUP_TOKEN_INVALID' } });

    const done = await call('/api/setup/organization/complete', 'POST', {
      body: { token: orgSetupToken, password: ORG_ADMIN_PASSWORD },
    });
    expect(done).toMatchObject({ status: 200, body: { status: 'COMPLETED' } });

    const again = await call('reissue', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${orgId}/admin-setup`,
    });
    expect(again).toMatchObject({ status: 409, body: { error: 'CANNOT_REISSUE' } });

    const tenantCookie = await signIn(orgAdminEmail, ORG_ADMIN_PASSWORD);
    const { resolveAuthContext } = await import('@/lib/auth/session');
    const ctx = await resolveAuthContext(
      new Headers({ cookie: tenantCookie, host: new URL(ORIGIN).host }),
    );
    expect(ctx?.orgId).toBe(orgId);
  });

  it('a tenant user — even the organization SUPER_ADMIN — gets 404 from every console route, and their session is untouched', async () => {
    const tenantCookie = await signIn(orgAdminEmail, ORG_ADMIN_PASSWORD);
    const token = tenantCookie.match(/session_token=([^;]+)/)?.[1] ?? '';
    // Idle by the platform's measure (30 minutes) but not by the tenant's.
    await owner.query(
      `update auth.auth_sessions set updated_at = now() - interval '31 minutes'
       where user_id = (select id from auth.auth_users where email = $1)`,
      [orgAdminEmail],
    );
    for (const [route, method] of [
      ['/api/platform/me', 'GET'],
      ['/api/platform/organizations', 'GET'],
      ['/api/platform/admins', 'GET'],
      ['/api/platform/audit', 'GET'],
    ] as const) {
      expect((await call(route, method, { cookie: tenantCookie })).status, route).toBe(404);
    }
    const provision = await call('/api/platform/organizations', 'POST', {
      cookie: tenantCookie,
      body: { idempotencyKey: `tenant-${RUN}-x` },
    });
    expect(provision.status).toBe(404);
    expect(token).not.toBe('');
    const sessions = await owner.query<{ n: number }>(
      `select count(*)::int n from auth.auth_sessions
       where user_id = (select id from auth.auth_users where email = $1)`,
      [orgAdminEmail],
    );
    expect(sessions.rows[0]!.n, 'the tenant sessions were not deleted').toBeGreaterThan(0);
  });

  it('suspends and reactivates, with a reason, idempotently, audited', async () => {
    const noReason = await call('suspend', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${orgId}/suspend`,
      body: { reason: 'x' },
    });
    expect(noReason.status).toBe(400);
    const suspended = await call('suspend', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${orgId}/suspend`,
      body: { reason: 'Console test suspension' },
    });
    expect(suspended).toMatchObject({ status: 200, body: { status: 'SUSPENDED' } });
    const twice = await call('suspend', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${orgId}/suspend`,
      body: { reason: 'Console test suspension' },
    });
    expect(twice).toMatchObject({ status: 200, body: { status: 'UNCHANGED' } });
    const unknown = await call('suspend', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${randomUUID()}/suspend`,
      body: { reason: 'Console test suspension' },
    });
    expect(unknown).toMatchObject({ status: 404, body: { error: 'NOT_FOUND' } });
    const reactivated = await call('reactivate', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${orgId}/reactivate`,
      body: { reason: 'Console test reactivation' },
    });
    expect(reactivated).toMatchObject({ status: 200, body: { status: 'ACTIVE' } });
    const actions = (await auditRows()).filter((r) => r.result === 'SUCCESS').map((r) => r.action);
    expect(actions.filter((a) => a === 'platform.organization.suspended')).toHaveLength(1);
    expect(actions.filter((a) => a === 'platform.organization.reactivated')).toHaveLength(1);
  });

  it('sensitive actions need a sign-in from the last 10 minutes; the refusal is audited', async () => {
    await owner.query(
      `update auth.auth_sessions set created_at = now() - interval '11 minutes'
       where user_id = (select auth_user_id from platform.admins where email = $1)`,
      [FIRST_EMAIL],
    );
    const stale = await call('suspend', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${orgId}/suspend`,
      body: { reason: 'Should need a fresh sign-in' },
    });
    expect(stale).toMatchObject({ status: 403, body: { error: 'STEP_UP_REQUIRED' } });
    // Reading is not sensitive.
    expect((await call('/api/platform/organizations', 'GET', { cookie: adminCookie })).status).toBe(
      200,
    );
    const denied = (await auditRows()).filter((r) => r.reason_code === 'STEP_UP_REQUIRED');
    expect(denied).toEqual([
      {
        action: 'platform.organization.suspend',
        result: 'DENIED',
        reason_code: 'STEP_UP_REQUIRED',
      },
    ]);
    adminCookie = await signIn(FIRST_EMAIL, PASSWORD, firstAdminSecret);
  });

  it('a platform session idle for 30 minutes is ended and deleted', async () => {
    const idle = await signIn(FIRST_EMAIL, PASSWORD, firstAdminSecret);
    const token = decodeURIComponent(idle.match(/session_token=([^;.]+)/)?.[1] ?? '');
    await owner.query(
      `update auth.auth_sessions set updated_at = now() - interval '31 minutes' where token = $1`,
      [token],
    );
    expect((await call('/api/platform/me', 'GET', { cookie: idle })).status).toBe(401);
    const left = await owner.query(`select 1 from auth.auth_sessions where token = $1`, [token]);
    expect(left.rowCount).toBe(0);
  });

  it('invites an administrator with only permissions the inviter holds; revocation ends their sessions', async () => {
    const email = `second.admin.${RUN}@platform.example`;
    const badPermission = await call('/api/platform/admins', 'POST', {
      cookie: adminCookie,
      body: { email, fullName: 'Second Admin', permissions: ['platform.everything'] },
    });
    expect(badPermission.status).toBe(400);
    const invited = await call('/api/platform/admins', 'POST', {
      cookie: adminCookie,
      body: { email, fullName: 'Second Admin', permissions: ['platform.organizations.suspend'] },
    });
    expect(invited.status).toBe(201);
    const secondId = invited.body.adminId as string;
    const done = await call('/api/platform/setup/complete', 'POST', {
      body: { token: tokenOf(invited.body.setupLink as string), password: PASSWORD },
    });
    expect(done.status).toBe(200);

    const listed = await call('/api/platform/admins', 'GET', { cookie: adminCookie });
    const second = (
      listed.body.admins as { adminId: string; permissions: string[]; status: string }[]
    ).find((a) => a.adminId === secondId);
    expect(second).toMatchObject({ status: 'ACTIVE' });
    expect(second!.permissions.sort()).toEqual(
      [
        'platform.audit.view',
        'platform.organizations.suspend',
        'platform.organizations.view',
      ].sort(),
    );

    // The second administrator signs in (aal1: no factor yet) — then is revoked.
    const secondCookie = await signIn(email, PASSWORD);
    const me = await call('/api/platform/me', 'GET', { cookie: adminCookie });
    const myId = (me.body.admin as { adminId: string }).adminId;
    const self = await call('revoke', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/admins/${myId}/revoke`,
      body: { reason: 'Cannot revoke myself' },
    });
    expect(self).toMatchObject({ status: 409, body: { error: 'CANNOT_REVOKE' } });
    const revoked = await call('revoke', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/admins/${secondId}/revoke`,
      body: { reason: 'Console test revocation' },
    });
    expect(revoked).toMatchObject({ status: 200, body: { status: 'REVOKED' } });
    expect((await call('/api/platform/me', 'GET', { cookie: secondCookie })).status).toBe(401);
  });

  it('pages the audit trail newest first without gaps or repeats', async () => {
    const all = await auditRows();
    const seen: string[] = [];
    type Cursor = { beforeAt: string; beforeId: string } | null;
    let cursor = null as Cursor;
    do {
      const q = new URLSearchParams({ limit: '3' });
      if (cursor) {
        q.set('beforeAt', cursor.beforeAt);
        q.set('beforeId', cursor.beforeId);
      }
      const page = await call('/api/platform/audit', 'GET', {
        cookie: adminCookie,
        path: `/api/platform/audit?${q.toString()}`,
      });
      expect(page.status).toBe(200);
      for (const r of page.body.rows as { id: string }[]) seen.push(r.id);
      cursor = page.body.next as typeof cursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(all.length);
  });

  it('break-glass recovery invalidates the old password and factor at once', async () => {
    const link = await operator('recover', {
      email: FIRST_EMAIL,
      reason: 'Console test: lost authenticator device',
    });
    expect((await call('/api/platform/me', 'GET', { cookie: adminCookie })).status).toBe(401);
    const old = await routes['/api/auth/login']!.POST!(
      new Request(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': nextIp(),
          origin: ORIGIN,
        },
        body: JSON.stringify({ email: FIRST_EMAIL, password: PASSWORD }),
      }),
    );
    expect(old.status).toBe(401);
    const NEW = `${PASSWORD}-recovered`;
    const done = await call('/api/platform/setup/complete', 'POST', {
      body: { token: tokenOf(link), password: NEW },
    });
    expect(done.status).toBe(200);
    const fresh = await signIn(FIRST_EMAIL, NEW);
    expect((await call('/api/platform/me', 'GET', { cookie: fresh })).body).toMatchObject({
      error: 'MFA_REQUIRED',
    });
    const recovered = (await auditRows()).filter((r) => r.action === 'platform.admin.recovered');
    expect(recovered).toEqual([
      { action: 'platform.admin.recovered', result: 'SUCCESS', reason_code: 'BREAK_GLASS' },
    ]);
  });
});
