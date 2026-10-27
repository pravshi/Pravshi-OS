import { z } from 'zod';
import { env } from '@/env';
import { BootstrapSetupError, sqlstateOf } from './bootstrap-setup';
import { clientIp } from './login-events';
import { completePlatformSetup, type PlatformSetupKind } from './platform-setup';
import { checkIpRateLimit, ipRateLimitKey } from './rate-limit';

/**
 * The HTTP half of the platform's two setup links — POST /api/platform/setup/complete and
 * POST /api/setup/organization/complete — shaped exactly as /api/bootstrap/complete:
 * same-origin only (T-17), a small body, 5 attempts a minute per IP, and answers by reason
 * code. The body is never logged; a failure is reported by SQLSTATE alone.
 */
const MAX_BODY_CHARS = 4096;
const Body = z.strictObject({ token: z.string(), password: z.string() });

const reply = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return true;
  try {
    return new URL(origin).origin === new URL(env.APP_URL).origin;
  } catch {
    return false;
  }
}

export async function handleSetupCompletion(
  req: Request,
  kind: PlatformSetupKind,
): Promise<Response> {
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

  try {
    if (!(await checkIpRateLimit(ipRateLimitKey(`setup:${kind}`, clientIp(req)), 5, 60))) {
      return reply(429, { error: 'RATE_LIMITED' });
    }
    const result = await completePlatformSetup(kind, body);
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
    const sqlstate = e instanceof BootstrapSetupError ? e.sqlstate : sqlstateOf(e);
    console.error('[setup] could not be completed', { kind, sqlstate });
    return reply(500, { error: 'INTERNAL' });
  }
}
