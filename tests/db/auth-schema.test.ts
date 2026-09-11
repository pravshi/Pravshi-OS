import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { authDbSchema } from '@/lib/auth/schema';
import { getTableConfig } from 'drizzle-orm/pg-core';

/**
 * Task 1.12 — the auth schema as a security boundary.
 *
 * The claim being tested is not "Better Auth has tables" but "the exception these tables
 * represent is bounded": they are outside `public`, the public RLS guard still means what
 * it says, app_user's rights are enumerated rather than inherited, and app_admin has none.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);

const AUTH_TABLES = [
  'auth_accounts',
  'auth_rate_limits',
  'auth_sessions',
  'auth_users',
  'auth_verifications',
] as const;

let orgA = '';
let deptA = '';

const mkPerson = async (org: string, name: string, authUserId: string | null = null) => {
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

const mkAuthUser = async (email: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into auth.auth_users (id, name, email)
       values (gen_random_uuid(), $1, $2) returning id`,
      ['Test Login', email],
    )
  ).rows[0]!.id;

const resolve = async (authUserId: string, sessionCreatedAt = 'now()') =>
  (
    await owner.query<{ person_id: string; org_id: string }>(
      `select person_id, org_id from public.resolve_auth_identity($1::uuid, ${sessionCreatedAt})`,
      [authUserId],
    )
  ).rows;

beforeAll(async () => {
  orgA = (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name,slug) values ($1,$2) returning id`,
      [`Au ${RUN}`, `authsch-${RUN}`],
    )
  ).rows[0]!.id;
  deptA = (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id,code,name) values ($1,$2,$3) returning id`,
      [orgA, `A${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, 'Auth Dept'],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

describe('the auth schema', () => {
  it('exists, owned by app_owner', async () => {
    const { rows } = await owner.query<{ nspname: string; owner: string }>(
      `select n.nspname, r.rolname owner from pg_namespace n
       join pg_roles r on r.oid = n.nspowner where n.nspname='auth'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.owner).toBe('app_owner');
  });

  it('holds exactly the five Better Auth tables and nothing else', async () => {
    const { rows } = await owner.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname='auth' order by tablename`,
    );
    expect(rows.map((r) => r.tablename)).toEqual([...AUTH_TABLES]);
  });

  it('puts none of them in public, so the RLS guard keeps its promise', async () => {
    const inPublic = await owner.query(
      `select 1 from pg_tables where schemaname='public' and tablename like 'auth\\_%'`,
    );
    expect(inPublic.rows).toEqual([]);

    // and the guard's own query still finds nothing unprotected
    const unprotected = await owner.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind in ('r','p')
         and c.relname not like '\\_%' and c.relname <> '__drizzle_migrations'
         and (not c.relrowsecurity or not c.relforcerowsecurity)`,
    );
    expect(unprotected.rows).toEqual([]);
  });

  it('uses uuid primary keys, so people.auth_user_id keeps its approved type', async () => {
    const { rows } = await owner.query<{ table_name: string; data_type: string }>(
      `select table_name, data_type from information_schema.columns
       where table_schema='auth' and column_name='id' order by table_name`,
    );
    expect(rows.length).toBe(5);
    for (const r of rows) expect(r.data_type, r.table_name).toBe('uuid');

    const personCol = await owner.query<{ data_type: string }>(
      `select data_type from information_schema.columns
       where table_schema='public' and table_name='people' and column_name='auth_user_id'`,
    );
    expect(personCol.rows[0]!.data_type).toBe('uuid');
  });

  it('stores the login email case-insensitively', async () => {
    const { rows } = await owner.query<{ udt_name: string }>(
      `select udt_name from information_schema.columns
       where table_schema='auth' and table_name='auth_users' and column_name='email'`,
    );
    expect(rows[0]!.udt_name).toBe('citext');

    const email = `Case.${RUN}@example.test`;
    await mkAuthUser(email);
    await expect(mkAuthUser(email.toLowerCase())).rejects.toThrow();
  });

  it('matches the Drizzle definitions column for column', async () => {
    // The SQL migration creates these tables and this file describes them. Two descriptions
    // of one thing drift; this is what stops that happening quietly.
    for (const [model, table] of Object.entries(authDbSchema)) {
      const config = getTableConfig(table);
      const declared = config.columns.map((c) => c.name).sort();
      const { rows } = await owner.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema='auth' and table_name=$1`,
        [model],
      );
      expect(rows.map((r) => r.column_name).sort(), model).toEqual(declared);
      expect(config.schema, `${model} must live in the auth schema`).toBe('auth');
    }
  });
});

describe('privilege posture', () => {
  it('grants app_user only what each table needs, and app_admin nothing', async () => {
    const { rows } = await owner.query<{ table_name: string; grantee: string; privs: string }>(
      `select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) privs
       from information_schema.table_privileges
       where table_schema='auth' and grantee <> 'app_owner'
       group by table_name, grantee order by table_name, grantee`,
    );
    const byTable = new Map(rows.map((r) => [`${r.table_name}:${r.grantee}`, r.privs]));

    // A login is disabled, never deleted — the audit trail and people row both point at it.
    expect(byTable.get('auth_users:app_user')).toBe('INSERT,SELECT,UPDATE');
    // Sessions, tokens and counters are consumed or revoked in normal operation.
    for (const t of ['auth_sessions', 'auth_accounts', 'auth_verifications', 'auth_rate_limits']) {
      expect(byTable.get(`${t}:app_user`), t).toBe('DELETE,INSERT,SELECT,UPDATE');
    }
    // app_admin is for bootstrap, provisioning and the audit writer. Authentication is none.
    expect(rows.filter((r) => r.grantee === 'app_admin')).toEqual([]);
    expect(rows.filter((r) => r.grantee === 'PUBLIC')).toEqual([]);
  });

  it('gives app_admin no way into the schema at all', async () => {
    const { rows } = await owner.query<{ has: boolean }>(
      `select has_schema_privilege('app_admin','auth','USAGE') has`,
    );
    expect(rows[0]!.has).toBe(false);
  });

  it('lets app_user reach the credential store only through these grants', async () => {
    // It can read its own tables...
    const ok = await asUser.query(`select count(*) from auth.auth_sessions`);
    expect(ok.rows.length).toBe(1);
    // ...and cannot create anything new in the schema.
    await expect(asUser.query(`create table auth.sneaky (id uuid primary key)`)).rejects.toThrow(
      /permission denied/i,
    );
    // ...nor delete a login.
    await expect(asUser.query(`delete from auth.auth_users`)).rejects.toThrow(/permission denied/i);
  });

  it('does not enable RLS here, and says so rather than leaving it ambiguous', async () => {
    const { rows } = await owner.query<{ relname: string; rls: boolean }>(
      `select c.relname, c.relrowsecurity rls from pg_class c
       join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='auth' and c.relkind='r'`,
    );
    // Deliberate: the auth server is the only reader and must see the rows it owns. The
    // boundary is the schema and the enumerated grants, documented in 0013.
    for (const r of rows) expect(r.rls, r.relname).toBe(false);

    const comment = await owner.query<{ c: string }>(
      `select obj_description(oid, 'pg_namespace') c from pg_namespace where nspname='auth'`,
    );
    expect(comment.rows[0]!.c).toMatch(/deliberate boundary/i);
  });
});

describe('the link to people', () => {
  it('is a foreign key with no cascade, so deleting a login cannot delete a person', async () => {
    const { rows } = await owner.query<{ confdeltype: string; def: string }>(
      `select c.confdeltype, pg_get_constraintdef(c.oid) def
       from pg_constraint c where c.conname='people_auth_user_fk'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.confdeltype).toBe('a'); // NO ACTION
    expect(rows[0]!.def).toMatch(/REFERENCES auth\.auth_users\(id\)/);
    expect(rows[0]!.def).not.toMatch(/CASCADE/);
  });

  it('refuses a person pointing at a login that does not exist', async () => {
    await expect(
      mkPerson(orgA, 'Ghost Login', '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow();
  });

  it('refuses to delete a login while a person still points at it', async () => {
    const login = await mkAuthUser(`linked.${RUN}@example.test`);
    await mkPerson(orgA, 'Linked', login);
    await expect(owner.query(`delete from auth.auth_users where id=$1`, [login])).rejects.toThrow();
  });

  it('keeps the relationship one-to-one', async () => {
    const login = await mkAuthUser(`shared.${RUN}@example.test`);
    await mkPerson(orgA, 'First Claim', login);
    await expect(mkPerson(orgA, 'Second Claim', login)).rejects.toThrow();
  });

  it('allows a person with no login, which is most of them', async () => {
    const person = await mkPerson(orgA, 'No Login Yet');
    const { rows } = await owner.query<{ auth_user_id: string | null }>(
      `select auth_user_id from public.people where id=$1`,
      [person],
    );
    expect(rows[0]!.auth_user_id).toBeNull();
  });
});

describe('resolve_auth_identity()', () => {
  it('is SECURITY DEFINER, STABLE, search_path pinned, granted only to app_user', async () => {
    const { rows } = await owner.query<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
      owner: string;
      grantees: string[];
    }>(
      `select p.prosecdef, p.provolatile, p.proconfig, r.rolname owner,
              coalesce(array_agg(coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC'))
                       filter (where ac.privilege_type='EXECUTE'), '{}') grantees
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       join pg_roles r on r.oid=p.proowner
       left join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ac on true
       where n.nspname='public' and p.proname='resolve_auth_identity'
       group by p.prosecdef, p.provolatile, p.proconfig, r.rolname`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.prosecdef).toBe(true);
    expect(rows[0]!.provolatile).toBe('s');
    expect(rows[0]!.proconfig ?? []).toContain('search_path=""');
    expect(rows[0]!.owner).toBe('app_owner');
    expect(rows[0]!.grantees).not.toContain('PUBLIC');
    expect(rows[0]!.grantees).toContain('app_user');
    expect(rows[0]!.grantees, 'authentication is not an app_admin path').not.toContain('app_admin');
  });

  it('takes no organization parameter, so a caller cannot propose a tenant', async () => {
    const { rows } = await owner.query<{ args: string }>(
      `select pg_get_function_arguments(p.oid) args from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='resolve_auth_identity'`,
    );
    expect(rows[0]!.args).toBe(
      'p_auth_user_id uuid, p_session_created_at timestamp with time zone',
    );
  });

  it('resolves a linked, active person and derives the organization from their row', async () => {
    const login = await mkAuthUser(`resolve.${RUN}@example.test`);
    const person = await mkPerson(orgA, 'Resolvable', login);
    const rows = await resolve(login);
    expect(rows.length).toBe(1);
    expect(rows[0]!.person_id).toBe(person);
    expect(rows[0]!.org_id).toBe(orgA);
  });

  it('resolves nothing for a login no person points at', async () => {
    const orphan = await mkAuthUser(`orphan.${RUN}@example.test`);
    expect(await resolve(orphan)).toEqual([]);
  });

  it('creates nothing when it refuses', async () => {
    const orphan = await mkAuthUser(`nothing.${RUN}@example.test`);
    expect(await resolve(orphan)).toEqual([]);
    // Scoped to this login. Other test files create people concurrently, so a global
    // count would be measuring the rest of the suite rather than this behaviour.
    const { rows } = await owner.query<{ people: string; roles: string }>(
      `select (select count(*) from public.people where auth_user_id = $1) people,
              (select count(*) from public.person_roles pr
                 join public.people p on p.id = pr.person_id
                where p.auth_user_id = $1) roles`,
      [orphan],
    );
    expect(rows[0]).toEqual({ people: '0', roles: '0' });
  });

  it('resolves nothing for a soft-deleted or non-ACTIVE person', async () => {
    const login = await mkAuthUser(`dead.${RUN}@example.test`);
    const person = await mkPerson(orgA, 'Deletable', login);
    expect((await resolve(login)).length).toBe(1);

    await owner.query(`update public.people set person_status='INACTIVE' where id=$1`, [person]);
    expect(await resolve(login)).toEqual([]);

    await owner.query(
      `update public.people set person_status='ACTIVE', deleted_at=now() where id=$1`,
      [person],
    );
    expect(await resolve(login)).toEqual([]);
  });

  it('refuses a session issued before sessions_revoked_at, and accepts one issued after', async () => {
    const login = await mkAuthUser(`revoked.${RUN}@example.test`);
    const person = await mkPerson(orgA, 'Revocable', login);
    expect((await resolve(login)).length).toBe(1);

    await owner.query(`update public.people set sessions_revoked_at=now() where id=$1`, [person]);
    expect(await resolve(login, `now() - interval '1 hour'`)).toEqual([]);
    expect((await resolve(login, `now() + interval '1 hour'`)).length).toBe(1);
  });

  it('still resolves a person whose engagement has ended, leaving that to authz.is_active()', async () => {
    // Blueprint 7.4 asks "authenticated?" before "engaged?". Conflating them here would put
    // a second copy of the access model in the auth layer, free to disagree with the first.
    const login = await mkAuthUser(`offboarded.${RUN}@example.test`);
    const person = await mkPerson(orgA, 'Offboarded', login);
    await owner.query(
      `insert into public.engagements
         (org_id,person_id,department_id,engagement_type,status,start_date)
       values ($1,$2,$3,'EMPLOYEE','ARCHIVED',current_date)`,
      [orgA, person, deptA],
    );
    expect((await resolve(login)).length).toBe(1);

    // ...and reaches nothing, because is_active() says so
    const c = await asUser.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.person_id',$1,true)`, [person]);
      const active = await c.query<{ a: boolean }>(`select authz.is_active() a`);
      expect(active.rows[0]!.a).toBe(false);
      const visible = await c.query(`select * from public.people`);
      expect(visible.rows.length).toBe(1); // their own row, by SELF policy
      const roles = await c.query(`select * from public.roles`);
      expect(roles.rows).toEqual([]);
      await c.query('commit');
    } finally {
      c.release();
    }
  });

  it('is callable by app_user, which is the whole point of it existing', async () => {
    const login = await mkAuthUser(`byuser.${RUN}@example.test`);
    const person = await mkPerson(orgA, 'By App User', login);
    const { rows } = await asUser.query<{ person_id: string; org_id: string }>(
      `select person_id, org_id from public.resolve_auth_identity($1::uuid, now())`,
      [login],
    );
    expect(rows[0]).toEqual({ person_id: person, org_id: orgA });
  });

  it('does not let app_user read public.people directly instead', async () => {
    // The function exists because this returns nothing without an identity in the
    // transaction — which is exactly the state the auth layer is in.
    const { rows } = await asUser.query(`select * from public.people`);
    expect(rows).toEqual([]);
  });
});
