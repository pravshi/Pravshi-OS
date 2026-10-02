import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';

/**
 * Phase 2 — CRM Core: companies, contacts, deals.
 *
 * Everything runs as a REAL database role over a REAL connection, the same way the
 * Phase 1 RLS suites do: owner (DATABASE_URL_MIGRATE, app_owner) seeds fixtures and
 * inspects the catalogue; user (DATABASE_URL_TEST, app_user) is where every boundary
 * is probed. A mocked policy proves only that the mock works.
 *
 * Coverage: tenant isolation, the scope matrix (GLOBAL/DEPARTMENT/TEAM/SELF/none +
 * record grants), insert/update rules (owner=self on create, edit scope on write),
 * referential integrity (the deal↔contact↔company consistency FKs, ON DELETE SET
 * NULL), the deal lifecycle (closed_at stamping), uniqueness (live-row only), the
 * no-identity fail-closed default, the permission catalogue, and the audit trail.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

/** Unique per run: these tables are permanent and the suite must be re-runnable. */
const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `C${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

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

/** An owner transaction carrying an identity, for writes app_user may not perform. */
async function asActor(ctx: Ctx, sql: string, params: unknown[] = []): Promise<void> {
  const c = await owner.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`, [
      ctx.personId ?? '',
      ctx.orgId ?? '',
    ]);
    await c.query(sql, params);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

