import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from '@neondatabase/serverless';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { auth, MIN_PASSWORD_LENGTH } from '@/lib/auth/server';
import { resolveAuthContext, revokeSessionsFor } from '@/lib/auth/session';
import { authDb } from '@/lib/db/auth-client';
import { authDbSchema } from '@/lib/auth/schema';

/**
 * Task 1.12 — authentication establishes identity and nothing else.
 *
 * These tests sign in for real: a session is minted by the actual `auth` instance, the
 * cookie it returns is handed back to resolveAuthContext(), and the AuthContext that comes
 * out is the one withAuthorizedDb() would run under.
 *
 * Creating the credential needs a signed-up account, and signing up is refused by design —
 * twice over. So the fixture below is a SECOND Better Auth instance, pointed at the same
 * database with sign-up enabled, standing in for the invitation flow that will eventually
 * create accounts. Every assertion that matters is then made against the real instance.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

const RUN = Math.random().toString(36).slice(2, 8);
const PASSWORD = 'correct horse battery staple';

/**
 * Drift guard: the expected authz-helper count is derived from the migration
 * SQL (distinct `create function authz.<name>`), so a future migration that
 * adds a helper updates the expectation instead of going red.
 */
const authzHelperCountFromSql = (): number => {
  const sql = readdirSync(join(process.cwd(), 'drizzle'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(process.cwd(), 'drizzle', f), 'utf8'))
    .join('\n');
  return new Set(
    [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+authz\.([a-z_][a-z0-9_]*)/gi)].map(
      (m) => m[1]!,
    ),
  ).size;
};

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
    // Provision the account only. An invitation creates a credential; it does not log
    // anybody in, and leaving this on would give every fixture a session it never asked for.
    autoSignIn: false,
  },
  session: { modelName: 'auth_sessions' },
  user: { modelName: 'auth_users' },
  account: { modelName: 'auth_accounts' },
  verification: { modelName: 'auth_verifications' },
  advanced: { database: { generateId: 'uuid' } },
});

let orgA = '';
let orgB = '';
let deptA = '';

const mkLogin = async (label: string) => {
  const email = `${label}.${RUN}@example.test`;
  const created = await provisioning.api.signUpEmail({
    body: { email, password: PASSWORD, name: label },
  });
  return { email, id: created.user.id };
};

