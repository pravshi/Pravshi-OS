import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Task 1.7 — roles, permissions, role_permissions, person_roles.
 *
 * The question this file exists to answer is not "can a role be created" but "can anybody
 * give themselves one". Most of what follows is therefore an attack, run through a real
 * database role against real policies and triggers.
 *
 * Two connections, and the difference between them is the whole point:
 *
 *   asUser  the runtime role. Holds no write grant on any of these four tables, so its
 *           attacks fail at the privilege check.
 *   owner   full write privilege on everything. Its attacks fail at the TRIGGER, because
 *           the protected-role rule judges the identity in the transaction context and
 *           not the database role that opened the connection. This is the barrier that
 *           would still be standing if a write grant were ever added by mistake.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `R${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

let orgA = '';
let orgB = '';
let deptA = '';
let deptB = '';

let sa = ''; // orgA, SUPER_ADMIN, active
let saSuspended = ''; // orgA, SUPER_ADMIN, engagement SUSPENDED
let hr = ''; // orgA, HR_ADMIN
let adm = ''; // orgA, ADMIN
let fin = ''; // orgA, FINANCE
let emp = ''; // orgA, EMPLOYEE
let plain = ''; // orgA, no roles at all
let saB = ''; // orgB, SUPER_ADMIN

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

const mkEngagement = (org: string, person: string, dept: string, status = 'ACTIVE') =>
  owner.query(
    `insert into public.engagements
       (org_id,person_id,department_id,engagement_type,status,start_date)
     values ($1,$2,$3,'EMPLOYEE','${status}'::public.engagement_status,current_date)`,
    [org, person, dept],
  );

const roleId = async (org: string, key: string) =>
  (
    await owner.query<{ id: string }>(`select id from public.roles where org_id=$1 and key=$2`, [
      org,
      key,
    ])
  ).rows[0]!.id;

const permissionId = async (key: string) =>
  (await owner.query<{ id: string }>(`select id from public.permissions where key=$1`, [key]))
    .rows[0]!.id;

/** One transaction carrying identity context, as the runtime role. */
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

/**
 * The same, but on the OWNER connection: every table privilege, acting as a named person.
 * This is how an escalation attempt by a compromised or careless privileged path is
 * simulated. If a test here passes, the trigger — not the grant — is what stopped it.
 */
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

const grantRole = (person: string, role: string, org: string) =>
  owner.query(`insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`, [
    person,
    role,
    org,
  ]);

beforeAll(async () => {
  const mkOrg = async (s: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name,slug) values ($1,$2) returning id`,
        [`Rp ${s}`, `rp-${RUN}-${s}`],
      )
    ).rows[0]!.id;
  // Independent rows go together. Serially this fixture is thirty-five round trips to
  // Neon, which overruns the hook budget as soon as the branch is under any load.
  [orgA, orgB] = await Promise.all([mkOrg('a'), mkOrg('b')]);

  const mkDept = async (org: string, code: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.departments (org_id,code,name) values ($1,$2,$3) returning id`,
        [org, code, `Dept ${code}`],
      )
    ).rows[0]!.id;
  [deptA, deptB] = await Promise.all([mkDept(orgA, `${CODE}_A`), mkDept(orgB, `${CODE}_B`)]);

  [sa, saSuspended, hr, adm, fin, emp, plain, saB] = await Promise.all([
    mkPerson(orgA, 'Super Admin'),
    mkPerson(orgA, 'Suspended Super Admin'),
    mkPerson(orgA, 'HR Admin'),
    mkPerson(orgA, 'Admin'),
    mkPerson(orgA, 'Finance'),
    mkPerson(orgA, 'Employee'),
    mkPerson(orgA, 'No Roles'),
    mkPerson(orgB, 'Super Admin B'),
  ]);

  const [superA, superB, hrRole, adminRole, finRole, empRole] = await Promise.all([
    roleId(orgA, 'SUPER_ADMIN'),
    roleId(orgB, 'SUPER_ADMIN'),
    roleId(orgA, 'HR_ADMIN'),
    roleId(orgA, 'ADMIN'),
    roleId(orgA, 'FINANCE'),
    roleId(orgA, 'EMPLOYEE'),
  ]);

  await Promise.all([
    ...[sa, hr, adm, fin, emp, plain].map((p) => mkEngagement(orgA, p, deptA)),
    mkEngagement(orgA, saSuspended, deptA, 'SUSPENDED'),
    mkEngagement(orgB, saB, deptB),
  ]);

  // Genesis: neither organization has a roles.manage holder yet, so the first protected
  // grant is permitted from a non-runtime role. This is the Task 1.14 bootstrap path. The
  // two organizations are independent, so their genesis grants do not race each other.
  await Promise.all([grantRole(sa, superA, orgA), grantRole(saB, superB, orgB)]);

  await Promise.all([
    grantRole(hr, hrRole, orgA),
    grantRole(adm, adminRole, orgA),
    grantRole(fin, finRole, orgA),
    grantRole(emp, empRole, orgA),
  ]);

  // Genesis is now closed for orgA, so this second protected grant has to go through an
  // actual GLOBAL roles.manage holder. That it succeeds is the positive control for every
  // negative test below.
  await asActor(
    { personId: sa, orgId: orgA },
    `insert into public.person_roles (person_id, role_id, org_id, granted_by) values ($1,$2,$3,$4)`,
    [saSuspended, superA, orgA, sa],
  );
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

// ── structure ────────────────────────────────────────────────────────────────────

describe('structure', () => {
  it('creates the four authorization tables', async () => {
    const { rows } = await owner.query<{ tablename: string }>(
      `select tablename from pg_tables
       where schemaname='public'
         and tablename in ('roles','permissions','role_permissions','person_roles')
       order by tablename`,
    );
    expect(rows.map((r) => r.tablename)).toEqual([
      'permissions',
      'person_roles',
      'role_permissions',
      'roles',
    ]);
  });

  it('declares access_scope broadest-first, so min(scope) is the broadest grant', async () => {
    const { rows } = await owner.query<{ labels: string[] }>(
      `select array_agg(e.enumlabel::text order by e.enumsortorder) labels
       from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname='access_scope'`,
    );
    expect(rows[0]!.labels).toEqual(['GLOBAL', 'DEPARTMENT', 'TEAM', 'PROJECT', 'SELF']);
  });

  it('uses the authoritative primary keys', async () => {
    const { rows } = await owner.query<{ table_name: string; cols: string[] }>(
      `select tc.table_name, array_agg(kcu.column_name::text order by kcu.ordinal_position) cols
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
       where tc.constraint_type='PRIMARY KEY' and tc.table_schema='public'
         and tc.table_name in ('role_permissions','person_roles')
       group by tc.table_name order by tc.table_name`,
    );
    const byTable = new Map(rows.map((r) => [r.table_name, r.cols]));
    expect(byTable.get('role_permissions')).toEqual(['role_id', 'permission_id']);
    expect(byTable.get('person_roles')).toEqual(['person_id', 'role_id']);
  });

  it('puts org_id where a second organization could disagree, and nowhere else', async () => {
    const { rows } = await owner.query<{ table_name: string }>(
      `select table_name from information_schema.columns
       where table_schema='public' and column_name='org_id'
         and table_name in ('roles','permissions','role_permissions','person_roles')
       order by table_name`,
    );
    // person_roles joins two org-bearing parents and needs it. roles is a tenant record.
    // permissions is a shared catalogue and role_permissions has exactly one org-bearing
    // parent, so an org_id on either would be truth with nothing to check it against.
    expect(rows.map((r) => r.table_name)).toEqual(['person_roles', 'roles']);
  });

  it('indexes both directions of the role/permission join, and person_roles by person', async () => {
    const { rows } = await owner.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname='public'
         and tablename in ('role_permissions','person_roles','roles')`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('role_permissions_pkey'); // role -> permissions
    expect(names).toContain('role_permissions_permission_idx'); // permission -> roles
    expect(names).toContain('person_roles_person_idx');
    expect(names).toContain('person_roles_role_idx');
    expect(names).toContain('roles_org_key_unique');
  });

  it('reserves a role key permanently: uniqueness is not partial', async () => {
    const { rows } = await owner.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where indexname='roles_org_key_unique'`,
    );
    expect(rows[0]!.indexdef).not.toMatch(/where/i);
  });
});

// ── the catalogue ────────────────────────────────────────────────────────────────

describe('permission catalogue', () => {
  it('seeds the security.md V1 catalogue and nothing invented', async () => {
    const { rows } = await owner.query<{ count: string }>(
      `select count(*) count from public.permissions`,
    );
    // 81 from the security.md section 1 V1 catalogue, plus record_grants.manage, added by
    // the Task 1.9 amendment as the capability requirePermission() will name, plus the
    // 14 CRM permissions (companies/contacts/deals) from the Phase 2 CRM migration (0033),
    // plus the 8 Track B permissions (activities/relationships × view/create/edit/delete)
    // from migration 0034.
    expect(Number(rows[0]!.count)).toBe(104);
  });

  it('holds every named key from each module', async () => {
    const expected = [
      'users.view',
      'users.create',
      'users.edit',
      'users.suspend',
      'users.delete',
      'users.impersonate',
      'sessions.revoke',
      'roles.view',
      'roles.manage',
      'permissions.view',
      'permissions.manage',
      'departments.view',
      'departments.manage',
      'teams.view',
      'teams.manage',
      'people.view',
      'people.create',
      'people.edit',
      'people.archive',
      'people.export',
      'hr.sensitive.view',
      'hr.sensitive.edit',
      'compensation.view',
      'compensation.edit',
      'engagements.view',
      'engagements.create',
      'engagements.edit',
      'engagements.transition',
      'candidates.view',
      'candidates.create',
      'candidates.edit',
      'interviews.view',
      'interviews.schedule',
      'scorecards.create',
      'scorecards.view_all',
      'offers.create',
      'offers.approve',
      'onboarding.view',
      'onboarding.manage',
      'onboarding.complete_task',
      'offboarding.view',
      'offboarding.initiate',
      'offboarding.manage',
      'leads.view',
      'leads.create',
      'leads.edit',
      'leads.delete',
      'leads.assign',
      'leads.export',
      'clients.view',
      'clients.create',
      'clients.edit',
      'clients.delete',
      'pipeline.manage',
      // Phase 2 CRM module (migration 0033). The CRM replaces the legacy sales
      // vocabulary for grants; the legacy keys above remain in the catalogue.
      'companies.view',
      'companies.create',
      'companies.edit',
      'companies.delete',
      'contacts.view',
      'contacts.create',
      'contacts.edit',
      'contacts.delete',
      'contacts.export',
      'deals.view',
      'deals.create',
      'deals.edit',
      'deals.delete',
      'deals.export',
      // Phase 2 Track B (migration 0034): the activity log and relationship permissions.
      'activities.view',
      'activities.create',
      'activities.edit',
      'activities.delete',
      'relationships.view',
      'relationships.create',
      'relationships.edit',
      'relationships.delete',
      'projects.view',
      'projects.create',
      'projects.edit',
      'projects.delete',
      'projects.manage_members',
      'tasks.view',
      'tasks.create',
      'tasks.edit',
      'tasks.assign',
      'tasks.delete',
      'tasks.comment',
      'documents.view',
      'documents.upload',
      'documents.download',
      'documents.verify',
      'documents.delete',
      'policies.view',
      'policies.manage',
      'policies.acknowledge',
      'policies.view_compliance',
      'reports.view',
      'reports.export',
      'audit_logs.view',
      'audit_logs.export',
      'settings.view',
      'settings.manage',
      'integrations.manage',
      // Task 1.9 amendment. Sits in the roles_permissions module with the other two
      // authorization-configuration capabilities.
      'record_grants.manage',
    ];
    const { rows } = await owner.query<{ key: string }>(`select key from public.permissions`);
    const keys = rows.map((r) => r.key);
    for (const k of expected) expect(keys, k).toContain(k);
    expect(keys.length).toBe(expected.length);
  });

  it('keeps resource.action in agreement with the key on every row', async () => {
    const { rows } = await owner.query<{ key: string }>(
      `select key from public.permissions where key <> resource || '.' || action`,
    );
    expect(rows).toEqual([]);
  });

  it('splits at the last dot, so hr.sensitive.view is a resource of hr.sensitive', async () => {
    const { rows } = await owner.query<{ resource: string; action: string }>(
      `select resource, action from public.permissions where key='hr.sensitive.view'`,
    );
    expect(rows[0]).toEqual({ resource: 'hr.sensitive', action: 'view' });
  });

  it('marks sensitive exactly where the architecture names a boundary', async () => {
    const { rows } = await owner.query<{ key: string }>(
      `select key from public.permissions where is_sensitive order by key`,
    );
    expect(rows.map((r) => r.key)).toEqual([
      'audit_logs.export',
      'audit_logs.view',
      'compensation.edit',
      'compensation.view',
      'contacts.export',
      'deals.export',
      'hr.sensitive.edit',
      'hr.sensitive.view',
      'leads.export',
      'people.export',
      'permissions.manage',
      'record_grants.manage',
      'reports.export',
      'roles.manage',
      'users.impersonate',
    ]);
  });

  it('lists users.impersonate but grants it to no role at all', async () => {
    const { rows } = await owner.query<{ count: string }>(
      `select count(*) count from public.role_permissions rp
       join public.permissions p on p.id = rp.permission_id
       where p.key='users.impersonate'`,
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });

  it('does not invent an openings.* expansion from a wildcard', async () => {
    const { rows } = await owner.query(
      `select 1 from public.permissions where key like 'openings.%'`,
    );
    expect(rows).toEqual([]);
  });

  it('rejects a permission whose key does not match its parts', async () => {
    await expect(
      owner.query(
        `insert into public.permissions (key,resource,action,module)
         values ('bogus.thing','other','thing','test')`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a duplicate key', async () => {
    await expect(
      owner.query(
        `insert into public.permissions (key,resource,action,module)
         values ('leads.view','leads','view','sales')`,
      ),
    ).rejects.toThrow();
  });
});

// ── the seeded system roles ──────────────────────────────────────────────────────

describe('system roles', () => {
  it('gives every organization the blueprint 6.1 role set at creation', async () => {
    const { rows } = await owner.query<{ key: string }>(
      `select key from public.roles where org_id=$1 order by key`,
      [orgA],
    );
    expect(rows.map((r) => r.key)).toEqual([
      'ADMIN',
      'DEVELOPER',
      'EMPLOYEE',
      'FINANCE',
      'HR_ADMIN',
      'HR_MANAGER',
      'INTERN',
      'MANAGER',
      'MARKETING',
      'PROJECT_MANAGER',
      'SALES',
      'SALES_MANAGER',
      'SUPER_ADMIN',
      'VIBECODER',
    ]);
  });

  it('seeds a brand-new organization without anyone asking it to', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `insert into public.organizations (name,slug) values ($1,$2) returning id`,
      [`Rp fresh ${RUN}`, `rp-${RUN}-fresh`],
    );
    const fresh = rows[0]!.id;
    const seeded = await owner.query<{ roles: string; grants: string }>(
      `select (select count(*) from public.roles where org_id=$1) roles,
              (select count(*) from public.role_permissions rp
                 join public.roles r on r.id=rp.role_id where r.org_id=$1) grants`,
      [fresh],
    );
    expect(Number(seeded.rows[0]!.roles)).toBe(14);
    expect(Number(seeded.rows[0]!.grants)).toBeGreaterThan(200);
  });

  it('marks every seeded role is_system, and only SUPER_ADMIN is_protected', async () => {
    const { rows } = await owner.query<{ key: string; is_system: boolean; is_protected: boolean }>(
      `select key, is_system, is_protected from public.roles where org_id=$1`,
      [orgA],
    );
    for (const r of rows) expect(r.is_system, r.key).toBe(true);
    expect(rows.filter((r) => r.is_protected).map((r) => r.key)).toEqual(['SUPER_ADMIN']);
  });

  it('gives SUPER_ADMIN the whole catalogue at GLOBAL except users.impersonate', async () => {
    const { rows } = await owner.query<{ total: string; global: string }>(
      `select count(*) total, count(*) filter (where rp.scope='GLOBAL') global
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       where r.org_id=$1 and r.key='SUPER_ADMIN'`,
      [orgA],
    );
    // 104 in the catalogue (82 pre-CRM + 14 CRM + 8 Track B), minus users.impersonate
    // which is listed but granted to no role.
    expect(Number(rows[0]!.total)).toBe(103);
    expect(Number(rows[0]!.global)).toBe(103);
  });

  it('seeds MANAGER and MARKETING with no grants rather than guessing at them', async () => {
    const { rows } = await owner.query<{ key: string; count: string }>(
      `select r.key, count(rp.permission_id) count
       from public.roles r left join public.role_permissions rp on rp.role_id=r.id
       where r.org_id=$1 and r.key in ('MANAGER','MARKETING')
       group by r.key order by r.key`,
      [orgA],
    );
    expect(rows.map((r) => [r.key, Number(r.count)])).toEqual([
      ['MANAGER', 0],
      ['MARKETING', 0],
    ]);
  });

  it('assigns no seeded role to any real person', async () => {
    // The fixtures in this file assign roles deliberately. The migration must not.
    const { rows } = await owner.query<{ count: string }>(
      `select count(*) count from public.person_roles pr
       join public.roles r on r.id = pr.role_id
       where r.org_id = (select id from public.organizations where slug=$1)`,
      [`rp-${RUN}-fresh`],
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });
});

// ── the four assertions security.md exists to guarantee ──────────────────────────

describe('the role boundaries the architecture names explicitly', () => {
  const grantsOf = async (key: string) =>
    (
      await owner.query<{ key: string; scope: string }>(
        `select p.key, rp.scope from public.role_permissions rp
         join public.roles r on r.id=rp.role_id
         join public.permissions p on p.id=rp.permission_id
         where r.org_id=$1 and r.key=$2`,
        [orgA, key],
      )
    ).rows;

  it('ADMIN is not a superset of HR', async () => {
    const admin = await grantsOf('ADMIN');
    const keys = admin.map((g) => g.key);
    for (const forbidden of [
      'hr.sensitive.view',
      'hr.sensitive.edit',
      'compensation.view',
      'compensation.edit',
    ]) {
      expect(keys, `ADMIN must not hold ${forbidden}`).not.toContain(forbidden);
    }
    // and HR_ADMIN does hold them, so the difference is real rather than an empty seed
    const hrKeys = (await grantsOf('HR_ADMIN')).map((g) => g.key);
    expect(hrKeys).toContain('hr.sensitive.view');
    expect(hrKeys).toContain('compensation.view');
  });

  it('HR cannot reach the sales pipeline or the audit log', async () => {
    for (const role of ['HR_ADMIN', 'HR_MANAGER']) {
      const keys = (await grantsOf(role)).map((g) => g.key);
      expect(
        keys.filter((k) => k.startsWith('leads.')),
        role,
      ).toEqual([]);
      expect(keys, role).not.toContain('audit_logs.view');
      expect(keys, role).not.toContain('pipeline.manage');
    }
  });

  it('sales cannot reach HR', async () => {
    for (const role of ['SALES', 'SALES_MANAGER']) {
      const grants = await grantsOf(role);
      const keys = grants.map((g) => g.key);
      expect(
        keys.filter((k) => k.startsWith('hr.')),
        role,
      ).toEqual([]);
      expect(
        keys.filter((k) => k.startsWith('compensation.')),
        role,
      ).toEqual([]);
      const peopleEdit = grants.find((g) => g.key === 'people.edit');
      if (peopleEdit) expect(peopleEdit.scope, `${role} people.edit`).toBe('SELF');
    }
  });

  it('interns and vibecoders hold nothing above PROJECT scope', async () => {
    for (const role of ['INTERN', 'VIBECODER']) {
      const grants = await grantsOf(role);
      expect(grants.length, role).toBeGreaterThan(0);
      for (const g of grants) {
        expect(['PROJECT', 'SELF'], `${role} ${g.key}`).toContain(g.scope);
      }
    }
  });

  it('FINANCE is a separate boundary: commercial data, no HR data', async () => {
    const keys = (await grantsOf('FINANCE')).map((g) => g.key);
    expect(keys).toContain('compensation.view');
    expect(keys).toContain('projects.view');
    expect(keys).not.toContain('hr.sensitive.view');
    expect(keys).not.toContain('people.export');
    expect(keys).not.toContain('candidates.view');
  });

  it('gives role management to SUPER_ADMIN and to nobody else', async () => {
    const { rows } = await owner.query<{ key: string }>(
      `select distinct r.key from public.role_permissions rp
       join public.roles r on r.id=rp.role_id
       join public.permissions p on p.id=rp.permission_id
       where r.org_id=$1 and p.key in ('roles.manage','permissions.manage')`,
      [orgA],
    );
    expect(rows.map((r) => r.key)).toEqual(['SUPER_ADMIN']);
  });

  it('gives EMPLOYEE a self-service baseline and nothing wider', async () => {
    const grants = await grantsOf('EMPLOYEE');
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g.scope, g.key).toBe('SELF');
  });
});

// ── role_permissions ─────────────────────────────────────────────────────────────

describe('role_permissions', () => {
  it('accepts a valid grant on an unprotected role', async () => {
    const role = await roleId(orgA, 'MARKETING');
    const perm = await permissionId('leads.view');
    await owner.query(
      `insert into public.role_permissions (role_id,permission_id,scope) values ($1,$2,'DEPARTMENT')`,
      [role, perm],
    );
    const { rows } = await owner.query(
      `select 1 from public.role_permissions where role_id=$1 and permission_id=$2`,
      [role, perm],
    );
    expect(rows.length).toBe(1);
    await owner.query(`delete from public.role_permissions where role_id=$1 and permission_id=$2`, [
      role,
      perm,
    ]);
  });

  it('blocks a duplicate grant', async () => {
    const role = await roleId(orgA, 'EMPLOYEE');
    const perm = await permissionId('people.view');
    await expect(
      owner.query(
        `insert into public.role_permissions (role_id,permission_id,scope) values ($1,$2,'GLOBAL')`,
        [role, perm],
      ),
    ).rejects.toThrow();
  });

  it('blocks a grant naming a permission that does not exist', async () => {
    const role = await roleId(orgA, 'MARKETING');
    await expect(
      owner.query(
        `insert into public.role_permissions (role_id,permission_id,scope)
         values ($1,'00000000-0000-0000-0000-000000000000','GLOBAL')`,
        [role],
      ),
    ).rejects.toThrow();
  });

  it('blocks a grant naming a role that does not exist', async () => {
    const perm = await permissionId('people.view');
    await expect(
      owner.query(
        `insert into public.role_permissions (role_id,permission_id,scope)
         values ('00000000-0000-0000-0000-000000000000',$1,'GLOBAL')`,
        [perm],
      ),
    ).rejects.toThrow();
  });

  it('requires a scope on every grant', async () => {
    const role = await roleId(orgA, 'MARKETING');
    const perm = await permissionId('teams.view');
    await expect(
      owner.query(
        `insert into public.role_permissions (role_id,permission_id,scope) values ($1,$2,null)`,
        [role, perm],
      ),
    ).rejects.toThrow();
  });
});

// ── person_roles ─────────────────────────────────────────────────────────────────

describe('person_roles', () => {
  it('accepts an assignment of an unprotected role', async () => {
    const role = await roleId(orgA, 'DEVELOPER');
    await grantRole(plain, role, orgA);
    const { rows } = await owner.query(
      `select 1 from public.person_roles where person_id=$1 and role_id=$2`,
      [plain, role],
    );
    expect(rows.length).toBe(1);
    await owner.query(`delete from public.person_roles where person_id=$1 and role_id=$2`, [
      plain,
      role,
    ]);
  });

  it('blocks a duplicate assignment', async () => {
    await expect(grantRole(emp, await roleId(orgA, 'EMPLOYEE'), orgA)).rejects.toThrow();
  });

  it('blocks assigning another organization role to this organization person', async () => {
    const roleB = await roleId(orgB, 'DEVELOPER');
    await expect(grantRole(plain, roleB, orgA)).rejects.toThrow();
    // and the same attempt with the other organization id, which the person cannot satisfy
    await expect(grantRole(plain, roleB, orgB)).rejects.toThrow();
  });

  it('blocks an assignment naming a person or role that does not exist', async () => {
    const role = await roleId(orgA, 'DEVELOPER');
    await expect(grantRole('00000000-0000-0000-0000-000000000000', role, orgA)).rejects.toThrow();
    await expect(grantRole(plain, '00000000-0000-0000-0000-000000000000', orgA)).rejects.toThrow();
  });

  it('blocks a granted_by from another organization', async () => {
    const role = await roleId(orgA, 'DEVELOPER');
    await expect(
      owner.query(
        `insert into public.person_roles (person_id,role_id,org_id,granted_by) values ($1,$2,$3,$4)`,
        [plain, role, orgA, saB],
      ),
    ).rejects.toThrow();
  });

  it('rejects an expiry that precedes the grant', async () => {
    const role = await roleId(orgA, 'DEVELOPER');
    await expect(
      owner.query(
        `insert into public.person_roles (person_id,role_id,org_id,expires_at)
         values ($1,$2,$3, now() - interval '1 day')`,
        [plain, role, orgA],
      ),
    ).rejects.toThrow();
  });
});

// ── the protected-role rule ──────────────────────────────────────────────────────

describe('the protected-role rule', () => {
  const superAdmin = () => roleId(orgA, 'SUPER_ADMIN');

  it('refuses HR self-assignment of SUPER_ADMIN, even on a fully privileged connection', async () => {
    await expect(
      asActor(
        { personId: hr, orgId: orgA },
        `insert into public.person_roles (person_id,role_id,org_id) values ($1,$2,$3)`,
        [hr, await superAdmin(), orgA],
      ),
    ).rejects.toThrow(/protected role requires roles.manage at GLOBAL/i);
  });

  it('refuses HR granting SUPER_ADMIN to somebody else', async () => {
    await expect(
      asActor(
        { personId: hr, orgId: orgA },
        `insert into public.person_roles (person_id,role_id,org_id) values ($1,$2,$3)`,
        [plain, await superAdmin(), orgA],
      ),
    ).rejects.toThrow(/protected role requires roles.manage at GLOBAL/i);
  });

  it('refuses HR revoking an existing SUPER_ADMIN assignment', async () => {
    await expect(
      asActor(
        { personId: hr, orgId: orgA },
        `delete from public.person_roles where person_id=$1 and role_id=$2`,
        [sa, await superAdmin()],
      ),
    ).rejects.toThrow(/protected role requires roles.manage at GLOBAL/i);
  });

  it('refuses HR repointing an ordinary assignment at SUPER_ADMIN', async () => {
    await expect(
      asActor(
        { personId: hr, orgId: orgA },
        `update public.person_roles set role_id=$1 where person_id=$2 and role_id=$3`,
        [await superAdmin(), emp, await roleId(orgA, 'EMPLOYEE')],
      ),
    ).rejects.toThrow(/protected role requires roles.manage at GLOBAL/i);
  });

  it('refuses HR modifying the protected role itself', async () => {
    await expect(
      asActor({ personId: hr, orgId: orgA }, `update public.roles set name=$1 where id=$2`, [
        'Compromised',
        await superAdmin(),
      ]),
    ).rejects.toThrow(/protected role requires roles.manage at GLOBAL/i);
  });

  it('refuses HR removing the protection flag', async () => {
    await expect(
      asActor(
        { personId: hr, orgId: orgA },
        `update public.roles set is_protected=false where id=$1`,
        [await superAdmin()],
      ),
    ).rejects.toThrow(/protected role requires roles.manage at GLOBAL/i);
  });

  it('refuses HR creating a protected role of its own', async () => {
    await expect(
      asActor(
        { personId: hr, orgId: orgA },
        `insert into public.roles (org_id,key,name,is_protected) values ($1,$2,$3,true)`,
        [orgA, `${CODE}_EVIL`, 'Evil'],
      ),
    ).rejects.toThrow(/protected role requires roles.manage at GLOBAL/i);
  });

  it('refuses HR granting role management to an ordinary role — the loophole', async () => {
    // Create the ordinary role as an unprivileged actor: this part is allowed, because an
    // unprotected role is not yet dangerous. The escalation only becomes real at the
    // moment roles.manage is attached to it, which is where the trigger stands.
    const created = await asActor<{ id: string }>(
      { personId: hr, orgId: orgA },
      `insert into public.roles (org_id,key,name) values ($1,$2,$3) returning id`,
      [orgA, `${CODE}_SNEAK`, 'Sneaky'],
    );
    const sneaky = created[0]!.id;
    await expect(
      asActor(
        { personId: hr, orgId: orgA },
        `insert into public.role_permissions (role_id,permission_id,scope)
         values ($1,$2,'GLOBAL')`,
        [sneaky, await permissionId('roles.manage')],
      ),
    ).rejects.toThrow(/roles.manage at GLOBAL/i);
    await expect(
      asActor(
        { personId: hr, orgId: orgA },
        `insert into public.role_permissions (role_id,permission_id,scope)
         values ($1,$2,'GLOBAL')`,
        [sneaky, await permissionId('permissions.manage')],
      ),
    ).rejects.toThrow(/roles.manage at GLOBAL/i);
  });

  it('refuses to let anyone delete a system role', async () => {
    await expect(
      asActor({ personId: sa, orgId: orgA }, `delete from public.roles where id=$1`, [
        await roleId(orgA, 'EMPLOYEE'),
      ]),
    ).rejects.toThrow(/system role cannot be deleted/i);
    // including on a connection with no identity at all
    await expect(
      owner.query(`delete from public.roles where id=$1`, [await roleId(orgA, 'MARKETING')]),
    ).rejects.toThrow(/system role cannot be deleted/i);
  });

  it('refuses to reclassify a system role so it could then be deleted', async () => {
    await expect(
      asActor(
        { personId: sa, orgId: orgA },
        `update public.roles set is_system=false where id=$1`,
        [await roleId(orgA, 'EMPLOYEE')],
      ),
    ).rejects.toThrow(/is_system is immutable/i);
  });

  it('refuses to rename a role key or move a role between organizations', async () => {
    const role = await roleId(orgA, 'DEVELOPER');
    await expect(
      asActor({ personId: sa, orgId: orgA }, `update public.roles set key=$1 where id=$2`, [
        'SUPER_ADMIN_2',
        role,
      ]),
    ).rejects.toThrow(/role key is immutable/i);
    await expect(
      asActor({ personId: sa, orgId: orgA }, `update public.roles set org_id=$1 where id=$2`, [
        orgB,
        role,
      ]),
    ).rejects.toThrow(/another organization/i);
  });

  it('lets an actual GLOBAL roles.manage holder do all of it', async () => {
    const role = await superAdmin();
    await asActor(
      { personId: sa, orgId: orgA },
      `insert into public.person_roles (person_id,role_id,org_id,granted_by) values ($1,$2,$3,$4)`,
      [plain, role, orgA, sa],
    );
    const held = await owner.query(
      `select 1 from public.person_roles where person_id=$1 and role_id=$2`,
      [plain, role],
    );
    expect(held.rows.length).toBe(1);

    await asActor(
      { personId: sa, orgId: orgA },
      `delete from public.person_roles where person_id=$1 and role_id=$2`,
      [plain, role],
    );
    const gone = await owner.query(
      `select 1 from public.person_roles where person_id=$1 and role_id=$2`,
      [plain, role],
    );
    expect(gone.rows.length).toBe(0);
  });

  it('refuses a SUPER_ADMIN whose engagement is not live', async () => {
    // saSuspended holds the role. Access is derived from the engagement, so holding it is
    // not the same as being able to use it.
    await expect(
      asActor(
        { personId: saSuspended, orgId: orgA },
        `insert into public.person_roles (person_id,role_id,org_id) values ($1,$2,$3)`,
        [plain, await superAdmin(), orgA],
      ),
    ).rejects.toThrow(/roles.manage at GLOBAL/i);
  });

  it('refuses a SUPER_ADMIN from another organization', async () => {
    await expect(
      asActor(
        { personId: saB, orgId: orgB },
        `insert into public.person_roles (person_id,role_id,org_id) values ($1,$2,$3)`,
        [plain, await superAdmin(), orgA],
      ),
    ).rejects.toThrow(/roles.manage at GLOBAL/i);
  });

  it('closes the genesis path once an organization has a holder', async () => {
    // No identity, full privilege, and still refused: the bootstrap exception is spent.
    await expect(
      owner.query(`insert into public.person_roles (person_id,role_id,org_id) values ($1,$2,$3)`, [
        plain,
        await superAdmin(),
        orgA,
      ]),
    ).rejects.toThrow(/protected role requires roles.manage at GLOBAL/i);
  });

  it('leaves genesis open for an organization that has no holder yet', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `insert into public.organizations (name,slug) values ($1,$2) returning id`,
      [`Rp genesis ${RUN}`, `rp-${RUN}-genesis`],
    );
    const org = rows[0]!.id;
    const dept = (
      await owner.query<{ id: string }>(
        `insert into public.departments (org_id,code,name) values ($1,$2,$3) returning id`,
        [org, `${CODE}_G`, 'Genesis'],
      )
    ).rows[0]!.id;
    const founder = await mkPerson(org, 'Founder');
    await mkEngagement(org, founder, dept);

    await grantRole(founder, await roleId(org, 'SUPER_ADMIN'), org);
    const held = await owner.query(`select 1 from public.person_roles where person_id=$1`, [
      founder,
    ]);
    expect(held.rows.length).toBe(1);

    // and it is spent immediately afterwards
    const second = await mkPerson(org, 'Second');
    await mkEngagement(org, second, dept);
    await expect(grantRole(second, await roleId(org, 'SUPER_ADMIN'), org)).rejects.toThrow(
      /protected role requires roles.manage at GLOBAL/i,
    );
  });

  it('treats a role that carries roles.manage as protected even without the flag', async () => {
    const { rows } = await owner.query<{ derived: boolean; flagged: boolean }>(
      `select public.role_is_protected(r.id) derived, r.is_protected flagged
       from public.roles r where r.org_id=$1 and r.key='SUPER_ADMIN'`,
      [orgA],
    );
    expect(rows[0]!.derived).toBe(true);
    const ordinary = await owner.query<{ derived: boolean }>(
      `select public.role_is_protected(r.id) derived from public.roles r
       where r.org_id=$1 and r.key='EMPLOYEE'`,
      [orgA],
    );
    expect(ordinary.rows[0]!.derived).toBe(false);
  });
});

// ── permission identity ──────────────────────────────────────────────────────────

describe('permission identity', () => {
  it('refuses to rename a permission key', async () => {
    await expect(
      owner.query(`update public.permissions set key='roles.manage' where key='people.view'`),
    ).rejects.toThrow(/permission key is immutable/i);
  });

  it('refuses to delete the permissions the protected-role rule is written in terms of', async () => {
    for (const key of ['roles.manage', 'permissions.manage']) {
      await expect(
        owner.query(`delete from public.permissions where key=$1`, [key]),
      ).rejects.toThrow(/cannot be removed/i);
    }
  });

  it('still allows ordinary catalogue metadata to be edited', async () => {
    await owner.query(
      `update public.permissions set description='edited by a test' where key='teams.view'`,
    );
    const { rows } = await owner.query<{ description: string }>(
      `select description from public.permissions where key='teams.view'`,
    );
    expect(rows[0]!.description).toBe('edited by a test');
  });
});

// ── direct SQL attacks as the runtime role ───────────────────────────────────────

describe('direct SQL attacks from app_user', () => {
  it('cannot write to any of the four tables', async () => {
    const role = await roleId(orgA, 'SUPER_ADMIN');
    const attempts: [string, string, unknown[]][] = [
      [
        'grant itself SUPER_ADMIN knowing the uuid',
        `insert into public.person_roles (person_id,role_id,org_id) values ($1,$2,$3)`,
        [emp, role, orgA],
      ],
      [
        'repoint its own assignment',
        `update public.person_roles set role_id=$1 where person_id=$2`,
        [role, emp],
      ],
      ['drop an assignment', `delete from public.person_roles where person_id=$1`, [emp]],
      [
        'grant itself a permission through role_permissions',
        `insert into public.role_permissions (role_id,permission_id,scope) values ($1,$2,'GLOBAL')`,
        [await roleId(orgA, 'EMPLOYEE'), await permissionId('roles.manage')],
      ],
      [
        'widen an existing grant',
        `update public.role_permissions set scope='GLOBAL' where role_id=$1`,
        [await roleId(orgA, 'EMPLOYEE')],
      ],
      [
        'rename a permission into a more powerful one',
        `update public.permissions set key='roles.manage' where key='people.view'`,
        [],
      ],
      [
        'mint a role',
        `insert into public.roles (org_id,key,name) values ($1,$2,$3)`,
        [orgA, `${CODE}_X`, 'X'],
      ],
      ['unprotect SUPER_ADMIN', `update public.roles set is_protected=false where id=$1`, [role]],
    ];
    // Run together rather than in sequence: each attempt is an independent transaction on
    // its own pooled connection, and eight serial round-trips to a cold branch is minutes
    // of test time for no extra evidence.
    const outcomes = await Promise.all(
      attempts.map(async ([label, sql, params]) => {
        try {
          await inContext({ personId: emp, orgId: orgA }, sql, params);
          return [label, 'SUCCEEDED'] as const;
        } catch (e) {
          return [label, (e as Error).message] as const;
        }
      }),
    );
    for (const [label, message] of outcomes) {
      expect(message, label).toMatch(/permission denied/i);
    }
  });

  it('cannot read another person assignments', async () => {
    const rows = await inContext<{ person_id: string }>(
      { personId: emp, orgId: orgA },
      `select person_id from public.person_roles`,
    );
    expect(rows.every((r) => r.person_id === emp)).toBe(true);
  });

  it('cannot read the roles it does not hold', async () => {
    const rows = await inContext<{ key: string }>(
      { personId: emp, orgId: orgA },
      `select key from public.roles`,
    );
    expect(rows.map((r) => r.key)).toEqual(['EMPLOYEE']);
  });

  it('cannot read the grants of roles it does not hold', async () => {
    const rows = await inContext<{ scope: string }>(
      { personId: emp, orgId: orgA },
      `select rp.scope from public.role_permissions rp
       join public.roles r on r.id = rp.role_id where r.key='SUPER_ADMIN'`,
    );
    expect(rows).toEqual([]);
  });

  it('sees only the catalogue entries for permissions it actually holds', async () => {
    const rows = await inContext<{ key: string }>(
      { personId: emp, orgId: orgA },
      `select key from public.permissions order by key`,
    );
    expect(rows.map((r) => r.key)).toEqual([
      'compensation.view',
      'documents.download',
      'documents.upload',
      'documents.view',
      'hr.sensitive.view',
      'people.edit',
      'people.view',
      'policies.acknowledge',
      'tasks.edit',
      'tasks.view',
    ]);
  });
});

// ── authz.has() ──────────────────────────────────────────────────────────────────

describe('authz.has()', () => {
  const has = async (person: string | null, org: string | null, key: string) =>
    (
      await inContext<{ h: boolean }>({ personId: person, orgId: org }, `select authz.has($1) h`, [
        key,
      ])
    )[0]!.h;

  it('is SECURITY DEFINER, STABLE, owned by app_owner, with search_path pinned empty', async () => {
    const { rows } = await owner.query<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
      owner: string;
    }>(
      `select p.prosecdef, p.provolatile, p.proconfig, r.rolname owner
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       join pg_roles r on r.oid = p.proowner
       where n.nspname='authz' and p.proname='has'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.prosecdef).toBe(true);
    expect(rows[0]!.provolatile).toBe('s');
    expect(rows[0]!.proconfig ?? []).toContain('search_path=""');
    expect(rows[0]!.owner).toBe('app_owner');
  });

  it('grants EXECUTE to app_user and app_admin and never to PUBLIC', async () => {
    const { rows } = await owner.query<{ grantee: string }>(
      `select coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC') grantee
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ac
       where n.nspname='authz' and p.proname='has' and ac.privilege_type='EXECUTE'`,
    );
    const grantees = rows.map((r) => r.grantee);
    expect(grantees).not.toContain('PUBLIC');
    expect(grantees).toContain('app_user');
    expect(grantees).toContain('app_admin');
  });

  it('is true only for a permission an assigned role actually grants', async () => {
    // One transaction per identity, several questions each: the answers are what matters,
    // and a round-trip per assertion is time spent proving nothing extra.
    const answers = async (person: string, keys: string[]) =>
      (
        await inContext<Record<string, boolean>>(
          { personId: person, orgId: orgA },
          `select ${keys.map((_, i) => `authz.has($${i + 1}) h${i}`).join(', ')}`,
          keys,
        )
      )[0]!;

    const employee = await answers(emp, [
      'policies.acknowledge',
      'people.view',
      'roles.manage',
      'leads.view',
    ]);
    expect([employee.h0, employee.h1, employee.h2, employee.h3]).toEqual([
      true,
      true,
      false,
      false,
    ]);

    const superAdmin = await answers(sa, ['roles.manage', 'permissions.manage']);
    expect([superAdmin.h0, superAdmin.h1]).toEqual([true, true]);

    const hrAdmin = await answers(hr, ['hr.sensitive.view', 'roles.manage', 'leads.view']);
    expect([hrAdmin.h0, hrAdmin.h1, hrAdmin.h2]).toEqual([true, false, false]);

    const finance = await answers(fin, ['compensation.view', 'hr.sensitive.view']);
    expect([finance.h0, finance.h1]).toEqual([true, false]);

    const administrator = await answers(adm, ['compensation.view', 'hr.sensitive.view']);
    expect([administrator.h0, administrator.h1]).toEqual([false, false]);
  });

  it('is false for an unknown permission key', async () => {
    expect(await has(sa, orgA, 'not.a.permission')).toBe(false);
    expect(await has(sa, orgA, '')).toBe(false);
  });

  it('is false with no identity at all', async () => {
    expect(await has(null, null, 'people.view')).toBe(false);
    expect(await has(null, orgA, 'people.view')).toBe(false);
  });

  it('is false for a person with no roles', async () => {
    expect(await has(plain, orgA, 'people.view')).toBe(false);
  });

  it('is false when the organization claim does not match the person', async () => {
    expect(await has(emp, orgB, 'people.view')).toBe(false);
  });

  it('is false when the engagement is not live', async () => {
    expect(await has(saSuspended, orgA, 'roles.manage')).toBe(false);
  });

  it('is false for a soft-deleted or non-ACTIVE person', async () => {
    const ghost = await mkPerson(orgA, 'Ghost');
    await mkEngagement(orgA, ghost, deptA);
    await grantRole(ghost, await roleId(orgA, 'EMPLOYEE'), orgA);
    expect(await has(ghost, orgA, 'people.view')).toBe(true);

    await owner.query(`update public.people set person_status='INACTIVE' where id=$1`, [ghost]);
    expect(await has(ghost, orgA, 'people.view')).toBe(false);

    await owner.query(
      `update public.people set person_status='ACTIVE', deleted_at=now() where id=$1`,
      [ghost],
    );
    expect(await has(ghost, orgA, 'people.view')).toBe(false);
  });

  it('is false once the assignment has expired', async () => {
    const temp = await mkPerson(orgA, 'Temp');
    await mkEngagement(orgA, temp, deptA);
    const role = await roleId(orgA, 'SALES');
    await owner.query(
      `insert into public.person_roles (person_id,role_id,org_id,expires_at)
       values ($1,$2,$3, now() + interval '1 second')`,
      [temp, role, orgA],
    );
    expect(await has(temp, orgA, 'companies.view')).toBe(true);
    await owner.query(
      `update public.person_roles
          set granted_at = now() - interval '2 days',
              expires_at = now() - interval '1 day'
        where person_id=$1 and role_id=$2`,
      [temp, role],
    );
    expect(await has(temp, orgA, 'companies.view')).toBe(false);
  });

  it('is false when the role is archived or soft-deleted', async () => {
    const p = await mkPerson(orgA, 'Archived Role Holder');
    await mkEngagement(orgA, p, deptA);
    const created = await asActor<{ id: string }>(
      { personId: sa, orgId: orgA },
      `insert into public.roles (org_id,key,name) values ($1,$2,$3) returning id`,
      [orgA, `${CODE}_TMP`, 'Temporary'],
    );
    const role = created[0]!.id;
    await owner.query(
      `insert into public.role_permissions (role_id,permission_id,scope) values ($1,$2,'GLOBAL')`,
      [role, await permissionId('teams.view')],
    );
    await grantRole(p, role, orgA);
    expect(await has(p, orgA, 'teams.view')).toBe(true);

    await asActor(
      { personId: sa, orgId: orgA },
      `update public.roles set status='ARCHIVED' where id=$1`,
      [role],
    );
    expect(await has(p, orgA, 'teams.view')).toBe(false);

    await asActor(
      { personId: sa, orgId: orgA },
      `update public.roles set status='ACTIVE', deleted_at=now() where id=$1`,
      [role],
    );
    expect(await has(p, orgA, 'teams.view')).toBe(false);
  });

  it('does not pretend to resolve scope: two roles with different scopes both answer true', async () => {
    // The whole point of the has()/scope_for() split. emp holds people.view at SELF and
    // hr holds it at GLOBAL; has() cannot tell them apart, and must not be used as though
    // it could.
    expect(await has(emp, orgA, 'people.view')).toBe(true);
    expect(await has(hr, orgA, 'people.view')).toBe(true);
    const scopes = await owner.query<{ scope: string }>(
      `select distinct rp.scope from public.role_permissions rp
       join public.roles r on r.id=rp.role_id
       join public.permissions p on p.id=rp.permission_id
       where r.org_id=$1 and r.key in ('EMPLOYEE','HR_ADMIN') and p.key='people.view'`,
      [orgA],
    );
    expect(scopes.rows.map((r) => r.scope).sort()).toEqual(['GLOBAL', 'SELF']);
  });

  it('creates no helper whose tables do not exist', async () => {
    const { rows } = await owner.query<{ proname: string }>(
      `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz'`,
    );
    const names = rows.map((r) => r.proname);
    // scope_for was on this list for Task 1.7 and arrived with Task 1.8, has_record_grant
    // with Task 1.9, reports_to_me with Task 1.16. Shrinking is the only direction this list
    // is allowed to move.
    for (const deferred of ['is_project_member']) {
      expect(names, `${deferred} must not exist as a stub`).not.toContain(deferred);
    }
  });

  it('leaves my_departments() driven by explicit membership, never by the tenant', async () => {
    const { rows } = await owner.query<{ src: string }>(
      `select pg_get_functiondef(p.oid) src from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' and p.proname='my_departments'`,
    );
    // Task 1.7 did not touch this helper; Task 1.8 completed it to the authoritative
    // "primary + secondary". What must hold either way is that membership is the only
    // source — there is no branch that returns the organization departments wholesale.
    const src = rows[0]!.src;
    expect(src).toContain('person_departments');
    expect(src).toContain('authz.person_id()');
    expect(src).toContain('authz.org_id()');
  });
});

