/**
 * The authentication plane's pool (src/lib/db/auth-pool.ts, migrations 0072/0073). LIVE DB.
 *
 *   - the configured DATABASE_URL_AUTH authenticates as app_auth, and the auth client uses it;
 *   - without DATABASE_URL_AUTH the module refuses to load — there is no fallback;
 *   - a DATABASE_URL_AUTH that authenticates as another login (the business role) is refused on
 *     first use by the pool itself, for every caller, including the Better Auth adapter's client.
 *
 * Each "other configuration" case loads a fresh copy of the module graph with a replaced
 * '@/env', so the process-wide pool used by the rest of the suite is untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import { AUTH_DB_READY } from '../auth-role';

const READY = AUTH_DB_READY && Boolean(process.env.DATABASE_URL_TEST);

describe.skipIf(!READY)('the app_auth pool (live DB)', () => {
  afterEach(() => {
    vi.doUnmock('@/env');
    vi.resetModules();
  });

  it('authenticates as app_auth, and the auth client runs on it', async () => {
    const { authSessionRole, AUTH_POOL_MAX } = await import('@/lib/db/auth-pool');
    expect(await authSessionRole()).toBe('app_auth');
    expect(AUTH_POOL_MAX).toBe(3);
    const { authDb } = await import('@/lib/db/auth-client');
    const r = await authDb.execute<{ role: string }>(sql`select session_user::text as role`);
    expect(r.rows[0]!.role).toBe('app_auth');
  });

  it('refuses to load without DATABASE_URL_AUTH — no fallback to DATABASE_URL', async () => {
    vi.resetModules();
    const actual = await vi.importActual<typeof import('@/env')>('@/env');
    vi.doMock('@/env', () => ({ ...actual, env: { ...actual.env, DATABASE_URL_AUTH: undefined } }));
    await expect(import('@/lib/db/auth-pool')).rejects.toThrow(
      /DATABASE_URL_AUTH is not configured/,
    );
  });

  it('refuses a DATABASE_URL_AUTH that authenticates as the business role, on first use', async () => {
    vi.resetModules();
    const actual = await vi.importActual<typeof import('@/env')>('@/env');
    vi.doMock('@/env', () => ({
      ...actual,
      env: { ...actual.env, DATABASE_URL_AUTH: process.env.DATABASE_URL_TEST },
    }));
    const pool = await import('@/lib/db/auth-pool');
    await expect(pool.authSessionRole()).rejects.toThrow(
      /DATABASE_URL_AUTH authenticates as 'app_user', not app_auth/,
    );
    // The same refusal reaches the Better Auth adapter's client: nothing runs on the wrong login.
    // (Drizzle wraps the pool's refusal; the reason is on its cause.)
    const { authDb } = await import('@/lib/db/auth-client');
    await expect(authDb.execute(sql`select 1`)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/not app_auth/) }),
    });
    await pool.authPool.end();
  });
});
