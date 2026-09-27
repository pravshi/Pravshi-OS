import { z } from 'zod';
import { env } from '@/env';
import { auth } from '@/lib/auth/server';
import { clientIp, recordLoginEvent, resolveLoginOrg } from '@/lib/auth/login-events';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/mfa/verify — the server-mediated second-factor check.
 *
 * The browser posts the TOTP code here (not to Better Auth directly) so MFA_FAILURE is
 * recorded like every other authentication outcome. The code check itself is delegated
 * to auth.api.verifyTOTP — this route invents no TOTP logic. On success the aal2 session
 * is created by the library (sessionAssuranceFor stamps it) and its cookies are forwarded.
 *
 * The email in the body is a logging hint, not an authentication input: the pending
 * two-factor session (carried in the forwarded cookies) identifies the user. A client
 * could claim any address here; the IP is the server-observed signal and the email is
 * corroboration. On success the verified address from the session replaces the hint.
 *
 * Pre-auth allow-listed in tests/guards/require-permission-first.test.ts: the session
 * does not exist yet — creating it is the point.
 */

const MAX_BODY_CHARS = 4096;
const Body = z.strictObject({
  code: z.string().trim().min(6).max(10),
  /** Logging hint only — see above. */
  email: z.string().trim().email().max(254).optional(),
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

  let res: Response;
  try {
    res = await auth.api.verifyTOTP({
      body: { code: body.code },
      headers: req.headers,
      asResponse: true,
    });
  } catch {
    const orgId = body.email ? await resolveLoginOrg(body.email) : null;
    await recordLoginEvent({
      orgId,
      eventType: 'MFA_FAILURE',
      email: body.email ?? null,
      authUserId: null,
      ip,
      userAgent,
    });
    return reply(401, { error: 'INVALID_CODE' });
  }

  const bodyText = await res.text();
  interface VerifyResult {
    user?: { id?: string; email?: string };
    token?: string;
  }
  let data: VerifyResult | null = null;
  try {
    data = JSON.parse(bodyText) as VerifyResult;
  } catch {
    data = null;
  }

  if (!res.ok || !data?.user?.id) {
    const orgId = body.email ? await resolveLoginOrg(body.email) : null;
    await recordLoginEvent({
      orgId,
      eventType: 'MFA_FAILURE',
      email: body.email ?? null,
      authUserId: null,
      ip,
      userAgent,
    });
    return reply(401, { error: 'INVALID_CODE' });
  }

  const verifiedEmail = data.user.email ?? body.email ?? null;
  const orgId = verifiedEmail ? await resolveLoginOrg(verifiedEmail) : null;
  await recordLoginEvent({
    orgId,
    eventType: 'LOGIN_SUCCESS',
    email: verifiedEmail,
    authUserId: data.user.id,
    ip,
    userAgent,
    metadata: { via: 'mfa' },
  });
  return forward(res, bodyText);
}
