import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Task 1.3 — the authz identity primitives.
 *
 * Every assertion runs through a real database role. The helpers are SECURITY DEFINER,
 * so the interesting question is not "do they return the right value" but "does being
 * SECURITY DEFINER hand app_user any capability it should not have".
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);

let orgA = '';
let orgB = '';
let alice = ''; // orgA, ACTIVE
let bob = ''; // orgA, ACTIVE
let carol = ''; // orgB, ACTIVE
let deleted = ''; // orgA, soft-deleted
let inactive = ''; // orgA, person_status = INACTIVE

/** One transaction carrying identity context, exactly as withAuthorizedDb establishes it. */
async function inContext<T>(
  ctx: { personId?: string | null; orgId?: string | null; aal?: string | null },
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = await asUser.connect();
  try {
    await c.query('begin');
    await c.query(
      `select set_config('app.person_id', $1, true),
              set_config('app.org_id',    $2, true),
              set_config('app.aal',       $3, true)`,
      [ctx.personId ?? '', ctx.orgId ?? '', ctx.aal ?? ''],
    );
    const r = await c.query(sql, params);
    await c.query('commit');
    return r.rows as T[];
  } catch (e) {
    // Releasing a connection that is still inside an aborted transaction poisons it for
    // whoever gets it next — the pooled-connection hazard withAuthorizedDb exists to
    // avoid. Roll back before handing it back.
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  const mkOrg = async (s: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name, slug) values ($1,$2) returning id`,
        [`Authz ${s}`, `authz-${RUN}-${s}`],
      )
    ).rows[0]!.id;
  orgA = await mkOrg('a');
  orgB = await mkOrg('b');

  const mkPerson = async (org: string, name: string, status = 'ACTIVE') => {
    const code = (
      await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
        org,
      ])
    ).rows[0]!.c;
    return (
      await owner.query<{ id: string }>(
        `insert into public.people (org_id, code, full_legal_name, person_status)
         values ($1,$2,$3,$4::public.person_status) returning id`,
        [org, code, name, status],
      )
    ).rows[0]!.id;
  };

  alice = await mkPerson(orgA, 'Alice');
  bob = await mkPerson(orgA, 'Bob');
  carol = await mkPerson(orgB, 'Carol');
  inactive = await mkPerson(orgA, 'Inactive', 'INACTIVE');
  deleted = await mkPerson(orgA, 'Deleted');
  await owner.query(`update public.people set deleted_at = now() where id = $1`, [deleted]);
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

describe('security properties of every implemented helper', () => {
  const implemented = ['person_id', 'is_active_person', 'org_id', 'aal'];

  it('all are SECURITY DEFINER, STABLE, with search_path pinned to empty', async () => {
    const { rows } = await owner.query<{
      proname: string;
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
    }>(
      `select p.proname, p.prosecdef, p.provolatile, p.proconfig
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='authz' and p.proname = any($1) order by p.proname`,
      [implemented],
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([...implemented].sort());
    for (const r of rows) {
      expect(r.prosecdef, `${r.proname} SECURITY DEFINER`).toBe(true);
      expect(r.provolatile, `${r.proname} STABLE`).toBe('s');
      // Pinned to EMPTY specifically, not merely set: search_path="" is what stops a
      // caller-controlled schema from shadowing an unqualified reference.
      expect(r.proconfig ?? [], `${r.proname} search_path pinned to empty`).toContain(
        'search_path=""',
      );
    }
  });

  it('is owned by app_owner — the definer identity is the schema owner', async () => {
    const { rows } = await owner.query<{ proname: string; owner: string }>(
      `select p.proname, r.rolname as owner
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       join pg_roles r on r.oid = p.proowner
       where n.nspname='authz' and p.proname = any($1)`,
      [implemented],
    );
    for (const r of rows) expect(r.owner, r.proname).toBe('app_owner');
  });

  it('grants EXECUTE to app_user and app_admin, and never to PUBLIC', async () => {
    const { rows } = await owner.query<{ proname: string; grantee: string }>(
      `select p.proname, a.grantee
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ac
       join lateral (select coalesce(pg_get_userbyid(nullif(ac.grantee,0)), 'PUBLIC') as grantee) a on true
       where n.nspname='authz' and p.proname = any($1) and ac.privilege_type='EXECUTE'`,
      [implemented],
    );
    const byFn = new Map<string, string[]>();
    for (const r of rows) byFn.set(r.proname, [...(byFn.get(r.proname) ?? []), r.grantee]);
    for (const fn of implemented) {
      const grantees = byFn.get(fn) ?? [];
      expect(grantees, `${fn} must not grant PUBLIC`).not.toContain('PUBLIC');
      expect(grantees, `${fn} grants app_user`).toContain('app_user');
      expect(grantees, `${fn} grants app_admin`).toContain('app_admin');
    }
  });

  it('creates no helper that is not yet implementable', async () => {
    const { rows } = await owner.query<{ proname: string }>(
      `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' order by proname`,
    );
    // my_departments was deferred here and implemented by Task 1.4, is_active by Task 1.5,
    // has by Task 1.7 once roles, permissions and their two joins existed, scope_for by
    // Task 1.8 and has_record_grant by Task 1.9. The list shrinks as each helper's tables
    // arrive; it must never grow.
    const deferred = ['reports_to_me', 'is_project_member'];
    for (const d of deferred) {
      expect(
        rows.map((r) => r.proname),
        `${d} must not exist as a stub`,
      ).not.toContain(d);
    }
  });
});

