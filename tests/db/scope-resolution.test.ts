import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Task 1.8 — scope resolution.
 *
 * Two claims carry this task, and most of the file exists to attack them:
 *
 *   1. scope_for() returns the BROADEST scope across every live role, and narrows the
 *      instant a broad role goes away.
 *   2. has(p) is true if and only if scope_for(p) is not null, in every identity state.
 *
 * Claim 2 is asserted by sweeping the entire 81-row permission catalogue for each state
 * rather than by spot-checking, because "these two agree" is only worth saying if it has
 * been checked everywhere it could fail.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `S${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

let orgA = '';
let orgB = '';
let orgSuspended = '';

let deptPrimary = '';
let deptSecondary = '';
let deptArchived = '';
let deptRemoved = '';
let deptB = '';

let alice = ''; // orgA, ACTIVE engagement in deptPrimary, secondary in deptSecondary
let bob = ''; // orgA, ACTIVE engagement, no secondary membership
let suspended = ''; // orgA, SUSPENDED engagement, roles assigned
let unengaged = ''; // orgA, no engagement at all, roles assigned
let removed = ''; // orgA, soft-deleted person
let dormant = ''; // orgA, person_status INACTIVE
let carol = ''; // orgB
let dave = ''; // orgSuspended

// Custom roles granting one permission at one scope each.
const scopeRole: Record<string, string> = {};
const SCOPE_PERMISSION = 'teams.view';

const mkPerson = async (org: string, name: string, status = 'ACTIVE') => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people (org_id,code,full_legal_name,person_status)
       values ($1,$2,$3,$4::public.person_status) returning id`,
      [org, code, name, status],
    )
  ).rows[0]!.id;
};

const mkEngagement = async (org: string, person: string, dept: string, status = 'ACTIVE') =>
  (
    await owner.query<{ id: string }>(
      `insert into public.engagements
         (org_id,person_id,department_id,engagement_type,status,start_date)
       values ($1,$2,$3,'EMPLOYEE',$4::public.engagement_status,current_date) returning id`,
      [org, person, dept, status],
    )
  ).rows[0]!.id;

const mkDept = async (org: string, code: string, status = 'ACTIVE') =>
  (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id,code,name,status) values ($1,$2,$3,$4) returning id`,
      [org, code, `Dept ${code}`, status],
    )
  ).rows[0]!.id;

const roleId = async (org: string, key: string) =>
  (
    await owner.query<{ id: string }>(`select id from public.roles where org_id=$1 and key=$2`, [
      org,
      key,
    ])
  ).rows[0]!.id;

const grantRole = (person: string, role: string, org: string) =>
  owner.query(`insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`, [
    person,
    role,
    org,
  ]);

const revokeRole = (person: string, role: string) =>
  owner.query(`delete from public.person_roles where person_id=$1 and role_id=$2`, [person, role]);

/** A role carrying exactly one permission at exactly one scope. */
const mkScopedRole = async (org: string, key: string, permission: string, scope: string) => {
  const id = (
    await owner.query<{ id: string }>(
      `insert into public.roles (org_id,key,name) values ($1,$2,$3) returning id`,
      [org, key, key],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into public.role_permissions (role_id, permission_id, scope)
     select $1, p.id, $2::public.access_scope from public.permissions p where p.key=$3`,
    [id, scope, permission],
  );
  return id;
};

