import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  APP_ROLE,
  isRetryableConnectError,
  resetAppRoleProofForTests,
  verifyAppUserLogin,
} from '@/lib/db/pool';

describe('isRetryableConnectError', () => {
  it('retries the errors a Neon cold start produces', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '08006', '08001']) {
      expect(isRetryableConnectError({ code })).toBe(true);
    }
  });

  it('does not retry a constraint violation', () => {
    expect(isRetryableConnectError({ code: '23505' })).toBe(false);
  });

  it('does not retry an unknown shape', () => {
    expect(isRetryableConnectError('boom')).toBe(false);
    expect(isRetryableConnectError(undefined)).toBe(false);
  });
});

describe('verifyAppUserLogin (the app_user pool proves its login)', () => {
  const fake = (result: { err?: Error; role?: string }) => ({
    query: (_t: string, cb: (err: Error | null, res?: { rows: { role?: string }[] }) => void) =>
      cb(result.err ?? null, result.err ? undefined : { rows: [{ role: result.role }] }),
  });
  const run = (client: ReturnType<typeof fake>) =>
    new Promise<Error | undefined>((resolve) => verifyAppUserLogin(client, resolve));

  beforeEach(() => resetAppRoleProofForTests());

  it('accepts a connection that authenticated as app_user', async () => {
    expect(await run(fake({ role: 'app_user' }))).toBeUndefined();
  });

  it('refuses any other login, naming the role and never a URL', async () => {
    for (const role of ['app_owner', 'neondb_owner', 'app_auth', '']) {
      resetAppRoleProofForTests();
      const err = await run(fake({ role }));
      expect(err?.message).toBe(
        `DATABASE_URL authenticates as '${role}', not app_user. Refusing to use it.`,
      );
      expect(err?.message).not.toMatch(/postgres(ql)?:\/\//);
    }
  });

  it('passes a failed role query through (the connection is not used)', async () => {
    const boom = new Error('connection reset');
    expect(await run(fake({ err: boom }))).toBe(boom);
  });

  it('proves the role once per process', async () => {
    let queries = 0;
    const counting = {
      query: (_t: string, cb: (err: Error | null, res?: { rows: { role?: string }[] }) => void) => {
        queries += 1;
        cb(null, { rows: [{ role: 'app_user' }] });
      },
    };
    await run(counting);
    await run(counting);
    expect(queries).toBe(1);
  });

  it('is wired into the pool', () => {
    expect(APP_ROLE).toBe('app_user');
    const source = readFileSync('src/lib/db/pool.ts', 'utf8');
    expect(source).toMatch(/verify: verifyAppUserLogin,/);
  });
});
