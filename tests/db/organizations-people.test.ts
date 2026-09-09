import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Task 1.2 — organizations, people, and the first real RLS policies.
 *
 * Every authorization assertion runs as a REAL database role over a REAL connection.
 * Nothing about RLS is mocked: a mocked policy proves only that the mock works.
 *
 *   owner (DATABASE_URL_MIGRATE, app_owner) — seeds fixtures, inspects the catalogue
 *   user  (DATABASE_URL_TEST,    app_user)  — the runtime role, where the boundary is
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

/** Unique per run: these tables are permanent and the suite must be re-runnable. */
const RUN = Math.random().toString(36).slice(2, 8);

let orgA = '';
let orgB = '';
let alice = ''; // in orgA
let bob = ''; // in orgA
let carol = ''; // in orgB
let deletedPerson = ''; // in orgA, soft-deleted

/** Runs a query inside a transaction carrying the identity context, as withAuthorizedDb does. */
async function asPerson<T>(
  ctx: { personId: string | null; orgId: string | null },
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = await asUser.connect();
  try {
    await c.query('begin');
    await c.query(
      `select set_config('app.person_id', $1, true), set_config('app.org_id', $2, true)`,
      [ctx.personId ?? '', ctx.orgId ?? ''],
    );
    const r = await c.query(sql, params);
    await c.query('commit');
    return r.rows as T[];
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  const org = async (slug: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name, slug) values ($1, $2) returning id`,
        [`Org ${slug}`, slug],
      )
    ).rows[0]!.id;

  orgA = await org(`${RUN}-a`);
  orgB = await org(`${RUN}-b`);

  const person = async (org: string, name: string) => {
    const code = (
      await owner.query<{ code: string }>(
        `select authz.next_identity_code($1::uuid, 'EMP', '2026') as code`,
        [org],
      )
    ).rows[0]!.code;
    return (
      await owner.query<{ id: string }>(
        `insert into public.people (org_id, code, full_legal_name, person_status)
         values ($1, $2, $3, 'ACTIVE') returning id`,
        [org, code, name],
      )
    ).rows[0]!.id;
  };

  alice = await person(orgA, 'Alice');
  bob = await person(orgA, 'Bob');
  carol = await person(orgB, 'Carol');
  deletedPerson = await person(orgA, 'Deleted');
  await owner.query(`update public.people set deleted_at = now() where id = $1`, [deletedPerson]);
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

describe('schema', () => {
  it('created both tables with uuid primary keys', async () => {
    const { rows } = await owner.query<{ table_name: string; data_type: string }>(
      `select c.table_name, c.data_type from information_schema.columns c
       where c.table_schema='public' and c.column_name='id'
         and c.table_name in ('organizations','people') order by c.table_name`,
    );
    expect(rows.map((r) => `${r.table_name}:${r.data_type}`)).toEqual([
      'organizations:uuid',
      'people:uuid',
    ]);
  });

  it('people.org_id references organizations', async () => {
    const { rows } = await owner.query<{ n: number }>(
      `select count(*)::int n from information_schema.table_constraints tc
       join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
       where tc.table_name='people' and tc.constraint_type='FOREIGN KEY'
         and ccu.table_name='organizations'`,
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
  });

  it('rejects a person in a non-existent organization', async () => {
    await expect(
      owner.query(
        `insert into public.people (org_id, code, full_legal_name)
         values (gen_random_uuid(), 'EMP-2026-9999', 'Ghost')`,
      ),
    ).rejects.toThrow();
  });

  it('enforces the person code format', async () => {
    await expect(
      owner.query(
        `insert into public.people (org_id, code, full_legal_name) values ($1,'nope','X')`,
        [orgA],
      ),
    ).rejects.toThrow();
  });

  it('enforces unique person codes per organization', async () => {
    const code = (
      await owner.query<{ code: string }>(
        `select authz.next_identity_code($1::uuid,'EMP','2026') as code`,
        [orgA],
      )
    ).rows[0]!.code;
    await owner.query(
      `insert into public.people (org_id, code, full_legal_name) values ($1,$2,'First')`,
      [orgA, code],
    );
    await expect(
      owner.query(
        `insert into public.people (org_id, code, full_legal_name) values ($1,$2,'Duplicate')`,
        [orgA, code],
      ),
    ).rejects.toThrow();
  });

  it('keeps a soft-deleted code reserved — it is never reissued', async () => {
    const { rows } = await owner.query<{ code: string }>(
      `select code from public.people where id = $1`,
      [deletedPerson],
    );
    await expect(
      owner.query(
        `insert into public.people (org_id, code, full_legal_name) values ($1,$2,'Reuse')`,
        [orgA, rows[0]!.code],
      ),
    ).rejects.toThrow();
  });
});

describe('person code immutability', () => {
  it('rejects an UPDATE of code as app_owner — the highest-privileged writer', async () => {
    await expect(
      owner.query(`update public.people set code = 'EMP-2026-0999' where id = $1`, [alice]),
    ).rejects.toThrow(/immutable/i);
  });

  it('allows other columns to be updated', async () => {
    await owner.query(`update public.people set preferred_name = 'Ally' where id = $1`, [alice]);
    const { rows } = await owner.query<{ preferred_name: string }>(
      `select preferred_name from public.people where id = $1`,
      [alice],
    );
    expect(rows[0]!.preferred_name).toBe('Ally');
  });

  it('maintains updated_at by trigger', async () => {
    const before = await owner.query<{ updated_at: Date }>(
      `select updated_at from public.people where id = $1`,
      [bob],
    );
    await owner.query(`update public.people set location = 'Hyderabad' where id = $1`, [bob]);
    const after = await owner.query<{ updated_at: Date }>(
      `select updated_at from public.people where id = $1`,
      [bob],
    );
    expect(after.rows[0]!.updated_at.valueOf()).toBeGreaterThan(
      before.rows[0]!.updated_at.valueOf(),
    );
  });
});

describe('RLS is enabled and forced', () => {
  it('on both tables', async () => {
    const { rows } = await owner.query<{ relname: string; enabled: boolean; forced: boolean }>(
      `select relname, relrowsecurity enabled, relforcerowsecurity forced
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and relname in ('organizations','people') order by relname`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.enabled, `${r.relname} RLS enabled`).toBe(true);
      expect(r.forced, `${r.relname} RLS forced`).toBe(true);
    }
  });

  it('leaves no table in public unprotected — the Phase 0 guard, applied here', async () => {
    const { rows } = await owner.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r'
         and c.relname <> '__drizzle_migrations'
         and (not c.relrowsecurity or not c.relforcerowsecurity)`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});

