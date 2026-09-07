import { createHash, timingSafeEqual } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { connectWithWake } from '@/lib/db/pool';
import { env } from '@/env';

export const dynamic = 'force-dynamic';

/**
 * Database reachability. For CI and humans — NOT FOR UPTIME MONITORS.
 *
 * Every successful call wakes suspended compute, so this endpoint is gated by a
 * shared secret in the `x-pravshi-health-token` header. Without it, an anonymous
 * caller on the internet could hold Neon awake around the clock simply by curling
 * this path in a loop — defeating the locked scale-to-zero decision from outside
 * the codebase, where none of our guards would see it.
 *
 * Point uptime monitors at /health instead. It is public and touches nothing.
 */
function authorized(req: Request): boolean {
  const configured = env.HEALTH_CHECK_TOKEN;
  if (!configured) return false; // unset means nobody — fail closed
  const presented = req.headers.get('x-pravshi-health-token');
  if (!presented) return false;
  // Hash both first: timingSafeEqual requires equal lengths, and comparing
  // digests avoids leaking the token's length through an early return.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(configured).digest();
  return timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  // AUTHORISE BEFORE TOUCHING THE DATABASE. This ordering is the entire control:
  // checking afterwards would still wake the compute for every anonymous caller.
  if (!authorized(req)) {
    // 404, not 401 — consistent with the spec's rule that we do not confirm the
    // existence of things the caller is not entitled to reach.
    return new Response(null, { status: 404 });
  }

  const started = Date.now();
  try {
    const client = await connectWithWake();
    try {
      await client.query('select 1');
    } finally {
      client.release();
    }
    return Response.json({ status: 'ok', wake_ms: Date.now() - started });
  } catch (e) {
    // Detail goes to observability. The caller gets nothing: database and
    // infrastructure errors name hosts, roles, versions and topology, and a
    // health endpoint is exactly where an attacker looks for them first.
    Sentry.captureException(e, { tags: { route: 'health/db' } });
    console.error('[health/db] database check failed', e);
    return Response.json({ status: 'error' }, { status: 503 });
  }
}
