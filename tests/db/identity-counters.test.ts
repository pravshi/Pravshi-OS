import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Task 1.1 — identity_counters and code generation.
 *
 * Two connections are used on purpose:
 *   owner  (DATABASE_URL_MIGRATE, app_owner) — inspects catalogue state
 *   user   (DATABASE_URL_TEST,    app_user)  — the runtime role, used to prove what it
 *                                              CANNOT do, and that it can still get a code
 *
 * The point of the app_user assertions is not that a grant is missing today. It is that a
 * counter which the runtime role can UPDATE could be rewound to re-issue a code that
 * already identifies a real person. That is why the table is unreachable and the function
 * is the only door.
 */

/**
 * Counters are permanent by design — nothing resets them, which is the whole point. So a
 * test that asserts "0001" is only true the first time it ever runs against a database.
 * Each run therefore invents its own code type, making the assertions exact and the suite
 * safe to re-run against a persistent dev branch.
 */
const RUN = Array.from({ length: 4 }, () =>
  String.fromCharCode(65 + Math.floor(Math.random() * 26)),
).join('');
const type = (suffix: string) => `${RUN}${suffix}`;

/**
 * Task 1.2 added identity_counters.org_id -> organizations(id), so counters can no
 * longer be allocated against an invented uuid. Real organizations are created here,
 * which is closer to how the counter is actually used.
 */
let ORG_A = '';
let ORG_B = '';

const owner = () => new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = () => new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const pools: Pool[] = [];
const track = <T extends Pool>(p: T): T => {
  pools.push(p);
  return p;
};

beforeAll(async () => {
  const p = track(owner());
  const make = async (suffix: string) =>
    (
      await p.query<{ id: string }>(
        `insert into public.organizations (name, slug) values ($1, $2) returning id`,
        [`Counter Org ${suffix}`, `ctr-${RUN.toLowerCase()}-${suffix}`],
      )
    ).rows[0]!.id;
  ORG_A = await make('a');
  ORG_B = await make('b');
});

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
});

