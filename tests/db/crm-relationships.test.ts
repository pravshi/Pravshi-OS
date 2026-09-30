import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';

/**
 * Phase 2 Track B — relationships: company_contacts, company_links, contact_links.
 *
 * Everything runs as a REAL database role over a REAL connection, the same way the
 * Phase 1 RLS suites and the CRM Core suite do: owner (DATABASE_URL_MIGRATE,
 * app_owner) seeds fixtures and inspects the catalogue; user (DATABASE_URL_TEST,
 * app_user) is where every boundary is probed. A mocked policy proves only that
 * the mock works.
 *
 * Coverage: tenant isolation, the relationships.view scope matrix + record grants,
 * insert/update rules (owner=self on create, edit scope on write), referential
 * integrity (composite org FKs, no-self-link CHECKs), live-pair uniqueness,
 * primary uniqueness + the primary-reassignment write pattern, soft deletes,
 * the no-DELETE rule, pg_class FORCE, the permission catalogue (4 relationships
 * keys + the 8 Track B keys), the ADMIN/SALES_MANAGER/SALES grants, and the
 * audit trail.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

/** Unique per run: these tables are permanent and the suite must be re-runnable. */
const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `R${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

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
      [`REL ${slug}`, slug],
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
      [org, roleKey, `REL ${roleKey}`],
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

// people (orgA unless noted)
let g = ''; // GLOBAL view/create/edit/delete
let s1 = ''; // owns co1, ct1
let s2 = ''; // owns co2, ct2
let pSelf = ''; // SELF view/create/edit — owns nothing yet
let vNone = ''; // no grants
let vSuspended = ''; // GLOBAL view but suspended
let sForeign = ''; // orgB

// fixture rows
let co1 = '';
let co2 = '';
let ct1 = '';
let ct2 = '';
let ct3 = '';
let ct4 = ''; // audit-test contact, never associated elsewhere
let coB = '';
let ctB = '';
let assoc1 = ''; // co1–ct1, primary, owned by s1
let assoc2 = ''; // co2–ct2, owned by s2
let link1 = ''; // co1→co2 PARENT, owned by s1
let clink1 = ''; // ct1→ct2 COLLEAGUE, owned by s1
let assocForeign = ''; // coB–ctB, owned by sForeign

const ctxOf = (person: string) => ({ personId: person, orgId: orgA });

const visibleAssocIds = async (person: string) =>
  (await inContext<{ id: string }>(ctxOf(person), `select id from public.company_contacts`)).map(
    (r) => r.id,
  );

beforeAll(async () => {
  [orgA, orgB] = await Promise.all([mkOrg(`rel-${RUN}-a`), mkOrg(`rel-${RUN}-b`)]);
  dA1 = await mkDept(orgA, `${CODE}_1`);
  const dB = await mkDept(orgB, `${CODE}_B`);

  [g, s1, s2, pSelf, vNone, vSuspended, sForeign] = await Promise.all([
    mkPerson(orgA, 'R Global'),
    mkPerson(orgA, 'R S One'),
    mkPerson(orgA, 'R S Two'),
    mkPerson(orgA, 'R P Self'),
    mkPerson(orgA, 'R None'),
    mkPerson(orgA, 'R Suspended'),
    mkPerson(orgB, 'R Foreign'),
  ]);

  await Promise.all([
    mkEngagement(orgA, g, dA1),
    mkEngagement(orgA, s1, dA1),
    mkEngagement(orgA, s2, dA1),
    mkEngagement(orgA, pSelf, dA1),
    mkEngagement(orgA, vNone, dA1),
    mkEngagement(orgA, vSuspended, dA1, { status: 'SUSPENDED' }),
    mkEngagement(orgB, sForeign, dB),
  ]);

  // scopes for the new relationships keys
  await mkRoleFor(orgA, g, `${CODE}-gv`, 'relationships.view', 'GLOBAL');
  await mkRoleFor(orgA, g, `${CODE}-gc`, 'relationships.create', 'GLOBAL');
  await mkRoleFor(orgA, g, `${CODE}-ge`, 'relationships.edit', 'GLOBAL');
  await mkRoleFor(orgA, g, `${CODE}-gd`, 'relationships.delete', 'GLOBAL');
  await mkRoleFor(orgA, pSelf, `${CODE}-pv`, 'relationships.view', 'SELF');
  await mkRoleFor(orgA, pSelf, `${CODE}-pc`, 'relationships.create', 'SELF');
  await mkRoleFor(orgA, pSelf, `${CODE}-pe`, 'relationships.edit', 'SELF');
  await mkRoleFor(orgA, pSelf, `${CODE}-pd`, 'relationships.delete', 'SELF');
  await mkRoleFor(orgA, vSuspended, `${CODE}-sv`, 'relationships.view', 'GLOBAL');

  // fixture CRM records (owner-written, actor-stamped)
  co1 = (
    await owner.query<{ id: string }>(
      `insert into public.companies (org_id, name, owner_person_id) values ($1,'Rel Co One',$2) returning id`,
      [orgA, s1],
    )
  ).rows[0]!.id;
  co2 = (
    await owner.query<{ id: string }>(
      `insert into public.companies (org_id, name, owner_person_id) values ($1,'Rel Co Two',$2) returning id`,
      [orgA, s2],
    )
  ).rows[0]!.id;
  ct1 = (
    await owner.query<{ id: string }>(
      `insert into public.contacts (org_id, first_name, last_name, owner_person_id)
       values ($1,'Rina','One',$2) returning id`,
      [orgA, s1],
    )
  ).rows[0]!.id;
  ct2 = (
    await owner.query<{ id: string }>(
      `insert into public.contacts (org_id, first_name, last_name, owner_person_id)
       values ($1,'Ravi','Two',$2) returning id`,
      [orgA, s2],
    )
  ).rows[0]!.id;
  ct3 = (
    await owner.query<{ id: string }>(
      `insert into public.contacts (org_id, first_name, last_name, owner_person_id)
       values ($1,'Runa','Three',$2) returning id`,
      [orgA, s1],
    )
  ).rows[0]!.id;
  ct4 = (
    await owner.query<{ id: string }>(
      `insert into public.contacts (org_id, first_name, last_name, owner_person_id)
       values ($1,'Rita','Four',$2) returning id`,
      [orgA, s1],
    )
  ).rows[0]!.id;
  coB = (
    await owner.query<{ id: string }>(
      `insert into public.companies (org_id, name, owner_person_id) values ($1,'Foreign Rel Co',$2) returning id`,
      [orgB, sForeign],
    )
  ).rows[0]!.id;
  ctB = (
    await owner.query<{ id: string }>(
      `insert into public.contacts (org_id, first_name, last_name, owner_person_id)
       values ($1,'Far','Away',$2) returning id`,
      [orgB, sForeign],
    )
  ).rows[0]!.id;

  // relationship fixtures, written as their owning actor
  assoc1 = (
    await owner.query<{ id: string }>(
      `insert into public.company_contacts
         (org_id, company_id, contact_id, role, is_primary, owner_person_id)
       values ($1,$2,$3,'Decision Maker',true,$4) returning id`,
      [orgA, co1, ct1, s1],
    )
  ).rows[0]!.id;
  assoc2 = (
    await owner.query<{ id: string }>(
      `insert into public.company_contacts
         (org_id, company_id, contact_id, owner_person_id)
       values ($1,$2,$3,$4) returning id`,
      [orgA, co2, ct2, s2],
    )
  ).rows[0]!.id;
  link1 = (
    await owner.query<{ id: string }>(
      `insert into public.company_links
         (org_id, from_company_id, to_company_id, link_type, owner_person_id)
       values ($1,$2,$3,'PARENT',$4) returning id`,
      [orgA, co1, co2, s1],
    )
  ).rows[0]!.id;
  clink1 = (
    await owner.query<{ id: string }>(
      `insert into public.contact_links
         (org_id, from_contact_id, to_contact_id, link_type, owner_person_id)
       values ($1,$2,$3,'COLLEAGUE',$4) returning id`,
      [orgA, ct1, ct2, s1],
    )
  ).rows[0]!.id;
  assocForeign = (
    await owner.query<{ id: string }>(
      `insert into public.company_contacts
         (org_id, company_id, contact_id, owner_person_id)
       values ($1,$2,$3,$4) returning id`,
      [orgB, coB, ctB, sForeign],
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
  it('a GLOBAL viewer in orgA sees orgA associations but never orgB rows', async () => {
    const ids = await visibleAssocIds(g);
    expect(ids).toContain(assoc1);
    expect(ids).toContain(assoc2);
    expect(ids).not.toContain(assocForeign);
    const links = (
      await inContext<{ id: string }>(ctxOf(g), `select id from public.company_links`)
    ).map((r) => r.id);
    expect(links).toContain(link1);
    const clinks = (
      await inContext<{ id: string }>(ctxOf(g), `select id from public.contact_links`)
    ).map((r) => r.id);
    expect(clinks).toContain(clink1);
  });

  it('inserting a pair that crosses orgs fails closed on the composite FK', async () => {
    // org claim is orgA, the company is orgA's but the contact is orgB's:
    // the composite (contact_id, org_id) FK cannot resolve — fail closed, not 500-leak.
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(g),
          `insert into public.company_contacts (org_id, company_id, contact_id, owner_person_id)
           values ($1,$2,$3,$4)`,
          [orgA, co1, ctB, g],
        ),
      ),
    ).toBe('23503');
  });

  it('inserting with a foreign org claim is denied by RLS', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(g),
          `insert into public.company_contacts (org_id, company_id, contact_id, owner_person_id)
           values ($1,$2,$3,$4)`,
          [orgB, coB, ctB, g],
        ),
      ),
    ).toBe('42501');
  });

  it('a cross-org company link is rejected by the composite FK', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(g),
          `insert into public.company_links
             (org_id, from_company_id, to_company_id, link_type, owner_person_id)
           values ($1,$2,$3,'PARTNER',$4)`,
          [orgA, co1, coB, g],
        ),
      ),
    ).toBe('23503');
  });

  it('a cross-org contact link is rejected by the composite FK', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(g),
          `insert into public.contact_links
             (org_id, from_contact_id, to_contact_id, link_type, owner_person_id)
           values ($1,$2,$3,'REFERRAL',$4)`,
          [orgA, ct1, ctB, g],
        ),
      ),
    ).toBe('23503');
  });

  it('cross-tenant owner reference is impossible: owner must be in the same org', async () => {
    await expect(
      owner.query(
        `insert into public.company_contacts (org_id, company_id, contact_id, owner_person_id)
         values ($1,$2,$3,$4)`,
        [orgA, co1, ct1, sForeign],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// the relationships.view scope matrix
// ═════════════════════════════════════════════════════════════════════════════════

describe('relationships.view scope matrix', () => {
  it('GLOBAL sees every live association in the org', async () => {
    const ids = await visibleAssocIds(g);
    expect(ids).toEqual(expect.arrayContaining([assoc1, assoc2]));
  });

  it('SELF sees only the associations they own', async () => {
    // pSelf owns nothing yet
    expect(await visibleAssocIds(pSelf)).toEqual([]);
    const mine = (
      await inContext<{ id: string }>(
        ctxOf(pSelf),
        `insert into public.company_contacts (org_id, company_id, contact_id, owner_person_id)
         values ($1,$2,$3,$4) returning id`,
        [orgA, co1, ct2, pSelf],
      )
    )[0]!.id;
    const ids = await visibleAssocIds(pSelf);
    expect(ids).toEqual([mine]);
  });

  it('no permission reaches nothing', async () => {
    expect(await visibleAssocIds(vNone)).toEqual([]);
    expect(
      (await inContext<{ id: string }>(ctxOf(vNone), `select id from public.company_links`)).length,
    ).toBe(0);
    expect(
      (await inContext<{ id: string }>(ctxOf(vNone), `select id from public.contact_links`)).length,
    ).toBe(0);
  });

  it('a suspended engagement sees nothing even with GLOBAL', async () => {
    expect(await visibleAssocIds(vSuspended)).toEqual([]);
  });

  it('a record grant reaches exactly its row', async () => {
    await owner.query(
      `insert into public.record_grants
         (org_id, entity_type, entity_id, person_id, permission_id, granted_by, reason)
       select $1,'company_contact',$2,$3,p.id,$3,'test grant'
       from public.permissions p where p.key='relationships.view'`,
      [orgA, assoc2, vNone],
    );
    expect(await visibleAssocIds(vNone)).toEqual([assoc2]);
  });

  it('a grant with a mistyped entity string reaches nothing', async () => {
    await owner.query(
      `insert into public.record_grants
         (org_id, entity_type, entity_id, person_id, permission_id, granted_by, reason)
       select $1,'company_contacts',$2,$3,p.id,$3,'typo grant'
       from public.permissions p where p.key='relationships.view'`,
      [orgA, assoc1, vNone],
    );
    expect(await visibleAssocIds(vNone)).not.toContain(assoc1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// insert and update rules
// ═════════════════════════════════════════════════════════════════════════════════

describe('insert rules', () => {
  it('a holder of relationships.create inserts an association they own, and forged stamps are overwritten', async () => {
    const id = randomUUID();
    await inContext(
      ctxOf(pSelf),
      `insert into public.company_contacts
         (id, org_id, company_id, contact_id, role, created_by, updated_by, owner_person_id)
       values ($1,$2,$3,$4,'Advisor',$5,$5,$6)`,
      [id, orgA, co2, ct1, s1, pSelf], // the caller tries to forge s1's attribution
    );
    const stamped = await owner.query<{ created_by: string; updated_by: string }>(
      `select created_by, updated_by from public.company_contacts where id=$1`,
      [id],
    );
    expect(stamped.rows).toHaveLength(1);
    expect(stamped.rows[0]!.created_by).toBe(pSelf);
    expect(stamped.rows[0]!.updated_by).toBe(pSelf);
  });

  it('created_by cannot be rewritten on update', async () => {
    expect(
      await sqlstateOf(
        inContext(ctxOf(g), `update public.company_contacts set created_by=$1 where id=$2`, [
          vNone,
          assoc1,
        ]),
      ),
    ).toBe('42501');
  });

  it('insert for another owner is denied', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(pSelf),
          `insert into public.company_contacts (org_id, company_id, contact_id, owner_person_id)
           values ($1,$2,$3,$4)`,
          [orgA, co1, ct1, s1],
        ),
      ),
    ).toBe('42501');
  });

  it('insert without the create permission is denied', async () => {
    await mkRoleFor(orgA, vNone, `${CODE}-nv`, 'relationships.view', 'GLOBAL');
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(vNone),
          `insert into public.company_contacts (org_id, company_id, contact_id, owner_person_id)
           values ($1,$2,$3,$4)`,
          [orgA, co1, ct2, vNone],
        ),
      ),
    ).toBe('42501');
  });

  it('self-links are rejected by CHECK, not the application', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(g),
          `insert into public.company_links
             (org_id, from_company_id, to_company_id, link_type, owner_person_id)
           values ($1,$2,$2,'PARENT',$3)`,
          [orgA, co1, g],
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(g),
          `insert into public.contact_links
             (org_id, from_contact_id, to_contact_id, link_type, owner_person_id)
           values ($1,$2,$2,'COLLEAGUE',$3)`,
          [orgA, ct1, g],
        ),
      ),
    ).toBe('23514');
  });

  it('an unknown link_type is rejected by CHECK', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(g),
          `insert into public.company_links
             (org_id, from_company_id, to_company_id, link_type, owner_person_id)
           values ($1,$2,$3,'CHILD',$4)`,
          [orgA, co1, co2, g],
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(g),
          `insert into public.contact_links
             (org_id, from_contact_id, to_contact_id, link_type, owner_person_id)
           values ($1,$2,$3,'FRIEND',$4)`,
          [orgA, ct1, ct2, g],
        ),
      ),
    ).toBe('23514');
  });
});

describe('uniqueness', () => {
  it('a live (company, contact) pair cannot repeat', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(g),
          `insert into public.company_contacts (org_id, company_id, contact_id, owner_person_id)
           values ($1,$2,$3,$4)`,
          [orgA, co1, ct1, g],
        ),
      ),
    ).toBe('23505');
  });

  it('a soft-deleted pair can be re-linked: live-row uniqueness only', async () => {
    // (co2, ct1) may already be live from the insert-rules test; retire it first.
    // Soft-delete is a privileged write: app_user cannot set deleted_at through
    // RLS (the SELECT policy's deleted_at IS NULL is enforced on the new row),
    // so the retire steps run as app_owner — the same pattern crm-core.test.ts
    // uses. The re-link itself is the app_user behavior under test.
    await owner.query(
      `update public.company_contacts set deleted_at=now()
       where company_id=$1::uuid and contact_id=$2::uuid and deleted_at is null`,
      [co2, ct1],
    );
    const id = (
      await inContext<{ id: string }>(
        ctxOf(g),
        `insert into public.company_contacts (org_id, company_id, contact_id, owner_person_id)
         values ($1,$2,$3,$4) returning id`,
        [orgA, co2, ct1, g],
      )
    )[0]!.id;
    await owner.query(`update public.company_contacts set deleted_at=now() where id=$1`, [id]);
    const relinked = (
      await inContext<{ id: string }>(
        ctxOf(g),
        `insert into public.company_contacts (org_id, company_id, contact_id, owner_person_id)
         values ($1,$2,$3,$4) returning id`,
        [orgA, co2, ct1, g],
      )
    )[0]!.id;
    expect(relinked).not.toBe(id);
    // leave no live (co2, ct1) for later tests
    await owner.query(`update public.company_contacts set deleted_at=now() where id=$1`, [
      relinked,
    ]);
  });

  it('a second primary contact for the same company is rejected', async () => {
    // co1 already has assoc1 (ct1) as its primary; (co1, ct3) is a fresh pair.
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(g),
          `insert into public.company_contacts
             (org_id, company_id, contact_id, is_primary, owner_person_id)
           values ($1,$2,$3,true,$4)`,
          [orgA, co1, ct3, g],
        ),
      ),
    ).toBe('23505');
  });

  it('a second primary company for the same contact is rejected', async () => {
    // give ct3 a primary company first, on a fresh pair
    await inContext(
      ctxOf(g),
      `insert into public.company_contacts
         (org_id, company_id, contact_id, is_primary, owner_person_id)
       values ($1,$2,$3,true,$4)`,
      [orgA, co2, ct3, g],
    );
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(g),
          `insert into public.company_contacts
             (org_id, company_id, contact_id, is_primary, owner_person_id)
           values ($1,$2,$3,true,$4)`,
          [orgA, co1, ct3, g],
        ),
      ),
    ).toBe('23505');
  });

  it('a live (from, to, type) link cannot repeat', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(g),
          `insert into public.company_links
             (org_id, from_company_id, to_company_id, link_type, owner_person_id)
           values ($1,$2,$3,'PARENT',$4)`,
          [orgA, co1, co2, g],
        ),
      ),
    ).toBe('23505');
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(g),
          `insert into public.contact_links
             (org_id, from_contact_id, to_contact_id, link_type, owner_person_id)
           values ($1,$2,$3,'COLLEAGUE',$4)`,
          [orgA, ct1, ct2, g],
        ),
      ),
    ).toBe('23505');
  });
});

describe('update rules', () => {
  it('GLOBAL edit updates any association in the org', async () => {
    const rows = await inContext<{ id: string }>(
      ctxOf(g),
      `update public.company_contacts set role='Champion' where id=$1 returning id`,
      [assoc2],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(assoc2);
  });

  it('a viewer without edit reaches zero rows on update', async () => {
    const rows = await inContext<{ id: string }>(
      ctxOf(vNone),
      `update public.company_contacts set role='X' where id=$1 returning id`,
      [assoc1],
    );
    expect(rows).toHaveLength(0);
  });

  it('primary reassignment clears the old primary in the same write pattern the service uses', async () => {
    // The service's friendly path: clear rival primary flags, then set ours.
    // (co2, ct3) is primary for ct3 from the uniqueness tests; assoc1 is
    // primary for co1 — the clear below retires both.
    const rows = await inContext<{ id: string; is_primary: boolean }>(
      ctxOf(g),
      `update public.company_contacts cc
       set is_primary = false, updated_at = now()
       where cc.org_id=$1::uuid and cc.deleted_at is null
         and (cc.company_id=$2::uuid or cc.contact_id=$3::uuid)
         and cc.is_primary
       returning id, is_primary`,
      [orgA, co1, ct3],
    );
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([assoc1]));
    expect(rows.every((r) => r.is_primary === false)).toBe(true);
    // now the new primary for co1 can be set without tripping the partial index
    const now = (
      await inContext<{ id: string }>(
        ctxOf(g),
        `insert into public.company_contacts
           (org_id, company_id, contact_id, is_primary, owner_person_id)
         values ($1,$2,$3,true,$4) returning id`,
        [orgA, co1, ct3, g],
      )
    )[0]!.id;
    const primaries = await inContext<{ id: string }>(
      ctxOf(g),
      `select id from public.company_contacts
       where org_id=$1::uuid and company_id=$2::uuid and is_primary and deleted_at is null`,
      [orgA, co1],
    );
    expect(primaries.map((r) => r.id)).toEqual([now]);
    // and restore the fixture primary so later tests see the documented state.
    // The retire runs as app_owner: app_user cannot set deleted_at through RLS
    // (SELECT policy's deleted_at IS NULL is enforced on the new row).
    await owner.query(`update public.company_contacts set deleted_at=now() where id=$1`, [now]);
    await inContext(ctxOf(g), `update public.company_contacts set is_primary=true where id=$1`, [
      assoc1,
    ]);
  });

  it('moving a row to another org is denied by the WITH CHECK', async () => {
    expect(
      await sqlstateOf(
        inContext(ctxOf(g), `update public.company_contacts set org_id=$1 where id=$2`, [
          orgB,
          assoc1,
        ]),
      ),
    ).toBe('42501');
  });

  it('owner reassignment to someone outside reach is denied before FK checks', async () => {
    // g holds relationships.edit at GLOBAL, so GLOBAL reach allows the move;
    // a SELF-scope editor moving a row to a stranger must fail 42501.
    // s1 needs relationships.view SELF too: without it the row is invisible to
    // the UPDATE scan (0 rows, no trigger) — the same requirement crm-core's
    // owner-reassignment tests satisfy.
    await mkRoleFor(orgA, s1, `${CODE}-s1e`, 'relationships.edit', 'SELF');
    await mkRoleFor(orgA, s1, `${CODE}-s1v`, 'relationships.view', 'SELF');
    expect(
      await sqlstateOf(
        inContext(ctxOf(s1), `update public.company_contacts set owner_person_id=$1 where id=$2`, [
          vNone,
          assoc1,
        ]),
      ),
    ).toBe('42501');
  });

  it('a soft-deleted row cannot be edited through UPDATE', async () => {
    // retire any live (co2, ct1) left by earlier tests, then work a fresh pair
    await owner.query(
      `update public.company_contacts set deleted_at=now()
       where company_id=$1::uuid and contact_id=$2::uuid and deleted_at is null`,
      [co2, ct1],
    );
    const id = (
      await inContext<{ id: string }>(
        ctxOf(g),
        `insert into public.company_contacts (org_id, company_id, contact_id, owner_person_id)
         values ($1,$2,$3,$4) returning id`,
        [orgA, co2, ct1, g],
      )
    )[0]!.id;
    // the retire itself runs as app_owner (see note in the re-link test)
    await owner.query(`update public.company_contacts set deleted_at=now() where id=$1`, [id]);
    const rows = await inContext<{ id: string }>(
      ctxOf(g),
      `update public.company_contacts set role='X' where id=$1 returning id`,
      [id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('soft delete and no hard delete', () => {
  it('remove sets deleted_at; the row leaves the lists', async () => {
    const id = (
      await inContext<{ id: string }>(
        ctxOf(g),
        `insert into public.company_links
           (org_id, from_company_id, to_company_id, link_type, owner_person_id)
         values ($1,$2,$3,'SUBSIDIARY',$4) returning id`,
        [orgA, co2, co1, g],
      )
    )[0]!.id;
    // retire as app_owner (see note in the re-link test); then verify the row
    // leaves the app_user lists and is stamped
    await owner.query(`update public.company_links set deleted_at=now() where id=$1`, [id]);
    const ids = (
      await inContext<{ id: string }>(ctxOf(g), `select id from public.company_links`)
    ).map((r) => r.id);
    expect(ids).not.toContain(id);
    const stamped = await owner.query<{ deleted_at: string | null }>(
      `select deleted_at from public.company_links where id=$1`,
      [id],
    );
    expect(stamped.rows[0]!.deleted_at).not.toBeNull();
  });

  it('app_user cannot hard-delete a company_contact', async () => {
    expect(await sqlstateOf(inContext(ctxOf(g), `delete from public.company_contacts`))).toBe(
      '42501',
    );
  });

  it('app_user cannot hard-delete a company_link or contact_link', async () => {
    expect(await sqlstateOf(inContext(ctxOf(g), `delete from public.company_links`))).toBe('42501');
    expect(await sqlstateOf(inContext(ctxOf(g), `delete from public.contact_links`))).toBe('42501');
  });
});

describe('no identity', () => {
  it('an unauthenticated session sees nothing and writes nothing', async () => {
    expect(await visibleAssocIds('')).toHaveLength(0);
    expect(
      await sqlstateOf(
        inContext(
          {},
          `insert into public.company_contacts (org_id, company_id, contact_id, owner_person_id)
           values ($1,$2,$3,$4)`,
          [orgA, co1, ct1, s1],
        ),
      ),
    ).toBe('42501');
  });
});

describe('RLS force', () => {
  it('all three tables have RLS enabled AND forced in pg_class', async () => {
    const { rows } = await owner.query<{ relname: string; enabled: boolean; forced: boolean }>(
      `select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname='public'
         and c.relname in ('company_contacts','company_links','contact_links')`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.enabled, r.relname).toBe(true);
      expect(r.forced, r.relname).toBe(true);
    }
  });
});

describe('permission catalogue', () => {
  const TRACK_B = [
    'relationships.view',
    'relationships.create',
    'relationships.edit',
    'relationships.delete',
    'activities.view',
    'activities.create',
    'activities.edit',
    'activities.delete',
  ];

  it('seeds the 4 relationships keys plus the 4 sibling activities keys', async () => {
    const rows = await owner.query<{ key: string; module: string; is_sensitive: boolean }>(
      `select key, module, is_sensitive from public.permissions
       where key like 'relationships.%' or key like 'activities.%'
       order by key`,
    );
    expect(rows.rows.map((r) => r.key).sort()).toEqual([...TRACK_B].sort());
    for (const r of rows.rows) {
      expect(r.module).toBe('crm');
      expect(r.is_sensitive).toBe(false);
    }
  });

  it('SUPER_ADMIN holds GLOBAL on all 8 Track B keys in an existing org', async () => {
    const rows = await owner.query<{ n: string }>(
      `select count(*) n
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where r.org_id = $1 and r.key = 'SUPER_ADMIN'
         and (p.key like 'relationships.%' or p.key like 'activities.%')
         and rp.scope = 'GLOBAL'::public.access_scope`,
      [orgA],
    );
    expect(Number(rows.rows[0]!.n)).toBe(8);
  });

  it('standard roles hold the Track B grants from the seed matrix', async () => {
    // orgA was created after migration 0035, so this exercises the replaced
    // seed_system_roles(); the backfill in the same migration covers older orgs.
    const rows = await owner.query<{ role: string; key: string; scope: string }>(
      `select r.key as role, p.key as key, rp.scope::text as scope
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where r.org_id = $1
         and r.key in ('ADMIN', 'SALES_MANAGER', 'SALES')
         and (p.key like 'relationships.%' or p.key like 'activities.%')`,
      [orgA],
    );
    const have = new Set(rows.rows.map((r) => `${r.role}|${r.key}|${r.scope}`));
    for (const k of TRACK_B) {
      expect(have.has(`ADMIN|${k}|GLOBAL`), k).toBe(true);
      expect(have.has(`SALES_MANAGER|${k}|DEPARTMENT`), k).toBe(true);
    }
    const SALES_KEYS = [
      'relationships.view',
      'relationships.create',
      'relationships.edit',
      'activities.view',
      'activities.create',
      'activities.edit',
    ];
    expect(rows.rows).toHaveLength(8 + 8 + 6);
    for (const k of SALES_KEYS) expect(have.has(`SALES|${k}|SELF`), k).toBe(true);
    // SALES has no delete at SELF
    expect(have.has('SALES|relationships.delete|SELF')).toBe(false);
    expect(have.has('SALES|activities.delete|SELF')).toBe(false);
  });
});

describe('audit trail', () => {
  it('attaches exactly one enabled audit trigger to each relationships table', async () => {
    const { rows } = await owner.query<{ relname: string; tgname: string; tgenabled: string }>(
      `select c.relname, t.tgname, t.tgenabled
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_proc p on p.oid = t.tgfoid
       where n.nspname='public' and p.proname='audit_row_change'
         and c.relname in ('company_contacts','company_links','contact_links')`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([
      'company_contacts',
      'company_links',
      'contact_links',
    ]);
    for (const r of rows) {
      expect(r.tgname, r.relname).toBe(`${r.relname}_audit`);
      expect(r.tgenabled, r.relname).toBe('O');
    }
  });

  it('relationship writes land in audit_logs at HIGH, whole-row', async () => {
    // (co1, ct4) is a fresh pair: ct4 is never associated elsewhere.
    const id = (
      await inContext<{ id: string }>(
        ctxOf(g),
        `insert into public.company_contacts (org_id, company_id, contact_id, role, owner_person_id)
         values ($1,$2,$3,'Audit Role',$4) returning id`,
        [orgA, co1, ct4, g],
      )
    )[0]!.id;
    const entry = await owner.query<{ severity: string; after: Record<string, unknown> }>(
      `select severity, after from public.audit_logs
       where entity_type='company_contact' and entity_id=$1 order by occurred_at desc limit 1`,
      [id],
    );
    expect(entry.rows).toHaveLength(1);
    expect(entry.rows[0]!.severity).toBe('HIGH');
    expect(entry.rows[0]!.after).toMatchObject({ role: 'Audit Role', company_id: co1 });
  });

  it('link writes are audited at HIGH too', async () => {
    const lid = (
      await inContext<{ id: string }>(
        ctxOf(g),
        `insert into public.company_links
           (org_id, from_company_id, to_company_id, link_type, owner_person_id)
         values ($1,$2,$3,'SUBSIDIARY',$4) returning id`,
        [orgA, co2, co1, g],
      )
    )[0]!.id;
    const rows = await owner.query<{ entity_type: string; severity: string }>(
      `select entity_type, severity from public.audit_logs
       where entity_type='company_link' and entity_id=$1`,
      [lid],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.severity).toBe('HIGH');
  });
});
