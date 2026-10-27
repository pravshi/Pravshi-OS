import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { createHash, randomBytes } from 'node:crypto';
import { auth } from '@/lib/auth/server';
import { acceptInvitation } from '@/lib/auth/invitations';
import { POST as mediatedLoginPOST } from '@/app/api/auth/login/route';

/**
 * LOCK-1 — one login is one identity whatever the case of the address typed.
 *
 * The sign-in lockout (0027) looks a login up by lower(email) inside SECURITY DEFINER functions
 * whose search_path is empty, where citext's case-insensitive "=" is not visible and the
 * comparison is plain, case-sensitive text. Logins created by invitation acceptance (0019/0031)
 * and bootstrap (0015) kept the address as typed, so a login stored as "Asha.Rao@Example.test"
 * was never locked out: failures were not recorded against it at all. Migration 0085 stores
 * every login address lower-cased (existing rows normalised, a trigger and a CHECK for every
 * writer) and makes the pre-authentication org lookup case-insensitive.
 *
 * Against a real database, through the real paths: invitation acceptance (app), the mediated
 * login route and the library's own sign-in, the lockout, and the password-reset request.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);
const owner = HAS_DB ? new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE }) : null;
owner?.on('error', () => undefined);

const RUN = randomBytes(4).toString('hex');
const PASSWORD = 'correct horse battery staple 001';
const WRONG = 'wrong password entirely 999';
const newToken = () => randomBytes(32).toString('hex');
const digestOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

let personSeq = 0;
const personCode = () => {
  personSeq += 1;
  return `EMP-2026-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}${String(personSeq).padStart(4, '0')}`;
};

let orgId = '';
let deptId = '';
let inviterId = '';

/** Invite a mixed-case address and accept through the app's real path. */
async function inviteAndAccept(label: string) {
  const typed = `Mixed.${label}.${RUN}@Example.Test`;
  const token = newToken();
  await owner!.query(
    `insert into public.invitations
       (org_id, code, email, token_hash, invited_by, expires_at, engagement_type, department_id, start_date)
     values ($1, $2, $3::citext, $4, $5, now() + interval '7 days', 'EMPLOYEE', $6::uuid, current_date)`,
    [
      orgId,
      `INV-${RUN}-${label}`.toUpperCase().slice(0, 24),
      typed,
      digestOf(token),
      inviterId,
      deptId,
    ],
  );
  const accepted = await acceptInvitation({
    token,
    fullName: `${label} Person`,
    password: PASSWORD,
  });
  const login = (
    await owner!.query<{ id: string; email: string }>(
      `select u.id, u.email::text from public.people p join auth.auth_users u on u.id = p.auth_user_id
       where p.id = $1`,
      [accepted.personId],
    )
  ).rows[0]!;
  return { typed, authUserId: login.id, storedEmail: login.email };
}

let ipSeq = 0;
const nextIp = () => `198.51.100.${(ipSeq += 1)}`;
const login = (email: string, password: string, ip = nextIp()) =>
  mediatedLoginPOST(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
        'user-agent': 'vitest-lock1',
      },
      body: JSON.stringify({ email, password }),
    }),
  );
/** The library's own sign-in; a refusal at the lockout choke point throws rather than answering. */
const libraryLogin = async (email: string, password: string): Promise<{ ok: boolean }> => {
  try {
    return (await auth.api.signInEmail({
      body: { email, password },
      headers: new Headers({ 'x-forwarded-for': nextIp(), 'user-agent': 'vitest-lock1' }),
      asResponse: true,
    })) as Response;
  } catch {
    return { ok: false };
  }
};
const lockoutRow = async (authUserId: string) =>
  (
    await owner!.query<{ failures: number; locked: boolean }>(
      `select failed_count::int failures, coalesce(locked_until > now(), false) locked
       from auth.login_lockouts where auth_user_id = $1`,
      [authUserId],
    )
  ).rows[0] ?? { failures: 0, locked: false };