describe('person_id()', () => {
  it('resolves a valid identity', async () => {
    const r = await inContext<{ pid: string }>(
      { personId: alice, orgId: orgA },
      `select authz.person_id() pid`,
    );
    expect(r[0]!.pid).toBe(alice);
  });

  it('fails closed with no identity context at all', async () => {
    const r = await asUser.query<{ pid: string | null }>(`select authz.person_id() pid`);
    expect(r.rows[0]!.pid).toBeNull();
  });

  it('fails closed on an empty identity', async () => {
    const r = await inContext<{ pid: string | null }>(
      { personId: '', orgId: '' },
      `select authz.person_id() pid`,
    );
    expect(r[0]!.pid).toBeNull();
  });

  it('fails closed on a nonexistent person', async () => {
    const r = await inContext<{ pid: string | null }>(
      { personId: '00000000-0000-0000-0000-000000000000', orgId: orgA },
      `select authz.person_id() pid`,
    );
    expect(r[0]!.pid).toBeNull();
  });

  it('fails closed on a soft-deleted person', async () => {
    const r = await inContext<{ pid: string | null }>(
      { personId: deleted, orgId: orgA },
      `select authz.person_id() pid`,
    );
    expect(r[0]!.pid).toBeNull();
  });

  it('fails closed on a person who is not ACTIVE', async () => {
    const r = await inContext<{ pid: string | null }>(
      { personId: inactive, orgId: orgA },
      `select authz.person_id() pid`,
    );
    expect(r[0]!.pid).toBeNull();
  });

  it('fails closed on a malformed identity rather than leaking an error', async () => {
    // A non-uuid cannot be cast; the request must fail, not silently widen.
    await expect(
      inContext({ personId: 'not-a-uuid', orgId: orgA }, `select authz.person_id()`),
    ).rejects.toThrow();
  });
});

describe('is_active_person()', () => {
  it('is true for a live identity and false for every failure mode', async () => {
    const cases: [string, string, boolean][] = [
      ['active', alice, true],
      ['soft-deleted', deleted, false],
      ['not ACTIVE', inactive, false],
      ['nonexistent', '00000000-0000-0000-0000-000000000000', false],
    ];
    for (const [label, pid, expected] of cases) {
      const r = await inContext<{ ok: boolean }>(
        { personId: pid, orgId: orgA },
        `select authz.is_active_person() ok`,
      );
      expect(r[0]!.ok, label).toBe(expected);
    }
  });

  it('is false with no context', async () => {
    const r = await asUser.query<{ ok: boolean }>(`select authz.is_active_person() ok`);
    expect(r.rows[0]!.ok).toBe(false);
  });
});

describe('org_id() is derived, never accepted', () => {
  it('resolves the person organization when no claim is made', async () => {
    const r = await inContext<{ oid: string }>(
      { personId: alice, orgId: null },
      `select authz.org_id() oid`,
    );
    expect(r[0]!.oid).toBe(orgA);
  });

  it('resolves when the claim agrees', async () => {
    const r = await inContext<{ oid: string }>(
      { personId: alice, orgId: orgA },
      `select authz.org_id() oid`,
    );
    expect(r[0]!.oid).toBe(orgA);
  });

  it('DENIES when the caller claims another organization — never grants it', async () => {
    const r = await inContext<{ oid: string | null }>(
      { personId: alice, orgId: orgB },
      `select authz.org_id() oid`,
    );
    expect(r[0]!.oid, 'a mismatching claim must deny, not switch tenant').toBeNull();
  });

  it('cannot be steered to another tenant by claiming that tenant', async () => {
    // Carol is in orgB. Alice claiming orgB must not see anything of orgB's.
    const rows = await inContext<{ id: string }>(
      { personId: alice, orgId: orgB },
      `select id from public.people where id = $1`,
      [carol],
    );
    expect(rows).toEqual([]);
  });

  it('fails closed for a deleted or inactive person', async () => {
    for (const pid of [deleted, inactive]) {
      const r = await inContext<{ oid: string | null }>(
        { personId: pid, orgId: orgA },
        `select authz.org_id() oid`,
      );
      expect(r[0]!.oid).toBeNull();
    }
  });

  it('is null with no identity', async () => {
    const r = await asUser.query<{ oid: string | null }>(`select authz.org_id() oid`);
    expect(r.rows[0]!.oid).toBeNull();
  });
});

