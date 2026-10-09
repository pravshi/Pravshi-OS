import { receiveInbound, rejectionResult } from '@/lib/integrations/inbound';
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

const reply = (result: { httpStatus: number; body: Record<string, unknown> }) =>
  Response.json(result.body, { status: result.httpStatus, headers: noStoreHeaders });

export async function POST(req: Request, { params }: { params: Promise<{ endpointKey: string }> }) {
  const { endpointKey } = await params;

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

  try {
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