describe('the runtime role cannot bypass RLS', () => {
  it('has no BYPASSRLS, is not superuser, owns nothing', async () => {
    const role = await asUser.query<{ b: boolean; s: boolean }>(
      `select rolbypassrls b, rolsuper s from pg_roles where rolname = current_user`,
    );
    expect(role.rows[0]!.b).toBe(false);
    expect(role.rows[0]!.s).toBe(false);
    const owned = await asUser.query<{ n: number }>(
      `select count(*)::int n from pg_class c join pg_roles g on g.oid=c.relowner
       where g.rolname = current_user and c.relkind='r'`,
    );
    expect(owned.rows[0]!.n).toBe(0);
  });

  it('holds no write grant on either table', async () => {
    const { rows } = await asUser.query<{ t: string; p: string }>(
      `select table_name t, privilege_type p from information_schema.table_privileges
       where grantee='app_user' and table_name in ('organizations','people')
         and privilege_type in ('INSERT','UPDATE','DELETE')`,
    );
    expect(rows).toEqual([]);
  });

  it('cannot INSERT, UPDATE or DELETE people', async () => {
    await expect(
      asUser.query(
        `insert into public.people (org_id, code, full_legal_name) values ($1,'EMP-2026-8888','Hax')`,
        [orgA],
      ),
    ).rejects.toThrow();
    await expect(
      asUser.query(`update public.people set full_legal_name = 'Hax'`),
    ).rejects.toThrow();
    await expect(asUser.query(`delete from public.people`)).rejects.toThrow();
  });
});

