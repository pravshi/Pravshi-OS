import { z } from 'zod';
import { env } from '@/env';
import { requestPasswordReset, PasswordResetError } from '@/lib/auth/password-reset';
import { clientIp } from '@/lib/auth/login-events';
import { requestWorkerWake } from '@/lib/jobs/wake';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/forgot-password — pre-authentication. Issues a single-use reset
 * token and emails the link when the address holds a login.
 *
 * ALWAYS answers 200 { ok: true }: whether the email exists, whether mail is
 * configured, and whether the request was rate-limited all answer identically,
 * so the endpoint cannot be used to enumerate accounts. (Rate limiting still
 * applies server-side — a throttled attacker just can't tell.)
 *
 * Pre-auth by construction: no session exists on this path, and the token is the
 * only credential the follow-up step accepts.
 */

const MAX_BODY_CHARS = 1024;

const BodySchema = z.object({ email: z.string().max(254) });

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
  if (!originAllowed(req)) return reply(200, { ok: true });

  if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_CHARS) {
    return reply(200, { ok: true });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return reply(200, { ok: true });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply(200, { ok: true });
  }
  const parsed = BodySchema.safeParse(body);
  const email = parsed.success ? parsed.data.email : '';

  try {
    await requestPasswordReset(email, clientIp(req));
  } catch (e) {
    // A throttled request is indistinguishable by design: it answers exactly like success.
    if (!(e instanceof PasswordResetError && e.code === 'RATE_LIMITED')) {
      console.error('[auth/forgot-password] request failed', {
        name: e instanceof Error ? e.name : typeof e,
      });
    }
    // Even an internal failure answers generic success: the existence question
    // must never become answerable through this endpoint's status codes.
  }
  // The reset email is a job; wake a worker sleeping in low-cost mode (WP-W) so it goes out
  // in seconds. Sent on EVERY path through this step — known address, unknown address,
  // throttled, failed — so the wake's own latency cannot become the timing difference the
  // reset email moved onto the job plane to remove (Phase 11, F-11-06). Never throws.
  await requestWorkerWake();
  return reply(200, { ok: true });
}