async function inContext<T>(
  ctx: { personId?: string | null; orgId?: string | null },
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = await asUser.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`, [
      ctx.personId ?? '',
      ctx.orgId ?? '',
    ]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r.rows as T[];
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** The owner connection carrying an identity: full table visibility, named actor. */
async function asActor<T>(
  ctx: { personId?: string | null; orgId?: string | null },
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = await owner.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`, [
      ctx.personId ?? '',
      ctx.orgId ?? '',
    ]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r.rows as T[];
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

type Ctx = { personId?: string | null; orgId?: string | null };

const scopeOf = async (ctx: Ctx, permission: string) =>
  (await inContext<{ s: string | null }>(ctx, `select authz.scope_for($1) s`, [permission]))[0]!.s;

const departmentsOf = async (ctx: Ctx) =>
  (await inContext<{ d: string[] }>(ctx, `select authz.my_departments() d`))[0]!.d;

/**
 * has() and scope_for() for EVERY permission in the catalogue, in one round trip. Run on
 * the owner connection so the permissions table itself is not RLS-filtered — the point is
 * to ask about all 81 keys, including the ones this identity does not hold.
 */
const sweep = (ctx: Ctx) =>
  asActor<{ key: string; h: boolean; s: string | null }>(
    ctx,
    `select p.key, authz.has(p.key) h, authz.scope_for(p.key) s
     from public.permissions p order by p.key`,
  );

const expectAgreement = (rows: { key: string; h: boolean; s: string | null }[], label: string) => {
  expect(rows.length, `${label}: catalogue size`).toBe(81);
  for (const r of rows) {
    expect(r.h, `${label}: has(${r.key}) must equal scope_for is not null (${r.s})`).toBe(
      r.s !== null,
    );
  }
};

beforeAll(async () => {
  const mkOrg = async (s: string, status = 'ACTIVE') =>
    (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name,slug,status) values ($1,$2,$3) returning id`,
        [`Sc ${s}`, `sc-${RUN}-${s}`, status],
      )
    ).rows[0]!.id;
  // Each stage depends on the one before it, but nothing inside a stage depends on its
  // siblings — so they go together. Serially this fixture is sixty round trips to Neon,
  // which is minutes of nothing happening and well past the hook timeout.
  [orgA, orgB, orgSuspended] = await Promise.all([mkOrg('a'), mkOrg('b'), mkOrg('s')]);

  let deptS = '';
  [deptPrimary, deptSecondary, deptArchived, deptRemoved, deptB, deptS] = await Promise.all([
    mkDept(orgA, `${CODE}_P`),
    mkDept(orgA, `${CODE}_S`),
    mkDept(orgA, `${CODE}_R`, 'ARCHIVED'),
    mkDept(orgA, `${CODE}_D`),
    mkDept(orgB, `${CODE}_B`),
    mkDept(orgSuspended, `${CODE}_X`),
  ]);

  [alice, bob, suspended, unengaged, removed, dormant, carol, dave] = await Promise.all([
    mkPerson(orgA, 'Alice'),
    mkPerson(orgA, 'Bob'),
    mkPerson(orgA, 'Suspended'),
    mkPerson(orgA, 'Unengaged'),
    mkPerson(orgA, 'Removed'),
    mkPerson(orgA, 'Dormant'),
    mkPerson(orgB, 'Carol'),
    mkPerson(orgSuspended, 'Dave'),
  ]);

  const [employeeRole, hrRoleB, hrRoleS] = await Promise.all([
    roleId(orgA, 'EMPLOYEE'),
    roleId(orgB, 'HR_ADMIN'),
    roleId(orgSuspended, 'HR_ADMIN'),
  ]);

  await Promise.all([
    // `unengaged` deliberately gets none.
    mkEngagement(orgA, alice, deptPrimary),
    mkEngagement(orgA, bob, deptPrimary),
    mkEngagement(orgA, suspended, deptPrimary, 'SUSPENDED'),
    mkEngagement(orgA, removed, deptPrimary),
    mkEngagement(orgA, dormant, deptPrimary),
    mkEngagement(orgB, carol, deptB),
    mkEngagement(orgSuspended, dave, deptS),
    owner.query(
      `insert into public.person_departments (org_id, person_id, department_id) values ($1,$2,$3)`,
      [orgA, alice, deptSecondary],
    ),
    // One role per scope, all granting the same permission, so the ladder is the only
    // variable in every broadening test below.
    ...['GLOBAL', 'DEPARTMENT', 'TEAM', 'PROJECT', 'SELF'].map(async (scope) => {
      scopeRole[scope] = await mkScopedRole(orgA, `${CODE}_${scope}`, SCOPE_PERMISSION, scope);
    }),
    // Everyone who needs a permission to resolve gets the seeded EMPLOYEE baseline.
    ...[alice, bob, suspended, unengaged, removed, dormant].map((p) =>
      grantRole(p, employeeRole, orgA),
    ),
    grantRole(carol, hrRoleB, orgB),
    grantRole(dave, hrRoleS, orgSuspended),
  ]);

  // Applied last, so the rows above could be created normally first.
  await Promise.all([
    owner.query(`update public.people set deleted_at=now() where id=$1`, [removed]),
    owner.query(`update public.people set person_status='INACTIVE' where id=$1`, [dormant]),
    owner.query(`update public.departments set deleted_at=now() where id=$1`, [deptRemoved]),
  ]);
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

// ── the enum is the ranking ──────────────────────────────────────────────────────

describe('scope ordering', () => {
  it('orders access_scope broadest-first in the database', async () => {
    const { rows } = await owner.query<{ labels: string[] }>(
      `select array_agg(e.enumlabel::text order by e.enumsortorder) labels
       from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname='access_scope'`,
    );
    expect(rows[0]!.labels).toEqual(['GLOBAL', 'DEPARTMENT', 'TEAM', 'PROJECT', 'SELF']);
  });

  it('makes min() mean broadest and max() mean narrowest', async () => {
    const { rows } = await owner.query<{ broadest: string; narrowest: string }>(
      `select min(x) broadest, max(x) narrowest
       from (values ('SELF'::public.access_scope),('PROJECT'),('TEAM'),('DEPARTMENT'),('GLOBAL'))
            v(x)`,
    );
    expect(rows[0]).toEqual({ broadest: 'GLOBAL', narrowest: 'SELF' });
  });

  it('resolves scope through that ordering and no other ranking mechanism', async () => {
    // No numeric rank column, no CASE ladder, no role-name comparison in the resolver.
    const { rows } = await owner.query<{ src: string }>(
      `select pg_get_functiondef(p.oid) src from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' and p.proname='scope_for'`,
    );
    const src = rows[0]!.src;
    expect(src).toContain('min(rp.scope)');
    expect(src).not.toMatch(/case\s+when/i);
    expect(src).not.toMatch(/SUPER_ADMIN|SALES_MANAGER|r\.key/);
  });

  it('returns one scope, not a set', async () => {
    const { rows } = await owner.query<{ rettype: string; retset: boolean }>(
      `select t.typname rettype, p.proretset retset
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       join pg_type t on t.oid = p.prorettype
       where n.nspname='authz' and p.proname='scope_for'`,
    );
    expect(rows[0]!.rettype).toBe('access_scope');
    expect(rows[0]!.retset).toBe(false);
  });
});

// ── each scope resolves ──────────────────────────────────────────────────────────

