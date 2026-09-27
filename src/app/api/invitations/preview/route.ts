import { z } from 'zod';
import { env } from '@/env';
import { previewInvitation } from '@/lib/auth/invitations';
import { INVITATION_TOKEN_PATTERN } from '@/lib/invitations/tokens';

export const dynamic = 'force-dynamic';

/**
 * POST /api/invitations/preview — pre-authentication. The accept page posts the token
 * (read from the URL fragment, so it never appears in a request line or access log)
 * and learns the invited email, the organization name, and whether the invitation is
 * still live — the minimum needed to render the page.
 *
 * Pre-auth allow-listed in tests/guards/require-permission-first.test.ts alongside
 * /api/bootstrap/complete: the token is the credential, no session exists yet.
 */

const MAX_BODY_CHARS = 4096;
const Body = z.strictObject({ token: z.string().regex(INVITATION_TOKEN_PATTERN) });

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

  let token: string;
  try {
    const parsed = Body.safeParse(JSON.parse(raw));
    if (!parsed.success) return reply(400, { error: 'INVALID_REQUEST' });
    token = parsed.data.token;
  } catch {
    return reply(400, { error: 'INVALID_REQUEST' });
  }

  try {
    const preview = await previewInvitation(token);
    if (!preview) return reply(400, { error: 'INVALID_REQUEST' });
    return reply(200, {
      email: preview.email,
      orgName: preview.orgName,
      valid: preview.valid,
    });
  } catch {
    return reply(500, { error: 'INTERNAL' });
  }
}
