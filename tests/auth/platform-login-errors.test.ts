import { describe, expect, it, vi } from 'vitest';

/**
 * Review S2-2 — the platform session check binds the session's bearer token as a query
 * parameter, and drizzle's error message embeds the parameters. When the check fails it must
 * fail closed WITHOUT that error: neither the thrown error nor anything logged may carry the
 * token. No database: the auth client is replaced by one that fails the way drizzle does.
 */
const SENTINEL = 'sentinel-session-token-value-0123456789';

vi.mock('@/lib/db/auth-client', () => ({
  authDb: {
    execute: async () => {
      const cause = Object.assign(new Error('connection terminated'), { code: '57P01' });
      throw Object.assign(
        new Error(`Failed query: select platform.end_stale_admin_session($1)\nparams: ${SENTINEL}`),
        { name: 'DrizzleQueryError', cause },
      );
    },
  },
}));

const { endStaleAdminSession, PlatformSessionCheckError } =
  await import('@/lib/auth/platform-login');

describe('the platform session check when the database fails', () => {
  it('fails closed with a fresh error, and nothing carries the token', async () => {
    const logged: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(args);
    });
    let thrown: unknown;
    try {
      await endStaleAdminSession(SENTINEL);
    } catch (e) {
      thrown = e;
    } finally {
      spy.mockRestore();
    }
    expect(thrown).toBeInstanceOf(PlatformSessionCheckError);
    expect((thrown as { sqlstate: string | null }).sqlstate).toBe('57P01');
    expect(String((thrown as Error).message)).not.toContain(SENTINEL);
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(logged)).not.toContain(SENTINEL);
    expect(logged).toHaveLength(1);
  });
});