describe('every scope resolves', () => {
  it('returns exactly the scope a single role grants', async () => {
    for (const scope of ['GLOBAL', 'DEPARTMENT', 'TEAM', 'PROJECT', 'SELF']) {
      await grantRole(bob, scopeRole[scope]!, orgA);
      expect(await scopeOf({ personId: bob, orgId: orgA }, SCOPE_PERMISSION), scope).toBe(scope);
      await revokeRole(bob, scopeRole[scope]!);
    }
  });

  it('returns null for a permission no role grants', async () => {
    expect(await scopeOf({ personId: bob, orgId: orgA }, SCOPE_PERMISSION)).toBeNull();
    expect(await scopeOf({ personId: bob, orgId: orgA }, 'roles.manage')).toBeNull();
  });

  it('returns null for a permission key that does not exist', async () => {
    expect(await scopeOf({ personId: alice, orgId: orgA }, 'not.a.permission')).toBeNull();
    expect(await scopeOf({ personId: alice, orgId: orgA }, '')).toBeNull();
  });

  it('resolves the seeded matrix scopes for the roles that carry them', async () => {
    const cases: [string, string, string][] = [
      ['HR_ADMIN', 'people.view', 'GLOBAL'],
      ['HR_MANAGER', 'people.view', 'DEPARTMENT'],
      ['EMPLOYEE', 'people.view', 'SELF'],
      ['DEVELOPER', 'projects.view', 'PROJECT'],
      ['FINANCE', 'compensation.view', 'GLOBAL'],
    ];
    for (const [role, permission, expected] of cases) {
      const p = await mkPerson(orgA, `Holder ${role}`);
      await mkEngagement(orgA, p, deptPrimary);
      await grantRole(p, await roleId(orgA, role), orgA);
      expect(await scopeOf({ personId: p, orgId: orgA }, permission), `${role} ${permission}`).toBe(
        expected,
      );
    }
  });
});

// ── broadest wins, and narrows again ─────────────────────────────────────────────

describe('multiple roles', () => {
  it('takes the broadest scope across roles and narrows the moment it is removed', async () => {
    const ladder: [string, string][] = [
      ['SELF', 'SELF'],
      ['PROJECT', 'PROJECT'],
      ['TEAM', 'TEAM'],
      ['DEPARTMENT', 'DEPARTMENT'],
      ['GLOBAL', 'GLOBAL'],
    ];
    // Add roles narrowest-first: each addition must broaden the answer to the new role.
    for (const [added, expected] of ladder) {
      await grantRole(bob, scopeRole[added]!, orgA);
      expect(await scopeOf({ personId: bob, orgId: orgA }, SCOPE_PERMISSION), `+${added}`).toBe(
        expected,
      );
    }
    // Remove broadest-first: each removal must narrow to the next one still held.
    const unwind: [string, string][] = [
      ['GLOBAL', 'DEPARTMENT'],
      ['DEPARTMENT', 'TEAM'],
      ['TEAM', 'PROJECT'],
      ['PROJECT', 'SELF'],
      ['SELF', null as unknown as string],
    ];
    for (const [dropped, expected] of unwind) {
      await revokeRole(bob, scopeRole[dropped]!);
      expect(await scopeOf({ personId: bob, orgId: orgA }, SCOPE_PERMISSION), `-${dropped}`).toBe(
        expected,
      );
    }
  });

  it('reproduces the blueprint 7.2 sales example from the seeded roles alone', async () => {
    const p = await mkPerson(orgA, 'Sales Ladder');
    await mkEngagement(orgA, p, deptPrimary);
    const ctx = { personId: p, orgId: orgA };

    await grantRole(p, await roleId(orgA, 'SALES'), orgA);
    expect(await scopeOf(ctx, 'leads.view')).toBe('SELF');

    await grantRole(p, await roleId(orgA, 'SALES_MANAGER'), orgA);
    expect(await scopeOf(ctx, 'leads.view')).toBe('DEPARTMENT');

    await grantRole(p, await roleId(orgA, 'ADMIN'), orgA);
    expect(await scopeOf(ctx, 'leads.view')).toBe('GLOBAL');

    await revokeRole(p, await roleId(orgA, 'ADMIN'));
    expect(await scopeOf(ctx, 'leads.view')).toBe('DEPARTMENT');

    await revokeRole(p, await roleId(orgA, 'SALES_MANAGER'));
    expect(await scopeOf(ctx, 'leads.view')).toBe('SELF');
  });

  it('cannot hold the same role twice, so a duplicate cannot skew resolution', async () => {
    const role = await roleId(orgA, 'EMPLOYEE');
    await expect(grantRole(alice, role, orgA)).rejects.toThrow();
  });
});

// ── identity and engagement gating ───────────────────────────────────────────────