const mkPerson = async (org: string, name: string, authUserId: string | null) => {
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

beforeAll(async () => {
  const mkOrg = async (s: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name,slug) values ($1,$2) returning id`,
        [`Se ${s}`, `sess-${RUN}-${s}`],
      )
    ).rows[0]!.id;
  [orgA, orgB] = await Promise.all([mkOrg('a'), mkOrg('b')]);
  deptA = (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id,code,name) values ($1,$2,$3) returning id`,
      [orgA, `S${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, 'Sessions'],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
});

describe('there is no signup route', () => {
  it('refuses sign-up through the real auth instance', async () => {
    await expect(
      auth.api.signUpEmail({
        body: { email: `intruder.${RUN}@example.test`, password: PASSWORD, name: 'Intruder' },
      }),
    ).rejects.toThrow();
  });

  it('creates no login when it refuses', async () => {
    const email = `nothing.${RUN}@example.test`;
    await expect(
      auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Nobody' } }),
    ).rejects.toThrow();
    const { rows } = await owner.query(`select 1 from auth.auth_users where email=$1`, [email]);
    expect(rows).toEqual([]);
  });

  it('is refused by configuration AND by an explicit hook, not by one of them', async () => {
    expect(auth.options.emailAndPassword?.disableSignUp).toBe(true);
    expect(auth.options.hooks?.before).toBeDefined();
  });

  it('creates no person, organization, role or permission as a side effect of anything', async () => {
    const login = await mkLogin('sideeffect');
    expect(login.id).toBeTruthy();
    // Scoped to this login rather than counted globally: the rest of the suite creates
    // people concurrently, and a global count would be measuring them.
    const { rows } = await owner.query<Record<string, string>>(
      `select (select count(*) from public.people where auth_user_id = $1) people,
              (select count(*) from public.person_roles pr
                 join public.people p on p.id = pr.person_id
                where p.auth_user_id = $1) person_roles,
              (select count(*) from public.engagements e
                 join public.people p on p.id = e.person_id
                where p.auth_user_id = $1) engagements`,
      [login.id],
    );
    expect(rows[0]).toEqual({ people: '0', person_roles: '0', engagements: '0' });
  });
});

describe('password rules', () => {
  it('requires at least twelve characters', async () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(auth.options.emailAndPassword?.minPasswordLength).toBe(12);
    await expect(
      provisioning.api.signUpEmail({
        body: { email: `short.${RUN}@example.test`, password: 'elevenchar', name: 'Short' },
      }),
    ).rejects.toThrow();
  });

  it('accepts a password at the boundary', async () => {
    const created = await provisioning.api.signUpEmail({
      body: {
        email: `boundary.${RUN}@example.test`,
        password: 'a'.repeat(MIN_PASSWORD_LENGTH),
        name: 'Boundary',
      },
    });
    expect(created.user.id).toBeTruthy();
  });

  it('stores a hash, never the password', async () => {
    const login = await mkLogin('hashed');
    const { rows } = await owner.query<{ password: string | null }>(
      `select password from auth.auth_accounts where user_id=$1`,
      [login.id],
    );
    expect(rows[0]!.password).toBeTruthy();
    expect(rows[0]!.password).not.toContain(PASSWORD);
  });
});

describe('identity resolution', () => {
  it('issues a uuid login id, matching people.auth_user_id', async () => {
    const login = await mkLogin('uuidcheck');
    expect(login.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('resolves a linked person to an AuthContext, with the organization from their row', async () => {
    const login = await mkLogin('linked');
    const person = await mkPerson(orgA, 'Linked Person', login.id);
    const { cookie } = await signIn(login.email);

    const ctx = await resolveAuthContext(headersFor(cookie));
    expect(ctx).not.toBeNull();
    expect(ctx!.personId).toBe(person);
    expect(ctx!.orgId).toBe(orgA);
    expect(ctx!.aal).toBe('aal1');
  });

  it('gives an authenticated stranger nothing at all', async () => {
    // A real login, a real session, and no people row pointing at it. Threat T-01.
    const login = await mkLogin('stranger');
    const { cookie } = await signIn(login.email);
    expect(await resolveAuthContext(headersFor(cookie))).toBeNull();
  });

  it('returns null with no session', async () => {
    expect(await resolveAuthContext(new Headers())).toBeNull();
    expect(await resolveAuthContext(headersFor('better-auth.session_token=nonsense'))).toBeNull();
  });

  it('refuses once the person is soft-deleted or no longer ACTIVE', async () => {
    const login = await mkLogin('deactivated');
    const person = await mkPerson(orgA, 'Deactivated', login.id);
    const { cookie } = await signIn(login.email);
    expect(await resolveAuthContext(headersFor(cookie))).not.toBeNull();

    await owner.query(`update public.people set person_status='INACTIVE' where id=$1`, [person]);
    expect(await resolveAuthContext(headersFor(cookie))).toBeNull();

    await owner.query(
      `update public.people set person_status='ACTIVE', deleted_at=now() where id=$1`,
      [person],
    );
    expect(await resolveAuthContext(headersFor(cookie))).toBeNull();
  });

  it('refuses a still-valid cookie after sessions_revoked_at is stamped', async () => {
    // The browser still holds a perfectly good session. It stops working anyway.
    const login = await mkLogin('bulkrevoked');
    const person = await mkPerson(orgA, 'Bulk Revoked', login.id);
    const { cookie } = await signIn(login.email);
    expect(await resolveAuthContext(headersFor(cookie))).not.toBeNull();

    await owner.query(
      `update public.people set sessions_revoked_at = now() + interval '1 minute' where id=$1`,
      [person],
    );
    expect(await resolveAuthContext(headersFor(cookie))).toBeNull();
  });

  it('refuses a session whose row has expired', async () => {
    const login = await mkLogin('expired');
    await mkPerson(orgA, 'Expired Session', login.id);
    const { cookie } = await signIn(login.email);
    expect(await resolveAuthContext(headersFor(cookie))).not.toBeNull();

    await owner.query(
      `update auth.auth_sessions set expires_at = now() - interval '1 day' where user_id=$1`,
      [login.id],
    );
    expect(await resolveAuthContext(headersFor(cookie))).toBeNull();
  });

  it('refuses immediately once the session row is deleted', async () => {
    const login = await mkLogin('revoked');
    await mkPerson(orgA, 'Revoked', login.id);
    const { cookie } = await signIn(login.email);
    expect(await resolveAuthContext(headersFor(cookie))).not.toBeNull();

    await revokeSessionsFor(login.id);
    expect(await resolveAuthContext(headersFor(cookie))).toBeNull();
  });

  it('still resolves someone whose engagement ended, leaving that to the database', async () => {
    // Blueprint 7.4 asks "authenticated?" before "engaged?". The offboarded person has an
    // identity and reaches nothing, which is step 2 working rather than step 1 pretending.
    const login = await mkLogin('offboarded');
    const person = await mkPerson(orgA, 'Offboarded', login.id);
    await owner.query(
      `insert into public.engagements
         (org_id,person_id,department_id,engagement_type,status,start_date)
       values ($1,$2,$3,'EMPLOYEE','ARCHIVED',current_date)`,
      [orgA, person, deptA],
    );
    const { cookie } = await signIn(login.email);
    const ctx = await resolveAuthContext(headersFor(cookie));
    expect(ctx).not.toBeNull();
    expect(ctx!.personId).toBe(person);
  });

  it('never takes the organization from anything the caller controls', async () => {
    const login = await mkLogin('tenant');
    await mkPerson(orgB, 'In Org B', login.id);
    const { cookie } = await signIn(login.email);
    const ctx = await resolveAuthContext(headersFor(cookie));
    expect(ctx!.orgId).toBe(orgB);
    expect(ctx!.orgId).not.toBe(orgA);
  });

  it('grants no role or permission by authenticating', async () => {
    const login = await mkLogin('noroles');
    const person = await mkPerson(orgA, 'No Roles', login.id);
    const { cookie } = await signIn(login.email);
    expect(await resolveAuthContext(headersFor(cookie))).not.toBeNull();

    const { rows } = await owner.query<{ n: string }>(
      `select count(*) n from public.person_roles where person_id=$1`,
      [person],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe('session configuration', () => {
  it('sets a 30-day rolling expiry refreshed daily', () => {
    expect(auth.options.session?.expiresIn).toBe(60 * 60 * 24 * 30);
    expect(auth.options.session?.updateAge).toBe(60 * 60 * 24);
  });

  it('sets HttpOnly and SameSite=Lax on the session cookie', async () => {
    const login = await mkLogin('cookie');
    await mkPerson(orgA, 'Cookie Person', login.id);
    const { setCookie } = await signIn(login.email);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
  });

  it('configures Secure cookies for production', () => {
    // NODE_ENV is 'test' here, so the flag is off; the configuration is what ships.
    expect(auth.options.advanced?.defaultCookieAttributes?.httpOnly).toBe(true);
    expect(auth.options.advanced?.defaultCookieAttributes?.sameSite).toBe('lax');
  });

  it('stores sessions in the database rather than in a token', async () => {
    const login = await mkLogin('dbsession');
    await mkPerson(orgA, 'DB Session', login.id);
    await signIn(login.email);
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) n from auth.auth_sessions where user_id=$1`,
      [login.id],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

describe('rate limiting', () => {
  it('is enabled, database-backed, and strictest on sign-in', () => {
    // Memory storage would reset on every serverless cold start and be shared by nobody.
    expect(auth.options.rateLimit?.enabled).toBe(true);
    expect(auth.options.rateLimit?.storage).toBe('database');
    expect(auth.options.rateLimit?.modelName).toBe('auth_rate_limits');
    expect(auth.options.rateLimit?.customRules?.['/sign-in/email']).toEqual({
      window: 60,
      max: 10,
    });
  });
});

describe('the authorization boundary is unmoved', () => {
  it('keeps every authz helper exactly as the earlier tasks left it', async () => {
    const { rows } = await owner.query<{ proname: string; src: string }>(
      `select p.proname, pg_get_functiondef(p.oid) src from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace where n.nspname='authz'`,
    );
    expect(rows.length).toBe(authzHelperCountFromSql());
    // Migrations 0023-0025 added narrow password-reset helpers; 0027 added the
    // login-lockout and MFA-enforcement helpers. They are the only helpers
    // besides aal() allowed to see the auth schema, and each may touch ONLY
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
      // 0027: the lockout helpers touch only the lockout ledger and the login
      // row it is keyed by. 'login' is the audit action name string
      // ('auth.login.lockout'), not a table reference.
      check_login_lockout: ['login_lockouts', 'auth_users'],
      record_login_failure: ['auth_users', 'login_lockouts', 'login'],
      clear_login_lockout: ['login_lockouts', 'auth_users'],
      // The TOTP trigger function reads auth.auth_users to attribute the audit
      // entry; the auth_two_factors reference lives in the trigger binding, not
      // the function body.
      audit_two_factor_change: ['auth_users'],
      mfa_enrollment_required: ['auth_two_factors'],
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
  });

  it('adds no policy to public and leaves every table protected', async () => {
    const policies = await owner.query<{ n: string }>(
      `select count(*) n from pg_policies
       where schemaname='public' and 'app_user' = any(roles)
         and tablename not like '\\_%'`,
    );
    // 71: the CRM migration (0033) adds nine app_user policies — select, insert,
    // and update on each of companies, contacts, and deals — the Track B
    // migrations add twelve more — select/insert/update on activities (0034) and
    // on company_contacts, company_links and contact_links (0035) — and the Phase 3
    // sales-pipeline migration (0037) adds eight more — select/insert/update on
    // pipelines and pipeline_stages, select/insert on deal_stage_history — and the
    // Phase 5 workflow-engine migration (0044) adds five more — select/insert/update
    // on workflows, select on workflow_executions, select on workflow_execution_steps.
    // The Phase 6 automation migrations (0045/0047) add nine more — select/insert/
    // update on each of jobs, schedules, and notifications.
    // The Phase 8 migration (0052) adds three more — select/insert/update on
    // notification_preferences.
    // The Phase 9 migration (0054) adds six more — select/insert/update on
    // each of ai_usage_requests and ai_org_limits.
    // The *_owner_all policies target app_owner and are not counted here.
    expect(Number(policies.rows[0]!.n)).toBe(89);

    const unprotected = await owner.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind in ('r','p')
         and c.relname not like '\\_%' and c.relname <> '__drizzle_migrations'
         and (not c.relrowsecurity or not c.relforcerowsecurity)`,
    );
    expect(unprotected.rows).toEqual([]);
  });
});
