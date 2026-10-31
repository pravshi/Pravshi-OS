import { z } from 'zod';
import { env } from '@/env';
import { auth } from '@/lib/auth/server';
import { clientIp, recordLoginEvent, resolveLoginOrg } from '@/lib/auth/login-events';
import { checkIpRateLimit, ipRateLimitKey } from '@/lib/auth/rate-limit';
import { reportAuthFailure } from '@/lib/auth/safe-log';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/mfa/verify — the server-mediated second-factor check.
 *
 * The browser posts the code here (not to Better Auth directly) so MFA_FAILURE is
 * recorded like every other authentication outcome. The check itself is delegated —
 * to auth.api.verifyTOTP for an authenticator code, or to auth.api.verifyBackupCode
 * when the body names method 'backup-code' (AUD-21) — this route invents no factor
 * logic. Backup codes are the library's: issued at enrolment, stored encrypted, and
 * single-use because the library removes the spent code from the stored set as it
 * verifies. On success the aal2 session is created by the library
 * (sessionAssuranceFor stamps it — '/two-factor/verify-' covers both endpoints)
 * and its cookies are forwarded.
 *
 * The email in the body is a logging hint, not an authentication input: the pending
 * two-factor session (carried in the forwarded cookies) identifies the user. A client
 * could claim any address here; the IP is the server-observed signal and the email is
 * corroboration. On success the verified address from the session replaces the hint.
 *
 * Pre-auth allow-listed in tests/guards/require-permission-first.test.ts: the session
 * does not exist yet — creating it is the point.
 *
 * Rate limiting (Phase 3, F-B1-7). Better Auth limits /two-factor/* in its HTTP router
 * only; auth.api.verifyTOTP() / verifyBackupCode() are direct calls that never pass
 * through it. The route therefore throttles each client address itself, before the
 * factor check. The library's own limits still apply underneath and stay the tight
 * per-account bound: five attempts per pending challenge, and a lockout after
 * consecutive failures. This limit is deliberately wider than the library's router
 * rule (3 per 10 s) so a user mistyping a code, or colleagues behind one office
 * address, are not shut out; what it adds is a ceiling on one address working through
 * many challenges or accounts. Throttled requests are not recorded as MFA_FAILURE —
 * they verify nothing, and recording each one would let a flood fill login_events —
 * but throttling raises the bounded auth alert, so it is visible when it fires.
 * When the limiter itself cannot answer, the attempt is refused with the route's
 * generic INVALID_CODE and an alert.
 */
const MFA_RATE_LIMIT = { max: 10, windowSeconds: 60 } as const;

const MAX_BODY_CHARS = 4096;
const Body = z.strictObject({
  code: z.string().trim().min(6).max(32),
  /** Which second factor the code belongs to. Absent means the authenticator code. */
  method: z.enum(['totp', 'backup-code']).optional(),
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

  let allowed: boolean;
  try {
    allowed = await checkIpRateLimit(
      ipRateLimitKey('mfa:verify', ip),
      MFA_RATE_LIMIT.max,
      MFA_RATE_LIMIT.windowSeconds,
    );
  } catch (e) {
    reportAuthFailure('auth.mfa.rate_limit_check_failed', e);
    return reply(401, { error: 'INVALID_CODE' });
  }
  if (!allowed) {
    // A bounded signal that throttling is firing (the alert limiter admits a few per
    // window, not one per request). It carries no code, email or address.
    reportAuthFailure('auth.mfa.rate_limited', new Error('mfa verify rate limited'));
    return reply(429, { error: 'RATE_LIMITED' });
  }

  const userAgent = req.headers.get('user-agent');
  const viaBackupCode = body.method === 'backup-code';

  let res: Response;
  try {
    res = viaBackupCode
      ? await auth.api.verifyBackupCode({
          body: { code: body.code },
          headers: req.headers,
          asResponse: true,
        })
      : await auth.api.verifyTOTP({
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
    metadata: { via: viaBackupCode ? 'backup-code' : 'mfa' },
  });
  return forward(res, bodyText);
}