describe('identity and engagement gating', () => {
  it('resolves nothing without an identity', async () => {
    expect(await scopeOf({ personId: null, orgId: null }, 'people.view')).toBeNull();
    expect(await scopeOf({ personId: null, orgId: orgA }, 'people.view')).toBeNull();
  });

  it('resolves nothing for an identity that does not exist', async () => {
    expect(
      await scopeOf(
        { personId: '00000000-0000-0000-0000-000000000000', orgId: orgA },
        'people.view',
      ),
    ).toBeNull();
  });

  it('resolves nothing for a soft-deleted or non-ACTIVE person', async () => {
    expect(await scopeOf({ personId: removed, orgId: orgA }, 'people.view')).toBeNull();
    expect(await scopeOf({ personId: dormant, orgId: orgA }, 'people.view')).toBeNull();
  });

  it('resolves nothing for a person with no engagement at all', async () => {
    expect(await scopeOf({ personId: unengaged, orgId: orgA }, 'people.view')).toBeNull();
  });

  it('treats every non-ACTIVE engagement status as no access', async () => {
    for (const status of [
      'PRE_ONBOARDING',
      'ONBOARDING',
      'NOTICE_PERIOD',
      'SUSPENDED',
      'OFFBOARDING',
      'ARCHIVED',
    ]) {
      const p = await mkPerson(orgA, `Status ${status}`);
      await mkEngagement(orgA, p, deptPrimary, status);
      await grantRole(p, await roleId(orgA, 'EMPLOYEE'), orgA);
      expect(await scopeOf({ personId: p, orgId: orgA }, 'people.view'), status).toBeNull();
    }
  });

  it('resolves nothing once the engagement is soft-deleted, on the very next query', async () => {
    const p = await mkPerson(orgA, 'Deletable');
    const e = await mkEngagement(orgA, p, deptPrimary);
    await grantRole(p, await roleId(orgA, 'EMPLOYEE'), orgA);
    expect(await scopeOf({ personId: p, orgId: orgA }, 'people.view')).toBe('SELF');

    await owner.query(`update public.engagements set deleted_at=now() where id=$1`, [e]);
    expect(await scopeOf({ personId: p, orgId: orgA }, 'people.view')).toBeNull();
  });

  it('resolves nothing when the organization is suspended or soft-deleted', async () => {
    expect(await scopeOf({ personId: dave, orgId: orgSuspended }, 'people.view')).toBe('GLOBAL');
    await owner.query(`update public.organizations set status='SUSPENDED' where id=$1`, [
      orgSuspended,
    ]);
    expect(await scopeOf({ personId: dave, orgId: orgSuspended }, 'people.view')).toBeNull();

    await owner.query(
      `update public.organizations set status='ACTIVE', deleted_at=now() where id=$1`,
      [orgSuspended],
    );
    expect(await scopeOf({ personId: dave, orgId: orgSuspended }, 'people.view')).toBeNull();
    await owner.query(`update public.organizations set deleted_at=null where id=$1`, [
      orgSuspended,
    ]);
  });

  it('does not accept person_status ACTIVE as a substitute for a live engagement', async () => {
    const status = await owner.query<{ person_status: string }>(
      `select person_status from public.people where id=$1`,
      [suspended],
    );
    expect(status.rows[0]!.person_status).toBe('ACTIVE');
    expect(await scopeOf({ personId: suspended, orgId: orgA }, 'people.view')).toBeNull();
  });
});

// ── organization isolation ───────────────────────────────────────────────────────

describe('organization isolation', () => {
  it('resolves a same-organization role', async () => {
    expect(await scopeOf({ personId: carol, orgId: orgB }, 'people.view')).toBe('GLOBAL');
  });

  it('fails closed on a mismatched tenant claim rather than falling back', async () => {
    expect(await scopeOf({ personId: carol, orgId: orgA }, 'people.view')).toBeNull();
    expect(await scopeOf({ personId: alice, orgId: orgB }, 'people.view')).toBeNull();
  });

  it('derives the organization from the identity, so an absent claim still resolves', async () => {
    expect(await scopeOf({ personId: carol, orgId: null }, 'people.view')).toBe('GLOBAL');
  });

  it('cannot be given a role from another organization in the first place', async () => {
    await expect(grantRole(alice, await roleId(orgB, 'HR_ADMIN'), orgA)).rejects.toThrow();
    await expect(grantRole(alice, await roleId(orgB, 'HR_ADMIN'), orgB)).rejects.toThrow();
  });

  it('never lets one organization grants reach another person', async () => {
    // carol holds HR_ADMIN in orgB, which grants people.view at GLOBAL there. alice holds
    // only EMPLOYEE in orgA. Neither sees the other scope.
    expect(await scopeOf({ personId: alice, orgId: orgA }, 'people.view')).toBe('SELF');
    expect(await scopeOf({ personId: carol, orgId: orgB }, 'people.view')).toBe('GLOBAL');
    expect(await scopeOf({ personId: alice, orgId: orgA }, 'hr.sensitive.view')).toBe('SELF');
    expect(await scopeOf({ personId: alice, orgId: orgA }, 'candidates.view')).toBeNull();
  });
});

// ── assignment expiry ────────────────────────────────────────────────────────────

