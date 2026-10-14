/**
 * The authentication plane's own database role, app_auth (migrations 0072/0073). LIVE DB, real
 * logins — DATABASE_URL_TEST = app_user (business), DATABASE_URL_AUTH = app_auth, DATABASE_URL_WORKER
 * = app_worker. Nothing here mocks an identity.
 *
 * The boundary under test:
 *   A. each login is itself; app_auth is a plain login with no membership; nobody becomes it;
 *      the privilege matrix is exactly the designed one;
 *   B. app_user reaches no table of the credential store — not password hashes, sessions, second
 *      factors, verification values or rate-limit state — however it sets its identity settings;
 *      app_auth can do what Better Auth does there;
 *   C. the pre-login functions answer app_auth and refuse app_user and app_worker; app_auth
 *      reaches no business or worker function;
 *   D. the administrator definers (authz.admin_session_action, authz.admin_issue_credential_reset)
 *      take their actor from the presented session token alone: a forged app.person_id /
 *      app.org_id / app.aal grants nothing; scope, the MFA rule and the organization boundary hold;
 *      failures change nothing; revocation and its audit entry are one transaction; no token is
 *      ever returned, echoed or audited;
 *   E. those definers reach only a person the administrator can see under people_select
 *      (people.view: GLOBAL / DEPARTMENT / TEAM / SELF / record grant — 0074, audit H1 / M1), and
 *      authz.person_visible() agrees with that policy row for row.
 *
 * Isolation: every case builds its own organizations and people; nothing global is touched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from '@neondatabase/serverless';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { DB_READY, mkOrg, mkPerson, RUN } from '../workflows/helpers';
import { SYSTEM_ACTOR, WORKER_DB_READY } from '../worker-role';
import { AUTH_DB_READY, seedSession } from '../auth-role';

const READY = DB_READY && WORKER_DB_READY && AUTH_DB_READY;

const AUTH_TABLES = [
  'auth.auth_users',
  'auth.auth_accounts',
  'auth.auth_sessions',
  'auth.auth_two_factors',
  'auth.auth_verifications',
  'auth.auth_rate_limits',
] as const;

/** Every pre-login function, with arguments that reach its body (never its grant check). */
const PRELOGIN: [string, string][] = [
  [
    'authz.check_rate_limit(text,integer,integer)',
    `select authz.check_rate_limit('probe:${RUN}', 5, 60)`,
  ],
  [
    'authz.request_password_reset(text,text)',
    `select authz.request_password_reset('nobody.${RUN}@example.test', repeat('a', 64))`,
  ],
  ['authz.consume_password_reset(text)', `select authz.consume_password_reset(repeat('b', 64))`],
  [
    'authz.update_credential_password(uuid,text)',
    `select authz.update_credential_password('${randomUUID()}', 'probe-hash')`,
  ],
  [
    'authz.record_password_reset_audit(uuid,inet,text)',
    `select authz.record_password_reset_audit('${randomUUID()}', null, null)`,
  ],
  [
    'public.enqueue_password_reset_email(uuid,text,text)',
    `select public.enqueue_password_reset_email('${randomUUID()}', 's', 'h')`,
  ],
  [
    'authz.check_login_lockout(text)',
    `select authz.check_login_lockout('nobody.${RUN}@example.test')`,
  ],
  [
    'authz.record_login_failure(text,inet,text)',
    `select authz.record_login_failure('nobody.${RUN}@example.test', null, null)`,
  ],
  [
    'authz.clear_login_lockout(text)',
    `select authz.clear_login_lockout('nobody.${RUN}@example.test')`,
  ],
  [
    'authz.mfa_enrollment_required(uuid)',
    `select authz.mfa_enrollment_required('${randomUUID()}')`,
  ],
  ['authz.login_person_active(uuid)', `select authz.login_person_active('${randomUUID()}')`],
  ['authz.stamp_sessions_revoked(uuid)', `select authz.stamp_sessions_revoked('${randomUUID()}')`],
  [
    'public.resolve_login_org(public.citext)',
    `select public.resolve_login_org('nobody.${RUN}@example.test')`,
  ],
  [
    'public.record_login_event(uuid,text,public.citext,uuid,inet,text,jsonb)',
    `select public.record_login_event(null, 'LOGIN_FAILURE', 'nobody.${RUN}@example.test', null, null, null, '{}')`,
  ],
  [
    'public.resolve_auth_identity(uuid,timestamptz)',
    `select * from public.resolve_auth_identity('${randomUUID()}', now())`,
  ],
  ['public.invitation_preview(text)', `select * from public.invitation_preview(repeat('c', 64))`],
  [
    'public.accept_invitation(text,text,text)',
    `select * from public.accept_invitation(repeat('d', 64), 'Probe', 'probe-hash')`,
  ],
  ['public.bootstrap_setup_pending()', `select public.bootstrap_setup_pending()`],
  [
    'public.bootstrap_setup_token_is_valid(bytea)',
    `select public.bootstrap_setup_token_is_valid('\\x00'::bytea)`,
  ],
  [
    'public.complete_bootstrap_setup(bytea,text)',
    `select public.complete_bootstrap_setup('\\x00'::bytea, 'probe-hash')`,
  ],
];

const ADMIN_FNS = [
  'authz.admin_session_action(text,uuid,text,uuid,uuid,inet,text)',
  'authz.admin_issue_credential_reset(text,uuid,text,uuid,inet,text)',
];