describe('fail-closed: no identity means no rows', () => {
  it('returns zero people outside an identity context', async () => {
    const { rows } = await asUser.query<{ n: string }>(`select count(*) n from public.people`);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('returns zero organizations outside an identity context', async () => {
    const { rows } = await asUser.query<{ n: string }>(
      `select count(*) n from public.organizations`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe('scoped access', () => {
  it('a person sees only themselves — SELF scope', async () => {
    const rows = await asPerson<{ id: string }>(
      { personId: alice, orgId: orgA },
      `select id from public.people`,
    );
    expect(rows.map((r) => r.id)).toEqual([alice]);
  });

  it('a person cannot see a colleague in the same organization', async () => {
    const rows = await asPerson<{ id: string }>(
      { personId: alice, orgId: orgA },
      `select id from public.people where id = $1`,
      [bob],
    );
    expect(rows).toEqual([]);
  });

  it('cross-tenant access is denied even with a valid person id', async () => {
    // Alice's real id, but pointed at the wrong organization.
    const rows = await asPerson<{ id: string }>(
      { personId: alice, orgId: orgB },
      `select id from public.people`,
    );
    expect(rows).toEqual([]);
  });

  it('a person in another organization cannot be read', async () => {
    const rows = await asPerson<{ id: string }>(
      { personId: alice, orgId: orgA },
      `select id from public.people where id = $1`,
      [carol],
    );
    expect(rows).toEqual([]);
  });

  it('excludes soft-deleted rows from the policy itself', async () => {
    const rows = await asPerson<{ id: string }>(
      { personId: deletedPerson, orgId: orgA },
      `select id from public.people`,
    );
    expect(rows, 'a soft-deleted person cannot even see themselves').toEqual([]);
  });

  it('an organization sees itself and no other', async () => {
    const rows = await asPerson<{ id: string }>(
      { personId: alice, orgId: orgA },
      `select id from public.organizations`,
    );
    expect(rows.map((r) => r.id)).toEqual([orgA]);
  });

  it('a soft-deleted organization is invisible', async () => {
    const tmp = (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name, slug, deleted_at)
         values ('Gone', $1, now()) returning id`,
        [`${RUN}-gone`],
      )
    ).rows[0]!.id;
    const rows = await asPerson<{ id: string }>(
      { personId: alice, orgId: tmp },
      `select id from public.organizations`,
    );
    expect(rows).toEqual([]);
  });
});

describe('pooled-connection isolation', () => {
  it('identity does not leak between successive transactions on one pool', async () => {
    const first = await asPerson<{ id: string }>(
      { personId: alice, orgId: orgA },
      `select id from public.people`,
    );
    // No context at all. If SET LOCAL leaked into the session, this would return Alice.
    const leaked = await asUser.query<{ n: string }>(`select count(*) n from public.people`);
    const second = await asPerson<{ id: string }>(
      { personId: bob, orgId: orgA },
      `select id from public.people`,
    );

    expect(first.map((r) => r.id)).toEqual([alice]);
    expect(Number(leaked.rows[0]!.n), 'context must not survive the transaction').toBe(0);
    expect(second.map((r) => r.id)).toEqual([bob]);
  });

  it('interleaved contexts never see each other', async () => {
    const [a, b] = await Promise.all([
      asPerson<{ id: string }>({ personId: alice, orgId: orgA }, `select id from public.people`),
      asPerson<{ id: string }>({ personId: bob, orgId: orgA }, `select id from public.people`),
    ]);
    expect(a.map((r) => r.id)).toEqual([alice]);
    expect(b.map((r) => r.id)).toEqual([bob]);
  });
});

describe('concurrent person creation', () => {
  it('30 parallel creations produce 30 unique codes', async () => {
    const N = 30;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        owner.query<{ code: string }>(
          `insert into public.people (org_id, code, full_legal_name)
           values ($1, authz.next_identity_code($1::uuid,'CONC','2026'), $2)
           returning code`,
          [orgA, `Concurrent ${i}`],
        ),
      ),
    );
    const codes = results.map((r) => r.rows[0]!.code);
    expect(new Set(codes).size).toBe(N);
    const seq = codes.map((c) => Number(c.split('-')[2]!)).sort((x, y) => x - y);
    expect(seq[seq.length - 1]! - seq[0]!).toBe(N - 1); // contiguous: no gap, no repeat
  }, 60_000);
});