describe('role assignment expiry', () => {
  const expiring = async () => {
    const p = await mkPerson(orgA, 'Expiring');
    await mkEngagement(orgA, p, deptPrimary);
    return p;
  };

  it('counts an assignment with no expiry', async () => {
    const p = await expiring();
    await grantRole(p, await roleId(orgA, 'HR_ADMIN'), orgA);
    expect(await scopeOf({ personId: p, orgId: orgA }, 'people.view')).toBe('GLOBAL');
  });

  it('counts an assignment expiring in the future', async () => {
    const p = await expiring();
    await owner.query(
      `insert into public.person_roles (person_id,role_id,org_id,expires_at)
       values ($1,$2,$3, now() + interval '1 hour')`,
      [p, await roleId(orgA, 'HR_ADMIN'), orgA],
    );
    expect(await scopeOf({ personId: p, orgId: orgA }, 'people.view')).toBe('GLOBAL');
  });

  it('stops counting the instant expires_at moves into the past', async () => {
    const p = await expiring();
    const role = await roleId(orgA, 'HR_ADMIN');
    await owner.query(
      `insert into public.person_roles (person_id,role_id,org_id,expires_at)
       values ($1,$2,$3, now() + interval '1 hour')`,
      [p, role, orgA],
    );
    expect(await scopeOf({ personId: p, orgId: orgA }, 'people.view')).toBe('GLOBAL');

    await owner.query(
      `update public.person_roles
          set granted_at = now() - interval '2 days', expires_at = now() - interval '1 day'
        where person_id=$1 and role_id=$2`,
      [p, role],
    );
    expect(await scopeOf({ personId: p, orgId: orgA }, 'people.view')).toBeNull();

    // and back again, without anything being re-inserted or a job running
    await owner.query(
      `update public.person_roles set expires_at = now() + interval '1 hour'
        where person_id=$1 and role_id=$2`,
      [p, role],
    );
    expect(await scopeOf({ personId: p, orgId: orgA }, 'people.view')).toBe('GLOBAL');
  });

  it('narrows to the next role when only the broad assignment expires', async () => {
    const p = await expiring();
    await grantRole(p, await roleId(orgA, 'EMPLOYEE'), orgA);
    const broad = await roleId(orgA, 'HR_ADMIN');
    await owner.query(
      `insert into public.person_roles (person_id,role_id,org_id,expires_at)
       values ($1,$2,$3, now() + interval '1 hour')`,
      [p, broad, orgA],
    );
    expect(await scopeOf({ personId: p, orgId: orgA }, 'people.view')).toBe('GLOBAL');

    await owner.query(
      `update public.person_roles
          set granted_at = now() - interval '2 days', expires_at = now() - interval '1 day'
        where person_id=$1 and role_id=$2`,
      [p, broad],
    );
    expect(await scopeOf({ personId: p, orgId: orgA }, 'people.view')).toBe('SELF');
  });
});

// ── role lifecycle ───────────────────────────────────────────────────────────────

describe('role lifecycle', () => {
  it('stops resolving through an archived role', async () => {
    const p = await mkPerson(orgA, 'Archived Role');
    await mkEngagement(orgA, p, deptPrimary);
    const role = await mkScopedRole(orgA, `${CODE}_ARCH`, SCOPE_PERMISSION, 'GLOBAL');
    await grantRole(p, role, orgA);
    expect(await scopeOf({ personId: p, orgId: orgA }, SCOPE_PERMISSION)).toBe('GLOBAL');

    await owner.query(`update public.roles set status='ARCHIVED' where id=$1`, [role]);
    expect(await scopeOf({ personId: p, orgId: orgA }, SCOPE_PERMISSION)).toBeNull();
  });

  it('stops resolving through a soft-deleted role', async () => {
    const p = await mkPerson(orgA, 'Deleted Role');
    await mkEngagement(orgA, p, deptPrimary);
    const role = await mkScopedRole(orgA, `${CODE}_DEL`, SCOPE_PERMISSION, 'GLOBAL');
    await grantRole(p, role, orgA);
    expect(await scopeOf({ personId: p, orgId: orgA }, SCOPE_PERMISSION)).toBe('GLOBAL');

    await owner.query(`update public.roles set deleted_at=now() where id=$1`, [role]);
    expect(await scopeOf({ personId: p, orgId: orgA }, SCOPE_PERMISSION)).toBeNull();
  });

  it('stops resolving when the grant itself is removed from the role', async () => {
    const p = await mkPerson(orgA, 'Ungranted Role');
    await mkEngagement(orgA, p, deptPrimary);
    const role = await mkScopedRole(orgA, `${CODE}_UNG`, SCOPE_PERMISSION, 'DEPARTMENT');
    await grantRole(p, role, orgA);
    expect(await scopeOf({ personId: p, orgId: orgA }, SCOPE_PERMISSION)).toBe('DEPARTMENT');

    await owner.query(`delete from public.role_permissions where role_id=$1`, [role]);
    expect(await scopeOf({ personId: p, orgId: orgA }, SCOPE_PERMISSION)).toBeNull();
  });

  it('leaves the Task 1.7 protected-role rule exactly as it was', async () => {
    const superAdmin = await roleId(orgA, 'SUPER_ADMIN');
    const protectedNow = await owner.query<{ p: boolean }>(
      `select public.role_is_protected($1) p`,
      [superAdmin],
    );
    expect(protectedNow.rows[0]!.p).toBe(true);

    // This file's orgA is brand new, so its genesis exception is still open and the first
    // protected grant is permitted from a non-runtime database role. Consuming it is what
    // makes the rule bite below, and is itself Task 1.7 bootstrap behaviour, unchanged.
    const [founder, climber] = await Promise.all([
      mkPerson(orgA, 'Founder'),
      mkPerson(orgA, 'Climber'),
    ]);
    await Promise.all([
      mkEngagement(orgA, founder, deptPrimary),
      mkEngagement(orgA, climber, deptPrimary),
    ]);
    await grantRole(founder, superAdmin, orgA);

    await expect(
      asActor(
        { personId: climber, orgId: orgA },
        `insert into public.person_roles (person_id,role_id,org_id) values ($1,$2,$3)`,
        [climber, superAdmin, orgA],
      ),
    ).rejects.toThrow(/protected role requires roles.manage at GLOBAL/i);

    // The holder, whose scope resolution now reads GLOBAL, still can — which is the same
    // fact stated twice: scope_for() and the protected-role trigger agree about who holds
    // roles.manage at GLOBAL because they read it from the same rows.
    expect(await scopeOf({ personId: founder, orgId: orgA }, 'roles.manage')).toBe('GLOBAL');
    await asActor(
      { personId: founder, orgId: orgA },
      `insert into public.person_roles (person_id,role_id,org_id) values ($1,$2,$3)`,
      [climber, superAdmin, orgA],
    );
    // Revocation is governed by the same rule, so the cleanup goes through the holder too.
    await asActor(
      { personId: founder, orgId: orgA },
      `delete from public.person_roles where person_id=$1 and role_id=$2`,
      [climber, superAdmin],
    );
  });
});

