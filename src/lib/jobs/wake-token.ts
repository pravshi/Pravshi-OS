/**
 * The header that carries the shared wake token (WORKER_WAKE_TOKEN).
 *
 * Kept in its own module with no imports, like observability/process-context.ts: the web app's wake
 * client (wake.ts) sends it and the worker's wake endpoint (src/worker/wake-server.ts) reads it,
 * and the endpoint sits on the database-free liveness path whose complete import list is pinned
 * by the Neon-autosuspend guard test — so the constant may not live in a module that imports
 * @/env or anything else.
 */
export const WAKE_TOKEN_HEADER = 'x-pravshi-worker-token';