/** The same address in five spellings: every attempt must land on the same login. */
const spellings = (typed: string) => [
  typed,
  typed.toLowerCase(),
  typed.toUpperCase(),
  typed.replace(/^m/i, 'M').replace(/\.test$/i, '.TEST'),
  typed.toLowerCase().replace('@example', '@EXAMPLE'),
];

beforeAll(async () => {
  if (!HAS_DB) return;
  orgId = (
    await owner!.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1, $2) returning id`,
      [`Case Org ${RUN}`, `case-${RUN}`],
    )
  ).rows[0]!.id;
  deptId = (
    await owner!.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1, $2, $3) returning id`,
      [orgId, `CAS${RUN.slice(0, 4).toUpperCase()}`, `Case Dept ${RUN}`],
    )
  ).rows[0]!.id;
  inviterId = (
    await owner!.query<{ id: string }>(
      `insert into public.people (org_id, code, full_legal_name, person_status)
       values ($1, $2, 'Case Inviter', 'ACTIVE') returning id`,
      [orgId, personCode()],
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
}, 120_000);

afterAll(async () => {
  await owner?.end();
});

describe.skipIf(!HAS_DB)('LOCK-1: one login, one lockout, whatever the case typed', () => {
  it('an invited mixed-case address is stored lower-cased', async () => {
    const u = await inviteAndAccept('stored');
    expect(u.storedEmail).toBe(u.typed.toLowerCase());
  });

  it('five failures in five spellings lock the login; the right password is then refused', async () => {
    const u = await inviteAndAccept('lock');
    for (const email of spellings(u.typed)) {
      expect((await login(email, WRONG)).status).toBe(401);
    }
    expect(await lockoutRow(u.authUserId)).toEqual({ failures: 5, locked: true });
    // Locked: the correct password is refused on both paths, in any spelling.
    expect((await login(u.typed, PASSWORD)).status).toBe(401);
    expect((await login(u.typed.toUpperCase(), PASSWORD)).status).toBe(401);
    expect((await libraryLogin(u.typed.toLowerCase(), PASSWORD)).ok).toBe(false);
  });

  it('four failures do not lock; a success in another spelling clears the counter', async () => {
    const u = await inviteAndAccept('threshold');
    for (const email of spellings(u.typed).slice(0, 4)) {
      expect((await login(email, WRONG)).status).toBe(401);
    }
    expect(await lockoutRow(u.authUserId)).toEqual({ failures: 4, locked: false });
    const ok = await login(u.typed.toUpperCase(), PASSWORD);
    expect(ok.status).toBe(200);
    expect(await lockoutRow(u.authUserId)).toEqual({ failures: 0, locked: false });
  });

  it("one login's failures never touch another's", async () => {
    const a = await inviteAndAccept('isola');
    const b = await inviteAndAccept('isolb');
    for (const email of spellings(a.typed)) await login(email, WRONG);
    expect((await lockoutRow(a.authUserId)).locked).toBe(true);
    expect(await lockoutRow(b.authUserId)).toEqual({ failures: 0, locked: false });
    expect((await login(b.typed, PASSWORD)).status).toBe(200);
  });

  it('a password-reset request finds the login in any spelling', async () => {
    const u = await inviteAndAccept('reset');
    const reset = await owner!.query<{ id: string | null }>(
      `select authz.request_password_reset($1, $2) id`,
      [u.typed.toUpperCase(), digestOf(newToken())],
    );
    expect(reset.rows[0]!.id).not.toBeNull();
  });

  it('a login event is filed under the organization in any spelling', async () => {
    const u = await inviteAndAccept('event');
    const org = await owner!.query<{ org_id: string | null }>(
      `select public.resolve_login_org($1::citext) org_id`,
      [u.typed.toUpperCase()],
    );
    expect(org.rows[0]!.org_id).toBe(orgId);
  });
});
