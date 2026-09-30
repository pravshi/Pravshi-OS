import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { createHash, randomBytes } from 'node:crypto';
import { auth } from '@/lib/auth/server';
import { acceptInvitation } from '@/lib/auth/invitations';

/**
 * BUG-001 + BUG-002 regression tests — the identity lifecycle against a real database.
 *
 * BUG-001: accept_invitation() (migration 0019) wrote the credential row with
 * account_id = the invitee's EMAIL, but Better Auth's sign-in-email resolves the
 * credential account by account.accountId === user.id. Every accepted invitation
 * produced a credential Better Auth could never find: login always failed with
 * "User not found". Fixed in migration 0031 (account_id = user_id::text + data repair).
 *
 * BUG-002: suspendUser() set person_status='INACTIVE', but nothing stopped the
 * suspended person from minting a FRESH session — the login routes delegated to
 * Better Auth, which knows nothing about people. Fixed in migration 0032 +
 * databaseHooks.session.create.before (src/lib/auth/server.ts): the single choke
 * point every session creation passes through refuses the mint, so the login
 * routes record their normal failure events and answer the generic 401.
 *
 * These tests exercise the REAL application paths: acceptInvitation() (the same
 * function the HTTP route calls, hashing via Better Auth's own scrypt) followed by
 * auth.api.signInEmail on the REAL auth instance — which runs the REAL
 * session.create.before hook.
 *
 * They run against the ephemeral Neon branch CI provisions (DATABASE_URL_TEST as
 * app_user, DATABASE_URL_MIGRATE as app_owner) and skip gracefully when no
 * database is configured, so a plain `pnpm test` without credentials stays green.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

const owner = HAS_DB ? new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE }) : null;

const RUN = randomBytes(4).toString('hex');
const PASSWORD = 'correct horse battery staple 001';

const newToken = () => randomBytes(32).toString('hex');
const digestOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

let personSeq = 0;
const personCode = () => {
  personSeq += 1;
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  return `EMP-2026-${rand}${String(personSeq).padStart(4, '0')}`;
};

let orgId = '';
let deptId = '';
let inviterId = '';

const sessionCountFor = async (authUserId: string): Promise<number> => {
  const r = await owner!.query<{ n: string }>(
    `select count(*) n from auth.auth_sessions where user_id = $1::uuid`,
    [authUserId],
  );
  return Number(r.rows[0]!.n);
};

const signIn = async (email: string, password: string = PASSWORD) =>
  (await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  })) as Response;

/**
 * Status of a sign-in attempt. The library may either return a 401 Response or
 * throw for a refused session creation (the session.create.before hook aborting
 * the mint) — both mean "no session".
 */
const signInStatus = async (email: string): Promise<{ status: number; res: Response | null }> => {
  try {
    const res = await signIn(email);
    return { status: res.status, res };
  } catch {
    return { status: 401, res: null };
  }
};

beforeAll(async () => {
  if (!HAS_DB) return;

  orgId = (
    await owner!.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1, $2) returning id`,
      [`Bugfix Org ${RUN}`, `bugfix-${RUN}`],
    )
  ).rows[0]!.id;

  deptId = (
    await owner!.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1, $2, $3) returning id`,
      [orgId, `BUG${RUN.slice(0, 4).toUpperCase()}`, `Bugfix Dept ${RUN}`],
    )
  ).rows[0]!.id;

  // Inviter with SUPER_ADMIN (roles.manage at GLOBAL): the protected-role trigger
  // judges the inviter's authority when the invitee's roles are granted on accept.
  inviterId = (
    await owner!.query<{ id: string }>(
      `insert into public.people (org_id, code, full_legal_name, person_status)
       values ($1, $2, $3, 'ACTIVE') returning id`,
      [orgId, personCode(), 'Bugfix Inviter'],
    )
  ).rows[0]!.id;
  const superAdmin = (
    await owner!.query<{ id: string }>(
      `select id from public.roles where org_id = $1 and key = 'SUPER_ADMIN' and is_system`,
      [orgId],
    )
  ).rows[0]!.id;
  await owner!.query(
    `insert into public.person_roles (person_id, role_id, org_id) values ($1, $2, $3)`,
    [inviterId, superAdmin, orgId],
  );
});