describe.skipIf(!READY)(
  'app_auth — the authentication plane’s own login (0072/0073, live DB)',
  () => {
    const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
    const appUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
    const appAuth = new Pool({ connectionString: process.env.DATABASE_URL_AUTH });
    const appWorker = new Pool({ connectionString: process.env.DATABASE_URL_WORKER });

    let orgA = '';
    let orgB = '';
    let admin = ''; // sessions.revoke + users.edit at GLOBAL, no sensitive permission → aal1 is enough
    let adminToken = '';
    let mfaAdmin = ''; // also roles.manage at GLOBAL (sensitive) → needs an aal2 session
    let deptAdmin = ''; // sessions.revoke at DEPARTMENT scope only
    let plain = ''; // no permission at all
    let plainToken = '';
    let foreigner = ''; // a person of orgB, with a login and a session

    /** A role in `org` carrying `perms` at `scope`, held by `person`. */
    const grant = async (
      org: string,
      person: string,
      perms: string[],
      scope = 'GLOBAL',
      actor?: string,
    ) => {
      const c = await owner.connect();
      try {
        await c.query('begin');
        // Granting role management is itself guarded (0021/0027): after an organization's first
        // protected grant, it needs an actor holding roles.manage at GLOBAL scope.
        if (actor) {
          await c.query(
            `select set_config('app.person_id', $1, true), set_config('app.org_id', $2, true)`,
            [actor, org],
          );
        }
        await grantIn(c, org, person, perms, scope);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    };
    const grantIn = async (
      owner: PoolClient,
      org: string,
      person: string,
      perms: string[],
      scope: string,
    ) => {
      const key = `AR_${randomBytes(4).toString('hex').toUpperCase()}`;
      const role = (
        await owner.query<{ id: string }>(
          `insert into public.roles (org_id, key, name) values ($1, $2, $2) returning id`,
          [org, key],
        )
      ).rows[0]!.id;
      for (const p of perms) {
        const r = await owner.query(
          `insert into public.role_permissions (role_id, permission_id, scope)
         select $1, id, $3::public.access_scope from public.permissions where key = $2`,
          [role, p, scope],
        );
        if (r.rowCount !== 1) throw new Error(`unknown permission ${p}`);
      }
      await owner.query(
        `insert into public.person_roles (person_id, role_id, org_id) values ($1, $2, $3)`,
        [person, role, org],
      );
    };

    beforeAll(async () => {
      if (!READY) return;
      orgA = await mkOrg(owner, `appa-a-${RUN}`);
      orgB = await mkOrg(owner, `appa-b-${RUN}`);
      // people.view: an administrator definer acts only on a person the administrator can see
      // under people_select (0074) — the reach the pre-0072 RLS lookup gave. Section E tests it.
      admin = await mkPerson(owner, orgA, `Appa Admin ${RUN}`);
      await grant(orgA, admin, ['sessions.revoke', 'users.edit', 'people.view']);
      adminToken = (await seedSession(owner, admin)).token;
      mfaAdmin = await mkPerson(owner, orgA, `Appa Mfa Admin ${RUN}`);
      await grant(orgA, mfaAdmin, ['sessions.revoke', 'users.edit', 'roles.manage', 'people.view']);
      deptAdmin = await mkPerson(owner, orgA, `Appa Dept Admin ${RUN}`);
      await grant(orgA, deptAdmin, ['sessions.revoke'], 'DEPARTMENT');
      plain = await mkPerson(owner, orgA, `Appa Plain ${RUN}`);
      plainToken = (await seedSession(owner, plain)).token;
      foreigner = await mkPerson(owner, orgB, `Appa Foreigner ${RUN}`);
      await seedSession(owner, foreigner);
    }, 120_000);

    afterAll(async () => {
      await owner.end();
      await appUser.end();
      await appAuth.end();
      await appWorker.end();
    });

    /** Run `sql` on one connection of `pool` with the given settings, always rolled back. */
    async function rolledBack<T extends Record<string, unknown>>(
      pool: Pool,
      ctx: { personId?: string; orgId?: string; aal?: string },
      sql: string,
      params: unknown[] = [],
      extra: Record<string, string> = {},
    ): Promise<T[]> {
      const c: PoolClient = await pool.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true),
                set_config('app.aal',$3,true)`,
          [ctx.personId ?? '', ctx.orgId ?? '', ctx.aal ?? ''],
        );
        for (const [name, value] of Object.entries(extra)) {
          await c.query(`select set_config($1, $2, true)`, [name, value]);
        }
        return (await c.query<T>(sql, params)).rows;
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
    }
    const codeOf = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'ALLOWED';
      } catch (e) {
        return (e as { code?: string }).code ?? 'ERROR';
      }
    };
    const errorOf = async (p: Promise<unknown>) => {
      try {
        await p;
        return null;
      } catch (e) {
        return e as {
          code?: string;
          message: string;
          detail?: string;
          hint?: string;
          where?: string;
        };
      }
    };

    /** Identity settings a raw-SQL caller could forge. */
    const FORGED = () => [
      {},
      { personId: SYSTEM_ACTOR, orgId: orgA },
      { personId: admin, orgId: orgA, aal: 'aal2' },
    ];

    // ═══ A. roles and the privilege matrix ════════════════════════════════════════════
    describe('A. roles and the privilege matrix', () => {
      it('each URL authenticates as its own role; app_auth is a plain login with no membership', async () => {
        const who = async (pool: Pool) =>
          (await pool.query<{ s: string }>(`select session_user::text s`)).rows[0]!.s;
        expect(await who(appUser)).toBe('app_user');
        expect(await who(appAuth)).toBe('app_auth');
        expect(await who(appWorker)).toBe('app_worker');
        const attrs = (
          await owner.query(
            `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
             from pg_roles where rolname = 'app_auth'`,
          )
        ).rows[0];
        expect(attrs).toEqual({
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolcanlogin: true,
        });
        const members = await owner.query<{ n: number }>(
          `select count(*)::int n from pg_auth_members am
           join pg_roles m on m.oid = am.member join pg_roles r on r.oid = am.roleid
          where 'app_auth' in (m.rolname, r.rolname)`,
        );
        expect(members.rows[0]!.n).toBe(0);
      });

      it('nobody becomes app_auth (SET ROLE / SET SESSION AUTHORIZATION), and app_auth becomes nobody', async () => {
        for (const pool of [appUser, appWorker]) {
          expect(await codeOf(rolledBack(pool, {}, `set local role app_auth`))).toBe('42501');
          expect(await codeOf(rolledBack(pool, {}, `set session authorization app_auth`))).toBe(
            '42501',
          );
        }
        for (const role of ['app_user', 'app_worker', 'app_owner']) {
          expect(await codeOf(rolledBack(appAuth, {}, `set local role ${role}`))).toBe('42501');
        }
      });

      it('the credential store belongs to app_auth alone — the exact table matrix', async () => {
        const expected: Record<string, string[]> = {
          'auth.auth_users': ['INSERT', 'SELECT', 'UPDATE'],
        };
        for (const t of AUTH_TABLES) expected[t] ??= ['DELETE', 'INSERT', 'SELECT', 'UPDATE'];
        for (const t of AUTH_TABLES) {
          for (const priv of [
            'SELECT',
            'INSERT',
            'UPDATE',
            'DELETE',
            'TRUNCATE',
            'REFERENCES',
            'TRIGGER',
          ]) {
            const r = (
              await owner.query<{ u: boolean; a: boolean; w: boolean; adm: boolean }>(
                `select has_table_privilege('app_user', $1, $2) u, has_table_privilege('app_auth', $1, $2) a,
                      has_table_privilege('app_worker', $1, $2) w, has_table_privilege('app_admin', $1, $2) adm`,
                [t, priv],
              )
            ).rows[0]!;
            expect({ t, priv, ...r }).toEqual({
              t,
              priv,
              u: false,
              a: expected[t]!.includes(priv),
              w: false,
              adm: false,
            });
          }
        }
        const usage = (
          await owner.query<{ u: boolean; a: boolean; w: boolean; adm: boolean }>(
            `select has_schema_privilege('app_user','auth','usage') u, has_schema_privilege('app_auth','auth','usage') a,
                  has_schema_privilege('app_worker','auth','usage') w, has_schema_privilege('app_admin','auth','usage') adm`,
          )
        ).rows[0];
        expect(usage).toEqual({ u: false, a: true, w: false, adm: false });
      });

      it('the function matrix: pre-login and administrator definers are app_auth’s alone', async () => {
        for (const sig of [...PRELOGIN.map(([s]) => s), ...ADMIN_FNS]) {
          const r = (
            await owner.query<{ u: boolean; a: boolean; w: boolean; adm: boolean; pub: boolean }>(
              `select has_function_privilege('app_user', $1, 'execute') u,
                    has_function_privilege('app_auth', $1, 'execute') a,
                    has_function_privilege('app_worker', $1, 'execute') w,
                    has_function_privilege('app_admin', $1, 'execute') adm,
                    exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                             where x.grantee = 0 and x.privilege_type = 'EXECUTE') pub
               from pg_proc p where p.oid = to_regprocedure($1)`,
              [sig],
            )
          ).rows[0];
          expect({ sig, ...r }).toEqual({
            sig,
            u: false,
            a: true,
            w: false,
            adm: false,
            pub: false,
          });
        }
        // The session-token resolver is callable by nobody but the definers (as the owner).
        for (const role of ['app_user', 'app_auth', 'app_worker', 'app_admin']) {
          const r = await owner.query<{ x: boolean }>(
            `select has_function_privilege($1, 'authz.verified_session_actor(text)', 'execute') x`,
            [role],
          );
          expect(r.rows[0]!.x, role).toBe(false);
        }
        // The business plane keeps authz.aal() (a definer reading the factor tables as the owner).
        const aal = await owner.query<{ x: boolean }>(
          `select has_function_privilege('app_user', 'authz.aal()', 'execute') x`,
        );
        expect(aal.rows[0]!.x).toBe(true);
      });

      it('app_auth holds no privilege on any business table, and cannot read one', async () => {
        const held = await owner.query<{ t: string }>(
          `select c.oid::regclass::text t
           from pg_class c join pg_namespace n on n.oid = c.relnamespace,
                unnest(array['select','insert','update','delete','truncate','references','trigger']) priv
          where n.nspname in ('public', 'authz') and c.relkind in ('r','p','v','m','f')
            and has_table_privilege('app_auth', c.oid, priv)`,
        );
        expect(held.rows).toEqual([]);
        for (const sql of [
          `select count(*) from public.people`,
          `select count(*) from public.audit_logs`,
          `select count(*) from public.jobs`,
        ]) {
          expect(
            await codeOf(rolledBack(appAuth, { personId: admin, orgId: orgA }, sql)),
            sql,
          ).toBe('42501');
        }
      });
    });

    // ═══ B. direct access to the credential store ═════════════════════════════════════
    describe('B. direct access to the credential store', () => {
      let login = '';
      beforeAll(async () => {
        if (!READY) return;
        login = (await seedSession(owner, plain)).authUserId;
        await owner.query(
          `insert into auth.auth_accounts (account_id, provider_id, user_id, password)
         select $1, 'credential', $2::uuid, 'scrypt:probe-hash'
         where not exists (select 1 from auth.auth_accounts where user_id = $2::uuid)`,
          [login, login],
        );
      }, 60_000);

      const statements = (t: string) => [
        `select count(*) from ${t}`,
        `delete from ${t} where false`,
        `update ${t} set ${t === 'auth.auth_rate_limits' ? 'count' : 'id'} = ${t === 'auth.auth_rate_limits' ? 'count' : 'id'} where false`,
      ];

      it.each(AUTH_TABLES)(
        'app_user is refused on %s — with no identity and with forged settings',
        async (t) => {
          for (const ctx of FORGED()) {
            for (const sql of statements(t)) {
              expect(
                await codeOf(rolledBack(appUser, ctx, sql)),
                `${sql} ${JSON.stringify(ctx)}`,
              ).toBe('42501');
            }
          }
        },
      );

      it('app_user can read no password hash, overwrite no password, mint no session, read no second factor', async () => {
        const forged = { personId: admin, orgId: orgA, aal: 'aal2' };
        const attempts = [
          [`select password from auth.auth_accounts where user_id = $1`, [login]],
          [`update auth.auth_accounts set password = 'attacker' where user_id = $1`, [login]],
          [
            `insert into auth.auth_sessions (user_id, token, expires_at) values ($1, $2, now() + interval '1 day')`,
            [login, randomBytes(24).toString('hex')],
          ],
          [`select token from auth.auth_sessions where user_id = $1`, [login]],
          [`select secret, backup_codes from auth.auth_two_factors`, []],
          [`update auth.auth_users set two_factor_enabled = false where id = $1`, [login]],
          [`select value from auth.auth_verifications`, []],
          [`delete from auth.auth_rate_limits`, []],
          [`select email from auth.auth_users`, []],
        ] as const;
        for (const [sql, params] of attempts) {
          expect(await codeOf(rolledBack(appUser, forged, sql, [...params])), sql).toBe('42501');
        }
        // Unchanged.
        const pw = await owner.query<{ password: string }>(
          `select password from auth.auth_accounts where user_id = $1`,
          [login],
        );
        expect(pw.rows[0]!.password).not.toBe('attacker');
      });

      it('app_auth can do what Better Auth does there (positive control, rolled back)', async () => {
        const t = randomBytes(24).toString('hex');
        const ok = [
          `select count(*) from auth.auth_users`,
          `update auth.auth_users set updated_at = now() where id = '${login}'`,
          `select password from auth.auth_accounts where user_id = '${login}'`,
          `update auth.auth_accounts set updated_at = now() where user_id = '${login}'`,
          `insert into auth.auth_sessions (user_id, token, expires_at) values ('${login}', '${t}', now() + interval '1 day')`,
          `delete from auth.auth_sessions where token = '${t}'`,
          `select count(*) from auth.auth_two_factors`,
          `insert into auth.auth_verifications (identifier, value, expires_at) values ('probe-${RUN}', 'v', now() + interval '1 minute')`,
          `select count(*) from auth.auth_rate_limits`,
        ];
        for (const sql of ok)
          expect(await codeOf(rolledBack(appAuth, {}, sql)), sql).toBe('ALLOWED');
        // ...and still cannot delete a login.
        expect(
          await codeOf(rolledBack(appAuth, {}, `delete from auth.auth_users where false`)),
        ).toBe('42501');
      });
    });

    // ═══ C. the pre-login functions ═══════════════════════════════════════════════════
    describe('C. the pre-login functions', () => {
      it.each(PRELOGIN)(
        '%s refuses app_user (no identity, system actor, forged administrator)',
        async (_sig, sql) => {
          for (const ctx of FORGED()) {
            expect(await codeOf(rolledBack(appUser, ctx, sql)), JSON.stringify(ctx)).toBe('42501');
          }
          expect(await codeOf(rolledBack(appWorker, {}, sql))).toBe('42501');
        },
      );

      it.each(PRELOGIN)(
        '%s answers app_auth (positive control: privilege granted, body reached)',
        async (_sig, sql) => {
          // Any outcome but a privilege refusal: these probes may legitimately be refused by the
          // function body itself (unknown token → 28000, no credential account → 55000, …).
          expect(await codeOf(rolledBack(appAuth, {}, sql))).not.toBe('42501');
        },
      );

      it('app_auth reaches no business, worker or internal function', async () => {
        for (const sql of [
          `select public.set_person_roles('${admin}'::uuid, array[]::uuid[])`,
          `select public.write_audit_log(p_action := 'x.y', p_entity_type := 'person')`,
          `select authz.next_identity_code_for_current_org('EMP', '2026')`,
          `select public.jobs_claim_next('probe', array['cleanup'])`,
          `select * from public.run_data_retention(1)`,
          `select * from public.jobs_run_cleanup('${randomUUID()}', 'probe')`,
          `select * from authz.verified_session_actor('${randomBytes(24).toString('hex')}')`,
        ]) {
          expect(
            await codeOf(rolledBack(appAuth, { personId: admin, orgId: orgA }, sql)),
            sql,
          ).toBe('42501');
        }
      });
    });

    // ═══ D. administrator actions proven by the administrator's own session ═══════════
    describe('D. administrator session actions (authz.admin_session_action)', () => {
      let target = ''; // orgA person with a login and sessions
      let targetLogin = '';

      const action = (
        pool: Pool,
        token: string,
        person: string,
        act: string,
        sessionId: string | null = null,
        ctx: { personId?: string; orgId?: string; aal?: string } = {},
      ) =>
        rolledBackCommit(
          pool,
          ctx,
          `select session_id, created_at, expires_at, ip_address, user_agent, affected
           from authz.admin_session_action($1, $2::uuid, $3, $4::uuid, $5::uuid, null, 'vitest')`,
          [token, person, act, sessionId, randomUUID()],
        );

      /** Like rolledBack, but COMMITS: the definer's work must persist to be observed. */
      async function rolledBackCommit<T extends Record<string, unknown>>(
        pool: Pool,
        ctx: { personId?: string; orgId?: string; aal?: string },
        sql: string,
        params: unknown[],
      ): Promise<T[]> {
        const c = await pool.connect();
        try {
          await c.query('begin');
          await c.query(
            `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true),
                  set_config('app.aal',$3,true)`,
            [ctx.personId ?? '', ctx.orgId ?? '', ctx.aal ?? ''],
          );
          const r = await c.query<T>(sql, params);
          await c.query('commit');
          return r.rows;
        } catch (e) {
          await c.query('rollback').catch(() => undefined);
          throw e;
        } finally {
          c.release();
        }
      }

      const sessionsOf = async (loginId: string) =>
        (
          await owner.query<{ id: string }>(
            `select id from auth.auth_sessions where user_id = $1 order by id`,
            [loginId],
          )
        ).rows.map((r) => r.id);
      const auditCount = async (entity: string) =>
        Number(
          (
            await owner.query<{ n: string }>(
              `select count(*)::text n from public.audit_logs where org_id = $1 and entity_id = $2`,
              [orgA, entity],
            )
          ).rows[0]!.n,
        );

      beforeAll(async () => {
        if (!READY) return;
        target = await mkPerson(owner, orgA, `Appa Target ${RUN}`);
        targetLogin = (await seedSession(owner, target)).authUserId;
        await seedSession(owner, target);
      }, 60_000);

      it('lists a same-organization person’s live sessions — and never a token', async () => {
        const rows = await action(appAuth, adminToken, target, 'list');
        expect(rows.length).toBeGreaterThanOrEqual(2);
        for (const r of rows) {
          expect(Object.keys(r).sort()).toEqual(
            [
              'affected',
              'created_at',
              'expires_at',
              'ip_address',
              'session_id',
              'user_agent',
            ].sort(),
          );
          expect(r.affected).toBeNull();
        }
        const tokens = (
          await owner.query<{ token: string }>(
            `select token from auth.auth_sessions where user_id = $1`,
            [targetLogin],
          )
        ).rows.map((r) => r.token);
        const serialized = JSON.stringify(rows);
        for (const t of tokens) expect(serialized.includes(t)).toBe(false);
      });

      it('revokes one session and audits it in the same transaction, attributed to the verified administrator', async () => {
        const { sessionId } = await seedSession(owner, target);
        const before = await auditCount(target);
        const rows = await action(appAuth, adminToken, target, 'revoke_one', sessionId);
        expect(rows[0]!.affected).toBe(1);
        expect(await sessionsOf(targetLogin)).not.toContain(sessionId);
        expect(await auditCount(target)).toBe(before + 1);
        const entry = (
          await owner.query<{
            action: string;
            actor_person_id: string;
            metadata: Record<string, unknown>;
          }>(
            `select action, actor_person_id, metadata from public.audit_logs
            where org_id = $1 and entity_id = $2 order by occurred_at desc limit 1`,
            [orgA, target],
          )
        ).rows[0]!;
        expect(entry).toMatchObject({ action: 'session.revoked', actor_person_id: admin });
        expect(entry.metadata).toMatchObject({
          scope: 'one',
          sessions_revoked: 1,
          session_id: sessionId,
        });
      });

      it('revokes all sessions, stamps the revocation, writes one entry and no duplicate people-audit', async () => {
        const victim = await mkPerson(owner, orgA, `Appa Victim ${RUN}`);
        const s1 = await seedSession(owner, victim);
        await seedSession(owner, victim);
        const before = await owner.query<{ n: string }>(
          `select count(*)::text n from public.audit_logs where org_id = $1 and entity_id = $2`,
          [orgA, victim],
        );
        const rows = await action(appAuth, adminToken, victim, 'revoke_all');
        expect(rows[0]!.affected).toBe(2);
        expect(await sessionsOf(s1.authUserId)).toEqual([]);
        const stamped = await owner.query<{ s: boolean }>(
          `select sessions_revoked_at is not null s from public.people where id = $1`,
          [victim],
        );
        expect(stamped.rows[0]!.s).toBe(true);
        const after = await owner.query<{ action: string }>(
          `select action from public.audit_logs where org_id = $1 and entity_id = $2 order by occurred_at`,
          [orgA, victim],
        );
        expect(after.rows.length - Number(before.rows[0]!.n)).toBe(1);
        expect(after.rows.at(-1)!.action).toBe('session.revoked_all');
      });

      // ── forged identity ──────────────────────────────────────────────────────────
      it('app_user cannot execute it — not even with the administrator’s settings', async () => {
        for (const ctx of FORGED()) {
          expect(await codeOf(action(appUser, adminToken, target, 'list', null, ctx))).toBe(
            '42501',
          );
        }
      });

      it('a valid NON-administrator token with forged administrator settings is refused, and changes nothing', async () => {
        const sessions = await sessionsOf(targetLogin);
        const audits = await auditCount(target);
        for (const act of ['list', 'revoke_all']) {
          const e = await errorOf(
            action(appAuth, plainToken, target, act, null, {
              personId: admin,
              orgId: orgA,
              aal: 'aal2',
            }),
          );
          expect(e?.code, act).toBe('42501');
        }
        expect(await sessionsOf(targetLogin)).toEqual(sessions);
        expect(await auditCount(target)).toBe(audits);
      });

      it('refuses unknown, expired and revoked sessions, and suspended, deleted or disengaged administrators', async () => {
        const refused = async (token: string) =>
          (await errorOf(action(appAuth, token, target, 'list')))?.code;
        expect(await refused(randomBytes(24).toString('hex'))).toBe('28000');
        expect(await refused('')).toBe('28000');
        const ex = await mkPerson(owner, orgA, `Appa Expired ${RUN}`);
        await grant(orgA, ex, ['sessions.revoke']);
        expect(await refused((await seedSession(owner, ex, { expired: true })).token)).toBe(
          '28000',
        );

        const rv = await mkPerson(owner, orgA, `Appa Revoked ${RUN}`);
        await grant(orgA, rv, ['sessions.revoke', 'people.view']);
        const rvTok = (await seedSession(owner, rv, { createdSecondsAgo: 120 })).token;
        expect(await refused(rvTok)).toBeUndefined(); // live: accepted
        await owner.query(`update public.people set sessions_revoked_at = now() where id = $1`, [
          rv,
        ]);
        expect(await refused(rvTok)).toBe('28000');

        const su = await mkPerson(owner, orgA, `Appa Suspended ${RUN}`);
        await grant(orgA, su, ['sessions.revoke']);
        const suTok = (await seedSession(owner, su)).token;
        await owner.query(`update public.people set person_status = 'INACTIVE' where id = $1`, [
          su,
        ]);
        expect(await refused(suTok)).toBe('28000');

        const de = await mkPerson(owner, orgA, `Appa Deleted ${RUN}`);
        await grant(orgA, de, ['sessions.revoke']);
        const deTok = (await seedSession(owner, de)).token;
        await owner.query(`update public.people set deleted_at = now() where id = $1`, [de]);
        expect(await refused(deTok)).toBe('28000');

        const di = await mkPerson(owner, orgA, `Appa Disengaged ${RUN}`);
        await grant(orgA, di, ['sessions.revoke']);
        const diTok = (await seedSession(owner, di)).token;
        {
          // An engagement transition needs an authenticated actor in the transaction (0016).
          const c = await owner.connect();
          try {
            await c.query('begin');
            await c.query(
              `select set_config('app.person_id', $1, true), set_config('app.org_id', $2, true)`,
              [mfaAdmin, orgA],
            );
            await c.query(
              `update public.engagements set status = 'SUSPENDED' where person_id = $1`,
              [di],
            );
            await c.query('commit');
          } catch (e) {
            await c.query('rollback').catch(() => undefined);
            throw e;
          } finally {
            c.release();
          }
        }
        expect(await refused(diTok)).toBe('42501');
      });

      it('refuses an administrator of a suspended organization', async () => {
        const orgS = await mkOrg(owner, `appa-s-${RUN}`);
        const sa = await mkPerson(owner, orgS, `Appa Org Suspended ${RUN}`);
        await grant(orgS, sa, ['sessions.revoke', 'people.view']);
        const tok = (await seedSession(owner, sa)).token;
        const victim = await mkPerson(owner, orgS, `Appa S Victim ${RUN}`);
        await seedSession(owner, victim);
        expect(await errorOf(action(appAuth, tok, victim, 'list'))).toBeNull();
        await owner.query(`update public.organizations set status = 'SUSPENDED' where id = $1`, [
          orgS,
        ]);
        expect((await errorOf(action(appAuth, tok, victim, 'list')))?.code).toBe('42501');
      });

      // ── authority ────────────────────────────────────────────────────────────────
      it('refuses DEPARTMENT scope and a missing permission', async () => {
        const deptTok = (await seedSession(owner, deptAdmin)).token;
        expect((await errorOf(action(appAuth, deptTok, target, 'list')))?.code).toBe('42501');
        expect((await errorOf(action(appAuth, plainToken, target, 'list')))?.code).toBe('42501');
      });

      it('applies the MFA rule from the session row: aal1 refused, aal2 claim without a verified factor refused, aal2 allowed', async () => {
        const aal1 = (await seedSession(owner, mfaAdmin)).token;
        expect((await errorOf(action(appAuth, aal1, target, 'list')))?.code).toBe('42501');
        // An aal2 claim on the session row while no verified second factor exists.
        const claimOnly = (await seedSession(owner, mfaAdmin)).token;
        await owner.query(`update auth.auth_sessions set aal = 'aal2' where token = $1`, [
          claimOnly,
        ]);
        expect((await errorOf(action(appAuth, claimOnly, target, 'list')))?.code).toBe('42501');
        // A verified factor and an aal2 session: allowed.
        const aal2 = (await seedSession(owner, mfaAdmin, { aal2: true })).token;
        expect(await errorOf(action(appAuth, aal2, target, 'list'))).toBeNull();
      });

      // ── tenant isolation ─────────────────────────────────────────────────────────
      it('a foreign target and a missing target are refused identically; nothing changes', async () => {
        const foreignLogin = (
          await owner.query<{ auth_user_id: string }>(
            `select auth_user_id from public.people where id = $1`,
            [foreigner],
          )
        ).rows[0]!.auth_user_id;
        const before = await sessionsOf(foreignLogin);
        const foreignErr = await errorOf(action(appAuth, adminToken, foreigner, 'revoke_all'));
        const missingErr = await errorOf(action(appAuth, adminToken, randomUUID(), 'revoke_all'));
        expect(foreignErr?.code).toBe('42501');
        expect(missingErr?.code).toBe('42501');
        expect(foreignErr?.message).toBe(missingErr?.message);
        expect(await sessionsOf(foreignLogin)).toEqual(before);
      });

      it('refuses a session id of another login, and a soft-deleted target', async () => {
        const other = await seedSession(owner, plain);
        const err = await errorOf(
          action(appAuth, adminToken, target, 'revoke_one', other.sessionId),
        );
        expect(err?.code).toBe('22023');
        expect(await sessionsOf(other.authUserId)).toContain(other.sessionId);
        const gone = await mkPerson(owner, orgA, `Appa Gone ${RUN}`);
        await seedSession(owner, gone);
        await owner.query(`update public.people set deleted_at = now() where id = $1`, [gone]);
        expect((await errorOf(action(appAuth, adminToken, gone, 'list')))?.code).toBe('42501');
      });

      // ── atomicity ────────────────────────────────────────────────────────────────
      it('rolls the deletion back when the audit entry cannot be written', async () => {
        const victim = await mkPerson(owner, orgA, `Appa Atomic ${RUN}`);
        const s = await seedSession(owner, victim);
        // A refusal on audit insert for this one person only, so no other suite is affected.
        const fn = `appa_refuse_${RUN}`;
        const trg = `appa_refuse_trg_${RUN}`;
        await owner.query(
          `create function public.${fn}() returns trigger language plpgsql as $f$
         begin
           if new.entity_id = '${victim}'::uuid then
             raise exception 'audit refused for this test' using errcode = 'P0001';
           end if;
           return new;
         end $f$`,
        );
        await owner.query(
          `create trigger ${trg} before insert on public.audit_logs for each row execute function public.${fn}()`,
        );
        try {
          const err = await errorOf(action(appAuth, adminToken, victim, 'revoke_all'));
          expect(err?.code).toBe('P0001');
        } finally {
          await owner.query(`drop trigger if exists ${trg} on public.audit_logs`);
          await owner.query(`drop function if exists public.${fn}()`);
        }
        expect(await sessionsOf(s.authUserId)).toEqual([s.sessionId]);
        const stamped = await owner.query<{ s: boolean }>(
          `select sessions_revoked_at is not null s from public.people where id = $1`,
          [victim],
        );
        expect(stamped.rows[0]!.s).toBe(false);
      });

      // ── workflows and the worker ─────────────────────────────────────────────────
      it('workflow execution identities cannot reach it: app_worker, and app_user carrying a workflow principal', async () => {
        expect(await codeOf(action(appWorker, adminToken, target, 'list'))).toBe('42501');
        // Exactly how src/lib/jobs/workflow-jobs.ts runs an action: app_user with the resolved
        // principal (here even an administrator) and organization set, and no session.
        const c = await appUser.connect();
        try {
          await c.query('begin');
          await c.query(
            `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true),
                  set_config('app.aal','aal1',true), set_config('app.work_kind','job',true),
                  set_config('app.work_id',$3,true), set_config('app.worker_id','wf',true)`,
            [admin, orgA, randomUUID()],
          );
          expect(
            await codeOf(
              c.query(`select * from authz.admin_session_action($1, $2::uuid, 'list')`, [
                adminToken,
                target,
              ]),
            ),
          ).toBe('42501');
        } finally {
          await c.query('rollback').catch(() => undefined);
          c.release();
        }
      });

      // ── token confidentiality ────────────────────────────────────────────────────
      it('never echoes the token: not in database errors, not in the audit entry', async () => {
        const bogus = `bogus-${randomBytes(20).toString('hex')}`;
        const err = await errorOf(action(appAuth, bogus, target, 'revoke_all'));
        expect(err?.code).toBe('28000');
        const text = [err?.message, err?.detail, err?.hint, err?.where].join(' ');
        expect(text.includes(bogus)).toBe(false);
        // A real token, refused for lack of authority, is not echoed either.
        const e2 = await errorOf(action(appAuth, plainToken, target, 'revoke_all'));
        expect([e2?.message, e2?.detail, e2?.hint, e2?.where].join(' ').includes(plainToken)).toBe(
          false,
        );
        // And no audit entry anywhere carries the administrator's token.
        const leaked = await owner.query<{ n: string }>(
          `select count(*)::text n from public.audit_logs where org_id = $1 and (metadata::text like '%' || $2 || '%')`,
          [orgA, adminToken],
        );
        expect(leaked.rows[0]!.n).toBe('0');
      });

      it('the application layer replaces every failure with a fixed message: no token, no query, no chained cause', async () => {
        const { listSessionsAsAdmin, revokeSessionsAsAdmin } =
          await import('@/lib/auth/admin-credentials');
        const spies = (['error', 'warn', 'log', 'info'] as const).map((m) =>
          vi.spyOn(console, m).mockImplementation(() => undefined),
        );
        const bogus = `bogus-${randomBytes(20).toString('hex')}`;
        try {
          for (const [tok, run] of [
            [
              bogus,
              () =>
                listSessionsAsAdmin(bogus, target, { requestId: null, ip: null, userAgent: null }),
            ],
            [
              plainToken,
              () =>
                revokeSessionsAsAdmin(plainToken, target, null, {
                  requestId: null,
                  ip: null,
                  userAgent: null,
                }),
            ],
          ] as const) {
            const e = (await errorOf(run())) as unknown as Error & {
              cause?: unknown;
              code?: string;
            };
            expect(e).not.toBeNull();
            expect(e.name).toBe('AdminAuthActionError');
            expect(e.cause).toBeUndefined();
            const everything = `${e.message} ${String(e.stack)} ${JSON.stringify(e)}`;
            expect(everything.includes(tok)).toBe(false);
            expect(everything).not.toMatch(/admin_session_action\(/);
          }
          for (const spy of spies) {
            for (const call of spy.mock.calls) {
              const line = call
                .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
                .join(' ');
              expect(line.includes(bogus) || line.includes(plainToken)).toBe(false);
            }
          }
        } finally {
          for (const spy of spies) spy.mockRestore();
        }
      });
    });

    // ═══ D12. administrator credential reset proven by the administrator's session ═════
    describe('D12. administrator credential reset (authz.admin_issue_credential_reset)', () => {
      const digest = () => createHash('sha256').update(randomBytes(32)).digest('hex');
      const issue = (
        pool: Pool,
        token: string,
        person: string,
        ctx: { personId?: string; orgId?: string; aal?: string } = {},
        hash = digest(),
      ) => rolledBackCommitIssue(pool, ctx, token, person, hash);

      async function rolledBackCommitIssue(
        pool: Pool,
        ctx: { personId?: string; orgId?: string; aal?: string },
        token: string,
        person: string,
        hash: string,
      ) {
        const c = await pool.connect();
        try {
          await c.query('begin');
          await c.query(
            `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true),
                  set_config('app.aal',$3,true)`,
            [ctx.personId ?? '', ctx.orgId ?? '', ctx.aal ?? ''],
          );
          const r = await c.query<{
            outcome: string;
            reset_id: string | null;
            login_email: string | null;
          }>(
            `select outcome, reset_id, login_email
             from authz.admin_issue_credential_reset($1, $2::uuid, $3, $4::uuid, null, 'vitest')`,
            [token, person, hash, randomUUID()],
          );
          await c.query('commit');
          return r.rows[0]!;
        } catch (e) {
          await c.query('rollback').catch(() => undefined);
          throw e;
        } finally {
          c.release();
        }
      }

      let target = '';
      let protectedTarget = '';
      beforeAll(async () => {
        if (!READY) return;
        target = await mkPerson(owner, orgA, `Appa Reset Target ${RUN}`);
        await seedSession(owner, target);
        protectedTarget = await mkPerson(owner, orgA, `Appa Protected ${RUN}`);
        await grant(orgA, protectedTarget, ['roles.manage'], 'GLOBAL', mfaAdmin);
        await seedSession(owner, protectedTarget);
      }, 60_000);

      it('issues a reset for the target’s own login: digest stored, single use, one hour', async () => {
        const hash = digest();
        const r = await issue(appAuth, adminToken, target, {}, hash);
        expect(r.outcome).toBe('ISSUED');
        const row = (
          await owner.query<{
            token_hash: string;
            used_at: string | null;
            ttl: number;
            email: string;
          }>(
            `select r.token_hash, r.used_at, extract(epoch from r.expires_at - now())::int ttl, u.email::text email
             from auth.password_resets r join auth.auth_users u on u.id = r.auth_user_id
            where r.id = $1`,
            [r.reset_id],
          )
        ).rows[0]!;
        expect(row.token_hash).toBe(hash);
        expect(row.used_at).toBeNull();
        expect(row.ttl).toBeGreaterThan(3500);
        expect(row.ttl).toBeLessThanOrEqual(3600);
        expect(r.login_email).toBe(row.email);
      });

      it('refuses a protected target for an administrator without roles.manage at GLOBAL — DENIED, audited, committed', async () => {
        const before = await owner.query<{ n: string }>(
          `select count(*)::text n from public.audit_logs where entity_id = $1 and result = 'DENIED'`,
          [protectedTarget],
        );
        const r = await issue(appAuth, adminToken, protectedTarget);
        expect(r).toEqual({ outcome: 'DENIED', reset_id: null, login_email: null });
        const after = await owner.query<{ n: string; actor: string }>(
          `select count(*)::text n, max(actor_person_id::text) actor from public.audit_logs
          where entity_id = $1 and result = 'DENIED'`,
          [protectedTarget],
        );
        expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n) + 1);
        expect(after.rows[0]!.actor).toBe(admin);
      });

      it('lets an administrator holding roles.manage at GLOBAL (with a verified second factor) reset a protected target', async () => {
        const tok = (await seedSession(owner, mfaAdmin, { aal2: true })).token;
        expect((await issue(appAuth, tok, protectedTarget)).outcome).toBe('ISSUED');
      });

      it('refuses forged settings, other tenants, the business role and bad digests', async () => {
        // A valid non-administrator token, with the administrator's identity forged.
        expect(
          (
            await errorOf(
              issue(appAuth, plainToken, target, { personId: admin, orgId: orgA, aal: 'aal2' }),
            )
          )?.code,
        ).toBe('42501');
        // Another tenant's person, and nobody.
        const f = await errorOf(issue(appAuth, adminToken, foreigner));
        const m = await errorOf(issue(appAuth, adminToken, randomUUID()));
        expect(f?.code).toBe('42501');
        expect(f?.message).toBe(m?.message);
        // The business role, even with the administrator's settings.
        expect(
          await codeOf(
            issue(appUser, adminToken, target, { personId: admin, orgId: orgA, aal: 'aal2' }),
          ),
        ).toBe('42501');
        // A digest that is not a sha-256 hex value.
        expect((await errorOf(issue(appAuth, adminToken, target, {}, 'not-a-digest')))?.code).toBe(
          '22023',
        );
        // The MFA rule: the roles.manage holder on an aal1 session.
        const aal1 = (await seedSession(owner, mfaAdmin)).token;
        expect((await errorOf(issue(appAuth, aal1, target)))?.code).toBe('42501');
      });
    });

    // ═══ E. target visibility: people.view, as people_select (0074; audit H1 / M1) ═══════
    //
    // Before 0072 both operations found the target on app_user under RLS, so a person outside
    // the administrator's people.view reach was "Person not found." 0072's definers looked the
    // target up as the owner and lost that. These cases pin the restored rule, on its own
    // organization with two departments, a manager chain and a record grant.
    describe('E. target visibility (people.view, as people_select)', () => {
      let orgV = '';
      let deptA = '';
      let deptB = '';
      let globalAdmin = ''; // users.edit, sessions.revoke, people.view, roles.manage: GLOBAL
      let globalTok = '';
      let deptResetter = ''; // deptA; users.edit + people.view DEPARTMENT; sessions.revoke GLOBAL
      let deptTok = '';
      let teamLead = ''; // deptA; users.edit + people.view TEAM; sessions.revoke GLOBAL
      let teamTok = '';
      let selfOnly = ''; // deptA; users.edit + people.view SELF; sessions.revoke GLOBAL
      let grantee = ''; // deptA; users.edit + sessions.revoke GLOBAL, no people.view; one record grant
      let granteeTok = '';
      let noView = ''; // deptA; users.edit + sessions.revoke GLOBAL, no people.view at all
      let inScope = ''; // deptA
      let outScope = ''; // deptB
      let report = ''; // deptB, reports to teamLead
      let granted = ''; // deptB, the subject of grantee's record grant
      let protectedIn = ''; // deptA, holds a protected role
      let protectedOut = ''; // deptB, holds a protected role
      let deleted = ''; // deptA, soft-deleted
      const IP = '203.0.113.77';
      const UA = `ua-visibility-probe-${RUN}`;

      /** A person in `dept` of orgV, with a live engagement (and `manager` when given). */
      const personIn = async (name: string, dept: string, manager: string | null = null) => {
        const id = await mkPerson(owner, orgV, `${name} ${RUN}`);
        // mkPerson gives each person a department of their own; move the engagement into
        // the department this case needs — owner, before any actor exists for this person.
        await owner.query(
          `update public.engagements set department_id = $2, manager_person_id = $3 where person_id = $1`,
          [id, dept, manager],
        );
        return id;
      };
      const mkDept = async (code: string) =>
        (
          await owner.query<{ id: string }>(
            `insert into public.departments (org_id, code, name) values ($1, $2, $2) returning id`,
            [orgV, `${code}${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`],
          )
        ).rows[0]!.id;

      const issueAs = async (
        token: string,
        person: string,
        ctx: { personId?: string; orgId?: string; aal?: string } = {},
      ) => {
        const c = await appAuth.connect();
        try {
          await c.query('begin');
          await c.query(
            `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true),
                  set_config('app.aal',$3,true)`,
            [ctx.personId ?? '', ctx.orgId ?? '', ctx.aal ?? ''],
          );
          const r = await c.query<{ outcome: string; reset_id: string | null }>(
            `select outcome, reset_id from authz.admin_issue_credential_reset(
               $1, $2::uuid, $3, $4::uuid, null, 'vitest')`,
            [
              token,
              person,
              createHash('sha256').update(randomBytes(32)).digest('hex'),
              randomUUID(),
            ],
          );
          await c.query('commit');
          return r.rows[0]!;
        } catch (e) {
          await c.query('rollback').catch(() => undefined);
          throw e;
        } finally {
          c.release();
        }
      };
      const sessionAs = async (
        token: string,
        person: string,
        act: string,
        sessionId: string | null = null,
        ctx: { personId?: string; orgId?: string; aal?: string } = {},
      ) => {
        const c = await appAuth.connect();
        try {
          await c.query('begin');
          await c.query(
            `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true),
                  set_config('app.aal',$3,true)`,
            [ctx.personId ?? '', ctx.orgId ?? '', ctx.aal ?? ''],
          );
          const r = await c.query<Record<string, unknown>>(
            `select * from authz.admin_session_action($1, $2::uuid, $3, $4::uuid, $5::uuid, null, 'vitest')`,
            [token, person, act, sessionId, randomUUID()],
          );
          await c.query('commit');
          return r.rows;
        } catch (e) {
          await c.query('rollback').catch(() => undefined);
          throw e;
        } finally {
          c.release();
        }
      };

      const loginOf = async (person: string) =>
        (
          await owner.query<{ auth_user_id: string }>(
            `select auth_user_id from public.people where id = $1`,
            [person],
          )
        ).rows[0]!.auth_user_id;
      /** Everything an out-of-reach attempt must leave untouched, for one target. */
      const footprint = async (person: string) => {
        const login = await loginOf(person);
        const r = await owner.query<{
          resets: string;
          sessions: string;
          stamped: boolean;
          audits: string;
        }>(
          `select
             (select count(*) from auth.password_resets where auth_user_id = $1)::text resets,
             (select string_agg(id::text, ',' order by id) from auth.auth_sessions where user_id = $1) sessions,
             (select sessions_revoked_at is not null from public.people where id = $2) stamped,
             (select count(*) from public.audit_logs where entity_id = $2)::text audits`,
          [login, person],
        );
        return r.rows[0]!;
      };

      beforeAll(async () => {
        if (!READY) return;
        orgV = await mkOrg(owner, `appa-v-${RUN}`);
        deptA = await mkDept('VA');
        deptB = await mkDept('VB');

        // The organization's first protected grant needs no actor; later ones are made by it.
        globalAdmin = await personIn('Vis Global', deptA);
        await grant(orgV, globalAdmin, [
          'users.edit',
          'sessions.revoke',
          'people.view',
          'roles.manage',
        ]);
        globalTok = (await seedSession(owner, globalAdmin, { aal2: true })).token;

        deptResetter = await personIn('Vis Dept', deptA);
        await grant(orgV, deptResetter, ['users.edit', 'people.view'], 'DEPARTMENT');
        await grant(orgV, deptResetter, ['sessions.revoke'], 'GLOBAL');
        deptTok = (await seedSession(owner, deptResetter)).token;

        teamLead = await personIn('Vis Team', deptA);
        await grant(orgV, teamLead, ['users.edit', 'people.view'], 'TEAM');
        await grant(orgV, teamLead, ['sessions.revoke'], 'GLOBAL');
        teamTok = (await seedSession(owner, teamLead)).token;

        selfOnly = await personIn('Vis Self', deptA);
        await grant(orgV, selfOnly, ['users.edit', 'people.view'], 'SELF');
        await grant(orgV, selfOnly, ['sessions.revoke'], 'GLOBAL');

        grantee = await personIn('Vis Grantee', deptA);
        await grant(orgV, grantee, ['users.edit', 'sessions.revoke'], 'GLOBAL');
        granteeTok = (await seedSession(owner, grantee)).token;

        noView = await personIn('Vis No View', deptA);
        await grant(orgV, noView, ['users.edit', 'sessions.revoke'], 'GLOBAL');

        inScope = await personIn('Vis In', deptA);
        outScope = await personIn('Vis Out', deptB);
        report = await personIn('Vis Report', deptB, teamLead);
        granted = await personIn('Vis Granted', deptB);
        protectedIn = await personIn('Vis Protected In', deptA);
        protectedOut = await personIn('Vis Protected Out', deptB);
        await grant(orgV, protectedIn, ['roles.manage'], 'GLOBAL', globalAdmin);
        await grant(orgV, protectedOut, ['roles.manage'], 'GLOBAL', globalAdmin);
        deleted = await personIn('Vis Deleted', deptA);

        for (const p of [inScope, outScope, report, granted, protectedIn, protectedOut, deleted]) {
          await seedSession(owner, p);
          await seedSession(owner, p);
        }
        // Distinctive session details: an out-of-reach refusal must not carry them anywhere.
        await owner.query(
          `update auth.auth_sessions set ip_address = $2, user_agent = $3
            where user_id = (select auth_user_id from public.people where id = $1)`,
          [outScope, IP, UA],
        );
        await owner.query(
          `insert into public.record_grants
             (org_id, entity_type, entity_id, person_id, permission_id, granted_by, reason)
           select $1, 'person', $2, $3, p.id, $4, 'visibility test'
           from public.permissions p where p.key = 'people.view'`,
          [orgV, granted, grantee, globalAdmin],
        );
        await owner.query(`update public.people set deleted_at = now() where id = $1`, [deleted]);
      }, 180_000);

      // ── the helper is the policy ─────────────────────────────────────────────────
      it('authz.person_visible agrees with people_select row for row: every scope, a record grant, self, a deleted person, another tenant, a forged tenant claim', async () => {
        const targets = [
          globalAdmin,
          deptResetter,
          teamLead,
          selfOnly,
          grantee,
          noView,
          inScope,
          outScope,
          report,
          granted,
          protectedIn,
          protectedOut,
          deleted,
          foreigner,
        ];
        const viewers: { name: string; personId: string; orgId: string }[] = [
          { name: 'GLOBAL', personId: globalAdmin, orgId: orgV },
          { name: 'DEPARTMENT', personId: deptResetter, orgId: orgV },
          { name: 'TEAM', personId: teamLead, orgId: orgV },
          { name: 'SELF', personId: selfOnly, orgId: orgV },
          { name: 'record grant', personId: grantee, orgId: orgV },
          { name: 'no people.view', personId: noView, orgId: orgV },
          { name: 'forged tenant', personId: globalAdmin, orgId: orgB },
          { name: 'no identity', personId: '', orgId: '' },
        ];
        let compared = 0;
        for (const v of viewers) {
          const ctx = { personId: v.personId, orgId: v.orgId };
          const policy = new Set(
            (
              await rolledBack<{ id: string }>(
                appUser,
                ctx,
                `select id from public.people where id = any($1::uuid[])`,
                [targets],
              )
            ).map((r) => r.id),
          );
          const helper = await rolledBack<{ id: string; visible: boolean }>(
            owner,
            ctx,
            `select t as id, authz.person_visible(t) visible from unnest($1::uuid[]) t`,
            [targets],
          );
          for (const h of helper) {
            expect(h.visible, `${v.name} → ${h.id}`).toBe(policy.has(h.id));
            compared++;
          }
        }
        expect(compared).toBe(viewers.length * targets.length);
        // The sample is not degenerate: each scope sees a different, non-trivial set.
        const seen = async (personId: string) =>
          (
            await rolledBack<{ id: string }>(
              owner,
              { personId, orgId: orgV },
              `select t as id from unnest($1::uuid[]) t where authz.person_visible(t)`,
              [targets],
            )
          ).map((r) => r.id);
        expect(await seen(deptResetter)).toEqual(
          expect.arrayContaining([inScope, protectedIn, deptResetter]),
        );
        expect(await seen(deptResetter)).not.toContain(outScope);
        expect(await seen(teamLead)).toEqual(expect.arrayContaining([report, teamLead]));
        expect(await seen(teamLead)).not.toContain(inScope);
        expect((await seen(grantee)).sort()).toEqual([grantee, granted].sort());
        expect(await seen(selfOnly)).toEqual([selfOnly]);
        expect(await seen(globalAdmin)).not.toContain(deleted);
        expect(await seen(globalAdmin)).not.toContain(foreigner);
      });

      it('authz.person_visible is callable by nobody but its owner', async () => {
        for (const pool of [appUser, appAuth, appWorker]) {
          expect(await codeOf(pool.query(`select authz.person_visible($1::uuid)`, [inScope]))).toBe(
            '42501',
          );
        }
      });

      // ── H1: credential reset ─────────────────────────────────────────────────────
      it('H1: a DEPARTMENT administrator cannot reset a person in another department — no reset, no session change, no audit, same answer as a missing person', async () => {
        const before = await footprint(outScope);
        const out = await errorOf(issueAs(deptTok, outScope));
        const missing = await errorOf(issueAs(deptTok, randomUUID()));
        expect(out?.code).toBe('42501');
        expect(out?.message).toBe(missing?.message);
        expect(await footprint(outScope)).toEqual(before);
        // Nor a protected-role holder out of reach: refused before ADR-001, so no DENIED entry.
        const pBefore = await footprint(protectedOut);
        expect((await errorOf(issueAs(deptTok, protectedOut)))?.code).toBe('42501');
        expect(await footprint(protectedOut)).toEqual(pBefore);
      });

      it('H1: through the application layer the refusal is NOT_FOUND, carries no token, and no reset is minted', async () => {
        const { issueAdminPasswordReset } = await import('@/lib/auth/admin-credentials');
        const before = await footprint(outScope);
        const e = (await errorOf(
          issueAdminPasswordReset(deptTok, outScope, {
            requestId: randomUUID(),
            ip: `198.51.100.${1 + Math.floor(Math.random() * 250)}`,
            userAgent: 'vitest',
          }),
        )) as unknown as { name: string; code: string; message: string; cause?: unknown };
        expect(e?.name).toBe('AdminAuthActionError');
        expect(e.code).toBe('NOT_FOUND');
        expect(e.cause).toBeUndefined();
        expect(JSON.stringify(e).includes(deptTok)).toBe(false);
        expect(await footprint(outScope)).toEqual(before);
      });

      it('H1: the same DEPARTMENT administrator can still reset a person in their own department', async () => {
        const r = await issueAs(deptTok, inScope);
        expect(r.outcome).toBe('ISSUED');
        expect(r.reset_id).toMatch(/^[0-9a-f-]{36}$/);
      });

      it('H1: TEAM reaches the manager chain, a record grant reaches its one person, SELF and no people.view reach no one else', async () => {
        expect((await issueAs(teamTok, report)).outcome).toBe('ISSUED');
        expect((await errorOf(issueAs(teamTok, inScope)))?.code).toBe('42501');
        expect((await issueAs(granteeTok, granted)).outcome).toBe('ISSUED');
        expect((await errorOf(issueAs(granteeTok, outScope)))?.code).toBe('42501');
        const selfTok = (await seedSession(owner, selfOnly)).token;
        expect((await errorOf(issueAs(selfTok, inScope)))?.code).toBe('42501');
        const noViewTok = (await seedSession(owner, noView)).token;
        expect((await errorOf(issueAs(noViewTok, inScope)))?.code).toBe('42501');
      });

      it('H1: a GLOBAL administrator (verified second factor) resets anyone in the organization, protected roles included under ADR-001', async () => {
        expect((await issueAs(globalTok, outScope)).outcome).toBe('ISSUED');
        expect((await issueAs(globalTok, protectedOut)).outcome).toBe('ISSUED');
      });

      it('H1: ADR-001 still refuses a VISIBLE protected-role holder — DENIED, audited', async () => {
        const before = Number((await footprint(protectedIn)).audits);
        expect(await issueAs(deptTok, protectedIn)).toEqual({ outcome: 'DENIED', reset_id: null });
        expect(Number((await footprint(protectedIn)).audits)).toBe(before + 1);
      });

      it('H1: forged identity settings do not widen visibility, and other tenants and deleted people stay out of reach', async () => {
        for (const ctx of [
          { personId: globalAdmin, orgId: orgV, aal: 'aal2' },
          { personId: SYSTEM_ACTOR, orgId: orgV },
        ]) {
          expect((await errorOf(issueAs(deptTok, outScope, ctx)))?.code).toBe('42501');
        }
        expect((await errorOf(issueAs(globalTok, foreigner)))?.code).toBe('42501');
        expect((await errorOf(issueAs(globalTok, deleted)))?.code).toBe('42501');
      });

      // ── M1: session actions ──────────────────────────────────────────────────────
      it('M1: GLOBAL sessions.revoke alone does not reach a person outside people.view — list, revoke one, revoke all are refused and change nothing', async () => {
        const before = await footprint(outScope);
        const oneId = before.sessions.split(',')[0]!;
        for (const [act, sid] of [
          ['list', null],
          ['revoke_one', oneId],
          ['revoke_all', null],
        ] as const) {
          const e = await errorOf(sessionAs(deptTok, outScope, act, sid));
          expect(e?.code, act).toBe('42501');
          // Nothing about the target's sessions in the refusal.
          const text = [e?.message, e?.detail, e?.hint, e?.where].join(' ');
          expect(text.includes(IP), act).toBe(false);
          expect(text.includes(UA), act).toBe(false);
          expect(text.includes(oneId), act).toBe(false);
        }
        expect(await footprint(outScope)).toEqual(before);
        // The answer is the one a missing person gets.
        const missing = await errorOf(sessionAs(deptTok, randomUUID(), 'list'));
        expect((await errorOf(sessionAs(deptTok, outScope, 'list')))?.message).toBe(
          missing?.message,
        );
      });

      it('M1: through the application layer the refusal is NOT_FOUND with no session details', async () => {
        const { listSessionsAsAdmin } = await import('@/lib/auth/admin-credentials');
        const e = (await errorOf(
          listSessionsAsAdmin(deptTok, outScope, { requestId: null, ip: null, userAgent: null }),
        )) as unknown as { code: string; message: string; stack?: string };
        expect(e.code).toBe('NOT_FOUND');
        const everything = `${e.message} ${String(e.stack)} ${JSON.stringify(e)}`;
        expect(everything.includes(IP) || everything.includes(UA)).toBe(false);
      });

      it('M1: the same administrator lists and revokes sessions of a person they can see', async () => {
        const rows = await sessionAs(deptTok, inScope, 'list');
        expect(rows.length).toBeGreaterThanOrEqual(2);
        const one = rows[0]!.session_id as string;
        const revoked = await sessionAs(deptTok, inScope, 'revoke_one', one);
        expect(revoked[0]!.affected).toBe(1);
        expect((await footprint(inScope)).sessions.split(',')).not.toContain(one);
      });

      it('M1: TEAM and record-grant reach apply to sessions too; a GLOBAL viewer reaches everyone in the organization and no one outside it', async () => {
        expect((await sessionAs(teamTok, report, 'list')).length).toBeGreaterThanOrEqual(1);
        expect((await errorOf(sessionAs(teamTok, inScope, 'list')))?.code).toBe('42501');
        expect((await sessionAs(granteeTok, granted, 'list')).length).toBeGreaterThanOrEqual(1);
        expect((await sessionAs(globalTok, outScope, 'list')).length).toBeGreaterThanOrEqual(1);
        expect((await errorOf(sessionAs(globalTok, foreigner, 'list')))?.code).toBe('42501');
        expect((await errorOf(sessionAs(globalTok, deleted, 'list')))?.code).toBe('42501');
      });

      it('M1: forged identity settings do not widen visibility for session actions', async () => {
        const before = await footprint(outScope);
        for (const ctx of [
          { personId: globalAdmin, orgId: orgV, aal: 'aal2' },
          { personId: SYSTEM_ACTOR, orgId: orgV },
        ]) {
          expect((await errorOf(sessionAs(deptTok, outScope, 'revoke_all', null, ctx)))?.code).toBe(
            '42501',
          );
        }
        expect(await footprint(outScope)).toEqual(before);
      });

      it('M1: the GLOBAL sessions.revoke requirement is unchanged — people.view GLOBAL without it is refused', async () => {
        const viewer = await personIn('Vis Viewer', deptA);
        await grant(orgV, viewer, ['people.view'], 'GLOBAL');
        const tok = (await seedSession(owner, viewer)).token;
        expect((await errorOf(sessionAs(tok, inScope, 'list')))?.code).toBe('42501');
      });
    });
  },
);
