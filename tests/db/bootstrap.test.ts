import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from '@neondatabase/serverless';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { auth } from '@/lib/auth/server';
import { resolveAuthContext } from '@/lib/auth/session';
import { completeBootstrapSetup } from '@/lib/auth/bootstrap-setup';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { POST } from '@/app/api/bootstrap/complete/route';

/**
 * Task 1.14 — first-run bootstrap, against a real database.
 *
 * ── WHY THIS FILE IS SHAPED THE WAY IT IS ────────────────────────────────────────
 *
 * Bootstrap happens once per database, and that is the property under test, so this file can
 * commit exactly one bootstrap. Everything else is REHEARSED: run inside a transaction that is
 * always rolled back, which proves the behaviour without spending the database's one bootstrap.
 * The committed section comes last and consumes it — with a genuine race, a genuine login and a
 * genuine second factor, because Better Auth reads through its own connections and cannot see
 * an uncommitted row.
 *
 * The consequence is deliberate and loud: run against a database that has already been
 * bootstrapped, the whole file fails in beforeAll, rather than passing vacuously. CI branches
 * are cut fresh from staging, which has never been bootstrapped.
 *
 * Bootstrap runs here as app_owner, the function's owner. CI holds no app_admin credential by
 * design; the grant to app_admin is asserted from the catalogue, and the operator path as
 * app_admin is exercised by the verification run recorded in the task report.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);

type DbError = { code?: string; message: string };
type Args = {
  orgName: string;
  orgSlug: string;
  ownerName: string;
  ownerEmail: string;
  token: string;
};
type Bootstrapped = {
  organization_id: string;
  owner_person_id: string;
  owner_engagement_id: string;
  setup_token_expires_at: Date;
};

const newToken = () => randomBytes(32).toString('base64url');
const digestOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

const argsFor = (label: string): Args => ({
  orgName: `Bootstrap ${label} ${RUN}`,
  orgSlug: `bs-${RUN}-${label}`,
  ownerName: `Owner ${label}`,
  ownerEmail: `owner.${label}.${RUN}@example.test`,
  token: newToken(),
});

const BOOTSTRAP = `select organization_id, owner_person_id, owner_engagement_id, setup_token_expires_at
  from public.bootstrap_organization($1, $2, $3, $4, decode($5, 'hex'))`;
const paramsFor = (a: Args) => [a.orgName, a.orgSlug, a.ownerName, a.ownerEmail, digestOf(a.token)];

const COMPLETE = `select linked_person_id, linked_org_id, linked_auth_user_id
  from public.complete_bootstrap_setup(decode($1, 'hex'), $2)`;

/** The Better Auth salt:key shape. Good enough for SQL rehearsals, which never sign in. */
const HASH_SHAPED = `${'0'.repeat(32)}:${'f'.repeat(128)}`;

const bootstrapOn = async (c: PoolClient, a: Args) =>
  (await c.query<Bootstrapped>(BOOTSTRAP, paramsFor(a))).rows[0]!;

/** Run fn in a transaction that is ALWAYS rolled back. Nothing a rehearsal does is committed. */
async function rehearse<T>(fn: (c: PoolClient) => Promise<T>, pool: Pool = owner): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

/** A statement that must fail, isolated by a savepoint so the rehearsal can continue. */
async function refused(c: PoolClient, text: string, params: unknown[] = []): Promise<DbError> {
  await c.query('savepoint attempt');
  try {
    await c.query(text, params);
  } catch (e) {
    await c.query('rollback to savepoint attempt');
    return e as DbError;
  }
  await c.query('release savepoint attempt');
  throw new Error(`expected a refusal, but this succeeded: ${text.trim().split('\n')[0]}`);
}

const setIdentity = (c: PoolClient, personId: string | null, orgId: string | null, aal = '') =>
  c.query(
    `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true),
            set_config('app.aal',$3,true)`,
    [personId ?? '', orgId ?? '', aal],
  );

const count = async (c: PoolClient | Pool, text: string, params: unknown[] = []) =>
  (await c.query<{ n: number }>(text, params)).rows[0]!.n;

const isValid = async (token: string) =>
  (
    await owner.query<{ v: boolean }>(
      `select public.bootstrap_setup_token_is_valid(decode($1, 'hex')) v`,
      [digestOf(token)],
    )
  ).rows[0]!.v;

/** Poll pg_stat_activity until the backend is waiting on a lock. */
async function waitsOnLock(pid: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await owner.query<{ w: string | null }>(
      `select wait_event_type w from pg_stat_activity where pid=$1`,
      [pid],
    );
    if (rows[0]?.w === 'Lock') return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

type Outcome = { ok: true; value: Bootstrapped } | { ok: false; error: DbError };
const settle = (p: Promise<Bootstrapped>): Promise<Outcome> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: DbError) => ({ ok: false as const, error }),
  );

// ── Better Auth helpers, as in tests/auth/two-factor.test.ts ─────────────────────

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

const signInRaw = (email: string, password: string) =>
  auth.api.signInEmail({ body: { email, password }, asResponse: true }) as Promise<Response>;

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

/** RFC 6238, independent of the library, so the stored seed is proven to be a real one. */
const totp = (secret: string, at = Date.now()): string => {
  const counter = Math.floor(at / 1000 / 30);
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
  return String(binary % 1_000_000).padStart(6, '0');
};