describe('identity_counters — schema and RLS', () => {
  it('the migration created the table', async () => {
    const p = track(owner());
    const { rows } = await p.query<{ n: number }>(
      `select count(*)::int n from information_schema.tables
       where table_schema='public' and table_name='identity_counters'`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('has RLS ENABLED and FORCED', async () => {
    const p = track(owner());
    const { rows } = await p.query<{ enabled: boolean; forced: boolean }>(
      `select c.relrowsecurity as enabled, c.relforcerowsecurity as forced
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname='public' and c.relname='identity_counters'`,
    );
    expect(rows[0]?.enabled, 'RLS must be enabled').toBe(true);
    expect(rows[0]?.forced, 'RLS must be FORCED — owner is otherwise exempt').toBe(true);
  });

  it('is owned by app_owner, not by the runtime role', async () => {
    const p = track(owner());
    const { rows } = await p.query<{ owner: string }>(
      `select r.rolname as owner from pg_class c
       join pg_roles r on r.oid = c.relowner
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname='public' and c.relname='identity_counters'`,
    );
    expect(rows[0]?.owner).toBe('app_owner');
  });

  it('grants app_user no privilege on the table at all', async () => {
    const p = track(owner());
    const { rows } = await p.query<{ priv: string }>(
      `select privilege_type as priv from information_schema.table_privileges
       where table_schema='public' and table_name='identity_counters' and grantee='app_user'`,
    );
    // roles.sql sets DEFAULT PRIVILEGES granting select/insert/update on new public
    // tables to app_user; the migration revokes them for this table specifically.
    expect(rows.map((r) => r.priv)).toEqual([]);
  });
});

describe('identity_counters — the runtime role cannot manipulate the counter', () => {
  it('app_user cannot SELECT the table', async () => {
    const p = track(asUser());
    await expect(p.query('select * from public.identity_counters')).rejects.toThrow();
  });

  it('app_user cannot INSERT into the table', async () => {
    const p = track(asUser());
    await expect(
      p.query(
        `insert into public.identity_counters (org_id, code_type, period, next_value)
         values ('${ORG_A}', 'HAX', '2026', 1)`,
      ),
    ).rejects.toThrow();
  });

  it('app_user cannot UPDATE the counter — the rewind attack', async () => {
    const p = track(asUser());
    await expect(p.query('update public.identity_counters set next_value = 1')).rejects.toThrow();
  });

  it('app_user cannot DELETE from the table', async () => {
    const p = track(asUser());
    await expect(p.query('delete from public.identity_counters')).rejects.toThrow();
  });

  it('app_user still has no BYPASSRLS and owns no tables', async () => {
    const p = track(asUser());
    const role = await p.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
    );
    expect(role.rows[0]?.rolbypassrls).toBe(false);
    expect(role.rows[0]?.rolsuper).toBe(false);
    const owned = await p.query<{ n: number }>(
      `select count(*)::int n from pg_class c join pg_roles g on g.oid=c.relowner
       where g.rolname = current_user and c.relkind='r'`,
    );
    expect(owned.rows[0]?.n).toBe(0);
  });
});

describe('authz.next_identity_code — generation', () => {
  it('app_user CAN execute the function', async () => {
    const p = track(asUser());
    const { rows } = await p.query<{ code: string }>(
      `select authz.next_identity_code('${ORG_A}'::uuid, '${type('X')}', '2026') as code`,
    );
    expect(rows[0]?.code).toMatch(new RegExp(`^${type('X')}-2026-[0-9]{4,}$`));
  });

  it('produces the documented format and increments deterministically', async () => {
    const p = track(asUser());
    const t = type('F');
    const first = await p.query<{ code: string }>(
      `select authz.next_identity_code('${ORG_A}'::uuid, '${t}', '2026') as code`,
    );
    const second = await p.query<{ code: string }>(
      `select authz.next_identity_code('${ORG_A}'::uuid, '${t}', '2026') as code`,
    );
    expect(first.rows[0]?.code).toBe(`${t}-2026-0001`);
    expect(second.rows[0]?.code).toBe(`${t}-2026-0002`);
  });

  it('is generic, not employee-specific', async () => {
    const p = track(asUser());
    // The real prefixes from the architecture. The sequence number is not asserted here
    // because these counters are shared with every other run; the format is what matters.
    for (const prefix of ['EMP', 'INT', 'CTR']) {
      const { rows } = await p.query<{ code: string }>(
        `select authz.next_identity_code('${ORG_A}'::uuid, '${prefix}', '2026') as code`,
      );
      expect(rows[0]?.code).toMatch(new RegExp(`^${prefix}-2026-[0-9]{4,}$`));
    }
  });

  it('keeps sequences separate per organization and per period', async () => {
    const p = track(asUser());
    const t = type('S');
    const a = await p.query<{ code: string }>(
      `select authz.next_identity_code('${ORG_A}'::uuid, '${t}', '2026') as code`,
    );
    const b = await p.query<{ code: string }>(
      `select authz.next_identity_code('${ORG_B}'::uuid, '${t}', '2026') as code`,
    );
    const c = await p.query<{ code: string }>(
      `select authz.next_identity_code('${ORG_A}'::uuid, '${t}', '2027') as code`,
    );
    expect(a.rows[0]?.code).toBe(`${t}-2026-0001`);
    expect(b.rows[0]?.code).toBe(`${t}-2026-0001`); // different org, own sequence
    expect(c.rows[0]?.code).toBe(`${t}-2027-0001`); // different period, own sequence
  });

  it('rejects invalid input and fails closed', async () => {
    const p = track(asUser());
    const bad: [string, string][] = [
      ['lower', '2026'], // not uppercase
      ['E', '2026'], // too short
      ['TOOLONGTYPE', '2026'], // too long
      ['EMP', '26'], // period not four digits
      ['EMP', 'YEAR'], // period not numeric
      ["EMP'; drop table public.identity_counters; --", '2026'], // injection shape
    ];
    for (const [type, period] of bad) {
      await expect(
        p.query(`select authz.next_identity_code('${ORG_A}'::uuid, $1, $2)`, [type, period]),
        `${type} / ${period}`,
      ).rejects.toThrow();
    }
    await expect(p.query(`select authz.next_identity_code(null, 'EMP', '2026')`)).rejects.toThrow();
  });

  it('leaks no value back in its error messages', async () => {
    const p = track(asUser());
    try {
      await p.query(`select authz.next_identity_code('${ORG_A}'::uuid, $1, '2026')`, [
        'sensitive-looking-value',
      ]);
      throw new Error('expected a rejection');
    } catch (e) {
      expect((e as Error).message).not.toContain('sensitive-looking-value');
      expect((e as Error).message).toMatch(/code_type/);
    }
  });

  it('survived the injection-shaped input with the table intact', async () => {
    const p = track(owner());
    const { rows } = await p.query<{ n: number }>(
      `select count(*)::int n from information_schema.tables
       where table_schema='public' and table_name='identity_counters'`,
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe('authz.next_identity_code — concurrency', () => {
  it('issues no duplicate under 50 concurrent calls on separate connections', async () => {
    const N = 50;
    const t = type('R');
    const p = track(asUser());
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        p.query<{ code: string }>(
          `select authz.next_identity_code('${ORG_A}'::uuid, '${t}', '2026') as code`,
        ),
      ),
    );
    const codes = results.map((r) => r.rows[0]!.code);

    expect(new Set(codes).size, 'every code must be unique').toBe(N);

    // Contiguous 1..N proves the increment was atomic: a lost update would leave a gap
    // or a repeat, and a duplicate would already have failed above.
    const seq = codes.map((c) => Number(c.split('-')[2])).sort((a, b) => a - b);
    expect(seq).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  }, 60_000);
});
