import { z } from 'zod';
import { env } from '@/env';
import { resetPassword, PasswordResetError } from '@/lib/auth/password-reset';
import { clientIp } from '@/lib/auth/login-events';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/reset-password — pre-authentication. Consumes the single-use
 * reset token and rotates the credential: new scrypt hash, every existing session
 * revoked, login event plus audit entry recorded.
 *
 * Unlike the forgot-password endpoint, this one MUST distinguish outcomes: the
 * token holder needs to know whether their link worked. The token itself is the
 * credential here — unguessable and single-use — so distinguishing INVALID_TOKEN
 * from success leaks nothing an attacker can act on.
 */

const MAX_BODY_CHARS = 4096;

const BodySchema = z.object({
  token: z.string().max(128),
  password: z.string().max(256),
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
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return reply(400, { error: 'INVALID_REQUEST' });

  try {
    await resetPassword(parsed.data.token, parsed.data.password, clientIp(req));
    return reply(200, { ok: true });
  } catch (e) {
    if (e instanceof PasswordResetError) {
      if (e.code === 'RATE_LIMITED') return reply(429, { error: 'RATE_LIMITED' });
      if (e.code === 'INVALID_TOKEN') return reply(400, { error: 'INVALID_TOKEN', message: e.message });
      if (e.code === 'WEAK_PASSWORD') {
        return reply(400, { error: 'WEAK_PASSWORD', reason: e.reason, message: e.message });
      }
    }
    console.error('[auth/reset-password] reset failed', {
      name: e instanceof Error ? e.name : typeof e,
    });
    return reply(500, { error: 'INTERNAL' });
  }
}
