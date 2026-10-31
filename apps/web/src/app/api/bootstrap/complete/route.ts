import { z } from 'zod';
import { env } from '@/env';
import { BootstrapSetupError, completeBootstrapSetup } from '@/lib/auth/bootstrap-setup';
import { clientIp } from '@/lib/auth/login-events';
import { checkIpRateLimit, ipRateLimitKey } from '@/lib/auth/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/bootstrap/complete — the backend half of the one-time setup link.
 *
 * Body: {"token": "<43 base64url chars>", "password": "<the owner's new password>"}
 *
 * The link scripts/bootstrap/run.mjs prints is APP_URL/setup#token=… — a fragment, so the
 * token never appears in a request line, an access log or a Referer header. The /setup page
 * that reads the fragment and posts here is frontend work and does not exist yet.
 *
 * Backend infrastructure, not a page. Every decision is made by completeBootstrapSetup() and,
 * beneath it, by the database; this handler only shapes HTTP. It never logs the body, and a
 * failure is reported by SQLSTATE alone.
 *
 * Once the token is consumed — or if this database was never bootstrapped — every request is
 * answered SETUP_TOKEN_INVALID. There is nothing left behind it to reach.
 *
 * Rate limited to 5 attempts a minute per IP: this mints the owner's login, so
 * token probing is throttled hard even though the token is unguessable.
 */

/** A token and a password are a few hundred bytes at most. */
const MAX_BODY_CHARS = 4096;

const Body = z.strictObject({ token: z.string(), password: z.string() });

const reply = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Threat T-17: a state-changing route handler verifies origin. A browser always sends Origin
 * on a cross-site POST, so a mismatch is refused. A request with no Origin is not a browser
 * acting on someone's behalf, and there is no ambient credential here to borrow anyway — the
 * token has to be in the body.
 */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return true;
  try {
    return new URL(origin).origin === new URL(env.APP_URL).origin;
  } catch {
    return false;
  }
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

  // One-time owner token: throttle per IP before touching it.
  if (!(await checkIpRateLimit(ipRateLimitKey('bootstrap:complete', clientIp(req)), 5, 60))) {
    return reply(429, { error: 'RATE_LIMITED' });
  }

  try {
    const result = await completeBootstrapSetup(body);
    if (result.ok) return reply(200, { status: 'COMPLETED' });

    switch (result.reason) {
      case 'PASSWORD_TOO_SHORT':
      case 'PASSWORD_TOO_LONG':
        return reply(400, {
          error: result.reason,
          minPasswordLength: result.minPasswordLength,
          maxPasswordLength: result.maxPasswordLength,
        });
      case 'SETUP_CANNOT_COMPLETE':
        return reply(409, { error: result.reason });
      default:
        return reply(400, { error: result.reason });
    }
  } catch (e) {
    const sqlstate = e instanceof BootstrapSetupError ? e.sqlstate : null;
    console.error('[bootstrap/complete] setup could not be completed', { sqlstate });
    return reply(500, { error: 'INTERNAL' });
  }
}
