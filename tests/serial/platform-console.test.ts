import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, Pool } from '@neondatabase/serverless';
import { DB_READY } from '../workflows/helpers';

/**
 * First-administrator setup links go out by email only (0087 policy). The mail provider is
 * replaced here: what the platform hands it is captured, so the suite completes setup with the
 * very link the recipient would receive, and can prove the link appears in no API answer.
 */
const mail = vi.hoisted(() => ({
  configured: true,
  accept: true,
  sent: [] as { to: string; link: string }[],
}));
vi.mock('@/lib/platform/setup-email', () => ({
  isSetupEmailConfigured: () => mail.configured,
  sendOrgAdminSetupEmail: async (m: { to: string; link: string }) => {
    mail.sent.push({ to: m.to, link: m.link });
    return mail.accept;
  },
}));
/** Every API answer body the suite saw, to prove no setup token ever appears in one. */
const answers: string[] = [];
/** The latest link emailed to an address. */
const linkSentTo = (email: string): string => {
  const m = [...mail.sent].reverse().find((x) => x.to.toLowerCase() === email.toLowerCase());
  if (!m) throw new Error(`no setup email was sent to ${email}`);
  return m.link;
};

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
  /** Whichever contender wins the concurrent bootstrap (first test). */
  let FIRST_EMAIL = `first.${RUN}@platform.example`;

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
    const text = await res.text();
    answers.push(text);
    let body: Record<string, unknown> = {};
    try {
      body = (JSON.parse(text) ?? {}) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: res.status, body };
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

  /** Completes a platform setup link, enrols TOTP, and signs in at aal2: the new admin's cookie. */
  const activateAdmin = async (email: string, link: string): Promise<string> => {
    const done = await call('/api/platform/setup/complete', 'POST', {
      body: { token: tokenOf(link), password: PASSWORD },
    });
    expect(done.status, 'setup').toBe(200);
    const { auth } = await import('@/lib/auth/server');
    const enrolCookie = await signIn(email, PASSWORD);
    const enabled = await auth.api.enableTwoFactor({
      body: { password: PASSWORD },
      headers: new Headers({ cookie: enrolCookie }),
    });
    if (enabled.method !== 'totp') throw new Error('expected a TOTP enrolment');
    const secret = new URL(enabled.totpURI).searchParams.get('secret')!;
    const verified = (await auth.api.verifyTOTP({
      body: { code: totpAt(secret) },
      headers: new Headers({ cookie: enrolCookie }),
      asResponse: true,
    })) as Response;
    expect(verified.ok).toBe(true);
    return signIn(email, PASSWORD, secret);
  };
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
      revokeSetup:
        await import('@/app/api/platform/organizations/[orgId]/admin-setup/revoke/route'),
      '/api/platform/admins': await import('@/app/api/platform/admins/route'),
      revoke: await import('@/app/api/platform/admins/[adminId]/revoke/route'),
      adminSetup: await import('@/app/api/platform/admins/[adminId]/setup/route'),
      '/api/auth/[...all]': await import('@/app/api/auth/[...all]/route'),
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
    // Two operators at once: exactly one bootstrap takes effect; the other is refused and leaves
    // nothing (Priority 3: concurrent bootstrap).
    const contenders = [FIRST_EMAIL, `rival.${RUN}@platform.example`];
    const results = await Promise.allSettled(
      contenders.map((email, i) => operator('first-admin', { email, name: `Contender ${i}` })),
    );
    const winners = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []));
    expect(winners).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(['55000', '23505']).toContain((loser.reason as { code?: string }).code);
    FIRST_EMAIL = contenders[winners[0]!]!;
    const link = (results[winners[0]!] as PromiseFulfilledResult<string>).value;
    const counts = await owner.query<{ admins: number; gate: number }>(
      `select (select count(*)::int from platform.admins) admins,
              (select count(*)::int from platform.bootstrap_state) gate`,
    );
    expect(counts.rows[0]).toEqual({ admins: 1, gate: 1 });
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
    // Email only: the answer says where the link went, never the link.
    expect(created.body).toMatchObject({ emailed: true, recipient: orgAdminEmail });
    expect(created.body.setupLink).toBeUndefined();
    const link = linkSentTo(orgAdminEmail);
    expect(link.startsWith(`${ORIGIN}/setup/organization#token=`)).toBe(true);
    const sentBeforeReplay = mail.sent.length;
    orgSetupToken = tokenOf(link);

    const replay = await call('/api/platform/organizations', 'POST', {
      cookie: adminCookie,
      body: request,
    });
    expect(replay).toMatchObject({ status: 200, body: { replayed: true, orgId } });
    expect(replay.body.setupLink).toBeUndefined();
    expect(mail.sent.length, 'a replay sends nothing').toBe(sentBeforeReplay);
    const conflict = await call('/api/platform/organizations', 'POST', {
      cookie: adminCookie,
      body: { ...request, name: 'Different' },
    });
    expect(conflict).toMatchObject({ status: 409, body: { error: 'CONFLICT' } });

    // A state change must come from this origin; a missing Origin is refused too.
    for (const origin of [null, 'https://evil.example']) {
      const refused = await call('/api/platform/organizations', 'POST', {
        cookie: adminCookie,
        body: request,
        origin,
      });
      expect(refused, String(origin)).toMatchObject({
        status: 403,
        body: { error: 'FORBIDDEN_ORIGIN' },
      });
    }

    // The same request twice at once (a double click, a retry racing the first): one
    // organization, one link; the other answer is the replay (Priority 3: concurrency).
    const raced = {
      ...request,
      idempotencyKey: `console-${RUN}-race`,
      name: `Raced Org ${RUN}`,
      slug: `raced-${RUN}`,
      adminEmail: `raced.${RUN}@tenant.example`,
    };
    const both = await Promise.all([
      call('/api/platform/organizations', 'POST', { cookie: adminCookie, body: raced }),
      call('/api/platform/organizations', 'POST', { cookie: adminCookie, body: raced }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(both.filter((r) => r.body.emailed === true)).toHaveLength(1);
    expect(mail.sent.filter((m) => m.to === raced.adminEmail)).toHaveLength(1);
    expect(
      (
        await owner.query(`select count(*)::int n from public.organizations where slug = $1`, [
          raced.slug,
        ])
      ).rows[0],
    ).toEqual({ n: 1 });

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
    expect(reissued.body).toMatchObject({ emailed: true, recipient: orgAdminEmail });
    expect(reissued.body.setupLink).toBeUndefined();
    const oldToken = orgSetupToken;
    orgSetupToken = tokenOf(linkSentTo(orgAdminEmail));

    // An expired link is refused like any dead one; a re-issue replaces it (Priority 3).
    await owner.query(
      `update platform.org_admin_setup
       set issued_at = now() - interval '73 hours', expires_at = now() - interval '1 hour'
       where org_id = $1`,
      [orgId],
    );
    const expired = await call('/api/setup/organization/complete', 'POST', {
      body: { token: orgSetupToken, password: ORG_ADMIN_PASSWORD },
    });
    expect(expired).toMatchObject({ status: 400, body: { error: 'SETUP_TOKEN_INVALID' } });
    const renewed = await call('reissue', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${orgId}/admin-setup`,
    });
    expect(renewed.status).toBe(200);
    const expiredToken = orgSetupToken;
    orgSetupToken = tokenOf(linkSentTo(orgAdminEmail));
    expect(orgSetupToken).not.toBe(expiredToken);

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
    const token = decodeURIComponent(tenantCookie.match(/session_token=([^;.]+)/)?.[1] ?? '');
    expect(token).not.toBe('');
    // Idle by the platform's measure (30 minutes) but not by the tenant's.
    const stamped = await owner.query<{ updated_at: string }>(
      `update auth.auth_sessions set updated_at = now() - interval '31 minutes' where token = $1
       returning updated_at::text`,
      [token],
    );
    expect(stamped.rowCount).toBe(1);
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
    // This very session: neither deleted nor stamped by the platform's limits.
    const after = await owner.query<{ updated_at: string }>(
      `select updated_at::text from auth.auth_sessions where token = $1`,
      [token],
    );
    expect(after.rows, 'the tenant session still exists, unstamped').toEqual(stamped.rows);
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

    // And 12 hours after its creation, however active it was.
    const old = await signIn(FIRST_EMAIL, PASSWORD, firstAdminSecret);
    const oldToken = decodeURIComponent(old.match(/session_token=([^;.]+)/)?.[1] ?? '');
    await owner.query(
      `update auth.auth_sessions set created_at = now() - interval '12 hours 1 minute' where token = $1`,
      [oldToken],
    );
    expect((await call('/api/platform/me', 'GET', { cookie: old })).status).toBe(401);
    expect(
      (await owner.query(`select 1 from auth.auth_sessions where token = $1`, [oldToken])).rowCount,
    ).toBe(0);
  });

  it('invites an administrator with only permissions the inviter holds; revocation ends their sessions', async () => {
    const email = `second.admin.${RUN}@platform.example`;
    const badPermission = await call('/api/platform/admins', 'POST', {
      cookie: adminCookie,
      body: {
        idempotencyKey: `invite-${RUN}-bad`,
        email,
        fullName: 'Second Admin',
        permissions: ['platform.everything'],
      },
    });
    expect(badPermission.status).toBe(400);
    const invitation = {
      idempotencyKey: `invite-${RUN}-second`,
      email,
      fullName: 'Second Admin',
      permissions: ['platform.organizations.suspend'],
    };
    const invited = await call('/api/platform/admins', 'POST', {
      cookie: adminCookie,
      body: invitation,
    });
    expect(invited.status).toBe(201);
    const secondId = invited.body.adminId as string;

    // F-CONSOLE-11: the same request again (a lost answer, retried) replays — no second
    // administrator, no second link; the same key with other details is refused.
    const retried = await call('/api/platform/admins', 'POST', {
      cookie: adminCookie,
      body: invitation,
    });
    expect(retried).toMatchObject({ status: 200, body: { replayed: true, adminId: secondId } });
    expect(retried.body.setupLink).toBeUndefined();
    const changed = await call('/api/platform/admins', 'POST', {
      cookie: adminCookie,
      body: { ...invitation, fullName: 'Someone Else' },
    });
    expect(changed).toMatchObject({ status: 409, body: { error: 'CONFLICT' } });
    expect(
      (await owner.query(`select count(*)::int n from platform.admins where email = $1`, [email]))
        .rows[0],
    ).toEqual({ n: 1 });
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

    // The second administrator enrols a factor and signs in at aal2: what they lack is refused
    // with 403 and a DENIED entry under the operation's own name.
    const { auth } = await import('@/lib/auth/server');
    const enrolCookie = await signIn(email, PASSWORD);
    const enabled = await auth.api.enableTwoFactor({
      body: { password: PASSWORD },
      headers: new Headers({ cookie: enrolCookie }),
    });
    if (enabled.method !== 'totp') throw new Error('expected a TOTP enrolment');
    const secondSecret = new URL(enabled.totpURI).searchParams.get('secret')!;
    const verified = (await auth.api.verifyTOTP({
      body: { code: totpAt(secondSecret) },
      headers: new Headers({ cookie: enrolCookie }),
      asResponse: true,
    })) as Response;
    expect(verified.ok).toBe(true);
    const secondCookie = await signIn(email, PASSWORD, secondSecret);
    expect((await call('/api/platform/me', 'GET', { cookie: secondCookie })).status).toBe(200);
    const notAllowed = await call('/api/platform/admins', 'GET', { cookie: secondCookie });
    expect(notAllowed).toMatchObject({ status: 403, body: { error: 'FORBIDDEN' } });
    const cannotInvite = await call('/api/platform/admins', 'POST', {
      cookie: secondCookie,
      body: {
        idempotencyKey: `invite-${RUN}-denied`,
        email: `third.${RUN}@platform.example`,
        fullName: 'Third',
        permissions: [],
      },
    });
    expect(cannotInvite).toMatchObject({ status: 403, body: { error: 'FORBIDDEN' } });
    const deniedRows = (await auditRows()).filter((r) => r.reason_code === 'NO_PERMISSION');
    expect(deniedRows).toEqual([
      { action: 'platform.admin.list', result: 'DENIED', reason_code: 'NO_PERMISSION' },
      { action: 'platform.admin.invite', result: 'DENIED', reason_code: 'NO_PERMISSION' },
    ]);
    // Suspension is theirs: allowed (an unknown organization answers 404).
    const theirs = await call('suspend', 'POST', {
      cookie: secondCookie,
      path: `/api/platform/organizations/${randomUUID()}/suspend`,
      body: { reason: 'Permission check only' },
    });
    expect(theirs.status).toBe(404);

    // Then they are revoked.
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

    // S-CONSOLE-3: the revoked administrator cannot obtain a session again, by any step —
    // password and second factor both correct.
    const ip = nextIp();
    const again = await routes['/api/auth/login']!.POST!(
      new Request(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, origin: ORIGIN },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    if (again.status === 200) {
      expect(((await again.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(
        true,
      );
      const verify = await routes['/api/auth/mfa/verify']!.POST!(
        new Request(`${ORIGIN}/api/auth/mfa/verify`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': ip,
            origin: ORIGIN,
            cookie: cookieFrom(again),
          },
          body: JSON.stringify({ code: totpAt(secondSecret), email, method: 'totp' }),
        }),
      );
      expect(verify.status).toBe(401);
    } else {
      expect(again.status).toBe(401);
    }
    const sessions = await owner.query<{ n: number }>(
      `select count(*)::int n from auth.auth_sessions
       where user_id = (select auth_user_id from platform.admins where id = $1)`,
      [secondId],
    );
    expect(sessions.rows[0]).toEqual({ n: 0 });
  });

  it('an invitation that was never used can be re-issued; the recipient stays; a used one cannot', async () => {
    const email = `pending.${RUN}@platform.example`;
    const invited = await call('/api/platform/admins', 'POST', {
      cookie: adminCookie,
      body: {
        idempotencyKey: `invite-${RUN}-pending`,
        email,
        fullName: 'Pending',
        permissions: [],
      },
    });
    expect(invited.status).toBe(201);
    const id = invited.body.adminId as string;
    const first = tokenOf(invited.body.setupLink as string);
    const reissued = await call('adminSetup', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/admins/${id}/setup`,
    });
    expect(reissued.status).toBe(200);
    const second = tokenOf(reissued.body.setupLink as string);
    expect(second).not.toBe(first);
    const stale = await call('/api/platform/setup/complete', 'POST', {
      body: { token: first, password: PASSWORD },
    });
    expect(stale).toMatchObject({ status: 400, body: { error: 'SETUP_TOKEN_INVALID' } });
    const done = await call('/api/platform/setup/complete', 'POST', {
      body: { token: second, password: PASSWORD },
    });
    expect(done.status).toBe(200);
    // The login it created is the invitation's recipient.
    const login = await owner.query<{ email: string }>(
      `select u.email::text from platform.admins a join auth.auth_users u on u.id = a.auth_user_id
       where a.id = $1`,
      [id],
    );
    expect(login.rows).toEqual([{ email }]);
    // Used: the console cannot re-issue it (recovery is the operator's).
    const used = await call('adminSetup', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/admins/${id}/setup`,
    });
    expect(used).toMatchObject({ status: 409, body: { error: 'CANNOT_REISSUE' } });
    const audited = await owner.query<{ action: string; actor_admin_id: string | null }>(
      `select action, actor_admin_id from platform.audit_events
       where target_id = $1 and action = 'platform.admin.setup_reissued'`,
      [id],
    );
    expect(audited.rows).toHaveLength(1);
    expect(audited.rows[0]!.actor_admin_id).not.toBeNull();
  });

  it('a re-issue never hands anyone more than an invitation of their own could (S2-1)', async () => {
    const invite = (cookie: string, key: string, email: string, permissions: string[]) =>
      call('/api/platform/admins', 'POST', {
        cookie,
        body: { idempotencyKey: `${key}-${RUN}`, email, fullName: key, permissions },
      });
    // A limited administrator: can manage administrators, nothing else beyond the views.
    const limitedEmail = `limited.${RUN}@platform.example`;
    const limitedInvite = await invite(adminCookie, 'limited', limitedEmail, [
      'platform.admins.manage',
    ]);
    expect(limitedInvite.status).toBe(201);
    const limited = await activateAdmin(limitedEmail, limitedInvite.body.setupLink as string);

    // A stronger invitation, sent by someone else, never used.
    const strong = await invite(adminCookie, 'strong', `strong.${RUN}@platform.example`, [
      'platform.organizations.create',
    ]);
    expect(strong.status).toBe(201);
    const strongId = strong.body.adminId as string;
    const tokenBefore = await owner.query<{ h: string }>(
      `select encode(token_hash, 'hex') h from platform.setup_tokens where admin_id = $1`,
      [strongId],
    );
    const takeover = await call('adminSetup', 'POST', {
      cookie: limited,
      path: `/api/platform/admins/${strongId}/setup`,
    });
    expect(takeover).toMatchObject({ status: 403, body: { error: 'FORBIDDEN' } });
    expect(takeover.body.setupLink).toBeUndefined();
    const tokenAfter = await owner.query<{ h: string }>(
      `select encode(token_hash, 'hex') h from platform.setup_tokens where admin_id = $1`,
      [strongId],
    );
    expect(tokenAfter.rows).toEqual(tokenBefore.rows);

    // Their own invitation, within what they hold: allowed.
    const own = await invite(limited, 'own', `own.${RUN}@platform.example`, []);
    expect(own.status).toBe(201);
    const ownReissue = await call('adminSetup', 'POST', {
      cookie: limited,
      path: `/api/platform/admins/${own.body.adminId as string}/setup`,
    });
    expect(ownReissue.status).toBe(200);
  });

  it("Better Auth's own routes apply the platform's session limits to administrators only", async () => {
    const selfService = (cookie: string) =>
      routes['/api/auth/[...all]']!.GET!(
        new Request(`${ORIGIN}/api/auth/list-sessions`, {
          headers: { cookie, 'x-forwarded-for': nextIp() },
        }),
      );
    // An administrator's session idle past 30 minutes is ended there too (S-CONSOLE-6).
    const idle = await signIn(FIRST_EMAIL, PASSWORD, firstAdminSecret);
    const token = decodeURIComponent(idle.match(/session_token=([^;.]+)/)?.[1] ?? '');
    expect((await selfService(idle)).status).toBe(200);
    await owner.query(
      `update auth.auth_sessions set updated_at = now() - interval '31 minutes' where token = $1`,
      [token],
    );
    expect((await selfService(idle)).status).toBe(401);
    expect(
      (await owner.query(`select 1 from auth.auth_sessions where token = $1`, [token])).rowCount,
    ).toBe(0);

    // A tenant user's session idle as long is theirs to keep.
    const tenant = await signIn(orgAdminEmail, ORG_ADMIN_PASSWORD);
    const tenantToken = decodeURIComponent(tenant.match(/session_token=([^;.]+)/)?.[1] ?? '');
    await owner.query(
      `update auth.auth_sessions set updated_at = now() - interval '31 minutes' where token = $1`,
      [tenantToken],
    );
    expect((await selfService(tenant)).status).toBe(200);
    expect(
      (await owner.query(`select 1 from auth.auth_sessions where token = $1`, [tenantToken]))
        .rowCount,
    ).toBe(1);
  });

  it('only same-site activity extends the idle clock; a cross-site or headerless read does not', async () => {
    const cookie = await signIn(FIRST_EMAIL, PASSWORD, firstAdminSecret);
    const token = decodeURIComponent(cookie.match(/session_token=([^;.]+)/)?.[1] ?? '');
    const backdate = () =>
      owner.query(
        `update auth.auth_sessions set updated_at = now() - interval '20 minutes' where token = $1`,
        [token],
      );
    const idleMinutes = async () =>
      (
        await owner.query<{ m: number }>(
          `select floor(extract(epoch from now() - updated_at) / 60)::int m
           from auth.auth_sessions where token = $1`,
          [token],
        )
      ).rows[0]!.m;
    const get = (site: string | null) => {
      const headers: Record<string, string> = { cookie, 'x-forwarded-for': nextIp() };
      if (site) headers['sec-fetch-site'] = site;
      return routes['/api/platform/me']!.GET!(
        new Request(`${ORIGIN}/api/platform/me`, { headers }),
      );
    };
    for (const site of ['cross-site', 'same-site', null]) {
      await backdate();
      expect((await get(site)).status, String(site)).toBe(200);
      expect(await idleMinutes(), String(site)).toBe(20);
    }
    for (const site of ['same-origin', 'none']) {
      await backdate();
      expect((await get(site)).status, site).toBe(200);
      expect(await idleMinutes(), site).toBe(0);
    }
  });

  it("the first administrator's recipient is fixed while their setup is pending (S-CONSOLE-10)", async () => {
    const request = {
      idempotencyKey: `console-${RUN}-fixed`,
      name: `Fixed Org ${RUN}`,
      slug: `fixed-${RUN}`,
      timezone: 'Asia/Kolkata',
      typeKey: (
        await owner.query<{ type_key: string }>(
          `select type_key from public.organizations where id = $1`,
          [orgId],
        )
      ).rows[0]!.type_key,
      adminFullName: 'Fixed Founder',
      adminEmail: `fixed.${RUN}@tenant.example`,
    };
    const created = await call('/api/platform/organizations', 'POST', {
      cookie: adminCookie,
      body: request,
    });
    expect(created.status).toBe(201);
    const person = await owner.query<{ person_id: string }>(
      `select person_id from platform.org_admin_setup where org_id = $1`,
      [created.body.orgId],
    );
    const personId = person.rows[0]!.person_id;
    // Nobody — not even the schema owner — can redirect the pending setup to another address.
    let refused = '';
    try {
      await owner.query(`update public.people set work_email = $2 where id = $1`, [
        personId,
        `attacker.${RUN}@evil.example`,
      ]);
    } catch (e) {
      refused = (e as { code?: string }).code ?? 'unknown';
    }
    expect(refused).toBe('42501');
    // A re-issue keeps the recipient; completing it creates that address's login.
    const reissued = await call('reissue', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${created.body.orgId}/admin-setup`,
    });
    expect(reissued.status).toBe(200);
    const done = await call('/api/setup/organization/complete', 'POST', {
      body: { token: tokenOf(linkSentTo(request.adminEmail)), password: ORG_ADMIN_PASSWORD },
    });
    expect(done.status).toBe(200);
    const login = await owner.query<{ email: string }>(
      `select u.email::text from public.people p join auth.auth_users u on u.id = p.auth_user_id
       where p.id = $1`,
      [personId],
    );
    expect(login.rows).toEqual([{ email: request.adminEmail }]);
    // The re-issue is audited with its actor and the recipient person.
    const audited = await owner.query<{ actor_admin_id: string | null; target_id: string }>(
      `select actor_admin_id, target_id from platform.audit_events
       where action = 'platform.organization.admin_setup_reissued' and target_org_id = $1`,
      [created.body.orgId],
    );
    expect(audited.rows).toHaveLength(1);
    expect(audited.rows[0]!.target_id).toBe(personId);
    expect(audited.rows[0]!.actor_admin_id).not.toBeNull();
    // Once setup is complete the email is the organization's to manage again.
    await owner.query(`update public.people set work_email = $2 where id = $1`, [
      personId,
      `renamed.${RUN}@tenant.example`,
    ]);
  });

  it('setup links are email only: refused unconfigured, audited when undelivered, revocable', async () => {
    const typeKey = (
      await owner.query<{ type_key: string }>(
        `select type_key from public.organizations where id = $1`,
        [orgId],
      )
    ).rows[0]!.type_key;
    const provision = (tag: string) =>
      call('/api/platform/organizations', 'POST', {
        cookie: adminCookie,
        body: {
          idempotencyKey: `console-${RUN}-${tag}`,
          name: `Mail ${tag} ${RUN}`,
          slug: `mail-${tag}-${RUN}`,
          timezone: 'Asia/Kolkata',
          typeKey,
          adminFullName: `Mail ${tag} Founder`,
          adminEmail: `mail.${tag}.${RUN}@tenant.example`,
        },
      });

    // Not configured: refused before anything exists — no link nobody can receive.
    mail.configured = false;
    try {
      const refused = await provision('off');
      expect(refused).toMatchObject({ status: 503, body: { error: 'EMAIL_NOT_CONFIGURED' } });
    } finally {
      mail.configured = true;
    }
    expect(
      (
        await owner.query(`select count(*)::int n from public.organizations where slug = $1`, [
          `mail-off-${RUN}`,
        ])
      ).rows[0],
    ).toEqual({ n: 0 });

    // Not accepted by the provider: the organization stands, the failure is audited, no link.
    mail.accept = false;
    let undelivered;
    try {
      undelivered = await provision('fail');
    } finally {
      mail.accept = true;
    }
    expect(undelivered.status).toBe(201);
    expect(undelivered.body).toMatchObject({ emailed: false });
    expect(undelivered.body.setupLink).toBeUndefined();
    const failedOrg = undelivered.body.orgId as string;
    const failures = await owner.query<{ result: string; reason_code: string }>(
      `select result, reason_code from platform.audit_events
       where target_org_id = $1 and action = 'platform.organization.provision'`,
      [failedOrg],
    );
    expect(failures.rows).toContainEqual({ result: 'ERROR', reason_code: 'EMAIL_DELIVERY_FAILED' });
    // A re-issue sends a fresh one to the recorded recipient.
    const resent = await call('reissue', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${failedOrg}/admin-setup`,
    });
    expect(resent).toMatchObject({
      status: 200,
      body: { emailed: true, recipient: `mail.fail.${RUN}@tenant.example` },
    });

    // Revocation ends the pending link without issuing another; audited; re-issue works after.
    const revocable = await provision('revoke');
    expect(revocable.status).toBe(201);
    const revOrg = revocable.body.orgId as string;
    const revToken = tokenOf(linkSentTo(`mail.revoke.${RUN}@tenant.example`));
    const noReason = await call('revokeSetup', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${revOrg}/admin-setup/revoke`,
      body: { reason: 'x' },
    });
    expect(noReason.status).toBe(400);
    const revoked = await call('revokeSetup', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${revOrg}/admin-setup/revoke`,
      body: { reason: 'Sent to the wrong person' },
    });
    expect(revoked.status).toBe(200);
    // EM-1: the stored hash is replaced, not only expired — a completion already under way
    // cannot match the revoked link.
    const stored = await owner.query<{ h: Buffer }>(
      `select token_hash h from platform.org_admin_setup where org_id = $1`,
      [revOrg],
    );
    expect(stored.rows[0]!.h.toString('hex')).not.toBe(
      createHash('sha256').update(revToken, 'utf8').digest('hex'),
    );
    const dead = await call('/api/setup/organization/complete', 'POST', {
      body: { token: revToken, password: ORG_ADMIN_PASSWORD },
    });
    expect(dead).toMatchObject({ status: 400, body: { error: 'SETUP_TOKEN_INVALID' } });
    const audited = await owner.query<{ actor_admin_id: string | null }>(
      `select actor_admin_id from platform.audit_events
       where target_org_id = $1 and action = 'platform.organization.admin_setup_revoked'`,
      [revOrg],
    );
    expect(audited.rows).toHaveLength(1);
    expect(audited.rows[0]!.actor_admin_id).not.toBeNull();
    const again = await call('reissue', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${revOrg}/admin-setup`,
    });
    expect(again).toMatchObject({ status: 200, body: { emailed: true } });
    const done = await call('/api/setup/organization/complete', 'POST', {
      body: {
        token: tokenOf(linkSentTo(`mail.revoke.${RUN}@tenant.example`)),
        password: ORG_ADMIN_PASSWORD,
      },
    });
    expect(done.status).toBe(200);
    const late = await call('revokeSetup', 'POST', {
      cookie: adminCookie,
      path: `/api/platform/organizations/${revOrg}/admin-setup/revoke`,
      body: { reason: 'Too late to revoke' },
    });
    expect(late).toMatchObject({ status: 409, body: { error: 'CANNOT_REVOKE' } });
  });

  it('no organization setup token ever appears in an API answer or in the audit', async () => {
    const tokens = mail.sent.map((m) => tokenOf(m.link));
    expect(tokens.length).toBeGreaterThan(5);
    const everything = answers.join(' ');
    for (const t of tokens) expect(everything.includes(t), 'a token in an API answer').toBe(false);
    const audit = await owner.query<{ m: string }>(
      `select coalesce(string_agg(metadata::text || coalesce(reason_code, ''), ' '), '') m
       from platform.audit_events`,
    );
    for (const t of tokens)
      expect(audit.rows[0]!.m.includes(t), 'a token in the audit').toBe(false);
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
    expect(all.length).toBeGreaterThan(6);
    const expected = await owner.query<{ id: string }>(
      `select id from platform.audit_events order by occurred_at desc, id desc`,
    );
    expect(seen).toEqual(expected.rows.map((r) => r.id));
  });

  it('sensitive actions are rate limited per administrator; the refusal is audited', async () => {
    let limited = false;
    for (let i = 0; i < 40 && !limited; i += 1) {
      const r = await call('suspend', 'POST', {
        cookie: adminCookie,
        path: `/api/platform/organizations/${randomUUID()}/suspend`,
        body: { reason: 'Rate limit probe' },
      });
      if (r.status === 429) limited = true;
      else expect(r.status).toBe(404);
    }
    expect(limited).toBe(true);
    // Further refusals in the same window are answered, not recorded again (review R-2).
    for (let i = 0; i < 3; i += 1) {
      const again = await call('suspend', 'POST', {
        cookie: adminCookie,
        path: `/api/platform/organizations/${randomUUID()}/suspend`,
        body: { reason: 'Rate limit probe' },
      });
      expect(again.status).toBe(429);
    }
    const rows = (await auditRows()).filter((r) => r.reason_code === 'RATE_LIMITED');
    expect(rows).toEqual([
      { action: 'platform.organization.suspend', result: 'DENIED', reason_code: 'RATE_LIMITED' },
    ]);
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
