import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from '@neondatabase/serverless';
import { DB_READY } from '../workflows/helpers';

/**
 * Migration 0083 — the platform administrator plane (ADR-008 P-1, P-2), against a database of
 * its own.
 *
 * ISOLATION. The platform bootstrap is permanent by design: once it has run in a database,
 * public.bootstrap_organization() refuses there, and tests/db/bootstrap.test.ts commits an
 * organization bootstrap in the shared test database. So this suite never touches the shared
 * database: CI provisions an empty `pravshi_platform_test` on its throwaway server
 * (.github/workflows/ci.yml) and passes its owner URL as DATABASE_URL_PLATFORM_TEST; the
 * suite migrates it from zero with the real runner, refuses it unless it is empty and distinct
 * from the shared database, and reaches it as app_platform, app_auth, app_user and app_worker
 * through their usual URLs with only the database name changed.
 *
 * The operator steps (bootstrap, setup re-issue, recovery) are called as app_owner: the
 * functions admit app_admin and app_owner, and no app_admin credential exists in CI by design
 * (as for bootstrap_organization, 0015).
 */
const ISOLATED_URL = process.env.DATABASE_URL_PLATFORM_TEST;
const ENABLED =
  DB_READY &&
  !!ISOLATED_URL &&
  !!process.env.DATABASE_URL_PLATFORM &&
  !!process.env.DATABASE_URL_AUTH &&
  !!process.env.DATABASE_URL_WORKER;

describe.runIf(DB_READY && !!process.env.CI)('platform identity tests: CI provisioning', () => {
  it('provides the isolated platform database and the app_platform login', () => {
    expect(ISOLATED_URL, 'DATABASE_URL_PLATFORM_TEST').toBeTruthy();
    expect(process.env.DATABASE_URL_PLATFORM, 'DATABASE_URL_PLATFORM').toBeTruthy();
  });
});

/** The same login, pointed at another database. */
const onDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const newToken = () => randomBytes(32).toString('base64url');
/** The Better Auth scrypt shape the functions accept: salt:key, 16 and 64 bytes in hex. */
const fakePasswordHash = () =>
  `${randomBytes(16).toString('hex')}:${randomBytes(64).toString('hex')}`;

async function stateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'NO ERROR';
  } catch (error) {
    for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
    return String(error);
  }
}

