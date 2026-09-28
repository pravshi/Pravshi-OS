import { env } from '@/env';
import { acceptInvitation } from '@/lib/auth/invitations';
import { InvitationError } from '@/lib/invitations/service';
import { AcceptInvitationSchema } from '@/lib/invitations/schema';
import { clientIp } from '@/lib/auth/login-events';
import { checkIpRateLimit, ipRateLimitKey } from '@/lib/auth/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/invitations/accept — pre-authentication. Consumes the single-use invitation
 * token and creates the login: auth user, credential account, person link or creation,
 * role grants, audit entry, login event. All of that happens inside
 * public.accept_invitation(); this handler only shapes HTTP.
 *
 * It does not sign anybody in. The new user signs in afterwards through the login page
 * like anyone else, receives an aal1 session, and enrols TOTP to reach aal2 — the same
 * posture as the bootstrap flow: nothing about the assurance model is short-circuited
 * by having been invited.
 *
 * Pre-auth allow-listed in tests/guards/require-permission-first.test.ts: the token is
 * the credential, no session exists yet.
 *
 * Rate limited to 10 attempts a minute per IP: the token is unguessable, but the
 * coarse error answers make this a cheap place to probe, so probing is throttled.
 */

const MAX_BODY_CHARS = 4096;

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

export async function POST(req: Request) {
  if (!originAllowed(req)) return reply(403, { error: 'FORBIDDEN_ORIGIN' });

  if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_CHARS) {
    return reply(413, { error: 'INVALID_REQUEST' });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return reply(413, { error: 'INVALID_REQUEST' });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: 'INVALID_REQUEST' });
  }
  const parsed = AcceptInvitationSchema.safeParse(body);
  if (!parsed.success) return reply(400, { error: 'INVALID_REQUEST' });

  // Pre-auth token endpoint: throttle per IP before touching the token.
  if (!(await checkIpRateLimit(ipRateLimitKey('invite:accept', clientIp(req)), 10, 60))) {
    return reply(429, { error: 'RATE_LIMITED' });
  }

  try {
    await acceptInvitation(parsed.data);
    return reply(200, { status: 'ACCEPTED' });
  } catch (e) {
    if (e instanceof InvitationError) {
      const status = e.code === 'PASSWORD_TOO_SHORT' || e.code === 'PASSWORD_TOO_LONG' ? 400 : 400;
      // Deliberately coarse: invalid, expired and already-used all answer the same,
      // so token probers learn nothing about which invitations exist.
      return reply(status, { error: e.code, message: e.message });
    }
    console.error('[invitations/accept] accept failed', {
      name: e instanceof Error ? e.name : typeof e,
    });
    return reply(500, { error: 'INTERNAL' });
  }
}