// ── has() / scope_for() equivalence ──────────────────────────────────────────────

describe('has() and scope_for() can never disagree', () => {
  it('is true by construction: has() is defined as scope_for() is not null', async () => {
    const { rows } = await owner.query<{ src: string }>(
      `select pg_get_functiondef(p.oid) src from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' and p.proname='has'`,
    );
    expect(rows[0]!.src).toContain('authz.scope_for(p_permission) is not null');
  });

  it('agrees across the whole catalogue for every identity state', async () => {
    const states: [string, Ctx][] = [
      ['no identity', { personId: null, orgId: null }],
      ['unknown identity', { personId: '00000000-0000-0000-0000-000000000000', orgId: orgA }],
      ['employee baseline', { personId: alice, orgId: orgA }],
      ['global admin in another org', { personId: carol, orgId: orgB }],
      ['mismatched tenant claim', { personId: carol, orgId: orgA }],
      ['suspended engagement', { personId: suspended, orgId: orgA }],
      ['no engagement', { personId: unengaged, orgId: orgA }],
      ['soft-deleted person', { personId: removed, orgId: orgA }],
      ['inactive person', { personId: dormant, orgId: orgA }],
    ];
    const swept = await Promise.all(
      states.map(async ([label, ctx]) => [label, await sweep(ctx)] as const),
    );
    for (const [label, rows] of swept) expectAgreement(rows, label);
  });

  it('agrees for a holder of every seeded role', async () => {
    const roles = (
      await owner.query<{ key: string }>(
        `select key from public.roles where org_id=$1 and is_system order by key`,
        [orgA],
      )
    ).rows.map((r) => r.key);
    expect(roles.length).toBe(14);

    // SUPER_ADMIN is excluded from the grant because it is protected and this file's orgA
    // may already have a holder; it is still swept, as an identity holding no role at all.
    const holders = await Promise.all(
      roles.map(async (key) => {
        const p = await mkPerson(orgA, `Sweep ${key}`);
        await mkEngagement(orgA, p, deptPrimary);
        if (key !== 'SUPER_ADMIN') await grantRole(p, await roleId(orgA, key), orgA);
        return [key, p] as const;
      }),
    );
    const swept = await Promise.all(
      holders.map(async ([key, p]) => [key, await sweep({ personId: p, orgId: orgA })] as const),
    );

    for (const [key, rows] of swept) {
      expectAgreement(rows, key);
      const held = rows.filter((r) => r.h).length;
      if (key === 'MANAGER' || key === 'MARKETING' || key === 'SUPER_ADMIN') {
        expect(held, `${key} holds nothing`).toBe(0);
      } else {
        expect(held, `${key} holds something`).toBeGreaterThan(0);
      }
    }
  });

  it('agrees at every rung of the scope ladder', async () => {
    for (const scope of ['GLOBAL', 'DEPARTMENT', 'TEAM', 'PROJECT', 'SELF']) {
      await grantRole(bob, scopeRole[scope]!, orgA);
      const rows = await sweep({ personId: bob, orgId: orgA });
      expectAgreement(rows, scope);
      const row = rows.find((r) => r.key === SCOPE_PERMISSION)!;
      expect(row.s, scope).toBe(scope);
      expect(row.h, scope).toBe(true);
      await revokeRole(bob, scopeRole[scope]!);
    }
    const cleared = await sweep({ personId: bob, orgId: orgA });
    const row = cleared.find((r) => r.key === SCOPE_PERMISSION)!;
    expect(row.s).toBeNull();
    expect(row.h).toBe(false);
  });
});

// ── my_departments() final semantics ─────────────────────────────────────────────

