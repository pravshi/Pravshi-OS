import { Pool } from '@neondatabase/serverless';
import { randomBytes } from 'node:crypto';

/**
 * The authentication plane's own login (role app_auth, migrations 0072/0073) for live-DB suites.
 *
 * Better Auth and the pre-login functions run on app_auth only, and app_user holds nothing in the
 * auth schema. Suites that exercise the authentication plane connect with DATABASE_URL_AUTH —
 * the real role, not a mocked context — exactly as the web app does.
 */
export const AUTH_DB_READY = Boolean(process.env.DATABASE_URL_AUTH);

export const authPool = () => new Pool({ connectionString: process.env.DATABASE_URL_AUTH });

export interface SeededSession {
  /** The bearer token, as Better Auth stores it and getSession() returns it. */
  token: string;
  sessionId: string;
  authUserId: string;
}

/**
 * Give `personId` a login (when it has none) and a session row, written by the owner — the
 * state Better Auth leaves after a sign-in, without going through one. `aal2` also enrols a
 * verified second factor, so authz.aal() answers aal2 for that session. The token is random per
 * call and never printed.
 */
export async function seedSession(
  owner: Pool,
  personId: string,
  opts: { aal2?: boolean; expired?: boolean; createdSecondsAgo?: number } = {},
): Promise<SeededSession> {
  let authUserId = (
    await owner.query<{ auth_user_id: string | null }>(
      `select auth_user_id from public.people where id = $1`,
      [personId],
    )
  ).rows[0]?.auth_user_id;
  if (!authUserId) {
    authUserId = (
      await owner.query<{ id: string }>(
        `insert into auth.auth_users (name, email) values ($1, $2) returning id`,
        ['Seeded Login', `seeded.${randomBytes(6).toString('hex')}@example.test`],
      )
    ).rows[0]!.id;
    await owner.query(`update public.people set auth_user_id = $1 where id = $2`, [
      authUserId,
      personId,
    ]);
  }
  if (opts.aal2) {
    await owner.query(`update auth.auth_users set two_factor_enabled = true where id = $1`, [
      authUserId,
    ]);
    await owner.query(
      `insert into auth.auth_two_factors (user_id, secret, backup_codes, verified)
       select $1, 'seeded-secret', 'seeded-codes', true
       where not exists (select 1 from auth.auth_two_factors where user_id = $1)`,
      [authUserId],
    );
  }
  const token = randomBytes(24).toString('hex');
  const sessionId = (
    await owner.query<{ id: string }>(
      `insert into auth.auth_sessions (user_id, token, expires_at, aal, created_at)
       values ($1, $2,
               now() + case when $3 then interval '-1 hour' else interval '1 day' end,
               $4, now() - make_interval(secs => $5::int))
       returning id`,
      [
        authUserId,
        token,
        opts.expired ?? false,
        opts.aal2 ? 'aal2' : 'aal1',
        opts.createdSecondsAgo ?? 0,
      ],
    )
  ).rows[0]!.id;
  return { token, sessionId, authUserId };
}
