import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins';
import { createHmac } from 'node:crypto';
import { auth, MIN_PASSWORD_LENGTH, sessionAssuranceFor } from '@/lib/auth/server';
import { resolveAuthContext, revokeSessionsFor } from '@/lib/auth/session';
import { authDb } from '@/lib/db/auth-client';
import { authDbSchema } from '@/lib/auth/schema';

/**
 * Task 1.13 — TOTP, and whether aal2 can be trusted.
 *
 * The claim under test is narrow and easy to get wrong: aal2 means a second factor was
 * verified ON THIS SESSION. Not that the person has one enrolled, not that they had one
 * earlier, and not that a device was remembered. Most of this file tries to produce an
 * aal2 that was not earned.
 *
 * Enrolment needs an account, and accounts are created by invitation — which does not exist
 * yet — so the provisioning fixture from the Task 1.12 suite reappears here for the same
 * reason. Every assertion is made against the real `auth` instance.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

const RUN = Math.random().toString(36).slice(2, 8);
const PASSWORD = 'correct horse battery staple';

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
  session: {
    modelName: 'auth_sessions',
    additionalFields: { aal: { type: 'string', defaultValue: 'aal1', input: false } },
  },
  user: { modelName: 'auth_users' },
  account: { modelName: 'auth_accounts' },
  verification: { modelName: 'auth_verifications' },
  advanced: { database: { generateId: 'uuid' } },
  plugins: [twoFactor({ schema: { twoFactor: { modelName: 'auth_two_factors' } } })],
});

let orgA = '';
let orgB = '';
let deptA = '';

type Ctx = { cookie: string };

const mkPerson = async (org: string, name: string, authUserId: string) => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people (org_id,code,full_legal_name,person_status,auth_user_id)
       values ($1,$2,$3,'ACTIVE',$4) returning id`,
      [org, code, name, authUserId],
    )
  ).rows[0]!.id;
};

const mkLogin = async (label: string) => {
  const email = `${label}.${RUN}@example.test`;
  const created = await provisioning.api.signUpEmail({
    body: { email, password: PASSWORD, name: label },
  });
  return { email, id: created.user.id };
};

const headersFor = (cookie: string) => new Headers({ cookie });

/**
 * Collect EVERY cookie the response sets, not just the first.
 *
 * A 2FA sign-in sets more than one — the challenge cookie among them — and `get('set-cookie')`
 * returns them joined, so taking the first name=value pair silently drops the one that
 * matters and every verification then fails as "no challenge".
 */
