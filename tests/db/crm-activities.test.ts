import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';

/**
 * Phase 2 Track B — activities: the interaction log.
 *
 * Same harness as the CRM Core suite: owner (DATABASE_URL_MIGRATE, app_owner)
 * seeds fixtures and inspects the catalogue; user (DATABASE_URL_TEST,
 * app_user) is where every boundary is probed. A mocked policy proves only
 * that the mock works.
 *
 * Coverage: tenant isolation, the activities.view scope matrix (SELF
 * spot-check), insert/update rules (owner=self on create), the polymorphic
 * link's missing FK (a random UUID entity_id succeeds at the database level —
 * the visibility probe is the app layer), CHECK constraints, soft delete,
 * the no-identity fail-closed default, the permission catalogue, and the
 * audit trail.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

/** Unique per run: these tables are permanent and the suite must be re-runnable. */
const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `A${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

type Ctx = { personId?: string | null; orgId?: string | null };

/** One transaction as app_user, carrying exactly the identity given — nothing more. */
async function inContext<T extends Record<string, unknown> = Record<string, unknown>>(
  ctx: Ctx,
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
    const result = await c.query<T>(sql, params);
    await c.query('commit');
    return result.rows;
  } catch (error) {
    await c.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

/** The sqlstate of a rejected statement. 42501 is insufficient_privilege (RLS deny). */
async function sqlstateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'NO ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

const mkOrg = async (slug: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1,$2) returning id`,
      [`ACT ${slug}`, slug],
    )
  ).rows[0]!.id;

const mkDept = async (org: string, code: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1,$2,$3) returning id`,
      [org, code, `Dept ${code}`],
    )
  ).rows[0]!.id;

const mkPerson = async (org: string, name: string, status = 'ACTIVE') => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people
         (org_id, code, full_legal_name, person_status, date_of_birth, personal_email, phone)
       values ($1,$2,$3,$4::public.person_status,'1990-01-01',$5,'+91-00000-00000')
       returning id`,
      [org, code, name, status, `${name.toLowerCase().replace(/[^a-z]/g, '')}.${RUN}@example.test`],
    )
  ).rows[0]!.id;
};

const mkEngagement = async (
  org: string,
  person: string,
  dept: string,
  opts: { status?: string; manager?: string | null } = {},
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.engagements
         (org_id, person_id, department_id, manager_person_id, engagement_type, status, start_date)
       values ($1,$2,$3,$4,'EMPLOYEE',$5::public.engagement_status, current_date)
       returning id`,
      [org, person, dept, opts.manager ?? null, opts.status ?? 'ACTIVE'],
    )
  ).rows[0]!.id;

/** A custom role carrying exactly one permission at one scope, assigned to one person. */
const mkRoleFor = async (
  org: string,
  person: string,
  key: string,
  permission: string,
  scope: string,
) => {
  const roleKey = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const role = (
    await owner.query<{ id: string }>(
      `insert into public.roles (org_id, key, name) values ($1,$2,$3) returning id`,
      [org, roleKey, `ACT ${roleKey}`],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into public.role_permissions (role_id, permission_id, scope)
     select $1, p.id, $2::public.access_scope from public.permissions p where p.key = $3`,
    [role, scope, permission],
  );
  await owner.query(
    `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
    [person, role, org],
  );
};

let orgA = '';
let orgB = '';
let dA1 = '';

// viewers / actors (orgA unless noted)
let vGlobal = ''; // activities.view GLOBAL
let vSelf = ''; // activities.view SELF
let c1 = ''; // activities.create + view + edit + delete, SELF
let s1 = ''; // dept 1, plain row owner
let s2 = ''; // dept 1, plain row owner
let sForeign = ''; // orgB

// referenced records (orgA unless noted)
let coS1 = ''; // company owned by s1
let ctS1 = ''; // contact owned by s1, on coS1
let dealS1 = ''; // deal owned by s1
let coForeign = ''; // orgB company owned by sForeign

// activity fixtures
let actS1 = ''; // owned by s1, on coS1
let actS2 = ''; // owned by s2, on coS1
let actVSelf = ''; // owned by vSelf, on coS1
let actForeign = ''; // orgB, owned by sForeign, on coForeign
let actC1 = ''; // created by c1 in the insert suite — c1's own activity

const ctxOf = (person: string) => ({ personId: person, orgId: orgA });

const mkActivity = async (
  org: string,
  ownerPerson: string,
  entityType: string,
  entityId: string,
  subject: string,
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.activities
         (org_id, entity_type, entity_id, type, subject, owner_person_id)
       values ($1,$2,$3,'CALL',$4,$5) returning id`,
      [org, entityType, entityId, subject, ownerPerson],
    )
  ).rows[0]!.id;

