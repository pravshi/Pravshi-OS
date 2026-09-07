import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/pool', () => ({
  connectWithWake: vi.fn(async () => {
    throw new Error('the database must not be touched by an unauthorised caller');
  }),
}));

vi.mock('@/env', () => ({
  env: { HEALTH_CHECK_TOKEN: 'a'.repeat(32), NODE_ENV: 'test' },
}));

beforeEach(() => vi.clearAllMocks());

async function call(headers: Record<string, string> = {}) {
  const { GET } = await import('@/app/health/db/route');
  return GET(new Request('http://localhost/health/db', { headers }));
}

describe('/health/db authorisation', () => {
  it('returns 404 with no token, and never opens a connection', async () => {
    const res = await call();
    expect(res.status).toBe(404);
    const { connectWithWake } = await import('@/lib/db/pool');
    expect(connectWithWake).not.toHaveBeenCalled();
  });

  it('returns 404 with a wrong token, and never opens a connection', async () => {
    const res = await call({ 'x-pravshi-health-token': 'b'.repeat(32) });
    expect(res.status).toBe(404);
    const { connectWithWake } = await import('@/lib/db/pool');
    expect(connectWithWake).not.toHaveBeenCalled();
  });

  it('returns 404 with a token of the right value but wrong length', async () => {
    const res = await call({ 'x-pravshi-health-token': 'a'.repeat(31) });
    expect(res.status).toBe(404);
  });
});