describe('aal()', () => {
  // Task 1.3 shipped this as a plain reader of app.aal, with a warning attached: the value
  // was not established by anything and must not gate a sensitive surface. Task 1.13
  // hardened it, so the two assertions that used to live here — "returns whatever the
  // context says" and "is null when unset" — are now the wrong shape. What replaces them is
  // stronger in both directions.

  it('refuses a claim of aal2 from somebody with no second factor', async () => {
    // alice has no login at all, so she certainly has no verified factor. The claim cannot
    // widen access — the same deny-never-grant rule org_id() applies to a tenant claim.
    const r = await inContext<{ a: string | null }>(
      { personId: alice, orgId: orgA, aal: 'aal2' },
      `select authz.aal() a`,
    );
    expect(r[0]!.a).toBe('aal1');
  });

  it('answers aal1 when unset, rather than a third state a caller could mishandle', async () => {
    const r = await inContext<{ a: string | null }>(
      { personId: alice, orgId: orgA },
      `select authz.aal() a`,
    );
    expect(r[0]!.a).toBe('aal1');
  });

  it('answers aal1 with no identity at all', async () => {
    const r = await inContext<{ a: string | null }>(
      { personId: null, orgId: null, aal: 'aal2' },
      `select authz.aal() a`,
    );
    expect(r[0]!.a).toBe('aal1');
  });

  // The positive case — an enrolled person whose claim IS honoured — is exercised end to
  // end in tests/auth/two-factor.test.ts, where a real TOTP verification produces it.
});

describe('SECURITY DEFINER grants app_user no extra capability', () => {
  it('app_user still cannot read people beyond its policy', async () => {
    // person_id() reads `people` internally as app_owner. That must not translate into
    // app_user being able to read the table.
    const rows = await inContext<{ id: string }>(
      { personId: alice, orgId: orgA },
      `select id from public.people`,
    );
    expect(
      rows.map((r) => r.id),
      'SELF scope still holds',
    ).toEqual([alice]);
  });

  it('app_user still cannot write people or organizations', async () => {
    await expect(asUser.query(`update public.people set full_legal_name='x'`)).rejects.toThrow();
    await expect(asUser.query(`delete from public.organizations`)).rejects.toThrow();
  });

  it('app_user still has no BYPASSRLS and owns nothing', async () => {
    const r = await asUser.query<{ b: boolean; s: boolean }>(
      `select rolbypassrls b, rolsuper s from pg_roles where rolname = current_user`,
    );
    expect(r.rows[0]!.b).toBe(false);
    expect(r.rows[0]!.s).toBe(false);
  });
});

describe('pooled-connection isolation', () => {
  it('A then B on a reused pool resolve to their own identities', async () => {
    const a = await inContext<{ pid: string; oid: string }>(
      { personId: alice, orgId: orgA },
      `select authz.person_id() pid, authz.org_id() oid`,
    );
    const b = await inContext<{ pid: string; oid: string }>(
      { personId: carol, orgId: orgB },
      `select authz.person_id() pid, authz.org_id() oid`,
    );
    expect(a[0]!.pid).toBe(alice);
    expect(a[0]!.oid).toBe(orgA);
    expect(b[0]!.pid).toBe(carol);
    expect(b[0]!.oid).toBe(orgB);
  });

  it('context does not survive into an unauthenticated request on the same pool', async () => {
    await inContext({ personId: alice, orgId: orgA }, `select authz.person_id()`);
    const leaked = await asUser.query<{ pid: string | null; oid: string | null }>(
      `select authz.person_id() pid, authz.org_id() oid`,
    );
    expect(leaked.rows[0]!.pid, 'identity must die with the transaction').toBeNull();
    expect(leaked.rows[0]!.oid).toBeNull();
  });

  it('alternating A/B/A/B never crosses over', async () => {
    for (const [pid, oid] of [
      [alice, orgA],
      [carol, orgB],
      [alice, orgA],
      [carol, orgB],
    ] as const) {
      const r = await inContext<{ pid: string; oid: string }>(
        { personId: pid, orgId: oid },
        `select authz.person_id() pid, authz.org_id() oid`,
      );
      expect(r[0]!.pid).toBe(pid);
      expect(r[0]!.oid).toBe(oid);
    }
  });

  it('20 concurrent interleaved contexts each see only themselves', async () => {
    const people = [
      [alice, orgA],
      [bob, orgA],
      [carol, orgB],
    ] as const;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const [pid, oid] = people[i % people.length]!;
        return inContext<{ pid: string; oid: string }>(
          { personId: pid, orgId: oid },
          `select authz.person_id() pid, authz.org_id() oid`,
        ).then((r) => ({
          expected: pid,
          expectedOrg: oid,
          got: r[0]!,
        }));
      }),
    );
    for (const r of results) {
      expect(r.got.pid).toBe(r.expected);
      expect(r.got.oid).toBe(r.expectedOrg);
    }
  }, 60_000);
});
