import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * P1c auth journeys (PR-E) — AUD-02, AUD-03, and the AUD-21 auth items,
 * exercised end to end against the real auth stack: the real route handlers,
 * the real Better Auth instance, the real lockout definers.
 *
 *   1. Invite accept with a breached password answers PASSWORD_BREACHED and
 *      the page's mapping names the breach — the invitation is NOT consumed;
 *      a compliant password then succeeds on the same token.
 *   2. Sign-out through the library endpoint (what the shell's user menu
 *      calls) records exactly one SESSION_REVOKED login event.
 *   3. requireAuthenticated sends an unauthenticated deep link to
 *      /login?next=<the path>; the mediated sign-in then succeeds.
 *   4. A backup code completes the MFA challenge once — and only once.
 *   5. A locked-out account that completes a password reset can sign in
 *      immediately: the reset clears the lockout ledger row.
 *   6. /login and /forgot-password redirect a signed-in user into the app,
 *      while /access-denied stays reachable.
 *
 * HAS_DB-gated like the other integration suites: CI provides the database.
 * The HIBP lookup is stubbed ONLY for scenario 1's breached password (a
 * range response built from that password's real SHA-1) and delegates every
 * other request to the real fetch — the same technique as
 * tests/auth/invitation-accept.test.ts.
 *
 * next/headers and next/navigation are mocked because requireAuthenticated
 * and the (auth) pages read the request through them; the mock headers are
 * swapped per scenario. Everything else — sessions, cookies, events — is
 * the production code path.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

const navMock = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: async () => navMock.headers,
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    const err = new Error(`NEXT_REDIRECT ${url}`) as Error & { digest?: string };
    err.digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw err;
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  usePathname: () => null,
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

import { auth } from '@/lib/auth/server';
import { acceptInvitation } from '@/lib/auth/invitations';
import { requestPasswordReset, resetPassword } from '@/lib/auth/password-reset';
import { generateInvitationToken } from '@/lib/invitations/tokens';
import { resolveAuthContext } from '@/lib/auth/session';
import { requireAuthenticated } from '@/lib/authz/page';
import { POST as mediatedLoginPOST } from '@/app/api/auth/login/route';
import { POST as mediatedMfaVerifyPOST } from '@/app/api/auth/mfa/verify/route';
import { POST as inviteAcceptPOST } from '@/app/api/invitations/accept/route';
import { POST as authHandlerPOST } from '@/app/api/auth/[...all]/route';
import LoginPage from '@/app/(auth)/login/page';
import ForgotPasswordPage from '@/app/(auth)/forgot-password/page';
import AccessDeniedPage from '@/app/(auth)/access-denied/page';
import { inviteAcceptErrorMessage } from '@/lib/invitations/error-messages';

const RUN = Math.random().toString(36).slice(2, 8);
const PASSWORD = `Journey!Pass-${RUN}7`;
const NEW_PASSWORD = `Reset!Pass-${RUN}8`;
const BREACHED_PASSWORD = 'password123456';
const APP_ORIGIN = 'http://localhost:3000';

let owner: Pool | null = null;
let orgId = '';
let deptId = '';
let inviterId = '';

const digestOf = (token: string) => createHash('sha256').update(token).digest('hex');
// Invitation tokens come from the product's own generator: the accept ROUTE's
// AcceptInvitationSchema enforces INVITATION_TOKEN_PATTERN (43-char base64url).
// The library-level acceptInvitation never checks the shape — it only hashes —
// so a hand-rolled hex token passes every lib-level scenario and fails only at
// the one route-level call (scenario 1), answered INVALID_REQUEST before the
// password policy is ever reached.
const newToken = () => generateInvitationToken();
// Identifier codes are NEVER hand-built: people.code is format-checked
// (people_code_format, '^[A-Z]{2,8}-[0-9]{4}-[0-9]{4,}$') and invitation codes
// are allocated by the same generator — see authz.next_identity_code usage in
// tests/auth/session.test.ts ('EMP') and tests/db/admin-services.test.ts ('INV').
// The generator needs the org, so it is queried inline at each insert site.

let ipSeq = 100;
const nextIp = () => `198.51.100.${(ipSeq += 1)}`;
const headersForIp = (ip: string) =>
  new Headers({ 'x-forwarded-for': ip, 'user-agent': 'vitest-journeys' });

const cookieHeaderFrom = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';', 1)[0]!)
    .join('; ');

const countEvents = async (email: string, eventType: string): Promise<number> => {
  const r = await owner!.query<{ n: string }>(
    `select count(*) n from public.login_events where email = $1::citext and event_type = $2`,
    [email, eventType],
  );
  return Number(r.rows[0]!.n);
};

