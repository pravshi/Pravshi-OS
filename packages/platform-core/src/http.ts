import { env } from '@/env';
import { gatePlatformRequest, json, type PlatformGate, type PlatformRequest } from './guard';
import { PlatformError } from './service';

/**
 * The shape every /api/platform route shares: same-origin for anything that changes state
 * (T-17 — the platform session is a cookie, so a state change must come from this origin,
 * and here a missing Origin is refused too), the gate, a bounded JSON body, and answers by
 * code. A route handler never sees a request the gate refused, and never builds an error
 * message from a driver error.
 */
const MAX_BODY_CHARS = 8192;

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return false;
  try {
    return new URL(origin).origin === new URL(env.APP_URL).origin;
  } catch {
    return false;
  }
}

export class BadRequest extends Error {
  constructor(readonly field: string | null = null) {
    super('INVALID_INPUT');
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_CHARS) throw new BadRequest();
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) throw new BadRequest();
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new BadRequest();
}

export function platformRoute(
  gate: PlatformGate,
  handler: (req: Request, ctx: PlatformRequest) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'GET' && !sameOrigin(req)) return json(403, { error: 'FORBIDDEN_ORIGIN' });
    const gated = await gatePlatformRequest(req, gate);
    if (gated instanceof Response) return gated;
    try {
      return await handler(req, gated);
    } catch (e) {
      if (e instanceof BadRequest) {
        return json(400, { error: 'INVALID_INPUT', field: e.field });
      }
      if (e instanceof PlatformError) {
        return json(e.status, { error: e.code, message: e.userMessage });
      }
      console.error('[platform] route failed', { name: e instanceof Error ? e.name : typeof e });
      return json(500, {
        error: 'INTERNAL',
        message: 'Something went wrong. Nothing was changed.',
      });
    }
  };
}

/** The setup links the console shows once. The token is in the fragment, never the query. */
export const platformSetupLink = (token: string) => `${env.APP_URL}/platform/setup#token=${token}`;
export const orgAdminSetupLink = (token: string) =>
  `${env.APP_URL}/setup/organization#token=${token}`;

/** The organization or administrator id from a dynamic route segment. */
export function segment(req: Request, after: string): string {
  const parts = new URL(req.url).pathname.split('/');
  const i = parts.indexOf(after);
  return i >= 0 ? (parts[i + 1] ?? '') : '';
}