afterAll(async () => {
  await owner?.end();
});

/** Create an invitation row directly, then accept it through the real app path. */
async function inviteAndAccept(
  label: string,
): Promise<{ email: string; authUserId: string; personId: string }> {
  const email = `${label}.${RUN}@example.test`;
  const token = newToken();
  const code = `INV-${RUN}-${label}`.toUpperCase().slice(0, 24);
  await owner!.query(
    `insert into public.invitations
       (org_id, code, email, token_hash, invited_by, expires_at,
        engagement_type, department_id, start_date)
     values ($1, $2, $3::citext, $4, $5, now() + interval '7 days',
             'EMPLOYEE', $6::uuid, $7::date)`,
    [orgId, code, email, digestOf(token), inviterId, deptId, '2026-09-28'],
  );
  const accepted = await acceptInvitation({
    token,
    fullName: `${label} Person`,
    password: PASSWORD,
  });
  const row = (
    await owner!.query<{ auth_user_id: string }>(
      `select auth_user_id::text from public.people where id = $1::uuid`,
      [accepted.personId],
    )
  ).rows[0]!;
  return { email, authUserId: row.auth_user_id, personId: accepted.personId };
}

describe.runIf(HAS_DB)('BUG-001: invitation accepters can log in', () => {
  it('accept -> sign-in succeeds (credential account_id = user id)', async () => {
    const { email } = await inviteAndAccept('bug001');

    const res = await signIn(email);
    expect(res.status).toBe(200);

    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.includes('better-auth.session_token'))).toBe(true);
  });

  it('the credential row carries account_id = user_id, not the email', async () => {
    const { email, authUserId } = await inviteAndAccept('bug001row');
    const row = (
      await owner!.query<{ account_id: string; user_id: string }>(
        `select account_id, user_id::text from auth.auth_accounts
          where provider_id = 'credential' and user_id = $1::uuid`,
        [authUserId],
      )
    ).rows[0]!;
    expect(row.account_id).toBe(row.user_id);
    expect(row.account_id).not.toBe(email);
  });
});

describe.runIf(HAS_DB)('BUG-002: suspension blocks fresh logins', () => {
  it('an ACTIVE person signs in normally', async () => {
    const { email } = await inviteAndAccept('bug002active');
    const res = await signIn(email);
    expect(res.status).toBe(200);
  });

  it('suspend -> sign-in is refused with 401 and no session is minted', async () => {
    const { email, authUserId, personId } = await inviteAndAccept('bug002susp');

    // Sanity: works while ACTIVE.
    expect((await signIn(email)).status).toBe(200);
    const sessionsBefore = await sessionCountFor(authUserId);
    expect(sessionsBefore).toBeGreaterThanOrEqual(1);

    // Suspend, exactly as suspendUser() does.
    await owner!.query(
      `update public.people set person_status = 'INACTIVE', sessions_revoked_at = now(), updated_at = now()
        where id = $1::uuid`,
      [personId],
    );

    const { status, res } = await signInStatus(email);
    expect(status).toBe(401);

    // No dangling session: the refused mint must not leave a usable row behind.
    expect(await sessionCountFor(authUserId)).toBe(sessionsBefore);
    if (res) {
      expect(res.headers.getSetCookie().some((c) => c.includes('better-auth.session_token'))).toBe(
        false,
      );
    }
  });

  it('unsuspend -> sign-in works again (the gate is status-driven)', async () => {
    const { email, personId } = await inviteAndAccept('bug002re');

    await owner!.query(`update public.people set person_status = 'INACTIVE' where id = $1::uuid`, [
      personId,
    ]);
    expect((await signInStatus(email)).status).toBe(401);

    await owner!.query(`update public.people set person_status = 'ACTIVE' where id = $1::uuid`, [
      personId,
    ]);
    expect((await signInStatus(email)).status).toBe(200);
  });
});
