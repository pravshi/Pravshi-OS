import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { createHash, randomBytes } from 'node:crypto';
import { auth } from '@/lib/auth/server';
import { acceptInvitation } from '@/lib/auth/invitations';
import { POST as mediatedLoginPOST } from '@/app/api/auth/login/route';

/**
 * Phase 11 (F-11-04 / F-11-05) regression tests — the auth choke point.
 *
 * The per-account lockout and the login-event recording used to live only in
 * the mediated /api/auth/login route, so Better Auth's own
 * POST /api/auth/sign-in/email bypassed both. They now live in the auth
 * hooks (src/lib/auth/server.ts), which the library's dispatch runs for
 * auth.api.* calls and HTTP requests alike. These tests prove, against a
 * real database:
 *
 *   - a sign-in on EITHER path is recorded exactly once (never zero, never
 *     twice — the mediated route delegates through the same hooks and keeps
 *     no bookkeeping of its own);
 *   - a locked account is refused before the credential check on both
 *     paths, with a response body-identical to a wrong password;
 *   - an MFA challenge is recorded as MFA_CHALLENGE, not LOGIN_SUCCESS;
 *   - the library's password-reset request endpoint is refused;
 *   - sign-out records exactly one SESSION_REVOKED.
 *
 * "Raw path" here is auth.api.signInEmail — the same dispatch the [...all]
 * HTTP handler runs — which is the closest executable stand-in for a direct
 * POST to /api/auth/sign-in/email.
 *
 * Runs against the ephemeral branch CI provisions and skips gracefully when
 * no database is configured (the Nov-1 rule: CI is the DB gate).
 */

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

const owner = HAS_DB ? new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE }) : null;

const RUN = randomBytes(4).toString('hex');
const PASSWORD = 'correct horse battery staple 001';
const WRONG = 'wrong password entirely 999';

const newToken = () => randomBytes(32).toString('hex');
const digestOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

let personSeq = 0;
const personCode = () => {
  personSeq += 1;
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  return `EMP-2026-${rand}${String(personSeq).padStart(4, '0')}`;
};

let orgId = '';
let deptId = '';
let inviterId = '';

beforeAll(async () => {
  if (!HAS_DB) return;

  orgId = (
    await owner!.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1, $2) returning id`,
      [`Choke Org ${RUN}`, `choke-${RUN}`],
    )
  ).rows[0]!.id;

  deptId = (
    await owner!.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1, $2, $3) returning id`,
      [orgId, `CHK${RUN.slice(0, 4).toUpperCase()}`, `Choke Dept ${RUN}`],
    )
  ).rows[0]!.id;

  inviterId = (
    await owner!.query<{ id: string }>(
      `insert into public.people (org_id, code, full_legal_name, person_status)
       values ($1, $2, $3, 'ACTIVE') returning id`,
      [orgId, personCode(), 'Choke Inviter'],
    )
  ).rows[0]!.id;
  const superAdmin = (
    await owner!.query<{ id: string }>(
      `select id from public.roles where org_id = $1 and key = 'SUPER_ADMIN' and is_system`,
      [orgId],
    )
  ).rows[0]!.id;
  await owner!.query(
    `insert into public.person_roles (person_id, role_id, org_id) values ($1, $2, $3)`,
    [inviterId, superAdmin, orgId],
  );
});

afterAll(async () => {
  await owner?.end();
});

/** Create an invitation row directly, then accept it through the real app path. */
async function inviteAndAccept(
  label: string,
): Promise<{ email: string; authUserId: string; personId: string }> {
  const email = `${label}.${RUN}@example.test`;
  const token = newToken();
  const code = `INV-${RUN}-${label}`.toUpperCase().slice(0, 24);
  await owner!.query(
    `insert into public.invitations
       (org_id, code, email, token_hash, invited_by, expires_at,
        engagement_type, department_id, start_date)
     values ($1, $2, $3::citext, $4, $5, now() + interval '7 days',
             'EMPLOYEE', $6::uuid, $7::date)`,
    [orgId, code, email, digestOf(token), inviterId, deptId, '2026-09-28'],
  );
  const accepted = await acceptInvitation({
    token,
    fullName: `${label} Person`,
    password: PASSWORD,
  });
  const row = (
    await owner!.query<{ auth_user_id: string }>(
      `select auth_user_id::text from public.people where id = $1::uuid`,
      [accepted.personId],
    )
  ).rows[0]!;
  return { email, authUserId: row.auth_user_id, personId: accepted.personId };
}

/** A distinct source IP per scenario, so the per-IP library limiter never couples tests. */
let ipSeq = 0;
const nextIp = () => `203.0.113.${(ipSeq += 1)}`;
const headersForIp = (ip: string) =>
  new Headers({ 'x-forwarded-for': ip, 'user-agent': 'vitest-choke-point' });

