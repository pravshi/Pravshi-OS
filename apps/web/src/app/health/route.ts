export const dynamic = 'force-dynamic';

/**
 * Liveness only. MUST NOT touch the database.
 *
 * Neon runs with scale-to-zero. An uptime monitor polling a DB-backed health
 * check every 60s would hold compute open around the clock and nobody would
 * notice until the bill arrived. Point monitors here.
 */
export function GET() {
  return Response.json({ status: 'ok', at: new Date().toISOString() });
}
