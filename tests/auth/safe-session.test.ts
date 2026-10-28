import { describe, expect, it, vi } from 'vitest';

/**
 * getSessionSafely (src/lib/auth/safe-session.ts) — the wrapper every server-side session
 * lookup goes through. From better-auth 1.7.7 on, a failed lookup throws an APIError whose
 * `cause` is the database driver's error, and drizzle embeds the query's parameters — the
 * session token — in that error's message. Whatever the library throws, what leaves the wrapper
 * must carry no token: not in its message, not in a cause chain, not in anything logged.
 * No database: the library call is replaced so each failure shape can be produced exactly.
 * The same property against a real database is tests/integration/auth-token-logging.test.ts.
 */
const SENTINEL = 'sentinel-session-token-4f1d9c2b7a6e';
const getSession = vi.fn();

vi.mock('@/lib/auth/server', () => ({ auth: { api: { getSession } } }));

const { getSessionSafely, SessionUnavailableError } = await import('@/lib/auth/safe-session');
const { APIError } = await import('better-auth/api');

/** Every own property and every cause, as text — what a logger walking the error could print. */
const everything = (e: unknown, depth = 0): string => {
  if (e === null || e === undefined || depth > 6) return '';
  if (typeof e !== 'object') return String(e);
  const parts: string[] = [];
  for (const k of Object.getOwnPropertyNames(e)) {
    const v = (e as Record<string, unknown>)[k];
    parts.push(k, typeof v === 'object' ? everything(v, depth + 1) : String(v));
  }
  return parts.join(' ');
};

const driverError = () =>
  Object.assign(new Error(`Failed query: select ... where token = $1\nparams: ${SENTINEL}`), {
    name: 'DrizzleQueryError',
    query: 'select ... where token = $1',
    params: [SENTINEL],
    cause: Object.assign(new Error(`permission denied; token ${SENTINEL}`), { code: '42501' }),
  });

/** The library's own error, built exactly as better-auth 1.7.14's getSession builds it. */
const libraryError = () =>
  (
    APIError.from as unknown as (
      status: string,
      error: { code: string; message: string },
      options: { cause: unknown },
    ) => Error
  )(
    'INTERNAL_SERVER_ERROR',
    { code: 'FAILED_TO_GET_SESSION', message: 'Failed to get session' },
    { cause: driverError() },
  );

async function capture(run: () => Promise<unknown>) {
  const logged: unknown[] = [];
  const spies = (['error', 'warn', 'log', 'info', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a) => {
      logged.push(a);
    }),
  );
  let thrown: unknown = null;
  let value: unknown;
  try {
    value = await run();
  } catch (e) {
    thrown = e;
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return { thrown, value, logged };
}

describe('getSessionSafely', () => {
  it('the fixture is the real hazard: the library error carries the token in its cause', () => {
    const e = libraryError();
    expect(e).toBeInstanceOf(APIError);
    expect(everything(e)).toContain(SENTINEL);
  });

  it('passes a session, and an absent session, through unchanged', async () => {
    const session = { user: { id: 'u' }, session: { id: 's' } };
    getSession.mockResolvedValueOnce(session);
    expect(await getSessionSafely(new Headers())).toBe(session);
    getSession.mockResolvedValueOnce(null);
    expect(await getSessionSafely(new Headers())).toBeNull();
  });

  for (const [shape, make] of [
    ['the library error with the driver error as its cause (better-auth >= 1.7.7)', libraryError],
    ['the driver error itself', driverError],
    ['a plain string carrying the token', () => `boom ${SENTINEL}`],
  ] as const) {
    it(`fails closed with no trace of the token — ${shape}`, async () => {
      getSession.mockRejectedValueOnce(make());
      const { thrown, logged } = await capture(() => getSessionSafely(new Headers()));
      expect(thrown).toBeInstanceOf(SessionUnavailableError);
      expect((thrown as Error).cause).toBeUndefined();
      expect(everything(thrown)).not.toContain(SENTINEL);
      expect(String(thrown)).not.toContain(SENTINEL);
      expect(JSON.stringify(logged)).not.toContain(SENTINEL);
      expect(logged).toEqual([]);
    });
  }

  it('asks the library exactly once, with the headers it was given', async () => {
    getSession.mockClear();
    getSession.mockResolvedValueOnce(null);
    const h = new Headers({ cookie: 'x=y' });
    await getSessionSafely(h);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith({ headers: h });
  });
});