/** The raw library path — what a direct POST to /api/auth/sign-in/email dispatches. */
const signInRaw = async (email: string, password: string, ip: string) =>
  (await auth.api.signInEmail({
    body: { email, password },
    headers: headersForIp(ip),
    asResponse: true,
  })) as Response;

/** The mediated path — the real /api/auth/login route handler. */
const signInMediated = async (email: string, password: string, ip: string) =>
  mediatedLoginPOST(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
        'user-agent': 'vitest-choke-point',
      },
      body: JSON.stringify({ email, password }),
    }),
  );

const countEvents = async (email: string, eventType: string): Promise<number> => {
  const r = await owner!.query<{ n: string }>(
    `select count(*) n from public.login_events where email = $1::citext and event_type = $2`,
    [email, eventType],
  );
  return Number(r.rows[0]!.n);
};

const lockoutRow = async (authUserId: string) => {
  const r = await owner!.query<{ failed_count: number; locked_until: string | null }>(
    `select failed_count, locked_until from auth.login_lockouts where auth_user_id = $1::uuid`,
    [authUserId],
  );
  return r.rows[0] ?? null;
};

const sessionCountFor = async (authUserId: string): Promise<number> => {
  const r = await owner!.query<{ n: string }>(
    `select count(*) n from auth.auth_sessions where user_id = $1::uuid`,
    [authUserId],
  );
  return Number(r.rows[0]!.n);
};

const cookieHeaderFrom = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');

describe.runIf(HAS_DB)('F-11-04: single recording on both sign-in paths', () => {
  it('raw sign-in success records exactly one LOGIN_SUCCESS, with the attempt ip/agent', async () => {
    const { email } = await inviteAndAccept('rawok');
    const ip = nextIp();

    const res = await signInRaw(email, PASSWORD, ip);
    expect(res.status).toBe(200);

    expect(await countEvents(email, 'LOGIN_SUCCESS')).toBe(1);
    expect(await countEvents(email, 'LOGIN_FAILURE')).toBe(0);
    const row = (
      await owner!.query<{ ip_address: string | null; user_agent: string | null }>(
        `select host(ip_address) as ip_address, user_agent from public.login_events
          where email = $1::citext and event_type = 'LOGIN_SUCCESS'`,
        [email],
      )
    ).rows[0]!;
    expect(row.ip_address).toBe(ip);
    expect(row.user_agent).toBe('vitest-choke-point');
  });

  it('mediated sign-in success records exactly one LOGIN_SUCCESS (not two)', async () => {
    const { email } = await inviteAndAccept('medok');
    const res = await signInMediated(email, PASSWORD, nextIp());
    expect(res.status).toBe(200);

    // The route still forwards the library body, with its enrolment hint added.
    const body = (await res.json()) as { token?: string; mfaEnrollmentRequired?: boolean };
    expect(body.token).toBeTruthy();
    expect(body.mfaEnrollmentRequired).toBe(false);

    expect(await countEvents(email, 'LOGIN_SUCCESS')).toBe(1);
    expect(await countEvents(email, 'LOGIN_FAILURE')).toBe(0);
  });

  it('raw wrong password records exactly one LOGIN_FAILURE and counts toward lockout', async () => {
    const { email, authUserId } = await inviteAndAccept('rawbad');
    const res = await signInRaw(email, WRONG, nextIp());
    expect(res.status).toBe(401);

    expect(await countEvents(email, 'LOGIN_FAILURE')).toBe(1);
    expect(await countEvents(email, 'LOGIN_SUCCESS')).toBe(0);
    expect((await lockoutRow(authUserId))?.failed_count).toBe(1);
  });

  it('mediated wrong password records exactly one LOGIN_FAILURE (not two)', async () => {
    const { email, authUserId } = await inviteAndAccept('medbad');
    const res = await signInMediated(email, WRONG, nextIp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'INVALID_CREDENTIALS' });

    expect(await countEvents(email, 'LOGIN_FAILURE')).toBe(1);
    expect((await lockoutRow(authUserId))?.failed_count).toBe(1);
  });
});

