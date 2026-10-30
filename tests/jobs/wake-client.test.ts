/**
 * WP-W — requestWorkerWake(): the web app's side of the wake signal. DB-free. Exercised
 * against a real local HTTP server (and a server that never answers) so the timeout,
 * failure and redirect behaviour is the runtime's, not a mock's.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/env';
import {
  markWorkerProcess,
  requestWorkerWake,
  resetWakeDebounce,
  WAKE_DEBOUNCE_MS,
  WAKE_FAILURE_BACKOFF_MS,
} from '@/lib/jobs/wake';
import { WAKE_TOKEN_HEADER } from '@/lib/jobs/wake-token';

const TOKEN = 'client-test-token-0123456789-abcdefghij';

type Seen = { method?: string; token?: string; length: number };
let server: Server | null = null;
let seen: Seen[] = [];

async function listen(handler: (res: import('node:http').ServerResponse) => void) {
  seen = [];
  server = createServer((req, res) => {
    let length = 0;
    req.on('data', (c: Buffer) => (length += c.length));
    req.on('end', () => {
      seen.push({ method: req.method, token: req.headers[WAKE_TOKEN_HEADER] as string, length });
      handler(res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/wake`;
}

const saved = { url: env.WORKER_WAKE_URL, token: env.WORKER_WAKE_TOKEN, nodeEnv: env.NODE_ENV };

beforeEach(() => {
  resetWakeDebounce();
  markWorkerProcess(false);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  env.WORKER_WAKE_URL = saved.url;
  env.WORKER_WAKE_TOKEN = saved.token;
  env.NODE_ENV = saved.nodeEnv;
  markWorkerProcess(false);
  vi.restoreAllMocks();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

describe('requestWorkerWake', () => {
  it('is disabled (sends nothing) until both URL and token are configured', async () => {
    env.WORKER_WAKE_URL = undefined;
    env.WORKER_WAKE_TOKEN = TOKEN;
    expect(await requestWorkerWake()).toBe('disabled');
    env.WORKER_WAKE_URL = 'http://127.0.0.1:9/wake';
    env.WORKER_WAKE_TOKEN = undefined;
    expect(await requestWorkerWake()).toBe('disabled');
  });

  it('POSTs the token header and no body, and reports a 202 as sent', async () => {
    env.WORKER_WAKE_URL = await listen((res) => res.writeHead(202).end());
    env.WORKER_WAKE_TOKEN = TOKEN;
    expect(await requestWorkerWake()).toBe('sent');
    expect(seen).toEqual([{ method: 'POST', token: TOKEN, length: 0 }]);
  });

  it('a wake that times out resolves "failed" within about a second and never throws', async () => {
    env.WORKER_WAKE_URL = await listen(() => {
      /* never answers */
    });
    env.WORKER_WAKE_TOKEN = TOKEN;
    const started = Date.now();
    expect(await requestWorkerWake({ timeoutMs: 300 })).toBe('failed');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('an unreachable worker resolves "failed" and never throws', async () => {
    env.WORKER_WAKE_URL = 'http://127.0.0.1:9/wake'; // discard port: connection refused
    env.WORKER_WAKE_TOKEN = TOKEN;
    await expect(requestWorkerWake({ timeoutMs: 500 })).resolves.toBe('failed');
  });

  it('a refusal (401/429/500) is "failed", then backs off; it retries after the back-off', async () => {
    let status = 429;
    env.WORKER_WAKE_URL = await listen((res) => res.writeHead(status).end());
    env.WORKER_WAKE_TOKEN = TOKEN;
    expect(await requestWorkerWake()).toBe('failed');
    status = 202;
    expect(await requestWorkerWake()).toBe('backoff'); // no request sent
    expect(seen).toHaveLength(1);
    resetWakeDebounce(); // stands in for WAKE_FAILURE_BACKOFF_MS passing
    expect(await requestWorkerWake()).toBe('sent');
    expect(seen).toHaveLength(2);
  });

  it('while the worker is down, only the first request per back-off window pays the timeout', async () => {
    env.WORKER_WAKE_URL = await listen(() => {
      /* never answers: a hung worker */
    });
    env.WORKER_WAKE_TOKEN = TOKEN;
    expect(await requestWorkerWake({ timeoutMs: 300 })).toBe('failed');
    const started = Date.now();
    for (let i = 0; i < 20; i++)
      expect(await requestWorkerWake({ timeoutMs: 300 })).toBe('backoff');
    expect(Date.now() - started).toBeLessThan(100);
    expect(WAKE_FAILURE_BACKOFF_MS).toBe(30_000);
  });

  it('duplicate wakes inside the debounce window are coalesced after a delivered one', async () => {
    env.WORKER_WAKE_URL = await listen((res) => res.writeHead(202).end());
    env.WORKER_WAKE_TOKEN = TOKEN;
    expect(await requestWorkerWake()).toBe('sent');
    expect(await requestWorkerWake()).toBe('debounced');
    expect(await requestWorkerWake()).toBe('debounced');
    expect(seen).toHaveLength(1);
    expect(WAKE_DEBOUNCE_MS).toBeLessThanOrEqual(5_000);
  });

  it('refuses to follow a redirect (the token must never reach another host)', async () => {
    let redirectedHits = 0;
    const target = createServer((_req, res) => {
      redirectedHits += 1;
      res.writeHead(202).end();
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    const address = target.address();
    const targetPort = typeof address === 'object' && address ? address.port : 0;
    env.WORKER_WAKE_URL = await listen((res) =>
      res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/wake` }).end(),
    );
    env.WORKER_WAKE_TOKEN = TOKEN;
    expect(await requestWorkerWake()).toBe('failed');
    expect(redirectedHits).toBe(0);
    target.closeAllConnections();
    await new Promise<void>((r) => target.close(() => r()));
  });

  it('inside the worker process it sends nothing', async () => {
    env.WORKER_WAKE_URL = await listen((res) => res.writeHead(202).end());
    env.WORKER_WAKE_TOKEN = TOKEN;
    markWorkerProcess();
    expect(await requestWorkerWake()).toBe('skipped');
    expect(seen).toHaveLength(0);
  });

  it('in production a plain-http URL is refused (the token would travel in clear)', async () => {
    env.WORKER_WAKE_URL = await listen((res) => res.writeHead(202).end());
    env.WORKER_WAKE_TOKEN = TOKEN;
    env.NODE_ENV = 'production';
    expect(await requestWorkerWake()).toBe('disabled');
    expect(seen).toHaveLength(0);
  });

  it('never logs the token', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      logged.push(JSON.stringify(a));
    });
    env.WORKER_WAKE_URL = 'http://127.0.0.1:9/wake';
    env.WORKER_WAKE_TOKEN = TOKEN;
    await requestWorkerWake({ timeoutMs: 300 });
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });
});
