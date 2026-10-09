import { z } from 'zod';
import { env } from '@/env';
import { auth } from '@/lib/auth/server';
import { mfaEnrollmentRequired } from '@/lib/auth/mfa-enforcement';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/login — the server-mediated sign-in.
 *
 * The browser never calls Better Auth's /sign-in/email directly. The route
 * validates the body, delegates the credential check to auth.api.signInEmail
 * — it invents no password logic — and forwards Better Auth's response
 * (cookies included) to the browser, adding one application behaviour of its
 * own: the post-login MFA-enrolment steer for privileged roles.
 *
 * Enforcement and recording are NOT here any more (Phase 11, F-11-04). The
 * per-account lockout and the login-event recording (LOGIN_SUCCESS,
 * MFA_CHALLENGE, LOGIN_FAILURE) live in the auth hooks in
 * src/lib/auth/server.ts — the choke point every sign-in crosses, including
 * a raw POST to the library endpoint. Because the delegated call passes
 * through those hooks, this route must record nothing itself: an outcome
 * written in both places would be two rows for one attempt. Every refusal
 * the hooks or the endpoint produce is answered here with the same generic
 * 401, so unknown email, wrong password and locked account stay
 * indistinguishable to the client.
 *
 * Pre-auth allow-listed in tests/guards/require-permission-first.test.ts: this route
 * establishes identity, so it cannot require one. Rate limiting rides along with the
 * delegated call: /sign-in/email is limited to ten attempts a minute per address.
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

  let res: Response;
  try {
    res = await auth.api.signInEmail({
      body: { email: body.email, password: body.password },
      headers: req.headers,
      asResponse: true,
    });
  } catch {
    // The library throws rather than returning a response for some failures —
    // including the choke-point lockout refusal in server.ts, which has
    // already recorded the attempt by the time it throws. Nothing is
    // recorded here; the answer is the same generic 401 as any other
    // credential failure.
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
    // answer the same. The outcome was recorded by the auth hooks.
    return reply(401, { error: 'INVALID_CREDENTIALS' });
  }

  if (data.twoFactorRedirect === true) {
    return forward(res, JSON.stringify({ twoFactorRedirect: true }));
  }

  // Privileged roles must enroll in TOTP: steer the client to /me/security when
  // the freshly authenticated person holds users.manage/roles.manage and has no
  // verified factor. The session is valid; the admin layout enforces the gate.
  const enrollmentRequired = data.user?.id != null && (await mfaEnrollmentRequired(data.user.id));
  const out = { ...data, mfaEnrollmentRequired: enrollmentRequired };
  return forward(res, JSON.stringify(out));
}