describe('my_departments()', () => {
  it('returns the primary department from the live engagement plus secondary membership', async () => {
    const d = await departmentsOf({ personId: alice, orgId: orgA });
    expect([...d].sort()).toEqual([deptPrimary, deptSecondary].sort());
  });

  it('returns the primary department alone when there is no secondary membership', async () => {
    expect(await departmentsOf({ personId: bob, orgId: orgA })).toEqual([deptPrimary]);
  });

  it('deduplicates a secondary membership that repeats the primary department', async () => {
    const p = await mkPerson(orgA, 'Duplicated');
    await mkEngagement(orgA, p, deptPrimary);
    await owner.query(
      `insert into public.person_departments (org_id, person_id, department_id) values ($1,$2,$3)`,
      [orgA, p, deptPrimary],
    );
    expect(await departmentsOf({ personId: p, orgId: orgA })).toEqual([deptPrimary]);
  });

  it('excludes an archived department and a soft-deleted one', async () => {
    const p = await mkPerson(orgA, 'Stale Departments');
    await mkEngagement(orgA, p, deptPrimary);
    for (const dept of [deptArchived, deptRemoved]) {
      await owner.query(
        `insert into public.person_departments (org_id, person_id, department_id)
         values ($1,$2,$3)`,
        [orgA, p, dept],
      );
    }
    expect(await departmentsOf({ personId: p, orgId: orgA })).toEqual([deptPrimary]);
  });

  it('drops the primary department when the engagement is not ACTIVE', async () => {
    const p = await mkPerson(orgA, 'Notice Period');
    await mkEngagement(orgA, p, deptPrimary, 'SUSPENDED');
    await owner.query(
      `insert into public.person_departments (org_id, person_id, department_id) values ($1,$2,$3)`,
      [orgA, p, deptSecondary],
    );
    // The secondary membership survives; only the engagement-derived one goes.
    expect(await departmentsOf({ personId: p, orgId: orgA })).toEqual([deptSecondary]);
  });

  it('drops the primary department when the engagement is soft-deleted', async () => {
    const p = await mkPerson(orgA, 'Deleted Engagement');
    const e = await mkEngagement(orgA, p, deptPrimary);
    expect(await departmentsOf({ personId: p, orgId: orgA })).toEqual([deptPrimary]);
    await owner.query(`update public.engagements set deleted_at=now() where id=$1`, [e]);
    expect(await departmentsOf({ personId: p, orgId: orgA })).toEqual([]);
  });

  it('excludes another tenant departments entirely', async () => {
    expect(await departmentsOf({ personId: carol, orgId: orgB })).toEqual([deptB]);
    const aliceDepts = await departmentsOf({ personId: alice, orgId: orgA });
    expect(aliceDepts).not.toContain(deptB);
  });

  it('returns an empty array with no identity, never a wildcard', async () => {
    expect(await departmentsOf({ personId: null, orgId: null })).toEqual([]);
    expect(await departmentsOf({ personId: null, orgId: orgA })).toEqual([]);
    expect(
      await departmentsOf({ personId: '00000000-0000-0000-0000-000000000000', orgId: orgA }),
    ).toEqual([]);
    // and a mismatched tenant claim denies rather than falls back
    expect(await departmentsOf({ personId: alice, orgId: orgB })).toEqual([]);
  });

  it('returns an empty array rather than every department when nothing matches', async () => {
    const total = await owner.query<{ n: string }>(
      `select count(*) n from public.departments where org_id=$1`,
      [orgA],
    );
    expect(Number(total.rows[0]!.n)).toBeGreaterThan(1);
    expect(await departmentsOf({ personId: unengaged, orgId: orgA })).toEqual([]);
  });
});

// ── RLS ──────────────────────────────────────────────────────────────────────────

