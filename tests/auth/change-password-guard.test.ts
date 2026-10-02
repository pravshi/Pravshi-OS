import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { auth, MIN_PASSWORD_LENGTH } from '@/lib/auth/server';
import { authDb } from '@/lib/db/auth-client';
import { authDbSchema } from '@/lib/auth/schema';

/**
 * P1-2 (real-human E2E, 2026-10-03): POST /api/auth/change-password was
 * directly reachable and rotated the credential while bypassing the
 * application's controlled change-password path — its 5/minute rate limit,
 * its other-session revocation, and its audit entry.
 *
 * The endpoint is refused outright by the before-hook in lib/auth/server.ts.
 * These tests prove the refusal through the real auth instance: the request
 * is rejected, and the stored credential hash is byte-identical afterwards,
 * so the old password still signs in and the attempted new one does not.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

const RUN = Math.random().toString(36).slice(2, 8);
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a wholly different horse staple';

/** Stands in for the invitation flow: the only thing here allowed to create an account. */
const provisioning = betterAuth({
  appName: 'PRAVSHI OS test provisioning',
  baseURL: 'http://localhost:3000',
  secret: 'test-only-provisioning-secret-at-least-32-chars',
  database: drizzleAdapter(authDb, { provider: 'pg', schema: authDbSchema }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: false,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    autoSignIn: false,
  },
  session: { modelName: 'auth_sessions' },
  user: { modelName: 'auth_users' },
  account: { modelName: 'auth_accounts' },
  verification: { modelName: 'auth_verifications' },
  advanced: { database: { generateId: 'uuid' } },
});

const mkLogin = async (label: string) => {
  const email = `p12-${label}.${RUN}@example.test`;
  const created = await provisioning.api.signUpEmail({
    body: { email, password: PASSWORD, name: label },
  });
  return { email, id: created.user.id };
};

/** Sign in through the REAL auth instance and return the cookie header it sets. */
const signIn = async (email: string, password = PASSWORD) => {
  const res = (await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  })) as Response;
  const setCookie = res.headers.get('set-cookie');
  if (!res.ok || !setCookie) throw new Error(`sign-in failed: ${res.status}`);
  return { setCookie, cookie: setCookie.split(';')[0]! };
};

const headersFor = (cookie: string) => new Headers({ cookie });

const storedHash = async (authUserId: string) =>
  (
    await owner.query<{ password: string | null }>(
      `select password from auth.auth_accounts where user_id = $1`,
      [authUserId],
    )
  ).rows[0]!.password;

/**
 * The raw endpoint, exactly as the E2E report reached it: POST with a live session.
 * The before-hook refusal surfaces as a thrown APIError (statusCode 403), not a
 * Response — hook rejections bypass the asResponse conversion.
 */
const rawChangePassword = (cookie: string) =>
  auth.api.changePassword({
    body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    headers: headersFor(cookie),
  });

/** The refusal every raw attempt must hit: 403 with the disabled-endpoint message. */
const expectRefused = (p: Promise<unknown>) =>
  expect(p).rejects.toMatchObject({
    statusCode: 403,
    body: { message: expect.stringContaining('This endpoint is disabled') },
  });

afterAll(async () => {
  await owner.end().catch(() => undefined);
});

describe('raw change-password endpoint is disabled (P1-2)', () => {
  it('is refused by an explicit hook, not only by configuration', async () => {
    expect(auth.options.hooks?.before).toBeDefined();
  });

  it('rejects the raw endpoint with 403', async () => {
    const login = await mkLogin('refused');
    const { cookie } = await signIn(login.email);
    await expectRefused(rawChangePassword(cookie));
  });

  it('does not rotate the credential when refused', async () => {
    const login = await mkLogin('untouched');
    const before = await storedHash(login.id);
    expect(before).toBeTruthy();

    const { cookie } = await signIn(login.email);
    await expectRefused(rawChangePassword(cookie));

    const after = await storedHash(login.id);
    expect(after).toBe(before);
  });

  it('leaves the old password working and the attempted new one rejected', async () => {
    const login = await mkLogin('oracle');
    const { cookie } = await signIn(login.email);
    await expectRefused(rawChangePassword(cookie));

    // Old password still signs in.
    await expect(signIn(login.email, PASSWORD)).resolves.toBeTruthy();
    // The refused change did not install the new password.
    await expect(signIn(login.email, NEW_PASSWORD)).rejects.toThrow();
  });
});