describe.skipIf(!ENABLED)('platform identity (0083, isolated live database)', () => {
  const dbName = ISOLATED_URL ? new URL(ISOLATED_URL).pathname.slice(1) : '';
  const shared = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE, max: 1 });
  const owner = new Pool({ connectionString: ISOLATED_URL, max: 2 });
  const platform = new Pool({
    connectionString: onDb(process.env.DATABASE_URL_PLATFORM ?? '', dbName),
    max: 2,
  });
  const auth = new Pool({
    connectionString: onDb(process.env.DATABASE_URL_AUTH ?? '', dbName),
    max: 2,
  });
  const user = new Pool({
    connectionString: onDb(process.env.DATABASE_URL_TEST ?? '', dbName),
    max: 1,
  });
  const worker = new Pool({
    connectionString: onDb(process.env.DATABASE_URL_WORKER ?? '', dbName),
    max: 1,
  });

  const FIRST = {
    email: `first.admin.${randomUUID().slice(0, 8)}@platform.example`,
    name: 'First Admin',
  };
  let firstAdmin = '';
  let firstLogin = '';

  /**
   * A session of the administrator's own login, as Better Auth would have created it (0086 binds
   * the actor to one). `ageMinutes` backdates it; an administrator with no login gets an id that
   * names no session.
   */
  type Session = { id: string; tokenSha256: string };
  const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
  const sessionFor = async (
    adminId: string | null,
    aal: 'aal1' | 'aal2',
    age: { createdMinutesAgo?: number; idleMinutes?: number } = {},
  ): Promise<Session> => {
    const token = newToken();
    const none = { id: randomUUID(), tokenSha256: sha256Hex(token) };
    if (!adminId || !/^[0-9a-f-]{36}$/.test(adminId)) return none;
    const res = await owner.query<{ id: string }>(
      `insert into auth.auth_sessions (user_id, token, expires_at, aal, created_at, updated_at)
       select a.auth_user_id, $2, now() + interval '1 day', $3,
              now() - make_interval(mins => $4), now() - make_interval(mins => $5)
       from platform.admins a where a.id = $1 and a.auth_user_id is not null
       returning id`,
      [adminId, token, aal, age.createdMinutesAgo ?? 0, age.idleMinutes ?? 0],
    );
    return res.rows[0] ? { id: res.rows[0].id, tokenSha256: sha256Hex(token) } : none;
  };

  /**
   * Runs SQL as app_platform with the given acting administrator and assurance level, on a live
   * session of that administrator's login with the same assurance (or `session`, when given).
   */
  const asAdmin = async <T extends Record<string, unknown>>(
    adminId: string | null,
    aal: string,
    text: string,
    params: unknown[] = [],
    session?: Session,
  ) => {
    const s = session ?? (await sessionFor(adminId, aal === 'aal2' ? 'aal2' : 'aal1'));
    const c: PoolClient = await platform.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.platform_admin_id', $1, true), set_config('app.platform_aal', $2, true),
                set_config('app.platform_session_id', $3, true),
                set_config('app.platform_session_token_sha256', $4, true)`,
        [adminId ?? '', aal, s.id, s.tokenSha256],
      );
      const res = await c.query<T>(text, params);
      await c.query('commit');
      return res;
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };
  /** Runs fn in an owner transaction that is always rolled back. */
  const rehearse = async (fn: (c: PoolClient) => Promise<unknown>) => {
    const c = await owner.connect();
    try {
      await c.query('begin');
      return await fn(c);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  };
  /** What Better Auth's TOTP enrolment leaves behind: a factor row and the enabled flag. */
  const enrolFactor = async (adminId: string) => {
    await owner.query(
      `insert into auth.auth_two_factors (user_id, secret, backup_codes)
       select a.auth_user_id, 'x', 'y' from platform.admins a where a.id = $1`,
      [adminId],
    );
    await owner.query(
      `update auth.auth_users set two_factor_enabled = true
       where id = (select auth_user_id from platform.admins where id = $1)`,
      [adminId],
    );
  };
  const audit = async () =>
    (
      await owner.query<{
        action: string;
        result: string;
        actor_type: string;
        reason_code: string | null;
      }>(
        `select action, result, actor_type, reason_code from platform.audit_events order by occurred_at, id`,
      )
    ).rows;

  // A dropped idle connection must surface as a handled error: an unhandled pool 'error' event
  // makes vitest serialise the client object — connection parameters included — into its report.
  for (const pool of [shared, owner, platform, auth, user, worker]) {
    pool.on('error', () => undefined);
  }

  beforeAll(async () => {
    const sharedDb = (await shared.query<{ d: string }>('select current_database() d')).rows[0]!.d;
    const isoDb = (await owner.query<{ d: string }>('select current_database() d')).rows[0]!.d;
    expect(isoDb, 'the isolated database must not be the shared one').not.toBe(sharedDb);
    const tables = await owner.query<{ n: number }>(
      `select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'platform', 'drizzle') and c.relkind = 'r'`,
    );
    expect(tables.rows[0]!.n, 'the isolated database must be empty').toBe(0);

    const run = spawnSync(process.execPath, ['scripts/migrate-ws.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL_MIGRATE: ISOLATED_URL },
      encoding: 'utf8',
      timeout: 240_000,
    });
    expect(run.status, (run.stderr || run.stdout).replace(/postgres(ql)?:\/\/\S+/g, '[URL]')).toBe(
      0,
    );
  }, 300_000);

  afterAll(async () => {
    await Promise.all([
      shared.end(),
      owner.end(),
      platform.end(),
      auth.end(),
      user.end(),
      worker.end(),
    ]);
  });

  it('grants: app_platform reaches only its functions; no other runtime login reaches the platform', async () => {
    const fns = await owner.query<{ fn: string; role: string; ok: boolean }>(
      `select p.oid::regprocedure::text fn, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') ok
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'platform'
       cross join (values ('app_user'), ('app_worker'), ('app_auth'), ('app_admin'), ('app_platform')) r(role)
       where has_function_privilege(r.role, p.oid, 'EXECUTE')
       order by 2, 1`,
    );
    // Sorted here: the database's collation orders '_' differently from a byte sort.
    expect(fns.rows.map((r) => `${r.role} ${r.fn.replace(/\(.*$/, '')}`).sort()).toEqual([
      'app_admin platform.bootstrap_first_admin',
      'app_admin platform.recover_admin',
      'app_admin platform.reissue_setup',
      'app_auth platform.complete_org_admin_setup',
      'app_auth platform.complete_setup',
      'app_auth platform.end_stale_admin_session',
      'app_auth platform.login_may_sign_in',
      'app_auth platform.org_admin_setup_token_is_valid',
      'app_auth platform.setup_token_is_valid',
      'app_platform platform.admin_for_login',
      'app_platform platform.invite_admin',
      'app_platform platform.invite_admin_once',
      'app_platform platform.list_admins',
      'app_platform platform.list_audit_events',
      'app_platform platform.list_organization_types',
      'app_platform platform.list_organizations',
      'app_platform platform.org_admin_setup_recipient',
      'app_platform platform.provision_organization',
      'app_platform platform.record_failure',
      'app_platform platform.reissue_admin_setup',
      'app_platform platform.reissue_org_admin_setup',
      'app_platform platform.revoke_admin',
      'app_platform platform.revoke_org_admin_setup',
      'app_platform platform.set_organization_status',
      'app_platform platform.whoami',
    ]);
    const tablePrivs = await owner.query<{ n: number }>(
      `select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'auth', 'platform', 'authz') and c.relkind in ('r', 'p', 'v')
         and (has_table_privilege('app_platform', c.oid, 'SELECT')
              or has_table_privilege('app_platform', c.oid, 'INSERT')
              or has_table_privilege('app_platform', c.oid, 'UPDATE')
              or has_table_privilege('app_platform', c.oid, 'DELETE'))`,
    );
    expect(tablePrivs.rows[0]!.n).toBe(0);
    const attrs = await owner.query(
      `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = 'app_platform'`,
    );
    expect(attrs.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
    expect(await stateOf(platform.query('select count(*) from platform.admins'))).toBe('42501');
    expect(await stateOf(platform.query('select count(*) from public.organizations'))).toBe(
      '42501',
    );
    expect(await stateOf(user.query('select platform.current_admin()'))).toBe('42501');
  });

  it('bootstrap: refused for every runtime login and for bad input; a refused attempt leaves nothing', async () => {
    const call = 'select * from platform.bootstrap_first_admin($1, $2, $3)';
    const args = [FIRST.email, FIRST.name, sha256(newToken())];
    for (const pool of [platform, auth, user, worker]) {
      expect(await stateOf(pool.query(call, args))).toBe('42501');
    }
    expect(await stateOf(owner.query(call, [FIRST.email, FIRST.name, Buffer.alloc(16)]))).toBe(
      '22023',
    );
    expect(await stateOf(owner.query(call, ['not-an-email', FIRST.name, sha256('x')]))).toBe(
      '22023',
    );
    expect(await stateOf(owner.query(call, [FIRST.email, ' ', sha256('x')]))).toBe('22023');
    expect((await owner.query('select count(*)::int n from platform.admins')).rows[0]!.n).toBe(0);
    expect(
      (await owner.query('select count(*)::int n from platform.bootstrap_state')).rows[0]!.n,
    ).toBe(0);
  });

  it('bootstrap: once per database; then the organization bootstrap is closed (N1, one-way)', async () => {
    // Before the platform bootstrap the organization bootstrap is still open (rehearsed only).
    expect(
      await rehearse((c) =>
        c.query(`select * from public.bootstrap_organization('Org', 'org-pre', 'Owner', $1, $2)`, [
          `owner.${randomUUID().slice(0, 8)}@org.example`,
          sha256(newToken()),
        ]),
      ).then(
        () => 'NO ERROR',
        (e) => stateOf(Promise.reject(e)),
      ),
    ).toBe('NO ERROR');

    const res = await owner.query<{ bootstrapped_admin_id: string; setup_expires_at: Date }>(
      'select * from platform.bootstrap_first_admin($1, $2, $3)',
      [FIRST.email, FIRST.name, sha256('first-token')],
    );
    firstAdmin = res.rows[0]!.bootstrapped_admin_id;
    // The token lives exactly 60 minutes, measured on the database's own clock.
    const life = await owner.query<{ m: number }>(
      `select extract(epoch from expires_at - issued_at)::int / 60 m from platform.setup_tokens where admin_id = $1`,
      [firstAdmin],
    );
    expect(life.rows[0]!.m).toBe(60);
    expect(res.rows[0]!.setup_expires_at).toBeInstanceOf(Date);

    expect(
      await stateOf(
        owner.query('select * from platform.bootstrap_first_admin($1, $2, $3)', [
          `other.${randomUUID().slice(0, 8)}@platform.example`,
          'Other',
          sha256(newToken()),
        ]),
      ),
    ).toBe('55000');

    const admin = await owner.query(
      `select a.status, a.auth_user_id, a.created_by,
              (select count(*)::int from platform.admin_permissions ap where ap.admin_id = a.id) perms
       from platform.admins a where a.id = $1`,
      [firstAdmin],
    );
    expect(admin.rows[0]).toEqual({
      status: 'PENDING_ENROLMENT',
      auth_user_id: null,
      created_by: null,
      perms: 7,
    });

    expect(
      await stateOf(
        owner.query(
          `select * from public.bootstrap_organization('Org', 'org-post', 'Owner', $1, $2)`,
          [`owner.${randomUUID().slice(0, 8)}@org.example`, sha256(newToken())],
        ),
      ),
    ).toBe('42501');
    expect(
      await stateOf(owner.query(`update platform.bootstrap_state set performed_by = 'x'`)),
    ).toBe('42501');
    expect(await stateOf(owner.query(`delete from platform.bootstrap_state`))).toBe('42501');
    expect(await stateOf(owner.query(`truncate platform.bootstrap_state`))).toBe('42501');

    expect(await audit()).toEqual([
      {
        action: 'platform.bootstrap.first_admin',
        result: 'SUCCESS',
        actor_type: 'operator',
        reason_code: null,
      },
    ]);
  });

  it('setup: one use, a library password hash only, then ACTIVE with a new login', async () => {
    const valid = 'select platform.setup_token_is_valid($1) v';
    expect((await auth.query(valid, [sha256('first-token')])).rows[0]!.v).toBe(true);
    expect((await auth.query(valid, [sha256('wrong')])).rows[0]!.v).toBe(false);

    const complete = 'select * from platform.complete_setup($1, $2)';
    expect(await stateOf(auth.query(complete, [sha256('wrong'), fakePasswordHash()]))).toBe(
      '28000',
    );
    expect(await stateOf(auth.query(complete, [sha256('first-token'), 'plaintext']))).toBe('22023');
    for (const pool of [platform, user, worker]) {
      expect(await stateOf(pool.query(complete, [sha256('first-token'), fakePasswordHash()]))).toBe(
        '42501',
      );
    }

    const done = await auth.query<{ setup_admin_id: string; setup_auth_user_id: string }>(
      complete,
      [sha256('first-token'), fakePasswordHash()],
    );
    expect(done.rows[0]!.setup_admin_id).toBe(firstAdmin);
    firstLogin = done.rows[0]!.setup_auth_user_id;
    expect(await stateOf(auth.query(complete, [sha256('first-token'), fakePasswordHash()]))).toBe(
      '28000',
    );

    const login = await owner.query(
      `select u.email::text, u.email_verified, (select count(*)::int from auth.auth_accounts c
         where c.user_id = u.id and c.provider_id = 'credential') creds
       from auth.auth_users u where u.id = $1`,
      [firstLogin],
    );
    expect(login.rows[0]).toEqual({ email: FIRST.email, email_verified: false, creds: 1 });
    const admin = await owner.query(
      'select status, auth_user_id from platform.admins where id = $1',
      [firstAdmin],
    );
    expect(admin.rows[0]).toEqual({ status: 'ACTIVE', auth_user_id: firstLogin });
    expect((await audit()).map((e) => e.action)).toEqual([
      'platform.bootstrap.first_admin',
      'platform.admin.setup_completed',
    ]);
  });

  it('identity: only app_platform, an ACTIVE administrator and aal2 make an actor', async () => {
    const who = 'select admin_id, permissions from platform.whoami()';
    expect(await stateOf(asAdmin(null, 'aal2', who))).toBe('42501');
    expect(await stateOf(asAdmin(firstAdmin, 'aal1', who))).toBe('42501');
    expect(await stateOf(asAdmin(firstAdmin, '', who))).toBe('42501');
    expect(await stateOf(asAdmin('not-a-uuid', 'aal2', who))).toBe('42501');
    expect(await stateOf(asAdmin(randomUUID(), 'aal2', who))).toBe('42501');
    // ACTIVE, but no second factor enrolled yet: an aal2 claim does not count (as authz.aal()).
    expect(await stateOf(asAdmin(firstAdmin, 'aal2', who))).toBe('42501');
    await enrolFactor(firstAdmin);
    const me = await asAdmin<{ admin_id: string; permissions: string[] }>(firstAdmin, 'aal2', who);
    expect(me.rows[0]!.admin_id).toBe(firstAdmin);
    expect(me.rows[0]!.permissions).toHaveLength(7);

    // 0086 (S-CONSOLE-1): the settings alone act as nobody. The actor needs a live aal2 session
    // of their own login — its id AND the hash of its bearer token — within the platform's
    // 12-hour and 30-minute limits.
    const live0 = await sessionFor(firstAdmin, 'aal2');
    expect(await stateOf(asAdmin(firstAdmin, 'aal2', who, [], { id: '', tokenSha256: '' }))).toBe(
      '42501',
    );
    expect(
      await stateOf(asAdmin(firstAdmin, 'aal2', who, [], { ...live0, id: randomUUID() })),
    ).toBe('42501');
    // The right session id without its token (R-1): an id is not a credential.
    expect(
      await stateOf(
        asAdmin(firstAdmin, 'aal2', who, [], { ...live0, tokenSha256: sha256Hex(newToken()) }),
      ),
    ).toBe('42501');
    expect(await stateOf(asAdmin(firstAdmin, 'aal2', who, [], { ...live0, tokenSha256: '' }))).toBe(
      '42501',
    );
    expect((await asAdmin(firstAdmin, 'aal2', who, [], live0)).rows).toHaveLength(1);
    const aal1Session = await sessionFor(firstAdmin, 'aal1');
    expect(await stateOf(asAdmin(firstAdmin, 'aal2', who, [], aal1Session))).toBe('42501');
    const idle = await sessionFor(firstAdmin, 'aal2', { idleMinutes: 31 });
    expect(await stateOf(asAdmin(firstAdmin, 'aal2', who, [], idle))).toBe('42501');
    const old = await sessionFor(firstAdmin, 'aal2', { createdMinutesAgo: 12 * 60 + 1 });
    expect(await stateOf(asAdmin(firstAdmin, 'aal2', who, [], old))).toBe('42501');
    const live = await sessionFor(firstAdmin, 'aal2', { createdMinutesAgo: 60, idleMinutes: 29 });
    expect((await asAdmin(firstAdmin, 'aal2', who, [], live)).rows).toHaveLength(1);
    // Another login's live aal2 session does not make this administrator an actor.
    const otherToken = newToken();
    const others = await owner.query<{ id: string }>(
      `insert into auth.auth_sessions (user_id, token, expires_at, aal)
       select id, $1, now() + interval '1 day', 'aal2' from auth.auth_users
       where id <> $2 limit 1 returning id`,
      [otherToken, firstLogin],
    );
    if (others.rows[0]) {
      const other = { id: others.rows[0].id, tokenSha256: sha256Hex(otherToken) };
      expect(await stateOf(asAdmin(firstAdmin, 'aal2', who, [], other))).toBe('42501');
    }

    const forLogin = await platform.query('select * from platform.admin_for_login($1)', [
      firstLogin,
    ]);
    expect(forLogin.rows).toEqual([{ admin_id: firstAdmin, status: 'ACTIVE' }]);
    expect(
      (await platform.query('select * from platform.admin_for_login($1)', [randomUUID()])).rows,
    ).toEqual([]);
  });

  it('a login is a platform administrator or a person, never both', async () => {
    await rehearse(async (c) => {
      const org = (
        await c.query<{ id: string }>(
          `insert into public.organizations (name, slug) values ('Mx', $1) returning id`,
          [`mx-${randomUUID().slice(0, 8)}`],
        )
      ).rows[0]!.id;
      expect(
        await stateOf(
          c.query(
            `insert into public.people (org_id, code, full_legal_name, work_email, person_status, auth_user_id)
             values ($1, 'EMP-2026-0001', 'Mx', $2, 'ACTIVE', $3)`,
            [org, `mx.${randomUUID().slice(0, 8)}@org.example`, firstLogin],
          ),
        ),
      ).toBe('23514');
    });
  });

  let second = '';
  it('administrator management: invite with least privilege; refuse existing logins; never self', async () => {
    const invite = 'select * from platform.invite_admin($1, $2, $3, $4, $5)';
    const email = `second.${randomUUID().slice(0, 8)}@platform.example`;
    const res = await asAdmin<{ invited_admin_id: string }>(firstAdmin, 'aal2', invite, [
      email,
      'Second Admin',
      ['platform.organizations.create'],
      sha256('second-token'),
      randomUUID(),
    ]);
    second = res.rows[0]!.invited_admin_id;
    const perms = await owner.query<{ k: string }>(
      'select permission_key k from platform.admin_permissions where admin_id = $1 order by 1',
      [second],
    );
    expect(perms.rows.map((r) => r.k)).toEqual([
      'platform.audit.view',
      'platform.organizations.create',
      'platform.organizations.view',
    ]);
    // An address with a login (the first administrator's) and an existing administrator: refused.
    expect(
      await stateOf(
        asAdmin(firstAdmin, 'aal2', invite, [FIRST.email, 'X', [], sha256(newToken()), null]),
      ),
    ).toBe('55000');
    // Case does not matter: the comparison is citext's, not text's.
    expect(
      await stateOf(
        asAdmin(firstAdmin, 'aal2', invite, [
          FIRST.email.toUpperCase(),
          'X',
          [],
          sha256(newToken()),
          null,
        ]),
      ),
    ).toBe('55000');
    expect(
      await stateOf(
        asAdmin(firstAdmin, 'aal2', invite, [email, 'X', [], sha256(newToken()), null]),
      ),
    ).toBe('55000');
    expect(
      await stateOf(
        asAdmin(firstAdmin, 'aal2', invite, [
          `x.${randomUUID().slice(0, 8)}@platform.example`,
          'X',
          ['platform.everything'],
          sha256(newToken()),
          null,
        ]),
      ),
    ).toBe('22023');

    // The invited administrator, once set up (and holding a factor), lacks admins.manage: refused.
    await auth.query('select * from platform.complete_setup($1, $2)', [
      sha256('second-token'),
      fakePasswordHash(),
    ]);
    await enrolFactor(second);
    expect(
      (
        await asAdmin<{ admin_id: string }>(
          second,
          'aal2',
          'select admin_id from platform.whoami()',
        )
      ).rows[0]!.admin_id,
    ).toBe(second);
    expect(
      await stateOf(
        asAdmin(second, 'aal2', invite, [
          `y.${randomUUID().slice(0, 8)}@platform.example`,
          'Y',
          [],
          sha256(newToken()),
          null,
        ]),
      ),
    ).toBe('42501');
    expect(
      await stateOf(
        asAdmin(firstAdmin, 'aal2', 'select platform.revoke_admin($1, $2, $3)', [
          firstAdmin,
          'self',
          null,
        ]),
      ),
    ).toBe('42501');
  });

  it('an administrator can grant only the permissions they hold', async () => {
    const invite = 'select * from platform.invite_admin($1, $2, $3, $4, $5)';
    const manager = (
      await asAdmin<{ invited_admin_id: string }>(firstAdmin, 'aal2', invite, [
        `manager.${randomUUID().slice(0, 8)}@platform.example`,
        'Manager',
        ['platform.admins.manage'],
        sha256('manager-token'),
        null,
      ])
    ).rows[0]!.invited_admin_id;
    await auth.query('select * from platform.complete_setup($1, $2)', [
      sha256('manager-token'),
      fakePasswordHash(),
    ]);
    await enrolFactor(manager);
    const target = () => `t.${randomUUID().slice(0, 8)}@platform.example`;
    expect(
      await stateOf(
        asAdmin(manager, 'aal2', invite, [
          target(),
          'T',
          ['platform.organizations.create'],
          sha256(newToken()),
          null,
        ]),
      ),
    ).toBe('42501');
    const ok = await asAdmin<{ invited_admin_id: string }>(manager, 'aal2', invite, [
      target(),
      'T',
      ['platform.admins.manage'],
      sha256(newToken()),
      null,
    ]);
    expect(ok.rows).toHaveLength(1);

    // The default view permissions count too: a manager who lacks audit.view cannot hand it out.
    await owner.query(
      `delete from platform.admin_permissions where admin_id = $1 and permission_key = 'platform.audit.view'`,
      [manager],
    );
    expect(
      await stateOf(
        asAdmin(manager, 'aal2', invite, [target(), 'T', [], sha256(newToken()), null]),
      ),
    ).toBe('42501');
  });

  it('revocation ends the administrator and every session of their login, once', async () => {
    const login = (
      await owner.query<{ id: string }>(
        'select auth_user_id id from platform.admins where id = $1',
        [second],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into auth.auth_sessions (user_id, token, expires_at) values ($1, $2, now() + interval '1 hour')`,
      [login, randomBytes(24).toString('hex')],
    );
    const revoke = 'select platform.revoke_admin($1, $2, $3)';
    await asAdmin(firstAdmin, 'aal2', revoke, [second, 'no longer needed', randomUUID()]);
    await asAdmin(firstAdmin, 'aal2', revoke, [second, 'no longer needed', randomUUID()]); // no-op
    const state = await owner.query(
      `select a.status, a.revoked_by, (select count(*)::int from auth.auth_sessions s where s.user_id = a.auth_user_id) sessions
       from platform.admins a where a.id = $1`,
      [second],
    );
    expect(state.rows[0]).toEqual({ status: 'REVOKED', revoked_by: firstAdmin, sessions: 0 });
    expect(await stateOf(asAdmin(second, 'aal2', 'select * from platform.whoami()'))).toBe('42501');
    expect((await audit()).filter((e) => e.action === 'platform.admin.revoked')).toHaveLength(1);
  });

  it('recovery (break glass): the whole old credential goes; nothing from the window survives', async () => {
    const session = () =>
      owner.query(
        `insert into auth.auth_sessions (user_id, token, expires_at) values ($1, $2, now() + interval '1 hour')`,
        [firstLogin, randomBytes(24).toString('hex')],
      );
    await session();
    // An outstanding reset link (issued before 0083 closed the web reset for administrators).
    await owner.query(
      `insert into auth.password_resets (auth_user_id, token_hash, expires_at)
       values ($1, $2, now() + interval '1 hour')`,
      [firstLogin, createHash('sha256').update(newToken()).digest('hex')],
    );

    const recover = 'select platform.recover_admin($1, $2, $3)';
    expect(
      await stateOf(platform.query(recover, [FIRST.email, 'lost the phone entirely', sha256('r')])),
    ).toBe('42501');
    expect(await stateOf(owner.query(recover, [FIRST.email, 'short', sha256('r')]))).toBe('22023');
    await owner.query(recover, [FIRST.email, 'lost the phone entirely', sha256('recovery-token')]);

    const after = await owner.query(
      `select a.status, u.two_factor_enabled,
              (select count(*)::int from auth.auth_sessions s where s.user_id = u.id) sessions,
              (select count(*)::int from auth.auth_two_factors f where f.user_id = u.id) factors
       from platform.admins a join auth.auth_users u on u.id = a.auth_user_id where a.id = $1`,
      [firstAdmin],
    );
    expect(after.rows[0]).toEqual({
      status: 'PENDING_ENROLMENT',
      two_factor_enabled: false,
      sessions: 0,
      factors: 0,
    });
    const credential = await owner.query(
      `select c.password,
              (select count(*)::int from auth.password_resets r
                where r.auth_user_id = c.user_id and r.used_at is null) open_resets
       from auth.auth_accounts c where c.user_id = $1 and c.provider_id = 'credential'`,
      [firstLogin],
    );
    expect(credential.rows[0]).toEqual({ password: null, open_resets: 0 });
    expect(await stateOf(asAdmin(firstAdmin, 'aal2', 'select * from platform.whoami()'))).toBe(
      '42501',
    );

    // Whatever someone managed during the window — a session, a factor of their own — does not
    // survive the real administrator's completion.
    await session();
    await enrolFactor(firstAdmin);
    const newHash = fakePasswordHash();
    const done = await auth.query('select * from platform.complete_setup($1, $2)', [
      sha256('recovery-token'),
      newHash,
    ]);
    expect(done.rows[0]).toEqual({ setup_admin_id: firstAdmin, setup_auth_user_id: firstLogin });
    const fresh = await owner.query(
      `select c.password, u.two_factor_enabled,
              (select count(*)::int from auth.auth_sessions s where s.user_id = u.id) sessions,
              (select count(*)::int from auth.auth_two_factors f where f.user_id = u.id) factors
       from auth.auth_accounts c join auth.auth_users u on u.id = c.user_id
       where c.user_id = $1 and c.provider_id = 'credential'`,
      [firstLogin],
    );
    expect(fresh.rows[0]).toEqual({
      password: newHash,
      two_factor_enabled: false,
      sessions: 0,
      factors: 0,
    });
    await enrolFactor(firstAdmin); // the administrator enrols their new factor
    const entries = await audit();
    expect(entries.find((e) => e.action === 'platform.admin.recovered')).toMatchObject({
      actor_type: 'operator',
      reason_code: 'BREAK_GLASS',
    });
    expect(
      entries.filter((e) => e.action === 'platform.admin.setup_completed').at(-1),
    ).toMatchObject({
      reason_code: 'RECOVERY',
    });
  });

  it('setup re-issue: only for an administrator still awaiting setup', async () => {
    const reissue = 'select platform.reissue_setup($1, $2)';
    expect(await stateOf(owner.query(reissue, [FIRST.email, sha256(newToken())]))).toBe('55000');
    const email = `third.${randomUUID().slice(0, 8)}@platform.example`;
    await asAdmin(firstAdmin, 'aal2', 'select * from platform.invite_admin($1, $2, $3, $4, $5)', [
      email,
      'Third',
      [],
      sha256('third-old'),
      null,
    ]);
    await owner.query(reissue, [email, sha256('third-new')]);
    expect(
      (await auth.query('select platform.setup_token_is_valid($1) v', [sha256('third-old')]))
        .rows[0]!.v,
    ).toBe(false);
    expect(
      (await auth.query('select platform.setup_token_is_valid($1) v', [sha256('third-new')]))
        .rows[0]!.v,
    ).toBe(true);
  });

  it('audit: append-only for every role; failures recorded by the actor only; listing needs audit.view', async () => {
    expect(await stateOf(owner.query(`update platform.audit_events set reason_code = 'X'`))).toBe(
      '42501',
    );
    expect(await stateOf(owner.query('delete from platform.audit_events'))).toBe('42501');
    expect(await stateOf(owner.query('truncate platform.audit_events'))).toBe('42501');
    expect(
      await stateOf(
        platform.query(
          `insert into platform.audit_events (actor_type, action, result) values ('system', 'platform.x.y', 'SUCCESS')`,
        ),
      ),
    ).toBe('42501');

    const fail = 'select platform.record_failure($1, $2, $3, $4, $5)';
    expect(
      await stateOf(
        asAdmin(null, 'aal2', fail, [
          'platform.organization.provision',
          'DENIED',
          'NO_PERMISSION',
          null,
          null,
        ]),
      ),
    ).toBe('42501');
    expect(
      await stateOf(
        asAdmin(firstAdmin, 'aal2', fail, [
          'platform.organization.provision',
          'SUCCESS',
          null,
          null,
          null,
        ]),
      ),
    ).toBe('22023');
    await asAdmin(firstAdmin, 'aal2', fail, [
      'platform.organization.provision',
      'DENIED',
      'NO_PERMISSION',
      null,
      randomUUID(),
    ]);
    expect((await audit()).at(-1)).toEqual({
      action: 'platform.organization.provision',
      result: 'DENIED',
      actor_type: 'platform_admin',
      reason_code: 'NO_PERMISSION',
    });

    const page = 'select id, occurred_at from platform.list_audit_events($1, $2, $3)';
    const all = await asAdmin<{ id: string; occurred_at: Date }>(firstAdmin, 'aal2', page, [
      null,
      null,
      200,
    ]);
    expect(all.rows.length).toBe((await audit()).length);
    // Paging with the (occurred_at, id) cursor walks every entry exactly once.
    const walked: string[] = [];
    let cursor: [Date | null, string | null] = [null, null];
    for (;;) {
      const rows = (
        await asAdmin<{ id: string; occurred_at: Date }>(firstAdmin, 'aal2', page, [...cursor, 3])
      ).rows;
      if (rows.length === 0) break;
      walked.push(...rows.map((r) => r.id));
      cursor = [rows.at(-1)!.occurred_at, rows.at(-1)!.id];
    }
    expect(walked).toEqual(all.rows.map((r) => r.id));
    expect(await stateOf(asAdmin(firstAdmin, 'aal2', page, [null, null, 0]))).toBe('22023');
    expect(await stateOf(asAdmin(firstAdmin, 'aal2', page, [new Date(), null, 10]))).toBe('22023');
    // A failure entry cannot invent an operation.
    expect(
      await stateOf(
        asAdmin(firstAdmin, 'aal2', fail, [
          'platform.made.up',
          'DENIED',
          'NO_PERMISSION',
          null,
          null,
        ]),
      ),
    ).toBe('22023');
    // No entry ever carries a token or a password hash.
    const leaked = await owner.query<{ n: number }>(
      `select count(*)::int n from platform.audit_events e
       where e.metadata::text ~ '[0-9a-f]{32}:[0-9a-f]{128}' or e.metadata::text ilike '%token%'`,
    );
    expect(leaked.rows[0]!.n).toBe(0);
  });

  // ── 0084: provisioning, the first organization administrator, suspend / reactivate ──────

  const provision =
    'select * from platform.provision_organization($1, $2, $3, $4, $5, $6, $7, $8, $9)';
  const orgArgs = (
    key: string,
    slug: string,
    email: string,
    type = 'generic_crm',
    tz = 'Asia/Kolkata',
  ) => [
    key,
    `Org ${slug}`,
    slug,
    tz,
    type,
    'Org Admin',
    email,
    sha256(`setup-${key}`),
    randomUUID(),
  ];
  let viewer = '';
  let orgA = '';
  let orgAdminA = '';
  const KEY_A = `prov-${randomUUID()}`;
  const SLUG_A = `prov-a-${randomUUID().slice(0, 8)}`;
  const EMAIL_A = `admin.a.${randomUUID().slice(0, 8)}@tenant.example`;

  it('types: only ACTIVE types with a published template are offered', async () => {
    const types = await asAdmin<{ type_key: string; latest_version: number }>(
      firstAdmin,
      'aal2',
      'select type_key, latest_version from platform.list_organization_types()',
    );
    expect(types.rows).toEqual([{ type_key: 'generic_crm', latest_version: 1 }]);
  });

  it('provisioning creates the organization, its first administrator and a setup token, once', async () => {
    const res = await asAdmin<{
      provisioned_org_id: string;
      admin_person_id: string;
      replayed: boolean;
    }>(firstAdmin, 'aal2', provision, orgArgs(KEY_A, SLUG_A, EMAIL_A));
    expect(res.rows[0]!.replayed).toBe(false);
    orgA = res.rows[0]!.provisioned_org_id;
    orgAdminA = res.rows[0]!.admin_person_id;

    const org = await owner.query(
      `select o.type_key, o.template_version, o.status, o.timezone,
              (select count(*)::int from public.roles r where r.org_id = o.id and r.is_system) system_roles,
              (select count(*)::int from public.departments d where d.org_id = o.id) departments,
              (select count(*)::int from public.pipelines p where p.org_id = o.id and p.is_default) default_pipelines
       from public.organizations o where o.id = $1`,
      [orgA],
    );
    expect(org.rows[0]).toEqual({
      type_key: 'generic_crm',
      template_version: 1,
      status: 'ACTIVE',
      timezone: 'Asia/Kolkata',
      system_roles: 14,
      departments: 1,
      default_pipelines: 1,
    });
    const person = await owner.query(
      `select p.person_status, p.auth_user_id, p.work_email::text,
              (select count(*)::int from public.engagements e where e.person_id = p.id and e.status = 'ACTIVE') engagements,
              (select array_agg(r.key) from public.person_roles pr join public.roles r on r.id = pr.role_id
                where pr.person_id = p.id) roles
       from public.people p where p.id = $1 and p.org_id = $2`,
      [orgAdminA, orgA],
    );
    expect(person.rows[0]).toEqual({
      person_status: 'ACTIVE',
      auth_user_id: null,
      work_email: EMAIL_A,
      engagements: 1,
      roles: ['SUPER_ADMIN'],
    });
    const setup = await owner.query<{ h: number }>(
      `select extract(epoch from expires_at - issued_at)::int / 3600 h from platform.org_admin_setup where org_id = $1`,
      [orgA],
    );
    expect(setup.rows[0]!.h).toBe(72);

    // The same key and parameters: the stored result, nothing written; other parameters: refused.
    const again = await asAdmin<{
      provisioned_org_id: string;
      replayed: boolean;
      setup_expires_at: Date | null;
    }>(firstAdmin, 'aal2', provision, orgArgs(KEY_A, SLUG_A, EMAIL_A));
    expect(again.rows[0]).toMatchObject({
      provisioned_org_id: orgA,
      replayed: true,
      setup_expires_at: null,
    });
    expect(
      await stateOf(asAdmin(firstAdmin, 'aal2', provision, orgArgs(KEY_A, `${SLUG_A}-x`, EMAIL_A))),
    ).toBe('23505');
    const entries = (await audit()).filter((e) => e.action === 'platform.organization.provisioned');
    expect(entries).toHaveLength(1);
    expect(
      (
        await owner.query('select count(*)::int n from public.organizations where slug = $1', [
          SLUG_A,
        ])
      ).rows[0]!.n,
    ).toBe(1);
  });

  it('provisioning refuses: no permission, aal1, unavailable type, used slug or email, bad input — leaving nothing', async () => {
    const vEmail = `viewer.${randomUUID().slice(0, 8)}@platform.example`;
    viewer = (
      await asAdmin<{ invited_admin_id: string }>(
        firstAdmin,
        'aal2',
        'select * from platform.invite_admin($1, $2, $3, $4, $5)',
        [vEmail, 'Viewer', [], sha256('viewer-token'), null],
      )
    ).rows[0]!.invited_admin_id;
    await auth.query('select * from platform.complete_setup($1, $2)', [
      sha256('viewer-token'),
      fakePasswordHash(),
    ]);
    await enrolFactor(viewer);

    const before = (
      await owner.query<{ n: number }>('select count(*)::int n from public.organizations')
    ).rows[0]!.n;
    const fresh = () => `prov-${randomUUID()}`;
    const slug = () => `prov-r-${randomUUID().slice(0, 8)}`;
    const mail = () => `r.${randomUUID().slice(0, 8)}@tenant.example`;
    expect(
      await stateOf(asAdmin(viewer, 'aal2', provision, orgArgs(fresh(), slug(), mail()))),
    ).toBe('42501');
    expect(
      await stateOf(asAdmin(firstAdmin, 'aal1', provision, orgArgs(fresh(), slug(), mail()))),
    ).toBe('42501');
    expect(
      await stateOf(
        asAdmin(firstAdmin, 'aal2', provision, orgArgs(fresh(), slug(), mail(), 'real_estate_crm')),
      ),
    ).toBe('22023');
    expect(
      await stateOf(
        asAdmin(firstAdmin, 'aal2', provision, orgArgs(fresh(), slug(), mail(), 'no_such_type')),
      ),
    ).toBe('22023');
    expect(
      await stateOf(asAdmin(firstAdmin, 'aal2', provision, orgArgs(fresh(), SLUG_A, mail()))),
    ).toBe('23505');
    expect(
      await stateOf(asAdmin(firstAdmin, 'aal2', provision, orgArgs(fresh(), slug(), FIRST.email))),
    ).toBe('55000');
    expect(
      await stateOf(
        asAdmin(firstAdmin, 'aal2', provision, orgArgs(fresh(), slug(), FIRST.email.toUpperCase())),
      ),
    ).toBe('55000');
    expect(
      await stateOf(asAdmin(firstAdmin, 'aal2', provision, orgArgs(fresh(), slug(), EMAIL_A))),
    ).toBe('55000');
    expect(
      await stateOf(
        asAdmin(
          firstAdmin,
          'aal2',
          provision,
          orgArgs(fresh(), slug(), mail(), 'generic_crm', 'Mars/Base'),
        ),
      ),
    ).toBe('22023');
    expect(
      await stateOf(asAdmin(firstAdmin, 'aal2', provision, orgArgs('short', slug(), mail()))),
    ).toBe('22023');
    expect(
      await stateOf(asAdmin(firstAdmin, 'aal2', provision, orgArgs(fresh(), 'Bad Slug', mail()))),
    ).toBe('22023');
    for (const pool of [user, worker, auth]) {
      expect(await stateOf(pool.query(provision, orgArgs(fresh(), slug(), mail())))).toBe('42501');
    }
    expect(
      (await owner.query<{ n: number }>('select count(*)::int n from public.organizations'))
        .rows[0]!.n,
    ).toBe(before);
  });

  it('the first administrator completes setup once; the login is theirs; re-issue only before', async () => {
    const valid = 'select platform.org_admin_setup_token_is_valid($1) v';
    const complete = 'select * from platform.complete_org_admin_setup($1, $2)';
    expect((await auth.query(valid, [sha256(`setup-${KEY_A}`)])).rows[0]!.v).toBe(true);
    for (const pool of [platform, user, worker]) {
      expect(
        await stateOf(pool.query(complete, [sha256(`setup-${KEY_A}`), fakePasswordHash()])),
      ).toBe('42501');
    }
    expect(await stateOf(auth.query(complete, [sha256(`setup-${KEY_A}`), 'plain']))).toBe('22023');

    // Re-issue before completion: the old token dies.
    const reissue = 'select platform.reissue_org_admin_setup($1, $2, $3)';
    expect(await stateOf(asAdmin(viewer, 'aal2', reissue, [orgA, sha256('a-new'), null]))).toBe(
      '42501',
    );
    await asAdmin(firstAdmin, 'aal2', reissue, [orgA, sha256('a-new'), randomUUID()]);
    expect((await auth.query(valid, [sha256(`setup-${KEY_A}`)])).rows[0]!.v).toBe(false);

    const done = await auth.query<{
      linked_person_id: string;
      linked_org_id: string;
      linked_auth_user_id: string;
    }>(complete, [sha256('a-new'), fakePasswordHash()]);
    expect(done.rows[0]).toMatchObject({ linked_person_id: orgAdminA, linked_org_id: orgA });
    expect(await stateOf(auth.query(complete, [sha256('a-new'), fakePasswordHash()]))).toBe(
      '28000',
    );
    expect(
      await stateOf(asAdmin(firstAdmin, 'aal2', reissue, [orgA, sha256('a-later'), null])),
    ).toBe('55000');

    const linked = await owner.query('select auth_user_id from public.people where id = $1', [
      orgAdminA,
    ]);
    expect(linked.rows[0]!.auth_user_id).toBe(done.rows[0]!.linked_auth_user_id);
    // The web password reset serves the organization's administrator, never a platform login.
    const reset = 'select authz.request_password_reset($1, $2) id';
    const resetHash = () => createHash('sha256').update(newToken()).digest('hex');
    expect((await auth.query(reset, [EMAIL_A, resetHash()])).rows[0]!.id).not.toBeNull();
    expect((await auth.query(reset, [FIRST.email, resetHash()])).rows[0]!.id).toBeNull();
    const tenantAudit = await owner.query<{ actor_person_id: string }>(
      `select actor_person_id from public.audit_logs where org_id = $1 and action = 'organization.first_admin_setup_completed'`,
      [orgA],
    );
    expect(tenantAudit.rows).toEqual([{ actor_person_id: orgAdminA }]);
    expect(
      (await audit()).filter((e) => e.action === 'platform.organization.admin_setup_completed'),
    ).toEqual([
      {
        action: 'platform.organization.admin_setup_completed',
        result: 'SUCCESS',
        actor_type: 'system',
        reason_code: null,
      },
    ]);
    // The organization now administers itself: the genesis branch is closed for it.
    expect(
      (await owner.query('select public.may_manage_protected_roles($1) m', [orgA])).rows[0]!.m,
    ).toBe(false);
  });

  it('suspend and reactivate: reason required, idempotent, the members refused while suspended', async () => {
    const setStatus = 'select platform.set_organization_status($1, $2, $3, $4) s';
    const memberActive = async () => {
      const c = await user.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.person_id', $1, true), set_config('app.org_id', $2, true), set_config('app.aal', 'aal2', true)`,
          [orgAdminA, orgA],
        );
        return (await c.query<{ a: boolean }>('select authz.is_active() a')).rows[0]!.a;
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
    };
    expect(await memberActive()).toBe(true);
    expect(
      await stateOf(asAdmin(viewer, 'aal2', setStatus, [orgA, 'SUSPENDED', 'abuse report', null])),
    ).toBe('42501');
    expect(
      await stateOf(asAdmin(firstAdmin, 'aal2', setStatus, [orgA, 'SUSPENDED', 'x', null])),
    ).toBe('22023');
    expect(
      await stateOf(asAdmin(firstAdmin, 'aal2', setStatus, [orgA, 'ARCHIVED', 'not in V1', null])),
    ).toBe('22023');
    expect(
      await stateOf(
        asAdmin(firstAdmin, 'aal2', setStatus, [randomUUID(), 'SUSPENDED', 'missing org', null]),
      ),
    ).toBe('P0002');

    const s1 = await asAdmin<{ s: string }>(firstAdmin, 'aal2', setStatus, [
      orgA,
      'SUSPENDED',
      'abuse report',
      randomUUID(),
    ]);
    expect(s1.rows[0]!.s).toBe('SUSPENDED');
    const s2 = await asAdmin<{ s: string }>(firstAdmin, 'aal2', setStatus, [
      orgA,
      'SUSPENDED',
      'abuse report',
      randomUUID(),
    ]);
    expect(s2.rows[0]!.s).toBe('UNCHANGED');
    const org = await owner.query(
      'select status, suspended_by, suspension_reason from public.organizations where id = $1',
      [orgA],
    );
    expect(org.rows[0]).toEqual({
      status: 'SUSPENDED',
      suspended_by: firstAdmin,
      suspension_reason: 'abuse report',
    });
    expect(await memberActive()).toBe(false);

    const r = await asAdmin<{ s: string }>(firstAdmin, 'aal2', setStatus, [
      orgA,
      'ACTIVE',
      'resolved',
      randomUUID(),
    ]);
    expect(r.rows[0]!.s).toBe('ACTIVE');
    expect(await memberActive()).toBe(true);
    const lifecycle = (await audit()).filter((e) =>
      /organization\.(suspended|reactivated)$/.test(e.action),
    );
    expect(lifecycle.map((e) => e.action)).toEqual([
      'platform.organization.suspended',
      'platform.organization.reactivated',
    ]);

    // An archived organization (V1.1 territory) cannot be moved by the platform in V1.
    await owner.query(`update public.organizations set status = 'ARCHIVED' where id = $1`, [orgA]);
    expect(
      await stateOf(asAdmin(firstAdmin, 'aal2', setStatus, [orgA, 'ACTIVE', 'restore', null])),
    ).toBe('55000');
    await owner.query(`update public.organizations set status = 'ACTIVE' where id = $1`, [orgA]);
  });

  it("a suspended organization's first administrator cannot complete setup", async () => {
    const key = `prov-${randomUUID()}`;
    const res = await asAdmin<{ provisioned_org_id: string }>(
      firstAdmin,
      'aal2',
      provision,
      orgArgs(
        key,
        `prov-b-${randomUUID().slice(0, 8)}`,
        `admin.b.${randomUUID().slice(0, 8)}@tenant.example`,
      ),
    );
    const orgB = res.rows[0]!.provisioned_org_id;
    await asAdmin(firstAdmin, 'aal2', 'select platform.set_organization_status($1, $2, $3, $4)', [
      orgB,
      'SUSPENDED',
      'payment review',
      null,
    ]);
    expect(
      (
        await auth.query('select platform.org_admin_setup_token_is_valid($1) v', [
          sha256(`setup-${key}`),
        ])
      ).rows[0]!.v,
    ).toBe(false);
    // Nor can its setup link be re-issued while it is suspended.
    expect(
      await stateOf(
        asAdmin(firstAdmin, 'aal2', 'select platform.reissue_org_admin_setup($1, $2, $3)', [
          orgB,
          sha256(newToken()),
          null,
        ]),
      ),
    ).toBe('55000');
    expect(
      await stateOf(
        auth.query('select * from platform.complete_org_admin_setup($1, $2)', [
          sha256(`setup-${key}`),
          fakePasswordHash(),
        ]),
      ),
    ).toBe('28000');
    const orgs = await asAdmin<{
      org_id: string;
      status: string;
      first_admin_setup_pending: boolean;
    }>(
      firstAdmin,
      'aal2',
      'select org_id, status, first_admin_setup_pending from platform.list_organizations() where org_id = any($1)',
      [[orgA, orgB]],
    );
    expect(orgs.rows.sort((a, b) => (a.org_id === orgA ? -1 : b.org_id === orgA ? 1 : 0))).toEqual([
      { org_id: orgA, status: 'ACTIVE', first_admin_setup_pending: false },
      { org_id: orgB, status: 'SUSPENDED', first_admin_setup_pending: true },
    ]);
  });

  it('a login created by setup is stored lower-cased, so the sign-in lockout reaches it', async () => {
    const key = `prov-${randomUUID()}`;
    const mixed = `Mixed.Admin.${randomUUID().slice(0, 8)}@Tenant.Example`;
    await asAdmin(
      firstAdmin,
      'aal2',
      provision,
      orgArgs(key, `prov-c-${randomUUID().slice(0, 8)}`, mixed),
    );
    const done = await auth.query<{ linked_auth_user_id: string }>(
      'select * from platform.complete_org_admin_setup($1, $2)',
      [sha256(`setup-${key}`), fakePasswordHash()],
    );
    const login = done.rows[0]!.linked_auth_user_id;
    const stored = await owner.query<{ email: string }>(
      'select email::text from auth.auth_users where id = $1',
      [login],
    );
    expect(stored.rows[0]!.email).toBe(mixed.toLowerCase());
    // Five failures through the authentication plane lock the login, as for every other login.
    let crossed = 0;
    for (let n = 1; n <= 5; n++) {
      const r = await auth.query<{ c: boolean }>(
        `select authz.record_login_failure($1, '127.0.0.1'::inet, 'test') c`,
        [mixed],
      );
      if (r.rows[0]!.c && !crossed) crossed = n;
    }
    expect(crossed).toBe(5);
    expect(
      (await auth.query<{ l: boolean }>('select authz.check_login_lockout($1) l', [mixed])).rows[0]!
        .l,
    ).toBe(true);
  });
});