beforeAll(async () => {
  [orgA, orgB] = await Promise.all([mkOrg(`act-${RUN}-a`), mkOrg(`act-${RUN}-b`)]);
  dA1 = await mkDept(orgA, `${CODE}_1`);
  const dB = await mkDept(orgB, `${CODE}_B`);

  [vGlobal, vSelf, c1, s1, s2, sForeign] = await Promise.all([
    mkPerson(orgA, 'AV Global'),
    mkPerson(orgA, 'AV Self'),
    mkPerson(orgA, 'AC One'),
    mkPerson(orgA, 'AS One'),
    mkPerson(orgA, 'AS Two'),
    mkPerson(orgB, 'AS Foreign'),
  ]);

  await Promise.all([
    mkEngagement(orgA, vGlobal, dA1),
    mkEngagement(orgA, vSelf, dA1),
    mkEngagement(orgA, c1, dA1),
    mkEngagement(orgA, s1, dA1),
    mkEngagement(orgA, s2, dA1),
    mkEngagement(orgB, sForeign, dB),
  ]);

  await mkRoleFor(orgA, vGlobal, `${CODE}-g`, 'activities.view', 'GLOBAL');
  await mkRoleFor(orgA, vSelf, `${CODE}-s`, 'activities.view', 'SELF');
  await mkRoleFor(orgA, c1, `${CODE}-cc`, 'activities.create', 'SELF');
  await mkRoleFor(orgA, c1, `${CODE}-cv`, 'activities.view', 'SELF');
  await mkRoleFor(orgA, c1, `${CODE}-ce`, 'activities.edit', 'SELF');
  await mkRoleFor(orgA, c1, `${CODE}-cd`, 'activities.delete', 'SELF');
  await mkRoleFor(orgB, sForeign, `${CODE}-sf`, 'activities.view', 'GLOBAL');

  coS1 = (
    await owner.query<{ id: string }>(
      `insert into public.companies (org_id, name, owner_person_id) values ($1,'Act Co One',$2) returning id`,
      [orgA, s1],
    )
  ).rows[0]!.id;
  ctS1 = (
    await owner.query<{ id: string }>(
      `insert into public.contacts (org_id, first_name, last_name, owner_person_id)
       values ($1,'Act','One',$2) returning id`,
      [orgA, s1],
    )
  ).rows[0]!.id;
  dealS1 = (
    await owner.query<{ id: string }>(
      `insert into public.deals (org_id, title, owner_person_id) values ($1,'Act Deal',$2) returning id`,
      [orgA, s1],
    )
  ).rows[0]!.id;
  coForeign = (
    await owner.query<{ id: string }>(
      `insert into public.companies (org_id, name, owner_person_id) values ($1,'Act Foreign',$2) returning id`,
      [orgB, sForeign],
    )
  ).rows[0]!.id;

  [actS1, actS2, actVSelf, actForeign] = await Promise.all([
    mkActivity(orgA, s1, 'company', coS1, `S1 call ${RUN}`),
    mkActivity(orgA, s2, 'contact', ctS1, `S2 email ${RUN}`),
    mkActivity(orgA, vSelf, 'deal', dealS1, `VSelf note ${RUN}`),
    mkActivity(orgB, sForeign, 'company', coForeign, `Foreign call ${RUN}`),
  ]);
});

afterAll(async () => {
  await owner.end();
  await asUser.end();
});

// ═════════════════════════════════════════════════════════════════════════════════
// tenant isolation
// ═════════════════════════════════════════════════════════════════════════════════

