import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ authRole: 'app_auth' }));

vi.mock('@/lib/db/pool', () => ({
  connectWithWake: vi.fn(async () => {
    throw new Error('the database must not be touched by an unauthorised caller');
  }),
}));

// The authentication plane's pool (0072/0073): the health check also proves its login. An
// unauthorised caller must not reach it either.
vi.mock('@/lib/db/auth-pool', () => ({
  AUTH_ROLE: 'app_auth',
  authSessionRole: vi.fn(async () => state.authRole),
}));

vi.mock('@/env', () => ({
  env: { HEALTH_CHECK_TOKEN: 'a'.repeat(32), NODE_ENV: 'test' },
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.authRole = 'app_auth';
});

async function call(headers: Record<string, string> = {}) {
  const { GET } = await import('@/app/health/db/route');
  return GET(new Request('http://localhost/health/db', { headers }));
}

describe('/health/db authorisation', () => {
  it('returns 404 with no token, and never opens a connection', async () => {
    const res = await call();
    expect(res.status).toBe(404);
    const { connectWithWake } = await import('@/lib/db/pool');
    const { authSessionRole } = await import('@/lib/db/auth-pool');
    expect(connectWithWake).not.toHaveBeenCalled();
    expect(authSessionRole).not.toHaveBeenCalled();
  });

  it('returns 404 with a wrong token, and never opens a connection', async () => {
    const res = await call({ 'x-pravshi-health-token': 'b'.repeat(32) });
    expect(res.status).toBe(404);
    const { connectWithWake } = await import('@/lib/db/pool');
    const { authSessionRole } = await import('@/lib/db/auth-pool');
    expect(connectWithWake).not.toHaveBeenCalled();
    expect(authSessionRole).not.toHaveBeenCalled();
  });

  it('returns 404 with a token of the right value but wrong length', async () => {
    const res = await call({ 'x-pravshi-health-token': 'a'.repeat(31) });
    expect(res.status).toBe(404);
  });
});

describe('/health/db checks both logins (0072/0073)', () => {
  const okClient = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };

  it('answers ok only when the business pool answers and the auth pool is app_auth', async () => {
    const { connectWithWake } = await import('@/lib/db/pool');
    vi.mocked(connectWithWake).mockResolvedValueOnce(okClient as never);
    const res = await call({ 'x-pravshi-health-token': 'a'.repeat(32) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('fails with 503 when DATABASE_URL_AUTH authenticates as another login', async () => {
    const { connectWithWake } = await import('@/lib/db/pool');
    vi.mocked(connectWithWake).mockResolvedValueOnce(okClient as never);
    state.authRole = 'app_user';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await call({ 'x-pravshi-health-token': 'a'.repeat(32) });
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error' });
  });
});