/** Create an invitation row directly, then accept it through the real app path. */
async function inviteAndAccept(
  label: string,
): Promise<{ email: string; authUserId: string; personId: string }> {
  const email = `${label}.${RUN}@example.test`;
  const token = newToken();
  const code = (
    await owner!.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'INV','2026') c`, [
      orgId,
    ])
  ).rows[0]!.c;
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

const signInMediated = async (email: string, password: string, ip: string) =>
  mediatedLoginPOST(
    new Request(`${APP_ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
        'user-agent': 'vitest-journeys',
      },
      body: JSON.stringify({ email, password }),
    }),
  );

// ── TOTP, implemented independently (RFC 6238) — same reasoning as
// tests/auth/two-factor.test.ts: proving the stored seed is a real TOTP seed,
// not that the library agrees with itself. ────────────────────────────────────
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
const totpNow = (secret: string): string => {
  const counter = Math.floor(Date.now() / 1000 / 30);
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

describe.runIf(HAS_DB)('P1c auth journeys', () => {
  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
    orgId = (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name, slug) values ($1, $2) returning id`,
        [`Journey Org ${RUN}`, `journey-${RUN}`],
      )
    ).rows[0]!.id;
    deptId = (
      await owner.query<{ id: string }>(
        `insert into public.departments (org_id, code, name) values ($1, $2, $3) returning id`,
        [orgId, `JRN${RUN.slice(0, 4).toUpperCase()}`, `Journey Dept ${RUN}`],
      )
    ).rows[0]!.id;
    const inviterCode = (
      await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
        orgId,
      ])
    ).rows[0]!.c;
    inviterId = (
      await owner.query<{ id: string }>(
        `insert into public.people (org_id, code, full_legal_name, person_status)
         values ($1, $2, $3, 'ACTIVE') returning id`,
        [orgId, inviterCode, 'Journey Inviter'],
      )
    ).rows[0]!.id;
    const superAdmin = (
      await owner.query<{ id: string }>(
        `select id from public.roles where org_id = $1 and key = 'SUPER_ADMIN' and is_system`,
        [orgId],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into public.person_roles (person_id, role_id, org_id) values ($1, $2, $3)`,
      [inviterId, superAdmin, orgId],
    );
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
  });

  // ── 1. Invite error truthfulness (AUD-02) ──────────────────────────────────
  it('invite accept: a breached password is reported as breached, and the same token then succeeds', async () => {
    const email = `breached.${RUN}@example.test`;
    const token = newToken();
    const code = (
      await owner!.query<{ c: string }>(
        `select authz.next_identity_code($1::uuid,'INV','2026') c`,
        [orgId],
      )
    ).rows[0]!.c;
    await owner!.query(
      `insert into public.invitations
           (org_id, code, email, token_hash, invited_by, expires_at,
            engagement_type, department_id, start_date)
         values ($1, $2, $3::citext, $4, $5, now() + interval '7 days',
                 'EMPLOYEE', $6::uuid, $7::date)`,
      [orgId, code, email, digestOf(token), inviterId, deptId, '2026-09-28'],
    );

    const accept = (password: string) =>
      inviteAcceptPOST(
        new Request(`${APP_ORIGIN}/api/invitations/accept`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            host: 'localhost:3000',
            origin: APP_ORIGIN,
            'x-forwarded-for': nextIp(),
          },
          body: JSON.stringify({ token, fullName: 'Breached Person', password }),
        }),
      );

    // Stub ONLY the HIBP range endpoint, with a body built from the real
    // SHA-1 of the breached password; everything else delegates.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.startsWith('https://api.pwnedpasswords.com/range/')) {
        const sha1 = createHash('sha1').update(BREACHED_PASSWORD).digest('hex').toUpperCase();
        return new Response(`${sha1.slice(5)}:3861493\r\n${'0'.repeat(35)}:2\r\n`, {
          status: 200,
        });
      }
      return realFetch(input as never, init as never);
    }) as typeof fetch;

    try {
      const refused = await accept(BREACHED_PASSWORD);
      expect(refused.status).toBe(400);
      const body = (await refused.json()) as { error?: string };
      expect(body.error).toBe('PASSWORD_BREACHED');
      // The exact copy the invite page renders for this code names the breach.
      expect(inviteAcceptErrorMessage(body.error).toLowerCase()).toContain('breach');
    } finally {
      globalThis.fetch = realFetch;
    }

    // The refusal did not consume the invitation…
    const state = await owner!.query<{ accepted_at: string | null }>(
      `select accepted_at from public.invitations where email = $1::citext`,
      [email],
    );
    expect(state.rows[0]!.accepted_at).toBeNull();

    // …and a compliant password succeeds on the same token.
    const ok = await accept(`Compliant!Pass-${RUN}3`);
    expect(ok.status).toBe(200);
  }, 120_000);

  // ── 2. Sign-out records SESSION_REVOKED (AUD-03) ───────────────────────────
  it('sign-out through the library endpoint records exactly one SESSION_REVOKED', async () => {
    const { email, authUserId } = await inviteAndAccept('signout');
    const ip = nextIp();
    const login = await signInMediated(email, PASSWORD, ip);
    expect(login.status).toBe(200);
    const cookie = cookieHeaderFrom(login);
    expect(cookie).toContain('session_token');

    expect(await countEvents(email, 'SESSION_REVOKED')).toBe(0);

    const res = await authHandlerPOST(
      new Request(`${APP_ORIGIN}/api/auth/sign-out`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: '{}',
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(await countEvents(email, 'SESSION_REVOKED')).toBe(1);

    // The session is gone, not just recorded.
    const sessions = await owner!.query<{ n: string }>(
      `select count(*) n from auth.auth_sessions where user_id = $1::uuid`,
      [authUserId],
    );
    expect(Number(sessions.rows[0]!.n)).toBe(0);
  }, 120_000);

  // ── 3. Post-login return path (AUD-21) ─────────────────────────────────────
  it('requireAuthenticated redirects a deep link to /login?next=…, and sign-in succeeds', async () => {
    navMock.headers = new Headers({ 'x-pathname': '/crm/deals', host: 'localhost:3000' });
    const err = await requireAuthenticated().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('NEXT_REDIRECT /login?next=%2Fcrm%2Fdeals');

    // No captured path → the bare /login (default destination unchanged).
    navMock.headers = new Headers({ host: 'localhost:3000' });
    const err2 = await requireAuthenticated().catch((e: unknown) => e);
    expect((err2 as Error).message).toBe('NEXT_REDIRECT /login');

    // The credential half of the journey: the mediated sign-in succeeds, and
    // the login form lands the user on safeNextPath(next) — validated
    // separately in tests/auth/next-path.test.ts.
    const { email } = await inviteAndAccept('returnpath');
    const login = await signInMediated(email, PASSWORD, nextIp());
    expect(login.status).toBe(200);
  }, 120_000);

  // ── 4. MFA backup codes (AUD-21) ───────────────────────────────────────────
  it('a backup code completes the challenge once, mints an aal2 session, and cannot be replayed', async () => {
    const { email } = await inviteAndAccept('backupcode');
    const ip = nextIp();

    // Enrol through the library, exactly as /me/security does.
    const first = (await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      headers: headersForIp(ip),
      asResponse: true,
    })) as Response;
    expect(first.ok).toBe(true);
    const enrolCookie = cookieHeaderFrom(first);
    const enabled = await auth.api.enableTwoFactor({
      body: { password: PASSWORD },
      headers: new Headers({ cookie: enrolCookie }),
    });
    if (enabled.method !== 'totp') throw new Error('expected a TOTP enrolment');
    expect(enabled.backupCodes.length).toBeGreaterThan(0);
    const secret = new URL(enabled.totpURI).searchParams.get('secret')!;
    const verified = (await auth.api.verifyTOTP({
      body: { code: totpNow(secret) },
      headers: new Headers({ cookie: enrolCookie }),
      asResponse: true,
    })) as Response;
    expect(verified.ok).toBe(true);

    const mfaVerify = (code: string, cookie: string) =>
      mediatedMfaVerifyPOST(
        new Request(`${APP_ORIGIN}/api/auth/mfa/verify`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie,
            'x-forwarded-for': ip,
            'user-agent': 'vitest-journeys',
          },
          body: JSON.stringify({ code, email, method: 'backup-code' }),
        }),
      );

    // First use: password sign-in → challenge → backup code → aal2 session.
    const challenge1 = await signInMediated(email, PASSWORD, ip);
    expect(challenge1.status).toBe(200);
    expect(((await challenge1.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(
      true,
    );
    const spent = await mfaVerify(enabled.backupCodes[0]!, cookieHeaderFrom(challenge1));
    expect(spent.status).toBe(200);
    const ctx = await resolveAuthContext(
      new Headers({ cookie: cookieHeaderFrom(spent), host: 'localhost:3000' }),
    );
    expect(ctx?.aal).toBe('aal2');
    const viaRow = await owner!.query<{ via: string | null }>(
      `select metadata->>'via' as via from public.login_events
          where email = $1::citext and event_type = 'LOGIN_SUCCESS'
          order by occurred_at desc limit 1`,
      [email],
    );
    expect(viaRow.rows[0]!.via).toBe('backup-code');

    // Replay: a fresh challenge, the SAME code → refused, and the refusal is
    // recorded as an MFA failure.
    const failuresBefore = await countEvents(email, 'MFA_FAILURE');
    const challenge2 = await signInMediated(email, PASSWORD, ip);
    expect(challenge2.status).toBe(200);
    const replay = await mfaVerify(enabled.backupCodes[0]!, cookieHeaderFrom(challenge2));
    expect(replay.status).toBe(401);
    expect(await countEvents(email, 'MFA_FAILURE')).toBe(failuresBefore + 1);
  }, 120_000);

  // ── 5. Lockout cleared on reset (AUD-21) ───────────────────────────────────
  it('a locked-out account that completes a password reset signs in immediately', async () => {
    const { email, authUserId } = await inviteAndAccept('lockout');
    const ip = nextIp();

    for (let i = 0; i < 5; i += 1) {
      const attempt = await signInMediated(email, 'definitely the wrong password', ip);
      expect(attempt.status).toBe(401);
    }
    const locked = await owner!.query<{ locked_until: string | null }>(
      `select locked_until from auth.login_lockouts where auth_user_id = $1::uuid`,
      [authUserId],
    );
    expect(locked.rows[0]?.locked_until).not.toBeNull();

    // Even the CORRECT password is refused while locked.
    const refused = await signInMediated(email, PASSWORD, ip);
    expect(refused.status).toBe(401);

    // Complete a reset through the real reset path: request one via the lib
    // entry the forgot-password flow uses, then read the plaintext token back
    // out of the enqueued email job — the mailbox is the only place it ever
    // exists, exactly as for a real user. The live row in auth.password_resets
    // (0024) is what the job's dedup key names (the phase11-adversarial §B
    // idiom); the database itself only ever holds the token's digest.
    await requestPasswordReset(email, ip);
    const resetRow = (
      await owner!.query<{ id: string }>(
        `select id from auth.password_resets
          where auth_user_id = $1::uuid and used_at is null
          order by created_at desc limit 1`,
        [authUserId],
      )
    ).rows[0]!;
    const job = (
      await owner!.query<{ payload: { html?: string } }>(
        `select payload from public.jobs where dedup_key = $1`,
        [`pwreset:${resetRow.id}`],
      )
    ).rows[0]!;
    const token = /reset-password\?token=([0-9a-f]{64})/.exec(job.payload.html ?? '')?.[1];
    if (!token) throw new Error('reset email job did not carry a token link');
    const done = await resetPassword(token, NEW_PASSWORD, ip);
    expect(done).toEqual({ ok: true });

    // The lockout ledger row is gone — counter and locked_until together.
    const after = await owner!.query<{ n: string }>(
      `select count(*) n from auth.login_lockouts where auth_user_id = $1::uuid`,
      [authUserId],
    );
    expect(Number(after.rows[0]!.n)).toBe(0);

    // And the new password signs in immediately.
    const login = await signInMediated(email, NEW_PASSWORD, ip);
    expect(login.status).toBe(200);
  }, 120_000);

  // ── 6. Signed-in page redirects (AUD-21) ───────────────────────────────────
  it('/login and /forgot-password redirect a signed-in user; /access-denied still renders', async () => {
    const { email } = await inviteAndAccept('signedin');
    const ip = nextIp();
    const login = (await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      headers: headersForIp(ip),
      asResponse: true,
    })) as Response;
    expect(login.ok).toBe(true);
    const cookie = cookieHeaderFrom(login);

    navMock.headers = new Headers({ cookie, host: 'localhost:3000' });
    const loginErr = await LoginPage({ searchParams: Promise.resolve({}) }).catch(
      (e: unknown) => e,
    );
    expect((loginErr as Error).message).toBe('NEXT_REDIRECT /');
    const forgotErr = await ForgotPasswordPage().catch((e: unknown) => e);
    expect((forgotErr as Error).message).toBe('NEXT_REDIRECT /');

    // /access-denied lives in the same (auth) group and must NOT be caught
    // by any blanket redirect: it renders for a signed-in user.
    expect(() => AccessDeniedPage()).not.toThrow();
    expect(AccessDeniedPage()).toBeTruthy();

    // Signed out, the same pages render their forms.
    navMock.headers = new Headers({ host: 'localhost:3000' });
    await expect(LoginPage({ searchParams: Promise.resolve({}) })).resolves.toBeTruthy();
    await expect(ForgotPasswordPage()).resolves.toBeTruthy();
  }, 120_000);
});