describe.runIf(HAS_DB)('F-11-04: a locked account is refused on both paths', () => {
  it('the correct password is refused once locked — generically, once per attempt', async () => {
    const { email, authUserId } = await inviteAndAccept('locked');
    const ip = nextIp();

    // Five wrong attempts cross the threshold (5 in 15 minutes, migration 0027).
    let wrongBody: unknown = null;
    for (let i = 0; i < 5; i += 1) {
      const res = await signInRaw(email, WRONG, ip);
      expect(res.status).toBe(401);
      if (i === 0) wrongBody = await res.json();
    }
    const lock = await lockoutRow(authUserId);
    expect(lock?.failed_count).toBe(5);
    expect(lock?.locked_until).not.toBeNull();
    expect(await countEvents(email, 'LOGIN_FAILURE')).toBe(5);

    // Raw path: the CORRECT password is now refused before any credential
    // check, and no session is minted. A before-hook refusal THROWS to an
    // auth.api caller (the HTTP router converts the same throw into the 401
    // response); the thrown error's body must be identical to the
    // wrong-password answer — that identity is the anti-enumeration point.
    const sessionsBefore = await sessionCountFor(authUserId);
    let lockedError: unknown = null;
    try {
      await signInRaw(email, PASSWORD, ip);
    } catch (e) {
      lockedError = e;
    }
    expect(lockedError).not.toBeNull();
    expect((lockedError as { statusCode?: number }).statusCode).toBe(401);
    expect((lockedError as { body?: unknown }).body).toEqual(wrongBody);
    expect(await sessionCountFor(authUserId)).toBe(sessionsBefore);

    // Mediated path: the same refusal, surfaced as the route's generic 401.
    const lockedMediated = await signInMediated(email, PASSWORD, ip);
    expect(lockedMediated.status).toBe(401);
    expect(await lockedMediated.json()).toEqual({ error: 'INVALID_CREDENTIALS' });

    // Each locked attempt recorded exactly one more LOGIN_FAILURE; neither
    // fed the failure counter (an active lockout is never extended), and no
    // success was ever recorded.
    expect(await countEvents(email, 'LOGIN_FAILURE')).toBe(7);
    expect(await countEvents(email, 'LOGIN_SUCCESS')).toBe(0);
    expect((await lockoutRow(authUserId))?.failed_count).toBe(5);
  });
});

describe.runIf(HAS_DB)('F-11-04: MFA challenge is its own outcome', () => {
  it('records exactly one MFA_CHALLENGE, no LOGIN_SUCCESS, and clears the counter', async () => {
    const { email, authUserId } = await inviteAndAccept('mfa');
    const ip = nextIp();
    // Enrolment flag only: the challenge conversion keys off the user row.
    await owner!.query(`update auth.auth_users set two_factor_enabled = true where id = $1::uuid`, [
      authUserId,
    ]);

    expect((await signInRaw(email, WRONG, ip)).status).toBe(401);
    expect((await lockoutRow(authUserId))?.failed_count).toBe(1);

    const res = await signInRaw(email, PASSWORD, ip);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { twoFactorRedirect?: boolean };
    expect(body.twoFactorRedirect).toBe(true);

    expect(await countEvents(email, 'MFA_CHALLENGE')).toBe(1);
    expect(await countEvents(email, 'LOGIN_SUCCESS')).toBe(0);
    expect(await countEvents(email, 'LOGIN_FAILURE')).toBe(1);
    // A successful password presentation clears the failure counter even
    // when a second factor is still owed.
    expect(await lockoutRow(authUserId)).toBeNull();
  });
});

describe.runIf(HAS_DB)('F-11-05: the library reset request is refused', () => {
  it('requestPasswordReset is refused with FORBIDDEN at the choke point', async () => {
    const { email } = await inviteAndAccept('resetrefused');
    let caught: unknown = null;
    try {
      await auth.api.requestPasswordReset({ body: { email } });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect((caught as { status?: string }).status).toBe('FORBIDDEN');
    expect((caught as { statusCode?: number }).statusCode).toBe(403);
  });
});

describe.runIf(HAS_DB)('F-11-05: sign-out is recorded', () => {
  it('records exactly one SESSION_REVOKED; a repeat sign-out records nothing', async () => {
    const { email, authUserId } = await inviteAndAccept('signout');
    const res = await signInRaw(email, PASSWORD, nextIp());
    expect(res.status).toBe(200);
    const cookie = cookieHeaderFrom(res);
    expect(cookie).toContain('session_token');

    const countRevoked = async (): Promise<number> => {
      const r = await owner!.query<{ n: string }>(
        `select count(*) n from public.login_events
          where auth_user_id = $1::uuid and event_type = 'SESSION_REVOKED'`,
        [authUserId],
      );
      return Number(r.rows[0]!.n);
    };

    await auth.api.signOut({ headers: new Headers({ cookie }) });
    expect(await countRevoked()).toBe(1);
    const row = (
      await owner!.query<{ email: string | null; org_id: string | null }>(
        `select email::text, org_id::text from public.login_events
          where auth_user_id = $1::uuid and event_type = 'SESSION_REVOKED'`,
        [authUserId],
      )
    ).rows[0]!;
    expect(row.email).toBe(email);
    expect(row.org_id).toBe(orgId);

    // The session is gone; signing out again has nothing to revoke.
    await auth.api.signOut({ headers: new Headers({ cookie }) });
    expect(await countRevoked()).toBe(1);
  });
});
