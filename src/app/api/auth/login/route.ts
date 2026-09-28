import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { env } from '@/env';
import { auth } from '@/lib/auth/server';
import { authDb } from '@/lib/db/auth-client';
import { mfaEnrollmentRequired } from '@/lib/auth/mfa-enforcement';
import { clientIp, recordLoginEvent, resolveLoginOrg } from '@/lib/auth/login-events';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/login — the server-mediated sign-in.
 *
 * The browser never calls Better Auth's /sign-in/email directly: every password outcome
 * is recorded as a login event (LOGIN_SUCCESS, MFA_CHALLENGE, LOGIN_FAILURE), which is
 * the reason public.login_events exists. The route delegates the actual credential
 * check to auth.api.signInEmail — it invents no password logic — inspects the outcome,
 * records it, and forwards Better Auth's response (cookies included) to the browser.
 *
 * Pre-auth allow-listed in tests/guards/require-permission-first.test.ts: this route
 * establishes identity, so it cannot require one. Rate limiting rides along with the
 * delegated call: /sign-in/email is limited to ten attempts a minute per address.
 *
 * ── LOGIN LOCKOUT ──────────────────────────────────────────────────────────────
 *
 * auth.login_lockouts (migration 0027) counts consecutive failed password attempts
 * per login: 5 failures within 15 minutes locks the account for 15 minutes. The
 * lockout check runs before the credential check; a locked account answers the
 * same generic 401 as a wrong password — the client never learns a lockout
 * exists. The HIGH audit entry (auth.login.lockout) is written inside
 * authz.record_login_failure() when the threshold is crossed. A successful login
 * clears the counter.
 */

const MAX_BODY_CHARS = 4096;
const Body = z.strictObject({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(256),
});

const reply = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** Threat T-17: state-changing route handlers verify origin. */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return true;
  try {
    return new URL(origin).origin === new URL(env.APP_URL).origin;
  } catch {
    return false;
  }
}

/** True when the account is inside a 15-minute lockout. Never throws. */
async function isLockedOut(email: string): Promise<boolean> {
  try {
    const res = await authDb.execute<{ locked: boolean }>(sql`
      select authz.check_login_lockout(${email}) as locked
    `);
    return res.rows[0]?.locked ?? false;
  } catch (e) {
    console.error('[auth/login] lockout check failed', {
      name: e instanceof Error ? e.name : typeof e,
    });
    return false;
  }
}

/**
 * Records one failed password attempt. The HIGH audit entry on lockout is written
 * inside the function. Never throws and never changes the generic client response.
 */
async function noteFailure(
  email: string,
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  try {
    await authDb.execute(sql`
      select authz.record_login_failure(${email}, ${ip}::inet, ${userAgent})
    `);
  } catch (e) {
    console.error('[auth/login] failure recording failed', {
      name: e instanceof Error ? e.name : typeof e,
    });
  }
}

/** Clears the failure counter after a successful login. Never throws. */
async function noteSuccess(email: string): Promise<void> {
  try {
    await authDb.execute(sql`
      select authz.clear_login_lockout(${email})
    `);
  } catch (e) {
    console.error('[auth/login] lockout clear failed', {
      name: e instanceof Error ? e.name : typeof e,
    });
  }
}

/** Forwards Better Auth's response — status, body and Set-Cookie headers — unmodified. */
function forward(res: Response, bodyText: string): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  const contentType = res.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  for (const cookie of res.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(bodyText, { status: res.status, headers });
}

export async function POST(req: Request) {
  if (!originAllowed(req)) return reply(403, { error: 'FORBIDDEN_ORIGIN' });

  if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_CHARS) {
    return reply(413, { error: 'INVALID_REQUEST' });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return reply(413, { error: 'INVALID_REQUEST' });

  let body: z.infer<typeof Body>;
  try {
    const parsed = Body.safeParse(JSON.parse(raw));
    if (!parsed.success) return reply(400, { error: 'INVALID_REQUEST' });
    body = parsed.data;
  } catch {
    return reply(400, { error: 'INVALID_REQUEST' });
  }

  const ip = clientIp(req);
  const userAgent = req.headers.get('user-agent');
  const orgId = await resolveLoginOrg(body.email);

  // Lockout is checked before the credential check, and answers the same generic
  // 401 as a wrong password: the client never learns a lockout exists.
  if (await isLockedOut(body.email)) {
    await recordLoginEvent({
      orgId,
      eventType: 'LOGIN_FAILURE',
      email: body.email,
      authUserId: null,
      ip,
      userAgent,
    });
    return reply(401, { error: 'INVALID_CREDENTIALS' });
  }

  let res: Response;
  try {
    res = await auth.api.signInEmail({
      body: { email: body.email, password: body.password },
      headers: req.headers,
      asResponse: true,
    });
  } catch {
    // The library throws rather than returning a response for some failures.
    await noteFailure(body.email, ip, userAgent);
    await recordLoginEvent({
      orgId,
      eventType: 'LOGIN_FAILURE',
      email: body.email,
      authUserId: null,
      ip,
      userAgent,
    });
    return reply(401, { error: 'INVALID_CREDENTIALS' });
  }

  const bodyText = await res.text();
  interface LoginResult {
    twoFactorRedirect?: boolean;
    user?: { id?: string };
    token?: string;
  }
  let data: LoginResult | null = null;
  try {
    data = JSON.parse(bodyText) as LoginResult;
  } catch {
    data = null;
  }

  if (!res.ok || !data) {
    // Deliberately generic: unknown email, wrong password and locked account
    // answer the same.
    await noteFailure(body.email, ip, userAgent);
    await recordLoginEvent({
      orgId,
      eventType: 'LOGIN_FAILURE',
      email: body.email,
      authUserId: null,
      ip,
      userAgent,
    });
    return reply(401, { error: 'INVALID_CREDENTIALS' });
  }

  if (data.twoFactorRedirect === true) {
    await noteSuccess(body.email);
    await recordLoginEvent({
      orgId,
      eventType: 'MFA_CHALLENGE',
      email: body.email,
      authUserId: data.user?.id ?? null,
      ip,
      userAgent,
      metadata: { twoFactorMethods: true },
    });
    return forward(res, JSON.stringify({ twoFactorRedirect: true }));
  }

  await noteSuccess(body.email);
  await recordLoginEvent({
    orgId,
    eventType: 'LOGIN_SUCCESS',
    email: body.email,
    authUserId: data.user?.id ?? null,
    ip,
    userAgent,
  });

  // Privileged roles must enroll in TOTP: steer the client to /me/security when
  // the freshly authenticated person holds users.manage/roles.manage and has no
  // verified factor. The session is valid; the admin layout enforces the gate.
  const enrollmentRequired = data.user?.id != null && (await mfaEnrollmentRequired(data.user.id));
  const out = { ...data, mfaEnrollmentRequired: enrollmentRequired };
  return forward(res, JSON.stringify(out));
}