const mkOrg = async (slug: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1,$2) returning id`,
      [`CRM ${slug}`, slug],
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
  // roles_key_format (migration 0008) requires ^[A-Z][A-Z0-9_]{1,39}$; the
  // call-site suffixes are lowercase with hyphens, so normalize here.
  const roleKey = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const role = (
    await owner.query<{ id: string }>(
      `insert into public.roles (org_id, key, name) values ($1,$2,$3) returning id`,
      [org, roleKey, `CRM ${roleKey}`],
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
let dA2 = '';

// scope viewers for companies.view
let vGlobal = '';
let vDept = '';
let vTeam = '';
let vSelf = '';
let vNone = '';
let vSuspended = ''; // GLOBAL view but a suspended engagement
// creators
let c1 = ''; // companies.create/view + contacts.create/view + deals.create/view, SELF
// editors (owner-laundering tests)
let eDept = ''; // companies.edit DEPARTMENT
let eSelf = ''; // s1 with companies.edit SELF, assigned in beforeAll
// row owners
let s1 = ''; // dept 1
let s2 = ''; // dept 2
let sReport = ''; // reports to vTeam
let sForeign = ''; // orgB
// GLOBAL viewers for contacts/deals
let gContacts = '';
let gDeals = '';
let dSelf = ''; // deals.view SELF

// fixture rows (orgA unless noted)
let coS1 = ''; // owned by s1
let coS2 = ''; // owned by s2
let coReport = ''; // owned by sReport
let coForeign = ''; // orgB, owned by sForeign
let ctS1 = ''; // contact owned by s1, on coS1
let dealS1 = ''; // deal owned by s1, company coS1 + contact ctS1

const ctxOf = (person: string) => ({ personId: person, orgId: orgA });

const companiesVisibleTo = async (person: string) =>
  (await inContext<{ id: string }>(ctxOf(person), `select id from public.companies`)).map(
    (r) => r.id,
  );

beforeAll(async () => {
  [orgA, orgB] = await Promise.all([mkOrg(`crm-${RUN}-a`), mkOrg(`crm-${RUN}-b`)]);
  [dA1, dA2] = await Promise.all([mkDept(orgA, `${CODE}_1`), mkDept(orgA, `${CODE}_2`)]);
  const dB = await mkDept(orgB, `${CODE}_B`);

  [
    vGlobal,
    vDept,
    vTeam,
    vSelf,
    vNone,
    vSuspended,
    c1,
    s1,
    s2,
    sReport,
    sForeign,
    gContacts,
    gDeals,
    dSelf,
    eDept,
  ] = await Promise.all([
    mkPerson(orgA, 'V Global'),
    mkPerson(orgA, 'V Dept'),
    mkPerson(orgA, 'V Team'),
    mkPerson(orgA, 'V Self'),
    mkPerson(orgA, 'V None'),
    mkPerson(orgA, 'V Suspended'),
    mkPerson(orgA, 'C One'),
    mkPerson(orgA, 'S One'),
    mkPerson(orgA, 'S Two'),
    mkPerson(orgA, 'S Report'),
    mkPerson(orgB, 'S Foreign'),
    mkPerson(orgA, 'G Contacts'),
    mkPerson(orgA, 'G Deals'),
    mkPerson(orgA, 'D Self'),
    mkPerson(orgA, 'E Dept'),
  ]);
  eSelf = s1; // s1 doubles as the SELF-scope editor below

  await Promise.all([
    mkEngagement(orgA, vGlobal, dA1),
    mkEngagement(orgA, vDept, dA1),
    mkEngagement(orgA, vTeam, dA1),
    mkEngagement(orgA, vSelf, dA1),
    mkEngagement(orgA, vNone, dA1),
    mkEngagement(orgA, vSuspended, dA1, { status: 'SUSPENDED' }),
    mkEngagement(orgA, c1, dA1),
    mkEngagement(orgA, s1, dA1),
    mkEngagement(orgA, s2, dA2),
    mkEngagement(orgA, sReport, dA1, { manager: vTeam }),
    mkEngagement(orgB, sForeign, dB),
    mkEngagement(orgA, gContacts, dA1),
    mkEngagement(orgA, gDeals, dA1),
    mkEngagement(orgA, dSelf, dA1),
    mkEngagement(orgA, eDept, dA1),
  ]);

  // scopes
  await mkRoleFor(orgA, vGlobal, `${CODE}-g`, 'companies.view', 'GLOBAL');
  await mkRoleFor(orgA, vDept, `${CODE}-d`, 'companies.view', 'DEPARTMENT');
  await mkRoleFor(orgA, vTeam, `${CODE}-t`, 'companies.view', 'TEAM');
  await mkRoleFor(orgA, vSelf, `${CODE}-s`, 'companies.view', 'SELF');
  await mkRoleFor(orgA, vSuspended, `${CODE}-susp`, 'companies.view', 'GLOBAL');
  await mkRoleFor(orgA, c1, `${CODE}-cc`, 'companies.create', 'SELF');
  await mkRoleFor(orgA, c1, `${CODE}-ccv`, 'companies.view', 'SELF');
  await mkRoleFor(orgA, c1, `${CODE}-ctc`, 'contacts.create', 'SELF');
  await mkRoleFor(orgA, c1, `${CODE}-ctcv`, 'contacts.view', 'SELF');
  await mkRoleFor(orgA, c1, `${CODE}-dc`, 'deals.create', 'SELF');
  await mkRoleFor(orgA, c1, `${CODE}-dcv`, 'deals.view', 'SELF');
  await mkRoleFor(orgA, gContacts, `${CODE}-gc`, 'contacts.view', 'GLOBAL');
  await mkRoleFor(orgA, gDeals, `${CODE}-gd`, 'deals.view', 'GLOBAL');
  await mkRoleFor(orgA, dSelf, `${CODE}-ds`, 'deals.view', 'SELF');
  await mkRoleFor(orgA, vGlobal, `${CODE}-ge`, 'companies.edit', 'GLOBAL');
  await mkRoleFor(orgA, eDept, `${CODE}-ed`, 'companies.edit', 'DEPARTMENT');
  await mkRoleFor(orgA, eDept, `${CODE}-edv`, 'companies.view', 'DEPARTMENT');
  await mkRoleFor(orgA, eSelf, `${CODE}-es`, 'companies.edit', 'SELF');
  await mkRoleFor(orgB, sForeign, `${CODE}-sf`, 'companies.view', 'GLOBAL');

  // fixture rows, written as the owning actor so the audit trail names a person
  coS1 = (
    await owner.query<{ id: string }>(
      `insert into public.companies (org_id, name, domain, industry, size, owner_person_id)
       values ($1,'Acme One','acmeone.example',$2,'ENTERPRISE',$3) returning id`,
      [orgA, 'SaaS', s1],
    )
  ).rows[0]!.id;
  coS2 = (
    await owner.query<{ id: string }>(
      `insert into public.companies (org_id, name, owner_person_id) values ($1,'Acme Two',$2) returning id`,
      [orgA, s2],
    )
  ).rows[0]!.id;
  coReport = (
    await owner.query<{ id: string }>(
      `insert into public.companies (org_id, name, owner_person_id) values ($1,'Acme Report',$2) returning id`,
      [orgA, sReport],
    )
  ).rows[0]!.id;
  coForeign = (
    await owner.query<{ id: string }>(
      `insert into public.companies (org_id, name, owner_person_id) values ($1,'Foreign Co',$2) returning id`,
      [orgB, sForeign],
    )
  ).rows[0]!.id;

  ctS1 = (
    await owner.query<{ id: string }>(
      `insert into public.contacts (org_id, company_id, first_name, last_name, email, owner_person_id)
       values ($1,$2,'Asha','One','asha.one.${RUN}@example.test',$3) returning id`,
      [orgA, coS1, s1],
    )
  ).rows[0]!.id;

  dealS1 = (
    await owner.query<{ id: string }>(
      `insert into public.deals (org_id, company_id, contact_id, title, value, stage, owner_person_id)
       values ($1,$2,$3,'Big Deal',250000.00,'PROPOSAL',$4) returning id`,
      [orgA, coS1, ctS1, s1],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await owner.end();
  await asUser.end();
});

// ═════════════════════════════════════════════════════════════════════════════════
// tenant isolation
// ═════════════════════════════════════════════════════════════════════════════════

describe('tenant isolation', () => {
  it('a GLOBAL viewer in orgA cannot see orgB companies', async () => {
    const ids = await companiesVisibleTo(vGlobal);
    expect(ids).toContain(coS1);
    expect(ids).not.toContain(coForeign);
  });

  it('a viewer in orgB cannot see orgA rows', async () => {
    const ids = (
      await inContext<{ id: string }>(
        { personId: sForeign, orgId: orgB },
        `select id from public.companies`,
      )
    ).map((r) => r.id);
    expect(ids).toEqual([coForeign]);
  });

  it('a spoofed org claim reaches nothing', async () => {
    const ids = await companiesVisibleTo(vGlobal).then((r) => r);
    expect(ids).toContain(coS1);
    const spoofed = (
      await inContext<{ id: string }>(
        { personId: vGlobal, orgId: orgB },
        `select id from public.companies`,
      )
    ).map((r) => r.id);
    // vGlobal's identity belongs to orgA; the org claim disagrees, so org_id() is NULL
    expect(spoofed).not.toContain(coS1);
  });

  it('cross-tenant owner reference is impossible: owner must be in the same org', async () => {
    await expect(
      owner.query(
        `insert into public.companies (org_id, name, owner_person_id) values ($1,'X',$2)`,
        [orgA, sForeign],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// the scope matrix
// ═════════════════════════════════════════════════════════════════════════════════

describe('companies.view scope matrix', () => {
  it('GLOBAL sees every live company in the org', async () => {
    const ids = await companiesVisibleTo(vGlobal);
    expect(ids).toEqual(expect.arrayContaining([coS1, coS2, coReport]));
  });

  it('DEPARTMENT sees only companies owned in the viewer’s departments', async () => {
    const ids = await companiesVisibleTo(vDept);
    expect(ids).toContain(coS1); // s1 is in dept 1, like vDept
    expect(ids).toContain(coReport);
    expect(ids).not.toContain(coS2); // s2 is in dept 2
  });

  it('TEAM sees own companies and those of direct/indirect reports', async () => {
    const ids = await companiesVisibleTo(vTeam);
    expect(ids).toContain(coReport); // sReport reports to vTeam
    expect(ids).not.toContain(coS1); // peer, not a report
    expect(ids).not.toContain(coS2);
  });

  it('SELF sees only companies they own', async () => {
    // vSelf owns nothing
    expect(await companiesVisibleTo(vSelf)).toEqual([]);
    // s1 with a SELF grant sees only their own
    await mkRoleFor(orgA, s1, `${CODE}-s1v`, 'companies.view', 'SELF');
    const ids = await companiesVisibleTo(s1);
    expect(ids).toContain(coS1);
    expect(ids).not.toContain(coS2);
    expect(ids).not.toContain(coReport);
  });

  it('no permission reaches nothing', async () => {
    expect(await companiesVisibleTo(vNone)).toEqual([]);
  });

  it('a suspended engagement sees nothing even with GLOBAL', async () => {
    expect(await companiesVisibleTo(vSuspended)).toEqual([]);
  });

  it('a record grant reaches exactly its row', async () => {
    await owner.query(
      `insert into public.record_grants
         (org_id, entity_type, entity_id, person_id, permission_id, granted_by, reason)
       select $1,'company',$2,$3,p.id,$3,'test grant'
       from public.permissions p where p.key='companies.view'`,
      [orgA, coS2, vNone],
    );
    const ids = await companiesVisibleTo(vNone);
    expect(ids).toEqual([coS2]);
  });

  it('a grant with a mistyped entity string reaches nothing', async () => {
    // F7: the policy arm names 'company'; a grant filed under 'companies' must not match.
    await owner.query(
      `insert into public.record_grants
         (org_id, entity_type, entity_id, person_id, permission_id, granted_by, reason)
       select $1,'companies',$2,$3,p.id,$3,'typo grant'
       from public.permissions p where p.key='companies.view'`,
      [orgA, coS1, vNone],
    );
    const ids = await companiesVisibleTo(vNone);
    expect(ids).not.toContain(coS1);
  });
});

describe('contacts and deals visibility', () => {
  it('contacts.view GLOBAL reaches contacts, deals.view GLOBAL reaches deals', async () => {
    const cts = (
      await inContext<{ id: string }>(ctxOf(gContacts), `select id from public.contacts`)
    ).map((r) => r.id);
    expect(cts).toContain(ctS1);
    const dls = (await inContext<{ id: string }>(ctxOf(dSelf), `select id from public.deals`)).map(
      (r) => r.id,
    );
    // dSelf holds deals.view at SELF and owns nothing
    expect(dls).toEqual([]);
    const gds = (await inContext<{ id: string }>(ctxOf(gDeals), `select id from public.deals`)).map(
      (r) => r.id,
    );
    expect(gds).toContain(dealS1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// insert and update rules
// ═════════════════════════════════════════════════════════════════════════════════

describe('insert rules', () => {
  it('a holder of companies.create inserts a company they own, and forged stamps are overwritten', async () => {
    // NB: no RETURNING — c1 holds companies.create but not companies.view, and
    // Postgres requires a SELECT policy for INSERT...RETURNING. The id is
    // generated up front so the test verifies the insert itself, not the read-back.
    const id = randomUUID();
    await inContext(
      ctxOf(c1),
      `insert into public.companies (id, org_id, name, owner_person_id, created_by, updated_by)
       values ($1,$2,'C1 Co',$3,$4,$4)`,
      [id, orgA, c1, s1], // the caller tries to forge s1's attribution
    );
    // the stamp trigger overwrites whatever the caller supplied
    const stamped = await owner.query<{ created_by: string; updated_by: string }>(
      `select created_by, updated_by from public.companies where id=$1`,
      [id],
    );
    expect(stamped.rows).toHaveLength(1);
    expect(stamped.rows[0]!.created_by).toBe(c1);
    expect(stamped.rows[0]!.updated_by).toBe(c1);
  });

  it('created_by cannot be rewritten on update', async () => {
    expect(
      await sqlstateOf(
        inContext(ctxOf(vGlobal), `update public.companies set created_by=$1 where id=$2`, [
          vDept,
          coS2,
        ]),
      ),
    ).toBe('42501');
    const r = await owner.query<{ created_by: string | null }>(
      `select created_by from public.companies where id=$1`,
      [coS2],
    );
    expect(r.rows[0]!.created_by).not.toBe(vDept);
  });

  it('insert for another owner is denied', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.companies (org_id, name, owner_person_id) values ($1,'X',$2)`,
          [orgA, s1],
        ),
      ),
    ).toBe('42501');
  });

  it('insert into another org is denied', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.companies (org_id, name, owner_person_id) values ($1,'X',$2)`,
          [orgB, c1],
        ),
      ),
    ).toBe('42501');
  });

  it('insert without the create permission is denied', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(vSelf),
          `insert into public.companies (org_id, name, owner_person_id) values ($1,'X',$2)`,
          [orgA, vSelf],
        ),
      ),
    ).toBe('42501');
  });

  it('insert by a suspended person is denied', async () => {
    await mkRoleFor(orgA, vSuspended, `${CODE}-suspc`, 'companies.create', 'SELF');
    expect(
      await sqlstateOf(
        inContext(
          { personId: vSuspended, orgId: orgA },
          `insert into public.companies (org_id, name, owner_person_id) values ($1,'X',$2)`,
          [orgA, vSuspended],
        ),
      ),
    ).toBe('42501');
  });

  it('blank names are rejected', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.companies (org_id, name, owner_person_id) values ($1,'   ',$2)`,
          [orgA, c1],
        ),
      ),
    ).toBe('23514');
  });

  it('an invalid size is rejected', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.companies (org_id, name, size, owner_person_id) values ($1,'X','GARGANTUAN',$2)`,
          [orgA, c1],
        ),
      ),
    ).toBe('23514');
  });
});

describe('update rules', () => {
  it('GLOBAL edit updates any company in the org', async () => {
    const rows = await inContext<{ id: string }>(
      ctxOf(vGlobal),
      `update public.companies set industry='Fintech' where id=$1 returning id`,
      [coS2],
    );
    expect(rows.map((r) => r.id)).toEqual([coS2]);
  });

  it('a viewer without edit reaches zero rows on update', async () => {
    const rows = await inContext<{ id: string }>(
      ctxOf(vDept),
      `update public.companies set industry='X' where id=$1 returning id`,
      [coS2],
    );
    expect(rows).toHaveLength(0);
  });

  it('moving a row to another org is denied by the WITH CHECK', async () => {
    expect(
      await sqlstateOf(
        inContext(ctxOf(vGlobal), `update public.companies set org_id=$1 where id=$2`, [
          orgB,
          coS1,
        ]),
      ),
    ).toBe('42501');
  });

  describe('owner reassignment (F1)', () => {
    let coLaunder = '';

    beforeAll(async () => {
      coLaunder = (
        await owner.query<{ id: string }>(
          `insert into public.companies (org_id, name, owner_person_id) values ($1,'Launder Co',$2) returning id`,
          [orgA, s1], // s1 is in dept 1, same as eDept
        )
      ).rows[0]!.id;
    });

    it('a DEPARTMENT editor can reassign within their department', async () => {
      // vDept holds no edit; eDept holds companies.edit DEPARTMENT and sits in dept 1.
      const rows = await inContext<{ id: string }>(
        ctxOf(eDept),
        `update public.companies set owner_person_id=$1 where id=$2 returning id`,
        [vDept, coLaunder], // vDept is in dept 1 — inside eDept's reach
      );
      expect(rows.map((r) => r.id)).toEqual([coLaunder]);
    });

    it('a DEPARTMENT editor cannot launder a row to another department', async () => {
      expect(
        await sqlstateOf(
          inContext(ctxOf(eDept), `update public.companies set owner_person_id=$1 where id=$2`, [
            s2, // s2 is in dept 2 — outside eDept's reach
            coLaunder,
          ]),
        ),
      ).toBe('42501');
      // the failed laundering left the owner untouched
      const r = await owner.query<{ owner_person_id: string }>(
        `select owner_person_id from public.companies where id=$1`,
        [coLaunder],
      );
      expect(r.rows[0]!.owner_person_id).toBe(vDept);
    });

    it('a SELF editor can only self-assign', async () => {
      // eSelf (= s1) holds companies.edit SELF. Reassigning their own row to
      // themselves is the blessed case; handing it to anyone else is denied.
      const selfRow = (
        await owner.query<{ id: string }>(
          `insert into public.companies (org_id, name, owner_person_id) values ($1,'Self Co',$2) returning id`,
          [orgA, eSelf],
        )
      ).rows[0]!.id;
      const ok = await inContext<{ id: string }>(
        ctxOf(eSelf),
        `update public.companies set owner_person_id=$1 where id=$2 returning id`,
        [eSelf, selfRow],
      );
      expect(ok.map((r) => r.id)).toEqual([selfRow]);
      expect(
        await sqlstateOf(
          inContext(ctxOf(eSelf), `update public.companies set owner_person_id=$1 where id=$2`, [
            vDept,
            selfRow,
          ]),
        ),
      ).toBe('42501');
    });

    it('a GLOBAL editor is unconstrained', async () => {
      const rows = await inContext<{ id: string }>(
        ctxOf(vGlobal),
        `update public.companies set owner_person_id=$1 where id=$2 returning id`,
        [s2, coLaunder],
      );
      expect(rows.map((r) => r.id)).toEqual([coLaunder]);
    });
  });

  it('a soft-deleted row cannot be undeleted through UPDATE', async () => {
    const coDel = (
      await owner.query<{ id: string }>(
        `insert into public.companies (org_id, name, owner_person_id) values ($1,'Gone Co',$2) returning id`,
        [orgA, s1],
      )
    ).rows[0]!.id;
    await owner.query(`update public.companies set deleted_at=now() where id=$1`, [coDel]);
    // the row is invisible…
    expect(await companiesVisibleTo(vGlobal)).not.toContain(coDel);
    // …and the UPDATE USING (deleted_at IS NULL) reaches zero rows, so no undelete
    const rows = await inContext<{ id: string }>(
      ctxOf(vGlobal),
      `update public.companies set deleted_at=null where id=$1 returning id`,
      [coDel],
    );
    expect(rows).toHaveLength(0);
    const still = await owner.query<{ deleted_at: string | null }>(
      `select deleted_at from public.companies where id=$1`,
      [coDel],
    );
    expect(still.rows[0]!.deleted_at).not.toBeNull();
  });

  it('updated_by is restamped on update', async () => {
    await inContext(ctxOf(vGlobal), `update public.companies set industry='Y' where id=$1`, [coS1]);
    const r = await owner.query<{ updated_by: string }>(
      `select updated_by from public.companies where id=$1`,
      [coS1],
    );
    expect(r.rows[0]!.updated_by).toBe(vGlobal);
  });
});

describe('no DELETE for the runtime roles', () => {
  it('app_user cannot delete a company', async () => {
    expect(
      await sqlstateOf(
        inContext(ctxOf(vGlobal), `delete from public.companies where id=$1`, [coS2]),
      ),
    ).toBe('42501');
  });
});

it('pg_class.relforcerowsecurity is true for companies, contacts and deals', async () => {
  // FORCE ROW LEVEL SECURITY subjects even the table owner to the policies, so a
  // privileged session cannot sidestep tenant isolation. The catalogue flag is
  // the durable assertion; the behavioral suites above prove the policies bite.
  const rows = await owner.query<{ tablename: string; rls: boolean; force: boolean }>(
    `select c.relname as tablename, c.relrowsecurity as rls, c.relforcerowsecurity as force
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('companies', 'contacts', 'deals')`,
  );
  expect(rows.rows.map((r) => r.tablename).sort()).toEqual(['companies', 'contacts', 'deals']);
  for (const r of rows.rows) {
    expect(r.rls).toBe(true);
    expect(r.force).toBe(true);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════
// no-identity fail-closed
// ═════════════════════════════════════════════════════════════════════════════════

describe('no identity', () => {
  it('an unauthenticated session sees nothing and writes nothing', async () => {
    const ids = (
      await inContext<{ id: string }>(
        { personId: null, orgId: null },
        `select id from public.companies`,
      )
    ).map((r) => r.id);
    expect(ids).toEqual([]);
    expect(
      await sqlstateOf(
        inContext(
          { personId: null, orgId: null },
          `insert into public.companies (org_id, name, owner_person_id) values ($1,'X',$2)`,
          [orgA, c1],
        ),
      ),
    ).toBe('42501');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// referential integrity
// ═════════════════════════════════════════════════════════════════════════════════

describe('referential integrity', () => {
  it('a contact on another company cannot back a deal for this company', async () => {
    const other = (
      await owner.query<{ id: string }>(
        `insert into public.contacts (org_id, company_id, first_name, owner_person_id)
         values ($1,$2,'Zed',$3) returning id`,
        [orgA, coS2, s2],
      )
    ).rows[0]!.id;
    await expect(
      inContext(
        ctxOf(c1),
        `insert into public.deals (org_id, company_id, contact_id, title, owner_person_id)
         values ($1,$2,$3,'Bad Deal',$4)`,
        [orgA, coS1, other, c1],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('a deal naming a contact from another org is rejected (the MATCH SIMPLE hole)', async () => {
    // The triple FK alone would skip the check entirely when company_id is NULL.
    // The pairwise (contact_id, org_id) FK closes it.
    const ctForeign = (
      await owner.query<{ id: string }>(
        `insert into public.contacts (org_id, first_name, owner_person_id)
         values ($1,'Xeno',$2) returning id`,
        [orgB, sForeign],
      )
    ).rows[0]!.id;
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.deals (org_id, contact_id, title, owner_person_id)
           values ($1,$2,'Xeno Deal',$3)`,
          [orgA, ctForeign, c1],
        ),
      ),
    ).toBe('23503');
  });

  it('a deal naming a nonexistent company is rejected', async () => {
    // The contract defined no FK from deals.company_id at all; the pairwise
    // (company_id, org_id) FK closes it.
    const ghost = '00000000-0000-0000-0000-000000000000';
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.deals (org_id, company_id, title, owner_person_id)
           values ($1,$2,'Ghost Deal',$3)`,
          [orgA, ghost, c1],
        ),
      ),
    ).toBe('23503');
  });

  it('a deal may name a company and a contact together, or neither', async () => {
    const rows = await inContext<{ id: string }>(
      ctxOf(c1),
      `insert into public.deals (org_id, title, owner_person_id) values ($1,'Solo Deal',$2) returning id`,
      [orgA, c1],
    );
    expect(rows).toHaveLength(1);
  });

  it('a deal value below zero and a probability above 100 are rejected', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.deals (org_id, title, value, owner_person_id) values ($1,'X',-1,$2)`,
          [orgA, c1],
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.deals (org_id, title, probability, owner_person_id) values ($1,'X',101,$2)`,
          [orgA, c1],
        ),
      ),
    ).toBe('23514');
  });

  it('an unknown stage is rejected', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.deals (org_id, title, stage, owner_person_id) values ($1,'X','MAYBE',$2)`,
          [orgA, c1],
        ),
      ),
    ).toBe('23514');
  });

  it('hard-deleting a company with live contacts fails closed', async () => {
    const co = (
      await owner.query<{ id: string }>(
        `insert into public.companies (org_id, name, owner_person_id) values ($1,'Anchored',$2) returning id`,
        [orgA, s1],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into public.contacts (org_id, company_id, first_name, owner_person_id)
       values ($1,$2,'Live',$3)`,
      [orgA, co, s1],
    );
    // contacts.company_id is (company_id, org_id) → companies(id, org_id)
    // ON DELETE SET NULL. Postgres nulls EVERY column of a composite FK on the
    // referenced delete, so this would null the contact's org_id — which is
    // NOT NULL. The delete must error and the company must survive: fail closed.
    const st = await sqlstateOf(owner.query(`delete from public.companies where id=$1`, [co]));
    expect(st).not.toBe('NO ERROR');
    const still = await owner.query(`select id from public.companies where id=$1`, [co]);
    expect(still.rows).toHaveLength(1);
  });

  it('ON DELETE SET NULL: with contacts detached first, the company delete goes through', async () => {
    const co = (
      await owner.query<{ id: string }>(
        `insert into public.companies (org_id, name, owner_person_id) values ($1,'Doomed',$2) returning id`,
        [orgA, s1],
      )
    ).rows[0]!.id;
    const ct = (
      await owner.query<{ id: string }>(
        `insert into public.contacts (org_id, company_id, first_name, owner_person_id)
         values ($1,$2,'Temp',$3) returning id`,
        [orgA, co, s1],
      )
    ).rows[0]!.id;
    // Detach first: with nothing referencing the company, SET NULL has nothing
    // to null and the delete succeeds. app_owner bypasses the runtime DELETE
    // ban (app_user has no DELETE policy at all — see 'no DELETE' above).
    await owner.query(`update public.contacts set company_id=null where id=$1`, [ct]);
    await owner.query(`delete from public.companies where id=$1`, [co]);
    const gone = await owner.query(`select id from public.companies where id=$1`, [co]);
    expect(gone.rows).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// deal lifecycle
// ═════════════════════════════════════════════════════════════════════════════════

describe('deal lifecycle', () => {
  it('closing a deal stamps closed_at; reopening clears it', async () => {
    const id = (
      await owner.query<{ id: string }>(
        `insert into public.deals (org_id, title, owner_person_id) values ($1,'Cycle',$2) returning id`,
        [orgA, s1],
      )
    ).rows[0]!.id;

    const before = await owner.query<{ closed_at: string | null }>(
      `select closed_at from public.deals where id=$1`,
      [id],
    );
    expect(before.rows[0]!.closed_at).toBeNull();

    await asActor(ctxOf(vGlobal), `update public.deals set stage='WON' where id=$1`, [id]);
    const won = await owner.query<{ closed_at: string | null }>(
      `select closed_at from public.deals where id=$1`,
      [id],
    );
    expect(won.rows[0]!.closed_at).not.toBeNull();

    await asActor(ctxOf(vGlobal), `update public.deals set stage='NEGOTIATION' where id=$1`, [id]);
    const reopened = await owner.query<{ closed_at: string | null }>(
      `select closed_at from public.deals where id=$1`,
      [id],
    );
    expect(reopened.rows[0]!.closed_at).toBeNull();
  });

  it('an explicit closed_at is respected, not overwritten', async () => {
    const stamp = '2026-01-15T10:00:00Z';
    const id = (
      await owner.query<{ id: string }>(
        `insert into public.deals (org_id, title, stage, closed_at, owner_person_id)
         values ($1,'Dated','WON',$2::timestamptz,$3) returning id`,
        [orgA, stamp, s1],
      )
    ).rows[0]!.id;
    const r = await owner.query<{ closed_at: string }>(
      `select closed_at from public.deals where id=$1`,
      [id],
    );
    expect(new Date(r.rows[0]!.closed_at).toISOString()).toBe(stamp.replace('Z', '.000Z'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// uniqueness
// ═════════════════════════════════════════════════════════════════════════════════

describe('uniqueness', () => {
  it('a live domain cannot repeat within an org', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.companies (org_id, name, domain, owner_person_id)
           values ($1,'Clone','acmeone.example',$2)`,
          [orgA, c1],
        ),
      ),
    ).toBe('23505');
  });

  it('the same domain is fine in another org, and after a soft delete', async () => {
    const rows = await inContext<{ id: string }>(
      ctxOf(c1),
      `insert into public.companies (org_id, name, domain, owner_person_id)
       values ($2,'Other Org','other.example',$1) returning id`,
      [c1, orgA],
    );
    expect(rows).toHaveLength(1);
    // soft-delete the acmeone row, then reuse its domain
    await owner.query(`update public.companies set deleted_at=now() where id=$1`, [coS1]);
    const reused = await inContext<{ id: string }>(
      ctxOf(c1),
      `insert into public.companies (org_id, name, domain, owner_person_id)
       values ($1,'Acme Reborn','acmeone.example',$2) returning id`,
      [orgA, c1],
    );
    expect(reused).toHaveLength(1);
    // and the soft-deleted row is invisible to GLOBAL
    const ids = await companiesVisibleTo(vGlobal);
    expect(ids).not.toContain(coS1);
    expect(ids).toContain(reused[0]!.id);
  });

  it('a live email cannot repeat within an org for contacts', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(c1),
          `insert into public.contacts (org_id, first_name, email, owner_person_id)
           values ($1,'Dupe','asha.one.${RUN}@example.test',$2)`,
          [orgA, c1],
        ),
      ),
    ).toBe('23505');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// permission catalogue
