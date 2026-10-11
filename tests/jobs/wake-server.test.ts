/**
 * WP-W — the worker's wake endpoint, exercised over real HTTP on an ephemeral port. DB-free:
 * the handler never touches the database, which is part of what is being proven (the
 * database modules are mocked to throw if anything reaches them).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/pool', () => ({
  connectWithWake: () => {
    throw new Error('the wake endpoint must never touch the database');
  },
  pool: {},
}));

import { WakeLatch } from '@/lib/jobs/wake-latch';
import { startWakeServer, WAKE_TOKEN_HEADER, type WakeServer } from '@/lib/jobs/wake-server';

const TOKEN = 'a'.repeat(20) + 'wake-token-for-tests-0123456789';

let running: WakeServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
  vi.restoreAllMocks();
});

async function start(over: Partial<Parameters<typeof startWakeServer>[0]> = {}) {
  const latch = new WakeLatch();
  running = await startWakeServer({ token: TOKEN, latch, port: 0, host: '127.0.0.1', ...over });
  const base = `http://127.0.0.1:${running.port}`;
  return { latch, base };
}

const wake = (base: string, headers: Record<string, string> = { [WAKE_TOKEN_HEADER]: TOKEN }) =>
  fetch(`${base}/wake`, { method: 'POST', headers });

describe('wake endpoint', () => {
  it('a valid token answers 202 and rings the latch', async () => {
    const { latch, base } = await start();
    const res = await wake(base);
    expect(res.status).toBe(202);
    expect(latch.rings).toBe(1);
  });

  it('a wrong, missing or differently-sized token answers 401 and does not ring', async () => {
    const { latch, base } = await start();
    expect((await wake(base, { [WAKE_TOKEN_HEADER]: TOKEN + 'x' })).status).toBe(401);
    expect((await wake(base, { [WAKE_TOKEN_HEADER]: 'short' })).status).toBe(401);
    expect((await wake(base, {})).status).toBe(401);
    expect(latch.rings).toBe(0);
  });

  it('refuses rings beyond the per-minute cap with 429, without ringing', async () => {
    const { latch, base } = await start({ maxRingsPerMinute: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await wake(base)).status);
    expect(statuses).toEqual([202, 202, 202, 429, 429]);
    expect(latch.rings).toBe(3);
  });

  it('the cap resets with the next minute', async () => {
    let now = 1_000_000;
    const { latch, base } = await start({ maxRingsPerMinute: 1, now: () => now });
    expect((await wake(base)).status).toBe(202);
    expect((await wake(base)).status).toBe(429);
    now += 60_000;
    expect((await wake(base)).status).toBe(202);
    expect(latch.rings).toBe(2);
  });

  it('caps failed authentications too', async () => {
    const { base } = await start({ maxRejectsPerMinute: 2 });
    const bad = { [WAKE_TOKEN_HEADER]: 'nope' };
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await wake(base, bad)).status);
    expect(statuses).toEqual([401, 401, 429, 429]);
  });

  it('refuses a request announcing a body, and never echoes anything', async () => {
    const { latch, base } = await start();
    const res = await fetch(`${base}/wake`, {
      method: 'POST',
      headers: { [WAKE_TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(4096) }),
    });
    expect(res.status).toBe(413);
    expect(latch.rings).toBe(0);
    expect(await (await wake(base)).text()).toBe('');
  });

  it('GET /healthz answers 200 without authentication; other paths and methods are refused', async () => {
    const { latch, base } = await start();
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/wake`)).status).toBe(405);
    expect(latch.rings).toBe(0);
  });

  it('never logs the token', async () => {
    const logged: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });
    }
    const { base } = await start({ maxRingsPerMinute: 1, maxRejectsPerMinute: 1 });
    await wake(base);
    await wake(base);
    await wake(base, { [WAKE_TOKEN_HEADER]: TOKEN.slice(0, -1) + 'Z' });
    await wake(base, { [WAKE_TOKEN_HEADER]: TOKEN.slice(0, -1) + 'Y' });
    expect(logged.join('\n')).not.toContain(TOKEN.slice(0, 20));
  });

  it('refuses to start with a token shorter than 32 characters', async () => {
    await expect(
      startWakeServer({ token: 'too-short', latch: new WakeLatch(), port: 0 }),
    ).rejects.toThrow(/at least 32/);
  });
});