// ── RLS and privileges ───────────────────────────────────────────────────────────

describe('RLS and privileges', () => {
  const tables = ['roles', 'permissions', 'role_permissions', 'person_roles'];

  it('enables AND forces row level security on all four tables', async () => {
    const { rows } = await owner.query<{ relname: string; enabled: boolean; forced: boolean }>(
      `select c.relname, c.relrowsecurity enabled, c.relforcerowsecurity forced
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname = any($1) order by c.relname`,
      [tables],
    );
    expect(rows.length).toBe(4);
    for (const r of rows) {
      expect(r.enabled, r.relname).toBe(true);
      expect(r.forced, r.relname).toBe(true);
    }
  });

  it('returns zero rows from every table when identity is absent', async () => {
    for (const t of tables) {
      const rows = await inContext({ personId: null, orgId: null }, `select * from public.${t}`);
      expect(rows, t).toEqual([]);
    }
  });

  it('has no app_user policy that can be satisfied without an identity', async () => {
    const { rows } = await owner.query<{ tablename: string; policyname: string; qual: string }>(
      `select tablename, policyname, qual from pg_policies
       where schemaname='public' and tablename = any($1) and 'app_user' = any(roles)`,
      [tables],
    );
    expect(rows.length).toBe(4);
    for (const p of rows) {
      expect(p.qual ?? '', `${p.tablename}.${p.policyname}`).toMatch(
        /authz\.person_id\(\)|authz\.has\(/,
      );
    }
  });

  it('grants app_user no write privilege on any of them', async () => {
    const { rows } = await owner.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.table_privileges
       where table_schema='public' and grantee='app_user' and table_name = any($1)
         and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')`,
      [tables],
    );
    expect(rows).toEqual([]);
  });

  it('grants app_user SELECT only, which the policies then govern', async () => {
    const { rows } = await owner.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.table_privileges
       where table_schema='public' and grantee='app_user' and table_name = any($1)
       order by table_name`,
      [tables],
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(['SELECT', 'SELECT', 'SELECT', 'SELECT']);
  });

  it('leaves app_user owning nothing and holding no escalation attribute', async () => {
    const attrs = await owner.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      `select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole from pg_roles where rolname='app_user'`,
    );
    expect(attrs.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    const owned = await owner.query<{ count: string }>(
      `select count(*) count from pg_class c
       join pg_namespace n on n.oid=c.relnamespace
       join pg_roles r on r.oid=c.relowner
       where n.nspname='public' and r.rolname='app_user'`,
    );
    expect(Number(owned.rows[0]!.count)).toBe(0);
  });

  it('keeps every new SECURITY DEFINER function schema-pinned and off PUBLIC', async () => {
    const fns = [
      'role_is_protected',
      'may_manage_protected_roles',
      'seed_system_roles',
      'enforce_protected_role_assignment',
      'enforce_protected_role_mutation',
      'enforce_protected_role_permission',
      'organizations_seed_system_roles',
    ];
    const { rows } = await owner.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      grantees: string[];
    }>(
      `select p.proname, p.prosecdef, p.proconfig,
              coalesce(array_agg(coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC'))
                       filter (where ac.privilege_type='EXECUTE'), '{}') grantees
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       left join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ac on true
       where n.nspname='public' and p.proname = any($1)
       group by p.proname, p.prosecdef, p.proconfig order by p.proname`,
      [fns],
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([...fns].sort());
    for (const r of rows) {
      expect(r.prosecdef, `${r.proname} SECURITY DEFINER`).toBe(true);
      expect(r.proconfig ?? [], `${r.proname} search_path`).toContain('search_path=""');
      expect(r.grantees, `${r.proname} must not grant PUBLIC`).not.toContain('PUBLIC');
      expect(r.grantees, `${r.proname} must not be an app API`).not.toContain('app_user');
    }
  });

  it('exposes no definer-rights function that performs a grant', async () => {
    // seed_system_roles writes, so it must be callable by nobody but its owner. Everything
    // else in the set only answers a question or raises.
    const { rows } = await owner.query<{ grantee: string }>(
      `select coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC') grantee
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ac
       where n.nspname='public' and p.proname='seed_system_roles'
         and ac.privilege_type='EXECUTE'`,
    );
    expect(rows.map((r) => r.grantee)).toEqual(['app_owner']);
  });
});

// ── pooled connections ───────────────────────────────────────────────────────────

describe('pooled connection isolation', () => {
  it('never lets alternating identities inherit each other roles', async () => {
    for (let i = 0; i < 6; i++) {
      const mine = await inContext<{ key: string }>(
        { personId: emp, orgId: orgA },
        `select key from public.roles order by key`,
      );
      expect(mine.map((r) => r.key)).toEqual(['EMPLOYEE']);

      const theirs = await inContext<{ key: string }>(
        { personId: hr, orgId: orgA },
        `select key from public.roles order by key`,
      );
      expect(theirs.map((r) => r.key)).toEqual(['HR_ADMIN']);
    }
  });

  it('leaves nothing behind on a reused connection', async () => {
    const c = await asUser.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
        [sa, orgA],
      );
      const inside = await c.query<{ h: boolean }>(`select authz.has('roles.manage') h`);
      expect(inside.rows[0]!.h).toBe(true);
      await c.query('commit');

      const after = await c.query<{ h: boolean }>(`select authz.has('roles.manage') h`);
      expect(after.rows[0]!.h).toBe(false);
      const rows = await c.query(`select * from public.person_roles`);
      expect(rows.rows).toEqual([]);
    } catch (e) {
      // A connection released mid-transaction poisons whoever gets it next, so an assertion
      // failure here must not become a cascade of unrelated failures in later tests.
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  });

  it('keeps twelve interleaved authorization contexts isolated', async () => {
    const people: [string, boolean][] = [
      [sa, true],
      [hr, false],
      [emp, false],
      [fin, false],
      [adm, false],
      [plain, false],
    ];
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const [person] = people[i % people.length]!;
        return inContext<{ h: boolean; pid: string }>(
          { personId: person, orgId: orgA },
          `select authz.has('roles.manage') h, authz.person_id() pid`,
        );
      }),
    );
    results.forEach((r, i) => {
      const [person, expected] = people[i % people.length]!;
      expect(r[0]!.pid, `row ${i}`).toBe(person);
      expect(r[0]!.h, `row ${i}`).toBe(expected);
    });
  });
});
