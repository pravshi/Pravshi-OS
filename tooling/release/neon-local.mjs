// Points the Neon serverless driver at a plain Postgres, through Neon's own wsproxy.
//
// WHY THIS EXISTS. CI used to cut a Neon branch from production for every run. With many
// pull requests a day that exhausted the project's monthly storage allowance, and it put a
// copy of production data into every CI run. CI now runs Postgres as a GitHub Actions
// service container and reaches it through ghcr.io/neondatabase/wsproxy, so the code under
// test keeps using the real driver — no swapped driver, no mocks.
//
// WHY RLS STILL MEANS SOMETHING. wsproxy copies bytes between a WebSocket and a TCP socket
// and does no authentication of its own. Every connection therefore authenticates to
// Postgres as the role in its own connection string — app_user, app_owner, app_admin — with
// that role's own password. RLS applies exactly as it does on Neon.
//
// INERT UNLESS ASKED. Nothing changes unless NEON_LOCAL_WSPROXY is set, which only the CI
// workflow does. Production, previews and local development are unaffected.
//
//   NEON_LOCAL_WSPROXY    host:port of wsproxy as seen from the job, e.g. localhost:8080
//   NEON_LOCAL_PG_ADDRESS host:port of Postgres as seen from wsproxy, e.g. postgres:5432
//
// The hostname inside each connection string is never resolved: every connection is sent
// to NEON_LOCAL_PG_ADDRESS. That is what lets CI keep src/env.ts's "-pooler." host rule
// without weakening it — the URLs carry a pooled-looking name that nothing ever looks up.
import { neonConfig } from '@neondatabase/serverless';

const proxy = process.env.NEON_LOCAL_WSPROXY;

if (proxy) {
  const address = process.env.NEON_LOCAL_PG_ADDRESS ?? 'postgres:5432';
  neonConfig.wsProxy = () => `${proxy}/v1?address=${encodeURIComponent(address)}`;
  // Plain WebSocket to a proxy on the runner; Postgres itself is on the job's private network.
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  // Pipelining relies on Neon's proxy accepting a cleartext password up front; a real
  // Postgres negotiates SCRAM, so the driver must wait for the server.
  neonConfig.pipelineConnect = false;
}