describe('tenant isolation', () => {
  it('a GLOBAL viewer in orgA cannot see orgB activities', async () => {
    const ids = (
      await inContext<{ id: string }>(ctxOf(vGlobal), `select id from public.activities`)
    ).map((r) => r.id);
    expect(ids).toContain(actS1);
    expect(ids).not.toContain(actForeign);
  });

  it('a viewer in orgB cannot see orgA rows', async () => {
    const ids = (
      await inContext<{ id: string }>(
        { personId: sForeign, orgId: orgB },
        `select id from public.activities`,
      )
    ).map((r) => r.id);
    expect(ids).toEqual([actForeign]);
  });

  it('a spoofed org claim reaches nothing', async () => {
    const spoofed = (
      await inContext<{ id: string }>(
        { personId: vGlobal, orgId: orgB },
        `select id from public.activities`,
      )
    ).map((r) => r.id);
    expect(spoofed).not.toContain(actS1);
  });

  it('cross-tenant insert is rejected: org must match the identity', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(vGlobal),
          `insert into public.activities
             (org_id, entity_type, entity_id, type, subject, owner_person_id)
           values ($1,'company',$2,'CALL','X',$3)`,
          [orgB, coForeign, vGlobal],
        ),
      ),
    ).toBe('42501');
  });

  it('cross-tenant owner reference is impossible: owner must be in the same org', async () => {
    await expect(
      owner.query(
        `insert into public.activities
           (org_id, entity_type, entity_id, type, subject, owner_person_id)
         values ($1,'company',$2,'CALL','X',$3)`,
        [orgA, coS1, sForeign],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('cross-tenant update touches zero rows (fail closed, not an error)', async () => {
    const rows = await inContext(
      ctxOf(vGlobal),
      `update public.activities set subject='Hacked' where id=$1 returning id`,
      [actForeign],
    );
    expect(rows).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// the scope matrix (spot-check)
// ═════════════════════════════════════════════════════════════════════════════════

describe('activities.view scope matrix', () => {
  it('GLOBAL sees every live activity in the org', async () => {
    const ids = (
      await inContext<{ id: string }>(ctxOf(vGlobal), `select id from public.activities`)
    ).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([actS1, actS2, actVSelf]));
  });

  it('SELF sees only their own activities', async () => {
    const ids = (
      await inContext<{ id: string }>(ctxOf(vSelf), `select id from public.activities`)
    ).map((r) => r.id);
    expect(ids).toEqual([actVSelf]);
  });

  it('a person with no activities.view grant sees nothing', async () => {
    const ids = (
      await inContext<{ id: string }>(ctxOf(s1), `select id from public.activities`)
    ).map((r) => r.id);
    expect(ids).toEqual([]);
  });

  it('a suspended engagement sees nothing (is_active gate)', async () => {
    const susp = await mkPerson(orgA, 'AV Susp');
    await mkEngagement(orgA, susp, dA1, { status: 'SUSPENDED' });
    await mkRoleFor(orgA, susp, `${CODE}-susp`, 'activities.view', 'GLOBAL');
    const ids = (
      await inContext<{ id: string }>(ctxOf(susp), `select id from public.activities`)
    ).map((r) => r.id);
    expect(ids).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// insert rules
// ═════════════════════════════════════════════════════════════════════════════════

describe('insert rules', () => {
  it('insert forces owner = actor: naming someone else is rejected', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.activities
             (org_id, entity_type, entity_id, type, subject, owner_person_id)
           values ($1,'company',$2,'CALL','Owned by another',$3) returning id`,
          [orgA, coS1, s1],
        ),
      ),
    ).toBe('42501');
  });

  it('a creator with activities.create can insert their own activity', async () => {
    const rows = await inContext<{ id: string; owner_person_id: string }>(
      ctxOf(c1),
      `insert into public.activities
         (org_id, entity_type, entity_id, type, subject, owner_person_id)
       values ($1,'company',$2,'EMAIL','My email',$3) returning id, owner_person_id`,
      [orgA, coS1, c1],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner_person_id).toBe(c1);
    actC1 = rows[0]!.id;
  });

  it('insert without the create permission is rejected', async () => {
    // s1 holds no activities.* grant at all
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(s1),
          `insert into public.activities
             (org_id, entity_type, entity_id, type, subject, owner_person_id)
           values ($1,'company',$2,'CALL','No grant',$3)`,
          [orgA, coS1, s1],
        ),
      ),
    ).toBe('42501');
  });

  it('the type CHECK rejects unknown types', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.activities
             (org_id, entity_type, entity_id, type, subject, owner_person_id)
           values ($1,'company',$2,'SMS','Bad type',$3)`,
          [orgA, coS1, c1],
        ),
      ),
    ).toBe('23514');
  });

  it('the entity_type CHECK rejects unknown entity types', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.activities
             (org_id, entity_type, entity_id, type, subject, owner_person_id)
           values ($1,'lead',$2,'CALL','Bad entity',$3)`,
          [orgA, coS1, c1],
        ),
      ),
    ).toBe('23514');
  });

  it('a blank subject is rejected', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.activities
             (org_id, entity_type, entity_id, type, subject, owner_person_id)
           values ($1,'company',$2,'CALL','   ',$3)`,
          [orgA, coS1, c1],
        ),
      ),
    ).toBe('23514');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// the polymorphic link has no foreign key — the probe is the app layer
// ═════════════════════════════════════════════════════════════════════════════════

describe('polymorphic link', () => {
  it('an activity may name a random UUID entity_id at the database level', async () => {
    // By design (plan §3): no cross-table FK. The app-layer visibility probe
    // (assertActivityReferences) is the only enforcement point.
    const ghost = randomUUID();
    const rows = await inContext<{ id: string }>(
      ctxOf(c1),
      `insert into public.activities
         (org_id, entity_type, entity_id, type, subject, owner_person_id)
       values ($1,'deal',$2::uuid,'NOTE','Ghost link',$3) returning id`,
      [orgA, ghost, c1],
    );
    expect(rows).toHaveLength(1);
    await owner.query(`delete from public.activities where id = $1`, [rows[0]!.id]);
  });

  it('an activity may link any of the three entity types', async () => {
    const ids = await inContext<{ id: string }>(
      ctxOf(c1),
      `insert into public.activities
         (org_id, entity_type, entity_id, type, subject, owner_person_id)
       values
         ($1,'company',$2,'CALL','C',$3),
         ($1,'contact',$4,'EMAIL','T',$3),
         ($1,'deal',$5,'MEETING','D',$3)
       returning id`,
      [orgA, coS1, c1, ctS1, dealS1],
    );
    expect(ids).toHaveLength(3);
    await owner.query(`delete from public.activities where id = any($1)`, [ids.map((r) => r.id)]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// update rules + soft delete
// ═════════════════════════════════════════════════════════════════════════════════

describe('update rules', () => {
  it('the owner can update their own activity', async () => {
    const rows = await inContext<{ subject: string }>(
      ctxOf(c1),
      `update public.activities set subject='Renamed by owner' where id=$1 returning subject`,
      [actC1],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject).toBe('Renamed by owner');
  });

  it('SELF edit scope cannot touch another person’s activity', async () => {
    const rows = await inContext(
      ctxOf(c1),
      `update public.activities set subject='Hacked' where id=$1 returning id`,
      [actS1],
    );
    expect(rows).toHaveLength(0);
  });

  it('created_by is immutable: changing it raises 42501', async () => {
    expect(
      await sqlstateOf(
        inContext(ctxOf(c1), `update public.activities set created_by=$2 where id=$1`, [actC1, s1]),
      ),
    ).toBe('42501');
  });
});

describe('soft delete', () => {
  it('soft-deleted activities disappear from reads', async () => {
    const target = await mkActivity(orgA, c1, 'company', coS1, `Doomed ${RUN}`);
    // Soft delete goes through public.crm_soft_delete(): a plain
    // UPDATE ... SET deleted_at = now() fails 42501 because PostgreSQL checks
    // the SELECT policy's `deleted_at is null` against the post-update row.
    await inContext(ctxOf(c1), `select public.crm_soft_delete('activity', $1::uuid)`, [target]);
    const ids = (
      await inContext<{ id: string }>(ctxOf(vGlobal), `select id from public.activities`)
    ).map((r) => r.id);
    expect(ids).not.toContain(target);
  });

  it('app_user cannot hard-delete an activity', async () => {
    expect(
      await sqlstateOf(
        inContext(ctxOf(vGlobal), `delete from public.activities where id=$1`, [actS2]),
      ),
    ).toBe('42501');
  });
});

describe('no identity', () => {
  it('an unauthenticated session sees nothing and writes nothing', async () => {
    const ids = (
      await inContext<{ id: string }>(
        { personId: null, orgId: null },
        `select id from public.activities`,
      )
    ).map((r) => r.id);
    expect(ids).toEqual([]);
    expect(
      await sqlstateOf(
        inContext(
          { personId: null, orgId: null },
          `insert into public.activities
             (org_id, entity_type, entity_id, type, subject, owner_person_id)
           values ($1,'company',$2,'CALL','X',$3)`,
          [orgA, coS1, c1],
        ),
      ),
    ).toBe('42501');
  });
});

it('pg_class.relforcerowsecurity is true for activities', async () => {
  // FORCE ROW LEVEL SECURITY subjects even the table owner to the policies, so a
  // privileged session cannot sidestep tenant isolation. The catalogue flag is
  // the durable assertion; the behavioral suites above prove the policies bite.
  const rows = await owner.query<{ tablename: string; rls: boolean; force: boolean }>(
    `select c.relname as tablename, c.relrowsecurity as rls, c.relforcerowsecurity as force
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'activities'`,
  );
  expect(rows.rows.map((r) => r.tablename)).toEqual(['activities']);
  for (const r of rows.rows) {
    expect(r.rls).toBe(true);
    expect(r.force).toBe(true);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════
// permission catalogue
// ═════════════════════════════════════════════════════════════════════════════════

describe('permission catalogue', () => {
  const EXPECTED = ['activities.view', 'activities.create', 'activities.edit', 'activities.delete'];

  it('seeds the 4 activities keys, not sensitive', async () => {
    const rows = await owner.query<{ key: string; module: string; is_sensitive: boolean }>(
      `select key, module, is_sensitive from public.permissions where key like 'activities.%' order by key`,
    );
    expect(rows.rows.map((r) => r.key).sort()).toEqual([...EXPECTED].sort());
    for (const r of rows.rows) {
      expect(r.module).toBe('crm');
      expect(r.is_sensitive).toBe(false);
    }
  });

  it('ADMIN, SALES_MANAGER and SALES hold the activities grants from the seed matrix', async () => {
    // orgA was created after migration 0034, so this exercises the replaced
    // seed_system_roles(); the backfill in the same migration covers older orgs.
    const rows = await owner.query<{ role: string; key: string; scope: string }>(
      `select r.key as role, p.key as key, rp.scope::text as scope
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where r.org_id = $1
         and r.key in ('ADMIN', 'SALES_MANAGER', 'SALES')
         and p.key like 'activities.%'`,
      [orgA],
    );
    const have = new Set(rows.rows.map((r) => `${r.role}|${r.key}|${r.scope}`));
    for (const k of EXPECTED) {
      expect(have.has(`ADMIN|${k}|GLOBAL`)).toBe(true);
      expect(have.has(`SALES_MANAGER|${k}|DEPARTMENT`)).toBe(true);
    }
    // SALES mirrors the leads.* SELF column: no delete.
    for (const k of ['activities.view', 'activities.create', 'activities.edit']) {
      expect(have.has(`SALES|${k}|SELF`)).toBe(true);
    }
    expect(have.has('SALES|activities.delete|SELF')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// audit
// ═════════════════════════════════════════════════════════════════════════════════

describe('audit trail', () => {
  it('attaches exactly one enabled audit trigger to activities', async () => {
    const { rows } = await owner.query<{ relname: string; tgname: string; tgenabled: string }>(
      `select c.relname, t.tgname, t.tgenabled
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_proc p on p.oid = t.tgfoid
       where n.nspname='public' and p.proname='audit_row_change'
         and c.relname = 'activities'`,
    );
    expect(rows.map((r) => r.relname)).toEqual(['activities']);
    expect(rows[0]!.tgname).toBe('activities_audit');
    expect(rows[0]!.tgenabled).toBe('O');
  });

  it('activity writes land in audit_logs at HIGH, whole-row', async () => {
    const id = (
      await inContext<{ id: string }>(
        ctxOf(c1),
        `insert into public.activities
           (org_id, entity_type, entity_id, type, subject, notes, owner_person_id)
         values ($1,'company',$2,'MEETING','Audit sync','Q3 review',$3) returning id`,
        [orgA, coS1, c1],
      )
    )[0]!.id;

    const entry = await owner.query<{ severity: string; after: Record<string, unknown> }>(
      `select severity, after from public.audit_logs
       where entity_type='activity' and entity_id=$1 order by occurred_at desc limit 1`,
      [id],
    );
    expect(entry.rows).toHaveLength(1);
    expect(entry.rows[0]!.severity).toBe('HIGH');
    expect(entry.rows[0]!.after).toMatchObject({
      type: 'MEETING',
      subject: 'Audit sync',
      notes: 'Q3 review',
      entity_type: 'company',
      owner_person_id: c1,
    });
  });
});
