import { clientIp } from '@/lib/auth/login-events';
import { checkIpRateLimit } from '@/lib/auth/rate-limit';
import { hashEndpointKey, receiveInbound, rejectionResult } from '@/lib/integrations/inbound';
import { noStoreHeaders } from '@/lib/integrations/http';

export const dynamic = 'force-dynamic';

/**
 * POST /api/integrations/inbound/[endpointKey] — pre-authentication.
 *
 * The endpoint key in the path is the credential (Phase 10 contract §4.4):
 * an unguessable 256-bit token whose SHA-256 digest is all the database
 * holds. No session exists on this path, and none is needed — the service
 * resolves the organisation from the digest alone and never trusts an org
 * id from the payload. Pre-auth allow-listed in
 * tests/guards/require-permission-first.test.ts (the one Phase 10 entry).
 *
 * Rate limited (Phase 11, F-11-08) on the authz.check_rate_limit substrate,
 * per source IP and per endpoint (keyed by the key's SHA-256 digest — the
 * raw key never lands in a bucket name). The throttle runs before the body
 * is read, so a flood costs the sender two counter increments and nothing
 * else: no parse, no resolution, no receipt. Over-limit answers are 429
 * carrying the SAME generic body as every other rejection — the status is
 * the only signal, so a throttled response cannot be used to tell a real
 * endpoint key from an invented one; the bucket that tripped is logged
 * server-side only.
 *
 * The body is read RAW: no JSON parsing happens before the size cap and
 * the payload hash inside receiveInbound. This handler only enforces the
 * contract's pre-resolution bound (256 KB, the §4.4 default — the service
 * re-checks the resolved provider's exact cap), shapes the uniform
 * responses, and keeps infrastructure failures opaque.
 *
 * No origin check: the callers are machines, not browsers, and the key —
 * not a cookie — is what authenticates, so T-17's browser concern does not
 * apply here.
 */

/** §4.4 contract default; a provider may declare less, never more, in V1. */
const MAX_BODY_BYTES = 256 * 1024;

/** F-11-08 contract values: per-endpoint and per-IP fixed-window allowances. */
const RATE_LIMIT_PER_ENDPOINT_PER_MINUTE = 60;
const RATE_LIMIT_PER_IP_PER_MINUTE = 300;
const RATE_LIMIT_WINDOW_SECONDS = 60;

const reply = (result: { httpStatus: number; body: Record<string, unknown> }) =>
  Response.json(result.body, { status: result.httpStatus, headers: noStoreHeaders });

/** Over-limit: the uniform rejection body under a 429 — nothing else differs. */
const throttledResult = (): { httpStatus: number; body: Record<string, unknown> } => ({
  httpStatus: 429,
  body: rejectionResult().body,
});

export async function POST(req: Request, { params }: { params: Promise<{ endpointKey: string }> }) {
  const { endpointKey } = await params;

  try {
    // Throttle first, before any body work (F-11-08). Per IP first: key
    // spraying is stopped there without touching the per-endpoint bucket,
    // and a refused request consumes no second bucket.
    if (
      !(await checkIpRateLimit(
        `inbound:ip:${clientIp(req) ?? 'unknown'}`,
        RATE_LIMIT_PER_IP_PER_MINUTE,
        RATE_LIMIT_WINDOW_SECONDS,
      ))
    ) {
      console.warn('[integrations/inbound] rate limited', { bucket: 'ip' });
      return reply(throttledResult());
    }
    if (
      !(await checkIpRateLimit(
        `inbound:ep:${hashEndpointKey(endpointKey)}`,
        RATE_LIMIT_PER_ENDPOINT_PER_MINUTE,
        RATE_LIMIT_WINDOW_SECONDS,
      ))
    ) {
      console.warn('[integrations/inbound] rate limited', { bucket: 'endpoint' });
      return reply(throttledResult());
    }

    // Cheap pre-read bound when the sender declares a length; the post-read
    // check below is the authoritative one (a declared length can lie).
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return reply(rejectionResult());
    }
    const raw = await req.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      return reply(rejectionResult());
    }

    return reply(await receiveInbound(endpointKey, raw, req.headers));
  } catch (error) {
    // Infrastructure failure only — every sender-shaped problem is a
    // uniform result from the service. Log the shape, never the body or
    // the key, and answer opaquely.
    console.error('[integrations/inbound] receipt failed', {
      name: error instanceof Error ? error.name : typeof error,
    });
    return reply({
      httpStatus: 500,
      body: { error: { code: 'INTERNAL', message: 'Internal error.' } },
    });
  }
}