// ═════════════════════════════════════════════════════════════════════════════════

describe('permission catalogue', () => {
  const EXPECTED = [
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
    // Phase 2 Track B (migration 0034): both Track B migrations seed all eight
    // keys so the matrix stays complete regardless of apply order.
    'activities.view',
    'activities.create',
    'activities.edit',
    'activities.delete',
    'relationships.view',
    'relationships.create',
    'relationships.edit',
    'relationships.delete',
    // Phase 3 (migration 0037): the sales-pipeline keys.
    'pipelines.view',
    'pipelines.create',
    'pipelines.edit',
    'pipelines.delete',
    'pipeline_stages.manage',
  ];

  it('seeds exactly the 27 crm keys with the right sensitivity flags', async () => {
    const rows = await owner.query<{ key: string; module: string; is_sensitive: boolean }>(
      `select key, module, is_sensitive from public.permissions where module='crm' order by key`,
    );
    expect(rows.rows.map((r) => r.key).sort()).toEqual([...EXPECTED].sort());
    const sensitive = new Map(rows.rows.map((r) => [r.key, r.is_sensitive]));
    expect(sensitive.get('contacts.export')).toBe(true);
    expect(sensitive.get('deals.export')).toBe(true);
    for (const k of EXPECTED) {
      if (k === 'contacts.export' || k === 'deals.export') continue;
      expect(sensitive.get(k)).toBe(false);
    }
  });

  it('SUPER_ADMIN holds GLOBAL on all 27 keys in an existing org', async () => {
    const rows = await owner.query<{ n: string }>(
      `select count(*) n
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where r.org_id = $1 and r.key = 'SUPER_ADMIN' and p.module = 'crm'
         and rp.scope = 'GLOBAL'::public.access_scope`,
      [orgA],
    );
    expect(Number(rows.rows[0]!.n)).toBe(27);
  });

  it('standard roles hold the crm grants from the seed matrix', async () => {
    // orgA was created after migration 0033, so this exercises the replaced
    // seed_system_roles(); the backfill in the same migration covers older orgs.
    const rows = await owner.query<{ role: string; key: string; scope: string }>(
      `select r.key as role, p.key as key, rp.scope::text as scope
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where r.org_id = $1
         and r.key in ('ADMIN', 'SALES_MANAGER', 'SALES')
         and p.module = 'crm'`,
      [orgA],
    );
    const have = new Set(rows.rows.map((r) => `${r.role}|${r.key}|${r.scope}`));
    for (const k of EXPECTED) {
      expect(have.has(`ADMIN|${k}|GLOBAL`)).toBe(true);
      expect(have.has(`SALES_MANAGER|${k}|DEPARTMENT`)).toBe(true);
    }
    const SALES_KEYS = [
      'companies.view',
      'companies.create',
      'companies.edit',
      'contacts.view',
      'contacts.create',
      'contacts.edit',
      'deals.view',
      'deals.create',
      'deals.edit',
      // Track B: SELF on view/create/edit only, mirroring the leads.* SELF column
      'activities.view',
      'activities.create',
      'activities.edit',
      'relationships.view',
      'relationships.create',
      'relationships.edit',
    ];
    for (const k of SALES_KEYS) expect(have.has(`SALES|${k}|SELF`)).toBe(true);
    // SALES mirrors the leads.* SELF column: no delete, no export.
    for (const k of [
      'companies.delete',
      'contacts.delete',
      'contacts.export',
      'deals.delete',
      'deals.export',
      'activities.delete',
      'relationships.delete',
    ]) {
      expect(have.has(`SALES|${k}|SELF`)).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// audit
// ═════════════════════════════════════════════════════════════════════════════════

describe('audit trail', () => {
  it('attaches exactly one enabled audit trigger to each CRM table', async () => {
    const { rows } = await owner.query<{ relname: string; tgname: string; tgenabled: string }>(
      `select c.relname, t.tgname, t.tgenabled
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_proc p on p.oid = t.tgfoid
       where n.nspname='public' and p.proname='audit_row_change'
         and c.relname in ('companies','contacts','deals')`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual(['companies', 'contacts', 'deals']);
    for (const r of rows) {
      expect(r.tgname, r.relname).toBe(`${r.relname}_audit`);
      expect(r.tgenabled, r.relname).toBe('O');
    }
  });

  it('company writes land in audit_logs at HIGH, whole-row', async () => {
    const id = (
      await inContext<{ id: string }>(
        ctxOf(c1),
        `insert into public.companies
           (org_id, name, domain, phone, owner_person_id)
         values ($1,'Audit Co','auditco.example','+91-99999-99999',$2) returning id`,
        [orgA, c1],
      )
    )[0]!.id;

    const entry = await owner.query<{ severity: string; after: Record<string, unknown> }>(
      `select severity, after from public.audit_logs
       where entity_type='company' and entity_id=$1 order by occurred_at desc limit 1`,
      [id],
    );
    expect(entry.rows).toHaveLength(1);
    // HIGH: owner reassignment changes who can see a record — access-affecting.
    expect(entry.rows[0]!.severity).toBe('HIGH');
    // whole-row capture per the security review: the full row image is the forensic record
    expect(entry.rows[0]!.after).toMatchObject({
      name: 'Audit Co',
      domain: 'auditco.example',
      phone: '+91-99999-99999',
      owner_person_id: c1,
    });
  });

  it('contact and deal writes are audited at HIGH too', async () => {
    const ct = (
      await inContext<{ id: string }>(
        ctxOf(c1),
        `insert into public.contacts (org_id, first_name, email, owner_person_id)
         values ($1,'Audited','audited.${RUN}@example.test',$2) returning id`,
        [orgA, c1],
      )
    )[0]!.id;
    const dl = (
      await inContext<{ id: string }>(
        ctxOf(c1),
        `insert into public.deals (org_id, title, owner_person_id) values ($1,'Audited Deal',$2) returning id`,
        [orgA, c1],
      )
    )[0]!.id;
    const rows = await owner.query<{ entity_type: string; severity: string }>(
      `select entity_type, severity from public.audit_logs
       where entity_id = any($1) and entity_type in ('contact','deal')`,
      [[ct, dl]],
    );
    expect(rows.rows.map((r) => r.entity_type).sort()).toEqual(['contact', 'deal']);
    for (const r of rows.rows) expect(r.severity).toBe('HIGH');
  });
});
