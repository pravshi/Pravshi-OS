import { z } from 'zod';
import { env } from '@/env';
import { auth } from '@/lib/auth/server';
import {
  clientIp,
  recordLoginEvent,
  resolveLoginOrg,
} from '@/lib/auth/login-events';

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

  const ip = clientIp(req);
  const userAgent = req.headers.get('user-agent');
  const orgId = await resolveLoginOrg(body.email);

  let res: Response;
  try {
    res = await auth.api.signInEmail({
      body: { email: body.email, password: body.password },
      headers: req.headers,
      asResponse: true,
    });
  } catch {
    // The library throws rather than returning a response for some failures.
    await recordLoginEvent({
      orgId, eventType: 'LOGIN_FAILURE', email: body.email, authUserId: null, ip, userAgent,
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
    // Deliberately generic: unknown email and wrong password answer the same.
    await recordLoginEvent({
      orgId, eventType: 'LOGIN_FAILURE', email: body.email, authUserId: null, ip, userAgent,
    });
    return reply(401, { error: 'INVALID_CREDENTIALS' });
  }

  if (data.twoFactorRedirect === true) {
    await recordLoginEvent({
      orgId, eventType: 'MFA_CHALLENGE', email: body.email,
      authUserId: data.user?.id ?? null, ip, userAgent,
      metadata: { twoFactorMethods: true },
    });
    return forward(res, JSON.stringify({ twoFactorRedirect: true }));
  }

  await recordLoginEvent({
    orgId, eventType: 'LOGIN_SUCCESS', email: body.email,
    authUserId: data.user?.id ?? null, ip, userAgent,
  });
  return forward(res, bodyText);
}