const cookieFrom = (res: Response): string => {
  const header = res.headers as Headers & { getSetCookie?: () => string[] };
  const all =
    typeof header.getSetCookie === 'function'
      ? header.getSetCookie()
      : (res.headers.get('set-cookie') ?? '').split(/,(?=[^;]+?=)/);
  return all
    .map((c) => c.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');
};

/** Sign in through the real instance. Returns the response so 2FA redirects are visible. */
const signInRaw = (email: string, password = PASSWORD) =>
  auth.api.signInEmail({ body: { email, password }, asResponse: true }) as Promise<Response>;

const signIn = async (email: string) => {
  const res = await signInRaw(email);
  if (!res.ok) throw new Error(`sign-in failed: ${res.status}`);
  return { res, cookie: cookieFrom(res) };
};

/** The TOTP seed is only ever handed out once, inside the enrolment URI. */
const secretFromUri = (uri: string) => new URL(uri).searchParams.get('secret')!;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Decode = (input: string): Buffer => {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

/**
 * RFC 6238, implemented here rather than imported from the library.
 *
 * Generating the code with Better Auth's own generator would only prove the library agrees
 * with itself. An independent implementation proves the thing that matters: what is stored
 * is a real TOTP seed that any authenticator app would accept.
 */
const totp = (secret: string, { period = 30, digits = 6, at = Date.now() } = {}): string => {
  const counter = Math.floor(at / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
};

const codeFor = (secret: string) => totp(secret);

/** Enrol and verify, leaving the login with a live aal2 session. */
const enrol = async (label: string, org = orgA) => {
  const login = await mkLogin(label);
  const person = await mkPerson(org, label, login.id);
  const first = await signIn(login.email);

  const enabled = await auth.api.enableTwoFactor({
    body: { password: PASSWORD },
    headers: headersFor(first.cookie),
  });
  if (enabled.method !== 'totp') throw new Error('expected a TOTP enrolment');
  const secret = secretFromUri(enabled.totpURI);

  // Enrolment completes only when a code proves possession of the seed.
  const verified = (await auth.api.verifyTOTP({
    body: { code: codeFor(secret) },
    headers: headersFor(first.cookie),
    asResponse: true,
  })) as Response;
  if (!verified.ok) throw new Error(`enrolment verify failed: ${verified.status}`);

  return {
    ...login,
    person,
    secret,
    backupCodes: enabled.backupCodes,
    cookie: cookieFrom(verified),
  };
};

const aalOf = async (ctx: Ctx) => (await resolveAuthContext(headersFor(ctx.cookie)))?.aal ?? null;

const twoFactorRow = async (userId: string) =>
  (
    await owner.query<{
      secret: string;
      backup_codes: string;
      verified: boolean;
      failed_verification_count: number;
      locked_until: string | null;
    }>(`select * from auth.auth_two_factors where user_id=$1`, [userId])
  ).rows[0];

beforeAll(async () => {
  const mkOrg = async (s: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name,slug) values ($1,$2) returning id`,
        [`Tf ${s}`, `tf-${RUN}-${s}`],
      )
    ).rows[0]!.id;
  [orgA, orgB] = await Promise.all([mkOrg('a'), mkOrg('b')]);
  deptA = (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id,code,name) values ($1,$2,$3) returning id`,
      [orgA, `F${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, 'Two Factor'],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
});

// ── enrolment ────────────────────────────────────────────────────────────────────

describe('enrolment', () => {
  it('requires the password, so a stolen aal1 cookie cannot add a factor', async () => {
    const login = await mkLogin('needspassword');
    await mkPerson(orgA, 'Needs Password', login.id);
    const { cookie } = await signIn(login.email);

    await expect(
      auth.api.enableTwoFactor({
        body: { password: 'wrong password entirely' },
        headers: headersFor(cookie),
      }),
    ).rejects.toThrow();
    await expect(
      auth.api.enableTwoFactor({ body: { password: '' }, headers: headersFor(cookie) }),
    ).rejects.toThrow();

    const before = await twoFactorRow(login.id);
    expect(before).toBeUndefined();
  });

  it('requires a session at all', async () => {
    await expect(
      auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers: new Headers() }),
    ).rejects.toThrow();
  });

  it('is not complete merely because a secret was generated', async () => {
    const login = await mkLogin('unverified');
    await mkPerson(orgA, 'Unverified', login.id);
    const { cookie } = await signIn(login.email);

    const enabled = await auth.api.enableTwoFactor({
      body: { password: PASSWORD },
      headers: headersFor(cookie),
    });
    expect(enabled.method).toBe('totp');
    if (enabled.method !== 'totp') throw new Error('unreachable');
    expect(enabled.totpURI).toBeTruthy();

    // A row exists but is unverified, and the login is NOT enrolled.
    const row = await twoFactorRow(login.id);
    expect(row!.verified).toBe(false);
    const user = await owner.query<{ two_factor_enabled: boolean }>(
      `select two_factor_enabled from auth.auth_users where id=$1`,
      [login.id],
    );
    expect(user.rows[0]!.two_factor_enabled).toBe(false);

    // ...and the session it was started from is still only aal1.
    expect(await aalOf({ cookie })).toBe('aal1');
  });

  it('completes on a valid code, flipping the login to enrolled', async () => {
    const user = await enrol('enrolled');
    const row = await twoFactorRow(user.id);
    expect(row!.verified).toBe(true);
    const flag = await owner.query<{ two_factor_enabled: boolean }>(
      `select two_factor_enabled from auth.auth_users where id=$1`,
      [user.id],
    );
    expect(flag.rows[0]!.two_factor_enabled).toBe(true);
  });

  it('rejects an invalid code and leaves the factor unverified', async () => {
    const login = await mkLogin('badcode');
    await mkPerson(orgA, 'Bad Code', login.id);
    const { cookie } = await signIn(login.email);
    await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers: headersFor(cookie) });

    const res = (await auth.api.verifyTOTP({
      body: { code: '000000' },
      headers: headersFor(cookie),
      asResponse: true,
    })) as Response;
    expect(res.ok).toBe(false);

    expect((await twoFactorRow(login.id))!.verified).toBe(false);
    expect(await aalOf({ cookie })).toBe('aal1');
  });
});

// ── the assurance level ──────────────────────────────────────────────────────────

describe('aal1 and aal2', () => {
  it('is aal1 for a person with no second factor', async () => {
    const login = await mkLogin('nofactor');
    await mkPerson(orgA, 'No Factor', login.id);
    const { cookie } = await signIn(login.email);
    expect(await aalOf({ cookie })).toBe('aal1');
  });

  it('is aal2 on the session minted by verifying the factor', async () => {
    const user = await enrol('aaltwo');
    expect(await aalOf({ cookie: user.cookie })).toBe('aal2');
  });

  it('is aal2 after signing in and answering the challenge', async () => {
    const user = await enrol('challenge');

    // Sign-in no longer mints a session: it returns a challenge instead.
    const res = await signInRaw(user.email);
    const body = (await res.clone().json()) as { twoFactorRedirect?: boolean };
    expect(body.twoFactorRedirect).toBe(true);

    const challengeCookie = cookieFrom(res);
    expect(await resolveAuthContext(headersFor(challengeCookie))).toBeNull();

    const verified = (await auth.api.verifyTOTP({
      body: { code: codeFor(user.secret) },
      headers: headersFor(challengeCookie),
      asResponse: true,
    })) as Response;
    expect(verified.ok).toBe(true);
    expect(await aalOf({ cookie: cookieFrom(verified) })).toBe('aal2');
  });

  it('does not upgrade a session that existed before enrolment', async () => {
    // The library rotates the session on enrolment — the pre-enrolment one is deleted, not
    // promoted. This is the case that would break "enrolled therefore aal2".
    const login = await mkLogin('preexisting');
    await mkPerson(orgA, 'Pre Existing', login.id);
    const before = await signIn(login.email);
    expect(await aalOf({ cookie: before.cookie })).toBe('aal1');

    const enabled = await auth.api.enableTwoFactor({
      body: { password: PASSWORD },
      headers: headersFor(before.cookie),
    });
    if (enabled.method !== 'totp') throw new Error('expected a TOTP enrolment');
    await auth.api.verifyTOTP({
      body: { code: codeFor(secretFromUri(enabled.totpURI)) },
      headers: headersFor(before.cookie),
      asResponse: true,
    });

    // The old cookie no longer resolves at all; it was not silently promoted.
    expect(await resolveAuthContext(headersFor(before.cookie))).toBeNull();
  });

  it('records the assurance on the session row itself, not on the person', async () => {
    const user = await enrol('onrow');
    const { rows } = await owner.query<{ aal: string }>(
      `select aal from auth.auth_sessions where user_id=$1`,
      [user.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.aal).toBe('aal2');
  });

  it('maps only the two-factor verify endpoints to aal2', () => {
    expect(sessionAssuranceFor('/two-factor/verify-totp')).toBe('aal2');
    expect(sessionAssuranceFor('/two-factor/verify-backup-code')).toBe('aal2');
    expect(sessionAssuranceFor('/sign-in/email')).toBe('aal1');
    expect(sessionAssuranceFor('/two-factor/enable')).toBe('aal1');
    expect(sessionAssuranceFor(undefined)).toBe('aal1');
  });
});

// ── replay and challenge handling ────────────────────────────────────────────────

describe('challenges are single-use', () => {
  it('refuses a replayed challenge cookie', async () => {
    const user = await enrol('replay');
    const res = await signInRaw(user.email);
    const challengeCookie = cookieFrom(res);

    const first = (await auth.api.verifyTOTP({
      body: { code: codeFor(user.secret) },
      headers: headersFor(challengeCookie),
      asResponse: true,
    })) as Response;
    expect(first.ok).toBe(true);

    // Same cookie, a fresh valid code: the challenge itself was consumed.
    const replayed = (await auth.api.verifyTOTP({
      body: { code: codeFor(user.secret) },
      headers: headersFor(challengeCookie),
      asResponse: true,
    })) as Response;
    expect(replayed.ok).toBe(false);
  });

  it('refuses a verification with no challenge and no session', async () => {
    const user = await enrol('nochallenge');
    const res = (await auth.api.verifyTOTP({
      body: { code: codeFor(user.secret) },
      headers: new Headers(),
      asResponse: true,
    })) as Response;
    expect(res.ok).toBe(false);
  });

  it('refuses a nonsense challenge cookie', async () => {
    const user = await enrol('badchallenge');
    const res = (await auth.api.verifyTOTP({
      body: { code: codeFor(user.secret) },
      headers: headersFor('better-auth.two_factor=forged'),
      asResponse: true,
    })) as Response;
    expect(res.ok).toBe(false);
  });
});

// ── recovery codes ───────────────────────────────────────────────────────────────

describe('backup codes', () => {
  it('are handed out once at enrolment, and never again', async () => {
    const user = await enrol('backupissue');
    expect(Array.isArray(user.backupCodes)).toBe(true);
    expect(user.backupCodes.length).toBeGreaterThan(0);

    // Nothing in the session, and nothing readable through getSession.
    const session = await auth.api.getSession({ headers: headersFor(user.cookie) });
    expect(JSON.stringify(session)).not.toContain(user.backupCodes[0]!);
  });

  it('establish aal2 when one is used', async () => {
    const user = await enrol('backupuse');
    const res = await signInRaw(user.email);
    const verified = (await auth.api.verifyBackupCode({
      body: { code: user.backupCodes[0]! },
      headers: headersFor(cookieFrom(res)),
      asResponse: true,
    })) as Response;
    expect(verified.ok).toBe(true);
    expect(await aalOf({ cookie: cookieFrom(verified) })).toBe('aal2');
  });

  it('are single use', async () => {
    const user = await enrol('backuponce');
    const code = user.backupCodes[0]!;

    const first = await signInRaw(user.email);
    const ok = (await auth.api.verifyBackupCode({
      body: { code },
      headers: headersFor(cookieFrom(first)),
      asResponse: true,
    })) as Response;
    expect(ok.ok).toBe(true);

    const second = await signInRaw(user.email);
    const reused = (await auth.api.verifyBackupCode({
      body: { code },
      headers: headersFor(cookieFrom(second)),
      asResponse: true,
    })) as Response;
    expect(reused.ok).toBe(false);
  });

  it('reject a code that was never issued', async () => {
    const user = await enrol('backupbad');
    const res = await signInRaw(user.email);
    const bad = (await auth.api.verifyBackupCode({
      body: { code: 'AAAAA-BBBBB' },
      headers: headersFor(cookieFrom(res)),
      asResponse: true,
    })) as Response;
    expect(bad.ok).toBe(false);
  });
});

// ── disabling ────────────────────────────────────────────────────────────────────

describe('disabling', () => {
  it('requires the password', async () => {
    const user = await enrol('disablepw');
    await expect(
      auth.api.disableTwoFactor({
        body: { password: 'not the password' },
        headers: headersFor(user.cookie),
      }),
    ).rejects.toThrow();
    expect((await twoFactorRow(user.id))!.verified).toBe(true);
  });

  it('removes the factor, wiping the seed and the recovery codes', async () => {
    const user = await enrol('disablewipe');
    await auth.api.disableTwoFactor({
      body: { password: PASSWORD },
      headers: headersFor(user.cookie),
    });
    expect(await twoFactorRow(user.id)).toBeUndefined();
    const flag = await owner.query<{ two_factor_enabled: boolean }>(
      `select two_factor_enabled from auth.auth_users where id=$1`,
      [user.id],
    );
    expect(flag.rows[0]!.two_factor_enabled).toBe(false);
  });

  it('returns the account to aal1, because authz.aal() stops honouring the claim', async () => {
    const user = await enrol('disableaal');
    expect(await aalOf({ cookie: user.cookie })).toBe('aal2');

    await auth.api.disableTwoFactor({
      body: { password: PASSWORD },
      headers: headersFor(user.cookie),
    });

    // The session row may still say aal2, but the database no longer agrees the person
    // holds a factor — so the effective level is aal1.
    const ctx = await resolveAuthContext(headersFor(user.cookie));
    const effective = ctx
      ? (
          await owner.query<{ a: string }>(
            `select authz.aal() a from (select set_config('app.person_id',$1,false),
                                                set_config('app.aal',$2,false)) _`,
            [ctx.personId, ctx.aal],
          )
        ).rows[0]!.a
      : 'aal1';
    expect(effective).toBe('aal1');
  });
});

// ── the database refuses a claim it cannot verify ────────────────────────────────

describe('authz.aal() fails closed', () => {
  const effectiveAal = async (personId: string | null, claim: string | null) => {
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.person_id',$1,true), set_config('app.aal',$2,true)`, [
        personId ?? '',
        claim ?? '',
      ]);
      const r = await c.query<{ a: string }>(`select authz.aal() a`);
      await c.query('commit');
      return r.rows[0]!.a;
    } finally {
      c.release();
    }
  };

  it('refuses a forged aal2 for somebody with no second factor', async () => {
    const login = await mkLogin('forged');
    const person = await mkPerson(orgA, 'Forged', login.id);
    expect(await effectiveAal(person, 'aal2')).toBe('aal1');
  });

  it('honours aal2 for an enrolled person', async () => {
    const user = await enrol('honoured');
    expect(await effectiveAal(user.person, 'aal2')).toBe('aal2');
  });

  it('still answers aal1 when the claim is aal1, enrolled or not', async () => {
    const user = await enrol('claimlow');
    expect(await effectiveAal(user.person, 'aal1')).toBe('aal1');
    expect(await effectiveAal(user.person, '')).toBe('aal1');
  });

  it('answers aal1 with no identity at all', async () => {
    expect(await effectiveAal(null, 'aal2')).toBe('aal1');
    expect(await effectiveAal('00000000-0000-0000-0000-000000000000', 'aal2')).toBe('aal1');
  });

  it('answers aal1 for a deleted or inactive person even when enrolled', async () => {
    const user = await enrol('deletedperson');
    expect(await effectiveAal(user.person, 'aal2')).toBe('aal2');

    await owner.query(`update public.people set person_status='INACTIVE' where id=$1`, [
      user.person,
    ]);
    // authz.person_id() refuses the identity, so the exists() cannot match.
    expect(await effectiveAal(user.person, 'aal2')).toBe('aal1');
  });

  it('refuses aal2 once the verified factor row is gone, even with the enrolment flag still set', async () => {
    // Task 1.15, migration 0016. Under the library's own flows the flag and a verified factor
    // travel together; this is the out-of-band state where they do not.
    const user = await enrol('factorgone');
    expect(await effectiveAal(user.person, 'aal2')).toBe('aal2');
    await owner.query(`delete from auth.auth_two_factors where user_id=$1`, [user.id]);
    const flag = await owner.query<{ f: boolean }>(
      `select two_factor_enabled f from auth.auth_users where id=$1`,
      [user.id],
    );
    expect(flag.rows[0]!.f).toBe(true);
    expect(await effectiveAal(user.person, 'aal2')).toBe('aal1');
  });

  it('refuses aal2 while the only factor is unverified', async () => {
    const user = await enrol('factorunverified');
    await owner.query(`update auth.auth_two_factors set verified = false where user_id=$1`, [
      user.id,
    ]);
    expect(await effectiveAal(user.person, 'aal2')).toBe('aal1');
  });

  it('never returns NULL, so a caller cannot mishandle a third state', async () => {
    for (const claim of [null, '', 'aal1', 'aal2', 'nonsense']) {
      const value = await effectiveAal(null, claim);
      expect(['aal1', 'aal2']).toContain(value);
    }
  });
});

// ── revocation still outranks assurance ──────────────────────────────────────────

describe('revocation outranks assurance', () => {
  it('kills an aal2 session when sessions_revoked_at is stamped', async () => {
    const user = await enrol('revokestamp');
    expect(await aalOf({ cookie: user.cookie })).toBe('aal2');

    await owner.query(
      `update public.people set sessions_revoked_at = now() + interval '1 minute' where id=$1`,
      [user.person],
    );
    expect(await resolveAuthContext(headersFor(user.cookie))).toBeNull();
  });

  it('kills an aal2 session when the row is deleted', async () => {
    const user = await enrol('revokedelete');
    expect(await aalOf({ cookie: user.cookie })).toBe('aal2');
    await revokeSessionsFor(user.id);
    expect(await resolveAuthContext(headersFor(user.cookie))).toBeNull();
  });

  it('gives an aal2 session nothing when the person is deactivated', async () => {
    const user = await enrol('deactivated');
    expect(await aalOf({ cookie: user.cookie })).toBe('aal2');
    await owner.query(`update public.people set deleted_at=now() where id=$1`, [user.person]);
    expect(await resolveAuthContext(headersFor(user.cookie))).toBeNull();
  });

  it('gives an enrolled login with no person nothing at all', async () => {
    const login = await mkLogin('unprovisioned2fa');
    const { cookie } = await signIn(login.email);
    const enabled = await auth.api.enableTwoFactor({
      body: { password: PASSWORD },
      headers: headersFor(cookie),
    });
    if (enabled.method !== 'totp') throw new Error('expected a TOTP enrolment');
    const verified = (await auth.api.verifyTOTP({
      body: { code: codeFor(secretFromUri(enabled.totpURI)) },
      headers: headersFor(cookie),
      asResponse: true,
    })) as Response;
    expect(verified.ok).toBe(true);
    // A perfectly good aal2 session belonging to nobody at PRAVSHI.
    expect(await resolveAuthContext(headersFor(cookieFrom(verified)))).toBeNull();
  });

  it('keeps the organization from the person row for an aal2 session', async () => {
    const user = await enrol('tenant', orgB);
    const ctx = await resolveAuthContext(headersFor(user.cookie));
    expect(ctx!.orgId).toBe(orgB);
    expect(ctx!.aal).toBe('aal2');
  });
});

// ── trusted devices are off ──────────────────────────────────────────────────────

describe('trustDevice is disabled', () => {
  it('refuses a verification that asks to be remembered', async () => {
    const user = await enrol('trustdevice');
    const res = await signInRaw(user.email);
    // The before-hook throws ahead of the endpoint, so this rejects rather than returning a
    // non-ok response. Asking for a trusted device is an error, not a silently dropped flag.
    await expect(
      auth.api.verifyTOTP({
        body: { code: codeFor(user.secret), trustDevice: true },
        headers: headersFor(cookieFrom(res)),
        asResponse: true,
      }),
    ).rejects.toThrow(/Trusted devices are disabled/i);
  });

  it('issues no trusted-device cookie on a normal verification', async () => {
    const user = await enrol('notrustcookie');
    const res = await signInRaw(user.email);
    const verified = (await auth.api.verifyTOTP({
      body: { code: codeFor(user.secret) },
      headers: headersFor(cookieFrom(res)),
      asResponse: true,
    })) as Response;
    expect(verified.headers.get('set-cookie') ?? '').not.toMatch(/trust/i);
  });
});

// ── secrets stay where they belong ───────────────────────────────────────────────

describe('secret and recovery material', () => {
  it('stores the TOTP seed encrypted, never in plaintext', async () => {
    const user = await enrol('encrypted');
    const row = await twoFactorRow(user.id);
    expect(row!.secret).toBeTruthy();
    expect(row!.secret).not.toContain(user.secret);
  });

  it('stores the recovery codes encrypted, never in plaintext', async () => {
    const user = await enrol('encryptedcodes');
    const row = await twoFactorRow(user.id);
    for (const code of user.backupCodes) {
      expect(row!.backup_codes).not.toContain(code);
    }
    // and not a readable JSON array either
    expect(() => JSON.parse(row!.backup_codes)).toThrow();
  });

  it('keeps the seed out of the AuthContext', async () => {
    const user = await enrol('notinctx');
    const ctx = await resolveAuthContext(headersFor(user.cookie));
    expect(Object.keys(ctx!).sort()).toEqual(['aal', 'orgId', 'personId']);
    expect(JSON.stringify(ctx)).not.toContain(user.secret);
  });

  it('keeps the seed and codes out of session responses', async () => {
    const user = await enrol('notinsession');
    const session = await auth.api.getSession({ headers: headersFor(user.cookie) });
    const serialised = JSON.stringify(session);
    expect(serialised).not.toContain(user.secret);
    for (const code of user.backupCodes) expect(serialised).not.toContain(code);
    expect(serialised).not.toContain('backupCodes');
  });

  it('keeps them out of audit_logs, which cannot see the auth schema', async () => {
    const user = await enrol('notinaudit');
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) n from public.audit_logs
       where before::text like '%' || $1 || '%'
          or after::text like '%' || $1 || '%'
          or metadata::text like '%' || $1 || '%'`,
      [user.secret],
    );
    expect(Number(rows[0]!.n)).toBe(0);

    // structurally, not just today: no audit trigger exists on the auth schema at all
    const triggers = await owner.query(
      `select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
       join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='auth' and not t.tgisinternal`,
    );
    expect(triggers.rows).toEqual([]);
  });

  it('gives the runtime role the minimum it needs on the factor table', async () => {
    const { rows } = await owner.query<{ grantee: string; privs: string }>(
      `select grantee, string_agg(privilege_type, ',' order by privilege_type) privs
       from information_schema.table_privileges
       where table_schema='auth' and table_name='auth_two_factors' and grantee <> 'app_owner'
       group by grantee`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.grantee).toBe('app_user');
    expect(rows[0]!.privs).toBe('DELETE,INSERT,SELECT,UPDATE');
  });
});

// ── the library's actual defaults, recorded ──────────────────────────────────────

describe('library defaults, as implemented rather than as documented', () => {
  it('issues ten recovery codes in five-five format', async () => {
    const user = await enrol('defaultcodes');
    expect(user.backupCodes.length).toBe(10);
    for (const code of user.backupCodes) expect(code).toMatch(/^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/);
  });

  it('uses six-digit, thirty-second TOTP', async () => {
    const user = await enrol('defaulttotp');
    expect(codeFor(user.secret)).toMatch(/^\d{6}$/);
    // a code generated for a different period does not validate
    const wrongPeriod = totp(user.secret, { period: 60 });
    const res = await signInRaw(user.email);
    if (wrongPeriod !== codeFor(user.secret)) {
      const bad = (await auth.api.verifyTOTP({
        body: { code: wrongPeriod },
        headers: headersFor(cookieFrom(res)),
        asResponse: true,
      })) as Response;
      expect(bad.ok).toBe(false);
    }
  });

  it('counts consecutive failures on the factor row', async () => {
    const user = await enrol('failcount');
    const res = await signInRaw(user.email);
    const cookie = cookieFrom(res);
    await auth.api
      .verifyTOTP({ body: { code: '000000' }, headers: headersFor(cookie), asResponse: true })
      .catch(() => undefined);
    const row = await twoFactorRow(user.id);
    expect(row!.failed_verification_count).toBeGreaterThan(0);
  });

  it('clears the failure count after a success', async () => {
    const user = await enrol('failreset');
    const res = await signInRaw(user.email);
    const cookie = cookieFrom(res);
    await auth.api
      .verifyTOTP({ body: { code: '000000' }, headers: headersFor(cookie), asResponse: true })
      .catch(() => undefined);
    expect((await twoFactorRow(user.id))!.failed_verification_count).toBeGreaterThan(0);

    const fresh = await signInRaw(user.email);
    const ok = (await auth.api.verifyTOTP({
      body: { code: codeFor(user.secret) },
      headers: headersFor(cookieFrom(fresh)),
      asResponse: true,
    })) as Response;
    expect(ok.ok).toBe(true);
    expect((await twoFactorRow(user.id))!.failed_verification_count).toBe(0);
  });
});

// ── nothing already approved has moved ───────────────────────────────────────────

describe('the rest of the model is untouched', () => {
  it('leaves every other authz helper exactly as it was', async () => {
    const { rows } = await owner.query<{ proname: string; src: string }>(
      `select p.proname, pg_get_functiondef(p.oid) src from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace where n.nspname='authz'`,
    );
    expect(rows.length).toBe(18);
    // Migrations 0023-0025 added narrow password-reset helpers. They are the only
    // helpers besides aal() allowed to see the auth schema, and each may touch ONLY
    // the tables listed here. The allow-list pins the exception so a future helper
    // cannot silently widen it.
    const allowedAuthTables: Record<string, string[]> = {
      request_password_reset: ['auth_users', 'password_resets'],
      consume_password_reset: ['password_resets'],
      update_credential_password: ['auth_accounts'],
      check_rate_limit: ['api_rate_limits'],
      // record_password_reset_audit reads auth.auth_users; 'password_reset' is the
      // audit action name string ('auth.password_reset'), not a table reference.
      record_password_reset_audit: ['auth_users', 'password_reset'],
    };
    for (const r of rows) {
      // aal() reads auth.auth_users from Task 1.13 onward: it has to check a claim of
      // aal2 against whether a second factor actually exists.
      if (r.proname === 'aal') continue;
      const allowed = allowedAuthTables[r.proname] ?? [];
      const touched = [...r.src.matchAll(/auth\.([a-z_]+)/g)].map((m) => m[1]!);
      for (const t of touched) {
        expect(allowed, `${r.proname} must not consult auth.${t}`).toContain(t);
      }
    }
    expect(rows.find((r) => r.proname === 'has')!.src).toContain(
      'authz.scope_for(p_permission) is not null',
    );
    expect(rows.find((r) => r.proname === 'scope_for')!.src).toContain('min(rp.scope)');
  });

  it('adds no aal2 clause to any policy yet', async () => {
    // database.md 4.2 describes it; the tables it belongs on are Phase 2.
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) n from pg_policies where schemaname='public' and qual like '%aal%'`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('leaves the public RLS guard intact and the auth schema out of public', async () => {
    const unprotected = await owner.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind in ('r','p')
         and c.relname not like '\\_%' and c.relname <> '__drizzle_migrations'
         and (not c.relrowsecurity or not c.relforcerowsecurity)`,
    );
    expect(unprotected.rows).toEqual([]);
    const inPublic = await owner.query(
      `select 1 from pg_tables where schemaname='public' and tablename like 'auth\\_%'`,
    );
    expect(inPublic.rows).toEqual([]);
  });

  it('keeps sign-up refused', async () => {
    await expect(
      auth.api.signUpEmail({
        body: { email: `still.${RUN}@example.test`, password: PASSWORD, name: 'Still' },
      }),
    ).rejects.toThrow();
  });
});