describe('RLS', () => {
  it('keeps the corrected array form and the InitPlan wrapper in the departments policy', async () => {
    const { rows } = await owner.query<{ qual: string }>(
      `select qual from pg_policies
       where schemaname='public' and tablename='departments' and policyname='departments_select_mine'`,
    );
    const qual = rows[0]!.qual;
    // c92a215: ANY over the ARRAY — not ANY(subquery), which fails with "operator does not
    // exist: uuid = uuid[]" — with the (select ...) InitPlan wrapper that makes the helper
    // run once per query rather than once per row.
    expect(qual).toMatch(/= ANY \(\(\s*SELECT authz\.my_departments\(\)[^)]*\)::uuid\[\]\)/i);
    expect(qual).toMatch(/org_id = \(\s*SELECT authz\.org_id\(\)/i);
  });

  it('shows a person the department they work in as well as the ones they sit in', async () => {
    const rows = await inContext<{ id: string }>(
      { personId: alice, orgId: orgA },
      `select id from public.departments`,
    );
    expect([...rows.map((r) => r.id)].sort()).toEqual([deptPrimary, deptSecondary].sort());
  });

  it('still shows nothing at all without an identity', async () => {
    for (const t of ['departments', 'roles', 'permissions', 'role_permissions', 'person_roles']) {
      const rows = await inContext({ personId: null, orgId: null }, `select * from public.${t}`);
      expect(rows, t).toEqual([]);
    }
  });

  it('leaves every table RLS-enabled and forced', async () => {
    const { rows } = await owner.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r'
         and c.relname not like '\\_%' and c.relname <> '__drizzle_migrations'
         and (not c.relrowsecurity or not c.relforcerowsecurity)`,
    );
    expect(rows).toEqual([]);
  });

  it('adds no new policy and widens none', async () => {
    // Scope resolution exists; the tables that will branch on it do not yet. The only
    // behaviour change is departments, through the helper rather than through a policy edit.
    const { rows } = await owner.query<{ n: string; with_scope: string }>(
      `select count(*) n, count(*) filter (where qual like '%scope_for%') with_scope
       from pg_policies where schemaname='public' and 'app_user' = any(roles)`,
    );
    // One app_user SELECT policy per table, exactly as Tasks 1.2-1.7 left them.
    expect(Number(rows[0]!.n)).toBe(13);
    // None branches on scope_for yet: TEAM needs reports_to_me and PROJECT needs
    // is_project_member, so the database.md 4.2 template is not writable in full.
    expect(Number(rows[0]!.with_scope)).toBe(0);
  });
});

// ── function properties and privileges ───────────────────────────────────────────

describe('function properties', () => {
  const touched = ['scope_for', 'has', 'my_departments'];

  it('are SECURITY DEFINER, STABLE, owned by app_owner, with search_path pinned empty', async () => {
    const { rows } = await owner.query<{
      proname: string;
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
      owner: string;
    }>(
      `select p.proname, p.prosecdef, p.provolatile, p.proconfig, r.rolname owner
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       join pg_roles r on r.oid=p.proowner
       where n.nspname='authz' and p.proname = any($1) order by p.proname`,
      [touched],
    );
    expect(rows.map((r) => r.proname)).toEqual([...touched].sort());
    for (const r of rows) {
      expect(r.prosecdef, `${r.proname} SECURITY DEFINER`).toBe(true);
      expect(r.provolatile, `${r.proname} STABLE`).toBe('s');
      expect(r.proconfig ?? [], `${r.proname} search_path`).toContain('search_path=""');
      expect(r.owner, `${r.proname} owner`).toBe('app_owner');
    }
  });

  it('grant EXECUTE to app_user and app_admin and never to PUBLIC', async () => {
    const { rows } = await owner.query<{ proname: string; grantee: string }>(
      `select p.proname, coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC') grantee
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ac
       where n.nspname='authz' and p.proname = any($1) and ac.privilege_type='EXECUTE'`,
      [touched],
    );
    const byFn = new Map<string, string[]>();
    for (const r of rows) byFn.set(r.proname, [...(byFn.get(r.proname) ?? []), r.grantee]);
    for (const fn of touched) {
      const grantees = byFn.get(fn) ?? [];
      expect(grantees, `${fn} PUBLIC`).not.toContain('PUBLIC');
      expect(grantees, `${fn} app_user`).toContain('app_user');
      expect(grantees, `${fn} app_admin`).toContain('app_admin');
    }
  });

  it('reference every object schema-qualified and use no dynamic SQL', async () => {
    const { rows } = await owner.query<{ proname: string; src: string }>(
      `select p.proname, pg_get_functiondef(p.oid) src from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' and p.proname = any($1)`,
      [touched],
    );
    for (const r of rows) {
      // Comments in the body contain ordinary English ("derived from the person"), which
      // would otherwise read as an unqualified FROM clause.
      const body = (r.src.split('AS $function$')[1] ?? '')
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n');
      const tables = body.match(/\b(from|join)\s+([a-z_.]+)/gi) ?? [];
      for (const t of tables) {
        expect(t, `${r.proname}: ${t}`).toMatch(/\s(public|authz)\./);
      }
      expect(body, `${r.proname} dynamic SQL`).not.toMatch(/\bexecute\b/i);
    }
  });

  it('still creates no helper whose tables do not exist', async () => {
    const { rows } = await owner.query<{ proname: string }>(
      `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz'`,
    );
    const names = rows.map((r) => r.proname);
    expect(names).toContain('scope_for');
    for (const deferred of ['reports_to_me', 'is_project_member', 'has_record_grant']) {
      expect(names, `${deferred} must not exist as a stub`).not.toContain(deferred);
    }
  });

  it('indexes the engagement lookup that every authorization query now performs', async () => {
    const { rows } = await owner.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname='public' and indexname='engagements_person_status_idx'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.indexdef).toMatch(/person_id, status/);
    expect(rows[0]!.indexdef).toMatch(/deleted_at IS NULL/i);
  });

  it('leaves app_user unable to bypass any of it', async () => {
    const { rows } = await owner.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      `select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
       from pg_roles where rolname='app_user'`,
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    const writes = await owner.query<{ table_name: string }>(
      `select table_name from information_schema.table_privileges
       where table_schema='public' and grantee='app_user'
         and privilege_type in ('INSERT','UPDATE','DELETE')
         and table_name in ('roles','permissions','role_permissions','person_roles')`,
    );
    expect(writes.rows).toEqual([]);
  });
});

// ── pooled connections ───────────────────────────────────────────────────────────

describe('pooled connection isolation', () => {
  it('never lets alternating identities inherit each other scopes', async () => {
    for (let i = 0; i < 6; i++) {
      expect(await scopeOf({ personId: alice, orgId: orgA }, 'people.view')).toBe('SELF');
      expect(await scopeOf({ personId: carol, orgId: orgB }, 'people.view')).toBe('GLOBAL');
    }
  });

  it('leaves no scope behind on a reused connection', async () => {
    const c = await asUser.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
        [carol, orgB],
      );
      const inside = await c.query<{ s: string | null; d: string[] }>(
        `select authz.scope_for('people.view') s, authz.my_departments() d`,
      );
      expect(inside.rows[0]!.s).toBe('GLOBAL');
      expect(inside.rows[0]!.d).toEqual([deptB]);
      await c.query('commit');

      const after = await c.query<{ s: string | null; d: string[] }>(
        `select authz.scope_for('people.view') s, authz.my_departments() d`,
      );
      expect(after.rows[0]!.s).toBeNull();
      expect(after.rows[0]!.d).toEqual([]);
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  });

  it('keeps twelve interleaved resolutions isolated', async () => {
    const cases: [string, string | null, string][] = [
      [alice, 'SELF', orgA],
      [carol, 'GLOBAL', orgB],
      [suspended, null, orgA],
      [bob, 'SELF', orgA],
      [unengaged, null, orgA],
      [dormant, null, orgA],
    ];
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const [person, , org] = cases[i % cases.length]!;
        return inContext<{ s: string | null; pid: string | null }>(
          { personId: person, orgId: org },
          `select authz.scope_for('people.view') s, authz.person_id() pid`,
        );
      }),
    );
    results.forEach((r, i) => {
      const [person, expected] = cases[i % cases.length]!;
      expect(r[0]!.s, `row ${i}`).toBe(expected);
      if (expected !== null) expect(r[0]!.pid, `row ${i}`).toBe(person);
    });
  });
});