beforeAll(async () => {
  const gates = await count(owner, `select count(*)::int n from public.bootstrap_state`);
  if (gates !== 0) {
    throw new Error(
      'tests/db/bootstrap.test.ts needs a database that has never been bootstrapped: bootstrap ' +
        'is once per database by design, and this file commits one. Run it against a fresh ' +
        'branch — CI branches always are.',
    );
  }
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

// ═════════════════════════════════════════════════════════════════════════════════
// structure and privileges
// ═════════════════════════════════════════════════════════════════════════════════

describe('structure and privileges', () => {
  const TABLES = ['bootstrap_setup_token', 'bootstrap_state'];
  const FUNCTIONS = [
    'bootstrap_organization',
    'bootstrap_setup_token_is_valid',
    'complete_bootstrap_setup',
  ];

  it('enables and forces RLS, with an owner policy and nothing at all for either runtime role', async () => {
    const tables = await owner.query<{ relname: string; enabled: boolean; forced: boolean }>(
      `select c.relname, c.relrowsecurity enabled, c.relforcerowsecurity forced
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname = any($1) order by c.relname`,
      [TABLES],
    );
    expect(tables.rows.map((r) => r.relname)).toEqual(TABLES);
    for (const r of tables.rows) {
      expect(r.enabled, r.relname).toBe(true);
      expect(r.forced, r.relname).toBe(true);
    }

    const policies = await owner.query<{ policyname: string; roles: string[] }>(
      `select policyname, roles::text[] roles from pg_policies
       where schemaname='public' and tablename = any($1) order by policyname`,
      [TABLES],
    );
    expect(policies.rows).toEqual([
      { policyname: 'bootstrap_setup_token_owner_all', roles: ['app_owner'] },
      { policyname: 'bootstrap_state_owner_all', roles: ['app_owner'] },
    ]);

    const privileges = await owner.query(
      `select table_name, grantee, privilege_type from information_schema.table_privileges
       where table_schema='public' and table_name = any($1)
         and grantee in ('app_user','app_admin','PUBLIC')`,
      [TABLES],
    );
    expect(privileges.rows).toEqual([]);
  });

  it('holds at most one row in each table: the key is a boolean that must be true', async () => {
    await rehearse(async (c) => {
      const e = await refused(
        c,
        `insert into public.bootstrap_state
           (id, org_id, department_id, person_id, engagement_id, performed_by)
         values (false, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                 gen_random_uuid(), 'app_owner')`,
      );
      expect(e.code).toBe('23514');
      expect(e.message).toMatch(/bootstrap_state_singleton/);
    });
  });

  it('checks the origin record foreign keys at COMMIT, so the gate can be the first write', async () => {
    const { rows } = await owner.query<{ deferrable: boolean; deferred: boolean }>(
      `select condeferrable deferrable, condeferred deferred from pg_constraint
       where conrelid='public.bootstrap_state'::regclass and contype='f'`,
    );
    expect(rows.length).toBe(4);
    for (const r of rows) expect(r).toEqual({ deferrable: true, deferred: true });
  });

  it('defines the functions as SECURITY DEFINER, owned by app_owner, search_path pinned, no dynamic SQL', async () => {
    const { rows } = await owner.query<{
      proname: string;
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
      owner: string;
      src: string;
    }>(
      `select p.proname, p.prosecdef, p.provolatile, p.proconfig, r.rolname owner,
              pg_get_functiondef(p.oid) src
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       join pg_roles r on r.oid=p.proowner
       where n.nspname='public' and p.proname = any($1) order by p.proname`,
      [FUNCTIONS],
    );
    expect(rows.map((r) => r.proname)).toEqual(FUNCTIONS);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.proconfig ?? [], r.proname).toContain('search_path=""');
      expect(r.owner, r.proname).toBe('app_owner');
      const body = (r.src.split('AS $function$')[1] ?? '')
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n');
      expect(body, `${r.proname} dynamic SQL`).not.toMatch(/\bexecute\b/i);
    }
    expect(rows.map((r) => r.provolatile)).toEqual(['v', 's', 'v']);
  });

  it('grants the bootstrap to app_admin alone, and completion to app_user alone', async () => {
    const grantees = async (fn: string) =>
      (
        await owner.query<{ grantee: string }>(
          `select coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC') grantee
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ac
           where n.nspname='public' and p.proname=$1 and ac.privilege_type='EXECUTE'`,
          [fn],
        )
      ).rows
        .map((r) => r.grantee)
        .sort();

    expect(await grantees('bootstrap_organization')).toEqual(['app_admin', 'app_owner']);
    // Authentication is not an app_admin path; bootstrap is not an app_user one.
    expect(await grantees('complete_bootstrap_setup')).toEqual(['app_owner', 'app_user']);
    expect(await grantees('bootstrap_setup_token_is_valid')).toEqual(['app_owner', 'app_user']);
    expect(await grantees('bootstrap_state_immutable')).toEqual(['app_owner']);
    expect(await grantees('bootstrap_setup_token_consume_once')).toEqual(['app_owner']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// unauthorized callers
// ═════════════════════════════════════════════════════════════════════════════════

describe('an unauthorized caller', () => {
  it('cannot execute the bootstrap as the runtime role', async () => {
    const a = argsFor('runtime');
    await rehearse(async (c) => {
      const e = await refused(c, BOOTSTRAP, paramsFor(a));
      expect(e.code).toBe('42501');
      expect(e.message).toMatch(/permission denied for function bootstrap_organization/);
    }, asUser);
    expect(
      await count(owner, `select count(*)::int n from public.organizations where slug=$1`, [
        a.orgSlug,
      ]),
    ).toBe(0);
  });

  it('cannot read, write or remove the gate or the token as the runtime role', async () => {
    for (const text of [
      `select * from public.bootstrap_state`,
      `select * from public.bootstrap_setup_token`,
      `insert into public.bootstrap_state (org_id, department_id, person_id, engagement_id, performed_by)
       values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'app_admin')`,
      `update public.bootstrap_setup_token set consumed_at = now()`,
      `delete from public.bootstrap_setup_token`,
    ]) {
      await expect(asUser.query(text), text).rejects.toThrow(/permission denied/i);
    }
  });

  it('is refused by the function itself even if EXECUTE were ever granted to app_user by mistake', async () => {
    const signature = 'public.bootstrap_organization(text, text, text, text, bytea)';
    await owner.query(`grant execute on function ${signature} to app_user`);
    try {
      await rehearse(async (c) => {
        const e = await refused(c, BOOTSTRAP, paramsFor(argsFor('mistake')));
        expect(e.code).toBe('42501');
        expect(e.message).toMatch(/only be performed by the bootstrap database role/);
      }, asUser);
    } finally {
      await owner.query(`revoke execute on function ${signature} from app_user`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// bootstrap, rehearsed — every transaction here is rolled back
// ═════════════════════════════════════════════════════════════════════════════════

describe('bootstrap, rehearsed', () => {
  it('creates the organization, Executive department, owner, engagement, origin grant and token in one call', async () => {
    const a = argsFor('shape');
    await rehearse(async (c) => {
      const b = await bootstrapOn(c, a);

      const org = await c.query(
        `select o.name, o.slug::text, o.status,
                (select count(*)::int from public.roles r where r.org_id=o.id) roles
         from public.organizations o where o.id=$1`,
        [b.organization_id],
      );
      expect(org.rows).toEqual([{ name: a.orgName, slug: a.orgSlug, status: 'ACTIVE', roles: 14 }]);

      const departments = await c.query(
        `select code, name, status from public.departments where org_id=$1`,
        [b.organization_id],
      );
      expect(departments.rows).toEqual([{ code: 'EXEC', name: 'Executive', status: 'ACTIVE' }]);

      const person = await c.query<{ code: string }>(
        `select org_id, code, full_legal_name, work_email::text, person_status::text, auth_user_id
         from public.people where id=$1`,
        [b.owner_person_id],
      );
      expect(person.rows.length).toBe(1);
      expect(person.rows[0]).toMatchObject({
        org_id: b.organization_id,
        full_legal_name: a.ownerName,
        work_email: a.ownerEmail,
        person_status: 'ACTIVE',
        auth_user_id: null,
      });
      expect(person.rows[0]!.code).toMatch(/^EMP-\d{4}-0001$/);

      const engagement = await c.query(
        `select e.person_id, e.engagement_type::text, e.status::text, e.is_primary, d.code department
         from public.engagements e join public.departments d on d.id=e.department_id
         where e.id=$1`,
        [b.owner_engagement_id],
      );
      expect(engagement.rows).toEqual([
        {
          person_id: b.owner_person_id,
          engagement_type: 'EMPLOYEE',
          status: 'ACTIVE',
          is_primary: true,
          department: 'EXEC',
        },
      ]);

      const grants = await c.query(
        `select r.key, r.is_protected, pr.granted_by, pr.expires_at
         from public.person_roles pr join public.roles r on r.id=pr.role_id
         where pr.person_id=$1`,
        [b.owner_person_id],
      );
      expect(grants.rows).toEqual([
        { key: 'SUPER_ADMIN', is_protected: true, granted_by: null, expires_at: null },
      ]);

      const state = await c.query(
        `select s.org_id, s.person_id, s.engagement_id, s.performed_by, d.code department
         from public.bootstrap_state s join public.departments d on d.id=s.department_id`,
      );
      expect(state.rows).toEqual([
        {
          org_id: b.organization_id,
          person_id: b.owner_person_id,
          engagement_id: b.owner_engagement_id,
          performed_by: 'app_owner',
          department: 'EXEC',
        },
      ]);

      const token = await c.query(
        `select encode(token_hash,'hex') digest, person_id,
                extract(epoch from expires_at - issued_at)::int lifetime,
                consumed_at, consumed_auth_user_id
         from public.bootstrap_setup_token`,
      );
      expect(token.rows).toEqual([
        {
          digest: digestOf(a.token),
          person_id: b.owner_person_id,
          lifetime: 3600,
          consumed_at: null,
          consumed_auth_user_id: null,
        },
      ]);
    });
  });

  it('makes the owner access-eligible: live engagement, roles.manage at GLOBAL, and aal1 until a factor exists', async () => {
    await rehearse(async (c) => {
      const b = await bootstrapOn(c, argsFor('eligible'));
      await setIdentity(c, b.owner_person_id, b.organization_id, 'aal2');
      const { rows } = await c.query(
        `select authz.person_id() person, authz.org_id() org, authz.is_active() active,
                authz.scope_for('roles.manage')::text roles,
                authz.scope_for('permissions.manage')::text permissions,
                authz.has('users.impersonate') impersonate, authz.aal() aal`,
      );
      expect(rows[0]).toEqual({
        person: b.owner_person_id,
        org: b.organization_id,
        active: true,
        roles: 'GLOBAL',
        permissions: 'GLOBAL',
        impersonate: false,
        aal: 'aal1',
      });
    });
  });

  it('writes no audit entry and attributes nothing to anyone — not even a person the caller names', async () => {
    await rehearse(async (c) => {
      const org = (
        await c.query<{ id: string }>(
          `insert into public.organizations (name, slug) values ($1, $2) returning id`,
          [`Framed ${RUN}`, `bs-${RUN}-framed`],
        )
      ).rows[0]!.id;
      const code = (
        await c.query<{ c: string }>(`select authz.next_identity_code($1,'EMP','2026') c`, [org])
      ).rows[0]!.c;
      const framed = (
        await c.query<{ id: string }>(
          `insert into public.people (org_id, code, full_legal_name, person_status)
           values ($1, $2, 'Framed', 'ACTIVE') returning id`,
          [org, code],
        )
      ).rows[0]!.id;
      // A caller who tries to have the bootstrap recorded as somebody's act.
      await setIdentity(c, framed, org);

      const b = await bootstrapOn(c, argsFor('audit'));

      expect(
        await count(
          c,
          `select count(*)::int n from public.audit_logs
           where entity_id = any($1::uuid[]) or actor_person_id = any($2::uuid[])`,
          [
            [b.organization_id, b.owner_person_id, b.owner_engagement_id],
            [framed, b.owner_person_id],
          ],
        ),
      ).toBe(0);
      expect(
        await count(
          c,
          `select count(*)::int n from public.audit_logs where actor_person_id is null`,
        ),
      ).toBe(0);
      const context = await c.query<{ p: string }>(
        `select current_setting('app.person_id', true) p`,
      );
      expect(context.rows[0]!.p).toBe('');
    });
  });

  it('refuses a second bootstrap, even inside the same transaction', async () => {
    await rehearse(async (c) => {
      await bootstrapOn(c, argsFor('first'));
      const second = argsFor('second');
      const e = await refused(c, BOOTSTRAP, paramsFor(second));
      expect(e.code).toBe('55000');
      expect(e.message).toMatch(/already been bootstrapped/);
      const { rows } = await c.query(
        `select (select count(*)::int from public.bootstrap_state) gates,
                (select count(*)::int from public.organizations where slug=$1) orgs`,
        [second.orgSlug],
      );
      expect(rows[0]).toEqual({ gates: 1, orgs: 0 });
    });
  });

  it('rolls back every row when it fails after writing all of them', async () => {
    const a = argsFor('late');
    await rehearse(async (c) => {
      // A failure injected at the very last write; the DDL is rolled back with the rehearsal.
      await c.query(
        `create function public._bootstrap_test_fail() returns trigger language plpgsql
         as $$ begin raise exception 'injected failure'; end $$`,
      );
      await c.query(
        `create trigger _bootstrap_test_fail before insert on public.bootstrap_setup_token
         for each row execute function public._bootstrap_test_fail()`,
      );
      const e = await refused(c, BOOTSTRAP, paramsFor(a));
      expect(e.message).toMatch(/injected failure/);

      const { rows } = await c.query(
        `select (select count(*)::int from public.bootstrap_state) gates,
                (select count(*)::int from public.organizations where slug=$1) orgs,
                (select count(*)::int from public.people where work_email=$2) people,
                (select count(*)::int from public.bootstrap_setup_token) tokens`,
        [a.orgSlug, a.ownerEmail],
      );
      expect(rows[0]).toEqual({ gates: 0, orgs: 0, people: 0, tokens: 0 });
    });
  });

  it('rolls back the gate when the organization cannot be created', async () => {
    const a = argsFor('taken-slug');
    await rehearse(async (c) => {
      await c.query(`insert into public.organizations (name, slug) values ('Taken', $1)`, [
        a.orgSlug,
      ]);
      const e = await refused(c, BOOTSTRAP, paramsFor(a));
      expect(e.code).toBe('23505');
      expect(await count(c, `select count(*)::int n from public.bootstrap_state`)).toBe(0);
    });
  });

  it('refuses malformed input by naming the parameter, never echoing its value', async () => {
    const a = argsFor('input');
    const cases: [string, unknown[], RegExp][] = [
      [
        'blank org name',
        ['  ', a.orgSlug, a.ownerName, a.ownerEmail, digestOf(a.token)],
        /organization name is required/,
      ],
      [
        'blank owner',
        [a.orgName, a.orgSlug, ' ', a.ownerEmail, digestOf(a.token)],
        /owner full name is required/,
      ],
      [
        'bad email',
        [a.orgName, a.orgSlug, a.ownerName, 'not-an-email', digestOf(a.token)],
        /work email is not a valid address/,
      ],
      [
        'short digest',
        [a.orgName, a.orgSlug, a.ownerName, a.ownerEmail, 'ab'.repeat(31)],
        /32-byte SHA-256 digest/,
      ],
    ];
    await rehearse(async (c) => {
      for (const [label, params, pattern] of cases) {
        const e = await refused(c, BOOTSTRAP, params);
        expect(e.code, label).toBe('22023');
        expect(e.message, label).toMatch(pattern);
        expect(e.message, label).not.toContain('not-an-email');
      }
      expect(await count(c, `select count(*)::int n from public.bootstrap_state`)).toBe(0);
    });
  });

  it('refuses to attach the first SUPER_ADMIN to an address a login already uses', async () => {
    const a = argsFor('existing-login');
    await rehearse(async (c) => {
      await c.query(`insert into auth.auth_users (name, email) values ('Somebody Else', $1)`, [
        a.ownerEmail,
      ]);
      const e = await refused(c, BOOTSTRAP, paramsFor(a));
      expect(e.code).toBe('55000');
      expect(e.message).toMatch(/login already exists/);
    });
  });

  it('makes a concurrent attempt wait on the gate, and lets it proceed if the first rolls back', async () => {
    const first = await owner.connect();
    const second = await owner.connect();
    try {
      await first.query('begin');
      await second.query('begin');
      await bootstrapOn(first, argsFor('wait-a'));

      const pid = (await second.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid;
      const waiting = settle(bootstrapOn(second, argsFor('wait-b')));
      expect(await waitsOnLock(pid)).toBe(true);

      // A failed attempt must not consume the one bootstrap.
      await first.query('rollback');
      const outcome = await waiting;
      expect(outcome.ok).toBe(true);
    } finally {
      await first.query('rollback').catch(() => undefined);
      await second.query('rollback').catch(() => undefined);
      first.release();
      second.release();
    }
    expect(await count(owner, `select count(*)::int n from public.bootstrap_state`)).toBe(0);
  });

  it('closes genesis at once: nobody without roles.manage can grant, revoke or rewrite SUPER_ADMIN', async () => {
    await rehearse(async (c) => {
      const b = await bootstrapOn(c, argsFor('protected'));
      const superAdmin = (
        await c.query<{ id: string }>(
          `select id from public.roles where org_id=$1 and key='SUPER_ADMIN'`,
          [b.organization_id],
        )
      ).rows[0]!.id;
      const manage = (
        await c.query<{ id: string }>(`select id from public.permissions where key='roles.manage'`)
      ).rows[0]!.id;
      const code = (
        await c.query<{ c: string }>(`select authz.next_identity_code($1,'EMP','2026') c`, [
          b.organization_id,
        ])
      ).rows[0]!.c;
      const climber = (
        await c.query<{ id: string }>(
          `insert into public.people (org_id, code, full_legal_name, person_status)
           values ($1, $2, 'Climber', 'ACTIVE') returning id`,
          [b.organization_id, code],
        )
      ).rows[0]!.id;

      await setIdentity(c, null, null);
      const attempts: [string, string, unknown[]][] = [
        [
          'grant a second SUPER_ADMIN',
          `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
          [climber, superAdmin, b.organization_id],
        ],
        [
          'revoke the origin grant',
          `delete from public.person_roles where person_id=$1 and role_id=$2`,
          [b.owner_person_id, superAdmin],
        ],
        [
          'make the origin grant expire',
          `update public.person_roles set expires_at = now() + interval '1 day' where person_id=$1 and role_id=$2`,
          [b.owner_person_id, superAdmin],
        ],
        [
          'unprotect SUPER_ADMIN',
          `update public.roles set is_protected = false where id=$1`,
          [superAdmin],
        ],
        [
          'strip roles.manage from SUPER_ADMIN',
          `delete from public.role_permissions where role_id=$1 and permission_id=$2`,
          [superAdmin, manage],
        ],
      ];
      for (const [label, text, params] of attempts) {
        const e = await refused(c, text, params);
        expect(e.code, label).toBe('42501');
        expect(e.message, label).toMatch(/protected role|role management/);
      }

      // The positive control: the bootstrapped owner holds the permission, and can.
      await setIdentity(c, b.owner_person_id, b.organization_id);
      await c.query(
        `insert into public.person_roles (person_id, role_id, org_id, granted_by) values ($1,$2,$3,$4)`,
        [climber, superAdmin, b.organization_id, b.owner_person_id],
      );
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// the setup token, rehearsed
// ═════════════════════════════════════════════════════════════════════════════════

describe('the setup token, rehearsed', () => {
  it('stores only the digest, is valid only for it, and is consumed exactly once into a linked login', async () => {
    const a = argsFor('consume');
    await rehearse(async (c) => {
      const b = await bootstrapOn(c, a);
      const valid = async (digest: string) =>
        (
          await c.query<{ v: boolean }>(
            `select public.bootstrap_setup_token_is_valid(decode($1,'hex')) v`,
            [digest],
          )
        ).rows[0]!.v;

      const stored = await c.query<{ token_hash: Buffer }>(
        `select token_hash from public.bootstrap_setup_token`,
      );
      expect(stored.rows[0]!.token_hash.toString('hex')).toBe(digestOf(a.token));
      expect(await valid(digestOf(a.token))).toBe(true);
      expect(await valid(digestOf(newToken()))).toBe(false);

      const wrong = await refused(c, COMPLETE, [digestOf(newToken()), HASH_SHAPED]);
      expect(wrong.code).toBe('28000');
      const plaintext = await refused(c, COMPLETE, [digestOf(a.token), 'a plaintext password']);
      expect(plaintext.code).toBe('22023');

      const linked = (
        await c.query<{
          linked_person_id: string;
          linked_org_id: string;
          linked_auth_user_id: string;
        }>(COMPLETE, [digestOf(a.token), HASH_SHAPED])
      ).rows[0]!;
      expect(linked.linked_person_id).toBe(b.owner_person_id);
      expect(linked.linked_org_id).toBe(b.organization_id);

      const login = await c.query(
        `select p.auth_user_id, u.email::text, u.email_verified, u.two_factor_enabled,
                acc.provider_id, acc.account_id, acc.password
         from public.people p
         join auth.auth_users u on u.id = p.auth_user_id
         join auth.auth_accounts acc on acc.user_id = u.id
         where p.id=$1`,
        [b.owner_person_id],
      );
      expect(login.rows).toEqual([
        {
          auth_user_id: linked.linked_auth_user_id,
          email: a.ownerEmail,
          email_verified: false,
          two_factor_enabled: false,
          provider_id: 'credential',
          account_id: linked.linked_auth_user_id,
          password: HASH_SHAPED,
        },
      ]);

      const token = await c.query(
        `select consumed_at is not null consumed, consumed_auth_user_id from public.bootstrap_setup_token`,
      );
      expect(token.rows).toEqual([
        { consumed: true, consumed_auth_user_id: linked.linked_auth_user_id },
      ]);
      expect(await valid(digestOf(a.token))).toBe(false);

      const replay = await refused(c, COMPLETE, [digestOf(a.token), HASH_SHAPED]);
      expect(replay.code).toBe('28000');

      // The identity the function set for attribution does not outlive it.
      const context = await c.query<{ p: string }>(
        `select current_setting('app.person_id', true) p`,
      );
      expect(context.rows[0]!.p).toBe('');
    });
  });

  it('expires: a token past its lifetime is neither valid nor consumable, and says nothing more', async () => {
    const a = argsFor('expired');
    await rehearse(async (c) => {
      await bootstrapOn(c, a);
      // Backdating needs the guard out of the way; the ALTER is rolled back with the rehearsal.
      await c.query(
        `alter table public.bootstrap_setup_token disable trigger bootstrap_setup_token_guard_update`,
      );
      await c.query(
        `update public.bootstrap_setup_token
         set issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'`,
      );
      await c.query(
        `alter table public.bootstrap_setup_token enable trigger bootstrap_setup_token_guard_update`,
      );

      const valid = await c.query<{ v: boolean }>(
        `select public.bootstrap_setup_token_is_valid(decode($1,'hex')) v`,
        [digestOf(a.token)],
      );
      expect(valid.rows[0]!.v).toBe(false);
      const e = await refused(c, COMPLETE, [digestOf(a.token), HASH_SHAPED]);
      expect(e.code).toBe('28000');
      expect(e.message).toBe('bootstrap setup token is invalid, expired or already used');
    });
  });

  it('cannot be repointed, extended, re-armed or removed, and neither can the origin record', async () => {
    const a = argsFor('frozen');
    await rehearse(async (c) => {
      await bootstrapOn(c, a);
      // bootstrap_state's foreign keys are deferred, so this transaction holds pending trigger
      // events, and Postgres refuses a TRUNCATE of such a table with 55006 before any trigger of
      // ours can fire. Checking the constraints now clears them, so what follows exercises the
      // immutability triggers themselves — the same state a committed row is in.
      await c.query('set constraints all immediate');
      const attempts: [string, string][] = [
        [
          'repoint the digest',
          `update public.bootstrap_setup_token set token_hash = decode('${digestOf(newToken())}','hex')`,
        ],
        [
          'extend the expiry',
          `update public.bootstrap_setup_token set expires_at = expires_at + interval '1 minute'`,
        ],
        ['delete the token', `delete from public.bootstrap_setup_token`],
        ['truncate the token', `truncate public.bootstrap_setup_token`],
        [
          'rewrite the origin record',
          `update public.bootstrap_state set performed_by = 'app_admin'`,
        ],
        ['delete the origin record', `delete from public.bootstrap_state`],
        ['truncate the origin record', `truncate public.bootstrap_state cascade`],
      ];
      for (const [label, text] of attempts) {
        const e = await refused(c, text);
        expect(e.code, label).toBe('42501');
      }

      // The sixty-minute ceiling is a constraint, not a convention.
      await c.query(
        `alter table public.bootstrap_setup_token disable trigger bootstrap_setup_token_guard_update`,
      );
      const longer = await refused(
        c,
        `update public.bootstrap_setup_token set expires_at = issued_at + interval '61 minutes'`,
      );
      expect(longer.code).toBe('23514');
      await c.query(
        `alter table public.bootstrap_setup_token enable trigger bootstrap_setup_token_guard_update`,
      );

      // Consumed once, it can never change again — not back to unconsumed, not to another login.
      await c.query(COMPLETE, [digestOf(a.token), HASH_SHAPED]);
      const rearm = await refused(
        c,
        `update public.bootstrap_setup_token set consumed_at = null, consumed_auth_user_id = null`,
      );
      expect(rearm.message).toMatch(/consumed and can never change again/);
    });
  });

  it('will not adopt a login it did not create, nor give the bootstrap person a second one', async () => {
    await rehearse(async (c) => {
      const a = argsFor('adopt');
      const b = await bootstrapOn(c, a);
      await c.query(`insert into auth.auth_users (name, email) values ('Front Runner', $1)`, [
        a.ownerEmail,
      ]);
      const adopted = await refused(c, COMPLETE, [digestOf(a.token), HASH_SHAPED]);
      expect(adopted.code).toBe('55000');
      expect(adopted.message).toMatch(/will not be adopted/);
      const person = await c.query(`select auth_user_id from public.people where id=$1`, [
        b.owner_person_id,
      ]);
      expect(person.rows).toEqual([{ auth_user_id: null }]);
    });

    await rehearse(async (c) => {
      const a = argsFor('second-login');
      const b = await bootstrapOn(c, a);
      const other = (
        await c.query<{ id: string }>(
          `insert into auth.auth_users (name, email) values ('Linked', $1) returning id`,
          [`linked.${RUN}@example.test`],
        )
      ).rows[0]!.id;
      await c.query(`update public.people set auth_user_id=$1 where id=$2`, [
        other,
        b.owner_person_id,
      ]);
      const e = await refused(c, COMPLETE, [digestOf(a.token), HASH_SHAPED]);
      expect(e.code).toBe('55000');
      expect(e.message).toMatch(/cannot receive a login/);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// the one real bootstrap of this database — committed, and therefore last
// ═════════════════════════════════════════════════════════════════════════════════

describe('the one real bootstrap of this database, committed', () => {
  const winner = argsFor('winner');
  const loser = argsFor('loser');
  const passwords = ['first racer password 01', 'second racer password 02'] as const;
  let b: Bootstrapped;
  let winningPassword = '';

  const completeRequest = (token: string, password: string) =>
    POST(
      new Request('http://localhost:3000/api/bootstrap/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      }),
    );

  it('lets exactly one of two concurrent attempts succeed, and leaves nothing of the other', async () => {
    const first = await owner.connect();
    const second = await owner.connect();
    let outcome: Outcome;
    try {
      await first.query('begin');
      b = await bootstrapOn(first, winner);

      const pid = (await second.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid;
      const racing = settle(bootstrapOn(second, loser));
      // The loser has written nothing: it is waiting on the gate row, the first write.
      expect(await waitsOnLock(pid)).toBe(true);

      await first.query('commit');
      outcome = await racing;
    } finally {
      first.release();
      second.release();
    }

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('55000');
      expect(outcome.error.message).toMatch(/already been bootstrapped/);
    }

    const { rows } = await owner.query(
      `select
         (select count(*)::int from public.bootstrap_state) gates,
         (select count(*)::int from public.organizations where slug = any($1::text[])) organizations,
         (select count(*)::int from public.people where work_email::text = any($2::text[])) people,
         (select count(*)::int from public.engagements e join public.people p on p.id=e.person_id
            where p.work_email::text = any($2::text[]) and e.status='ACTIVE') active_engagements,
         (select count(*)::int from public.person_roles pr
            join public.roles r on r.id=pr.role_id join public.people p on p.id=pr.person_id
            where p.work_email::text = any($2::text[]) and r.key='SUPER_ADMIN' and pr.granted_by is null) origin_grants,
         (select count(*)::int from public.bootstrap_setup_token) tokens`,
      [
        [winner.orgSlug, loser.orgSlug],
        [winner.ownerEmail, loser.ownerEmail],
      ],
    );
    expect(rows[0]).toEqual({
      gates: 1,
      organizations: 1,
      people: 1,
      active_engagements: 1,
      origin_grants: 1,
      tokens: 1,
    });

    const survivors = await owner.query(
      `select (select count(*)::int from public.organizations where slug=$1) organizations,
              (select count(*)::int from public.people where work_email=$2) people`,
      [loser.orgSlug, loser.ownerEmail],
    );
    expect(survivors.rows[0]).toEqual({ organizations: 0, people: 0 });

    const state = await owner.query(
      `select org_id, person_id, engagement_id from public.bootstrap_state`,
    );
    expect(state.rows).toEqual([
      {
        org_id: b.organization_id,
        person_id: b.owner_person_id,
        engagement_id: b.owner_engagement_id,
      },
    ]);
  });

  it('refuses any later bootstrap, whatever it names', async () => {
    const late = argsFor('latecomer');
    await expect(owner.query(BOOTSTRAP, paramsFor(late))).rejects.toMatchObject({ code: '55000' });
    const { rows } = await owner.query(
      `select (select count(*)::int from public.bootstrap_state) gates,
              (select count(*)::int from public.organizations where slug=$1) organizations`,
      [late.orgSlug],
    );
    expect(rows[0]).toEqual({ gates: 1, organizations: 0 });
  });

  it('can never be rewritten, removed or truncated once committed — not even by the owner role', async () => {
    for (const text of [
      `update public.bootstrap_state set performed_by = 'app_admin'`,
      `delete from public.bootstrap_state`,
      `truncate public.bootstrap_state cascade`,
      `update public.bootstrap_setup_token set expires_at = expires_at + interval '1 minute'`,
      `delete from public.bootstrap_setup_token`,
      `truncate public.bootstrap_setup_token`,
    ]) {
      await expect(owner.query(text), text).rejects.toMatchObject({ code: '42501' });
    }
    expect(await count(owner, `select count(*)::int n from public.bootstrap_state`)).toBe(1);
    // and the token those attempts aimed at is untouched and still live
    expect(await isValid(winner.token)).toBe(true);
  });

  it('keeps the committed SUPER_ADMIN origin grant out of reach of anybody without roles.manage', async () => {
    const superAdmin = (
      await owner.query<{ id: string }>(
        `select id from public.roles where org_id=$1 and key='SUPER_ADMIN'`,
        [b.organization_id],
      )
    ).rows[0]!.id;
    const manage = (
      await owner.query<{ id: string }>(
        `select id from public.permissions where key='roles.manage'`,
      )
    ).rows[0]!.id;
    const code = (
      await owner.query<{ c: string }>(`select authz.next_identity_code($1,'EMP','2026') c`, [
        b.organization_id,
      ])
    ).rows[0]!.c;
    const climber = (
      await owner.query<{ id: string }>(
        `insert into public.people (org_id, code, full_legal_name, person_status)
         values ($1, $2, 'Committed Climber', 'ACTIVE') returning id`,
        [b.organization_id, code],
      )
    ).rows[0]!.id;

    const attempts: [string, unknown[]][] = [
      [
        `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
        [climber, superAdmin, b.organization_id],
      ],
      [
        `delete from public.person_roles where person_id=$1 and role_id=$2`,
        [b.owner_person_id, superAdmin],
      ],
      [`update public.roles set is_protected = false where id=$1`, [superAdmin]],
      [
        `delete from public.role_permissions where role_id=$1 and permission_id=$2`,
        [superAdmin, manage],
      ],
    ];
    for (const [text, params] of attempts) {
      await expect(owner.query(text, params), text).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      asUser.query(
        `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
        [climber, superAdmin, b.organization_id],
      ),
    ).rejects.toThrow(/permission denied/i);

    const grants = await owner.query(
      `select person_id, granted_by from public.person_roles where role_id=$1`,
      [superAdmin],
    );
    expect(grants.rows).toEqual([{ person_id: b.owner_person_id, granted_by: null }]);
  });

  it('wrote no audit entry for the bootstrap, and attributed nothing to the owner', async () => {
    expect(
      await count(
        owner,
        `select count(*)::int n from public.audit_logs
         where entity_id = any($1::uuid[]) or actor_person_id = $2`,
        [[b.organization_id, b.owner_person_id, b.owner_engagement_id], b.owner_person_id],
      ),
    ).toBe(0);
    expect(
      await count(
        owner,
        `select count(*)::int n from public.audit_logs where actor_person_id is null`,
      ),
    ).toBe(0);
  });

  it('completes setup exactly once, even when two requests race with the same token', async () => {
    // Refusals first: none of them may disturb a live token.
    expect((await completeRequest(newToken(), passwords[0])).status).toBe(400);
    expect((await completeRequest(winner.token, 'too short')).status).toBe(400);
    expect(await isValid(winner.token)).toBe(true);

    const responses = await Promise.all(passwords.map((p) => completeRequest(winner.token, p)));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    const refusedResponse = responses.find((r) => r.status === 400)!;
    expect(await refusedResponse.json()).toEqual({ error: 'SETUP_TOKEN_INVALID' });
    winningPassword = passwords[responses.findIndex((r) => r.status === 200)]!;

    expect(await isValid(winner.token)).toBe(false);
    expect((await completeRequest(winner.token, winningPassword)).status).toBe(400);
  });

  it('created the login in Better Auth’s own shape, linked to the bootstrap person and nobody else', async () => {
    const { rows } = await owner.query<{
      auth_user_id: string;
      email: string;
      email_verified: boolean;
      two_factor_enabled: boolean;
      provider_id: string;
      account_id: string;
      scrypt_shaped: boolean;
      consumed_auth_user_id: string;
    }>(
      `select p.auth_user_id, u.email::text, u.email_verified, u.two_factor_enabled,
              acc.provider_id, acc.account_id,
              acc.password ~ '^[0-9a-f]{32}:[0-9a-f]{128}$' scrypt_shaped,
              t.consumed_auth_user_id
       from public.people p
       join auth.auth_users u on u.id = p.auth_user_id
       join auth.auth_accounts acc on acc.user_id = u.id
       cross join public.bootstrap_setup_token t
       where p.id=$1`,
      [b.owner_person_id],
    );
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.email).toBe(winner.ownerEmail);
    expect(row.email_verified).toBe(false);
    expect(row.two_factor_enabled).toBe(false);
    expect(row.provider_id).toBe('credential');
    expect(row.account_id).toBe(row.auth_user_id);
    expect(row.scrypt_shaped).toBe(true);
    expect(row.consumed_auth_user_id).toBe(row.auth_user_id);
    expect(
      await count(owner, `select count(*)::int n from auth.auth_users where email=$1`, [
        winner.ownerEmail,
      ]),
    ).toBe(1);
  });

  it('lets the owner sign in with the password that won, and only that one, at aal1', async () => {
    const losingPassword = passwords.find((p) => p !== winningPassword)!;
    expect((await signInRaw(winner.ownerEmail, losingPassword)).ok).toBe(false);

    const res = await signInRaw(winner.ownerEmail, winningPassword);
    expect(res.ok).toBe(true);
    const ctx = await resolveAuthContext(new Headers({ cookie: cookieFrom(res) }));
    expect(ctx).toEqual({ personId: b.owner_person_id, orgId: b.organization_id, aal: 'aal1' });

    const gate = await withAuthorizedDb(ctx!, (tx) =>
      tx.execute(
        sql`select authz.is_active() active, authz.scope_for('roles.manage')::text roles, authz.aal() aal`,
      ),
    );
    expect(gate.rows[0]).toEqual({ active: true, roles: 'GLOBAL', aal: 'aal1' });
  });

  it('reaches aal2 only by enrolling and verifying a second factor, like anybody else', async () => {
    const signedIn = await signInRaw(winner.ownerEmail, winningPassword);
    const cookie = cookieFrom(signedIn);
    const enabled = await auth.api.enableTwoFactor({
      body: { password: winningPassword },
      headers: new Headers({ cookie }),
    });
    if (enabled.method !== 'totp') throw new Error('expected a TOTP enrolment');
    const secret = new URL(enabled.totpURI).searchParams.get('secret')!;

    const verified = (await auth.api.verifyTOTP({
      body: { code: totp(secret) },
      headers: new Headers({ cookie }),
      asResponse: true,
    })) as Response;
    expect(verified.ok).toBe(true);

    const ctx = await resolveAuthContext(new Headers({ cookie: cookieFrom(verified) }));
    expect(ctx).toEqual({ personId: b.owner_person_id, orgId: b.organization_id, aal: 'aal2' });
    const level = await withAuthorizedDb(ctx!, (tx) => tx.execute(sql`select authz.aal() aal`));
    expect(level.rows[0]).toEqual({ aal: 'aal2' });
  });

  it('records completion as the owner’s own act, and carries the origin as what it was', async () => {
    const completed = await owner.query<{
      actor_person_id: string;
      org_id: string;
      severity: string;
      result: string;
      metadata: Record<string, unknown>;
    }>(
      `select actor_person_id, org_id, severity, result::text, metadata from public.audit_logs
       where action='bootstrap.setup_completed' and entity_id=$1`,
      [b.owner_person_id],
    );
    expect(completed.rows.length).toBe(1);
    expect(completed.rows[0]).toMatchObject({
      actor_person_id: b.owner_person_id,
      org_id: b.organization_id,
      severity: 'CRITICAL',
      result: 'SUCCESS',
    });
    expect(completed.rows[0]!.metadata).toMatchObject({
      source: 'bootstrap',
      origin: {
        performed_by: 'app_owner',
        engagement_id: b.owner_engagement_id,
        grant: { role: 'SUPER_ADMIN', granted_by: null },
      },
    });

    const link = await owner.query<{ actor_person_id: string; linked: string }>(
      `select actor_person_id, after->>'auth_user_id' linked from public.audit_logs
       where action='person.updated' and entity_id=$1`,
      [b.owner_person_id],
    );
    expect(link.rows.length).toBe(1);
    expect(link.rows[0]!.actor_person_id).toBe(b.owner_person_id);
    expect(link.rows[0]!.linked).toBeTruthy();

    // Nothing anywhere claims the owner granted themselves SUPER_ADMIN.
    expect(
      await count(
        owner,
        `select count(*)::int n from public.audit_logs where entity_type='person_role' and entity_id=$1`,
        [b.owner_person_id],
      ),
    ).toBe(0);
    expect(
      await count(
        owner,
        `select count(*)::int n from public.audit_logs where actor_person_id is null`,
      ),
    ).toBe(0);
  });

  it('left the token and both passwords nowhere in the database, and the digest out of the audit log', async () => {
    const patterns = [winner.token, ...passwords].map((s) => `%${s}%`);
    const tables = await owner.query<{ s: string; t: string }>(
      `select n.nspname s, c.relname t from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname in ('public','auth') and c.relkind in ('r','p') and not c.relispartition
       order by 1, 2`,
    );
    expect(tables.rows.length).toBeGreaterThan(10);
    for (const { s, t } of tables.rows) {
      expect(
        await count(
          owner,
          `select count(*)::int n from "${s}"."${t}" x where x::text like any($1)`,
          [patterns],
        ),
        `${s}.${t}`,
      ).toBe(0);
    }

    const hash = (
      await owner.query<{ password: string }>(
        `select acc.password from auth.auth_accounts acc
         join public.people p on p.auth_user_id = acc.user_id where p.id=$1`,
        [b.owner_person_id],
      )
    ).rows[0]!.password;
    expect(
      await count(
        owner,
        `select count(*)::int n from public.audit_logs x where x::text like any($1)`,
        [[`%${digestOf(winner.token)}%`, `%${hash}%`]],
      ),
    ).toBe(0);
  });

  it('is inert afterwards: no token completes, and no bootstrap starts', async () => {
    for (const token of [winner.token, newToken()]) {
      expect(await completeBootstrapSetup({ token, password: 'another long password 03' })).toEqual(
        { ok: false, reason: 'SETUP_TOKEN_INVALID' },
      );
    }
    await expect(owner.query(BOOTSTRAP, paramsFor(argsFor('afterwards')))).rejects.toMatchObject({
      code: '55000',
    });
    expect(await count(owner, `select count(*)::int n from public.bootstrap_state`)).toBe(1);
  });
});
