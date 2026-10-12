/**
 * The worker's wake endpoint (WP-W, low-cost worker mode).
 *
 *   POST /wake     header x-pravshi-worker-token: <WORKER_WAKE_TOKEN>  → 202, rings the latch
 *   GET  /healthz  no auth, no database                               → 200 "ok"
 *   anything else                                                     → 404
 *
 * The web app calls /wake right after it commits new work (src/lib/jobs/wake.ts), so a
 * worker sleeping without polling picks the work up within seconds instead of at its next
 * scheduled wake.
 *
 * What a caller can do with it, at most: make the worker look at the queue. The request
 * carries no data and the body is never read; the handler never touches the database; the
 * response says nothing beyond its status. Stealing the token therefore buys only database
 * wake-ups (Neon compute time), which the per-minute caps below bound:
 *   - accepted rings beyond maxRingsPerMinute are refused with 429 and do not ring;
 *   - failed authentications beyond maxRejectsPerMinute are answered 429 as well.
 * The token is compared as SHA-256 digests with timingSafeEqual (no length or timing
 * signal), and neither it nor any header is ever logged.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { WakeLatch } from './wake-latch';

export const WAKE_TOKEN_HEADER = 'x-pravshi-worker-token';
export const WAKE_TOKEN_MIN_LENGTH = 32;
/** A wake carries no data; anything announcing more than this is not a wake. */
const MAX_BODY_BYTES = 1024;

export interface WakeServerOptions {
  token: string;
  latch: WakeLatch;
  port: number;
  host?: string;
  maxRingsPerMinute?: number;
  maxRejectsPerMinute?: number;
  /** Injectable clock for the rate-limit windows. */
  now?: () => number;
}

export interface WakeServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** A fixed one-minute window counter. */
function windowCounter(limit: number, now: () => number) {
  let windowStart = 0;
  let count = 0;
  return {
    /** Counts one event; false once the window's limit is exceeded. */
    take(): boolean {
      const t = now();
      if (t - windowStart >= 60_000) {
        windowStart = t;
        count = 0;
      }
      count += 1;
      return count <= limit;
    },
  };
}

export function startWakeServer(options: WakeServerOptions): Promise<WakeServer> {
  if (options.token.length < WAKE_TOKEN_MIN_LENGTH) {
    return Promise.reject(
      new Error(`WORKER_WAKE_TOKEN must be at least ${WAKE_TOKEN_MIN_LENGTH} characters`),
    );
  }
  const now = options.now ?? Date.now;
  const expected = digest(options.token);
  const rings = windowCounter(options.maxRingsPerMinute ?? 60, now);
  const rejects = windowCounter(options.maxRejectsPerMinute ?? 30, now);

  const reply = (res: ServerResponse, status: number, body = '') => {
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'close',
    });
    res.end(body);
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    // The body is never read: discard whatever arrives without buffering it.
    req.resume();
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/healthz' && req.method === 'GET') return reply(res, 200, 'ok');
    if (path !== '/wake') return reply(res, 404);
    if (req.method !== 'POST') return reply(res, 405);
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return reply(res, 413);

    const presented = req.headers[WAKE_TOKEN_HEADER];
    const valid = typeof presented === 'string' && timingSafeEqual(digest(presented), expected);
    if (!valid) {
      if (!rejects.take()) {
        console.warn('[worker] wake: rejected-request limit reached');
        return reply(res, 429);
      }
      return reply(res, 401);
    }
    if (!rings.take()) {
      console.warn('[worker] wake: ring limit reached; ignoring until the next minute');
      return reply(res, 429);
    }
    options.latch.ring();
    return reply(res, 202);
  };

  const server = createServer(handle);
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.maxHeadersCount = 50;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
