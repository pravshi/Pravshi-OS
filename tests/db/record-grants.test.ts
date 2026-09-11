import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Task 1.9 — record grants.
 *
 * A record grant is an exception for ONE person on ONE record. Almost every test here is
 * an attempt to make one reach further than that: a different record, a different
 * resource, a different permission, a different person, a different tenant, or a person
 * whose engagement has ended.
 *
 * The other half of the file is the negative space: scope_for() and has() must behave
 * exactly as Task 1.8 left them, because a record grant that quietly widened a scope would
 * be a second authorization system wearing the first one's clothes.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `G${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

let orgA = '';
let orgB = '';
let orgSuspended = '';
let deptA = '';
let deptB = '';
let deptS = '';

let alice = ''; // orgA, ACTIVE — the subject of most grants
let grantor = ''; // orgA, ACTIVE — issues them
let bob = ''; // orgA, ACTIVE — holds none
let removed = ''; // orgA, soft-deleted person
let dormant = ''; // orgA, person_status INACTIVE
let unengaged = ''; // orgA, no engagement at all
let carol = ''; // orgB
let grantorB = ''; // orgB
let dave = ''; // orgSuspended
let grantorS = ''; // orgSuspended

// Two records of two kinds, none of which need to exist as rows: leads and projects are
// Phases 3 and 4, and a grant is written before the policy that consults it.
const RECORD_ONE = '11111111-1111-4111-8111-111111111111';
const RECORD_TWO = '22222222-2222-4222-8222-222222222222';

type Ctx = { personId?: string | null; orgId?: string | null };

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

const mkDept = async (org: string, code: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id,code,name) values ($1,$2,$3) returning id`,
      [org, code, `Dept ${code}`],
    )
  ).rows[0]!.id;

/** Issue a grant on the owner connection, with no identity: the provisioning path. */
const mkGrant = async (opts: {
  org: string;
  person: string;
  by: string;
  entityType?: string;
  entityId?: string;
  permission?: string;
  expiresAt?: string | null;
  reason?: string | null;
}) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.record_grants
         (org_id, entity_type, entity_id, person_id, permission_id, granted_by, expires_at, reason)
       select $1, $2, $3, $4, p.id, $5, $6::timestamptz, $7
       from public.permissions p where p.key = $8
       returning id`,
      [
        opts.org,
        opts.entityType ?? 'lead',
        opts.entityId ?? RECORD_ONE,
        opts.person,
        opts.by,
        opts.expiresAt ?? null,
        opts.reason ?? 'temporary access for a test',
        opts.permission ?? 'leads.view',
      ],
    )
  ).rows[0]!.id;

async function inContext<T>(ctx: Ctx, sql: string, params: unknown[] = []): Promise<T[]> {
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

/** The owner connection carrying an identity: full privilege, named actor. */
async function asActor<T>(ctx: Ctx, sql: string, params: unknown[] = []): Promise<T[]> {
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

const hasGrant = async (
  ctx: Ctx,
  entityType = 'lead',
  entityId = RECORD_ONE,
  permission = 'leads.view',
) =>
  (
    await inContext<{ g: boolean }>(ctx, `select authz.has_record_grant($1,$2::uuid,$3) g`, [
      entityType,
      entityId,
      permission,
    ])
  )[0]!.g;

beforeAll(async () => {
  const mkOrg = async (s: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name,slug) values ($1,$2) returning id`,
        [`Rg ${s}`, `rg-${RUN}-${s}`],
      )
    ).rows[0]!.id;
  [orgA, orgB, orgSuspended] = await Promise.all([mkOrg('a'), mkOrg('b'), mkOrg('s')]);

  [deptA, deptB, deptS] = await Promise.all([
    mkDept(orgA, `${CODE}_A`),
    mkDept(orgB, `${CODE}_B`),
    mkDept(orgSuspended, `${CODE}_S`),
  ]);

  [alice, grantor, bob, removed, dormant, unengaged, carol, grantorB, dave, grantorS] =
    await Promise.all([
      mkPerson(orgA, 'Alice'),
      mkPerson(orgA, 'Grantor'),
      mkPerson(orgA, 'Bob'),
      mkPerson(orgA, 'Removed'),
      mkPerson(orgA, 'Dormant'),
      mkPerson(orgA, 'Unengaged'),
      mkPerson(orgB, 'Carol'),
      mkPerson(orgB, 'Grantor B'),
      mkPerson(orgSuspended, 'Dave'),
      mkPerson(orgSuspended, 'Grantor S'),
    ]);

  await Promise.all([
    // `unengaged` deliberately gets none.
    ...[alice, grantor, bob, removed, dormant].map((p) => mkEngagement(orgA, p, deptA)),
    ...[carol, grantorB].map((p) => mkEngagement(orgB, p, deptB)),
    ...[dave, grantorS].map((p) => mkEngagement(orgSuspended, p, deptS)),
  ]);

  await Promise.all([
    owner.query(`update public.people set deleted_at=now() where id=$1`, [removed]),
    owner.query(`update public.people set person_status='INACTIVE' where id=$1`, [dormant]),
  ]);

  // The baseline grant: alice, leads.view, one lead, no expiry.
  await mkGrant({ org: orgA, person: alice, by: grantor });
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

// ── A. the grant works ───────────────────────────────────────────────────────────

describe('a valid grant', () => {
  it('is true for the person it names, on the record it names', async () => {
    expect(await hasGrant({ personId: alice, orgId: orgA })).toBe(true);
  });

  it('is true with no expiry at all', async () => {
    const { rows } = await owner.query<{ expires_at: string | null }>(
      `select expires_at from public.record_grants where person_id=$1 and entity_id=$2`,
      [alice, RECORD_ONE],
    );
    expect(rows[0]!.expires_at).toBeNull();
    expect(await hasGrant({ personId: alice, orgId: orgA })).toBe(true);
  });

  it('is true with an expiry in the future', async () => {
    const p = await mkPerson(orgA, 'Future Expiry');
    await mkEngagement(orgA, p, deptA);
    await mkGrant({
      org: orgA,
      person: p,
      by: grantor,
      entityId: RECORD_TWO,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(await hasGrant({ personId: p, orgId: orgA }, 'lead', RECORD_TWO)).toBe(true);
  });

  it('does not require the record to exist as a row anywhere', async () => {
    // leads and projects are Phases 3 and 4. A grant is written before the table it
    // eventually protects, which is why the target is (entity_type, entity_id) and not a
    // foreign key.
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) n from information_schema.tables
       where table_schema='public' and table_name in ('leads','projects')`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
    expect(await hasGrant({ personId: alice, orgId: orgA })).toBe(true);
  });
});

// ── B. expiry, in the predicate ──────────────────────────────────────────────────

describe('expiry', () => {
  it('is false once expires_at has passed, and true again when it moves forward', async () => {
    const p = await mkPerson(orgA, 'Expiring');
    await mkEngagement(orgA, p, deptA);
    // granted_at is immutable, so a grant that is already expired is CREATED that way
    // rather than back-dated afterwards. Ending a live grant early is revoked_at, not a
    // rewritten history — see the revocation test below.
    const id = (
      await owner.query<{ id: string }>(
        `insert into public.record_grants
           (org_id, entity_type, entity_id, person_id, permission_id, granted_by,
            granted_at, expires_at)
         select $1,'lead',$2,$3,p.id,$4, now() - interval '2 days', now() - interval '1 day'
         from public.permissions p where p.key='leads.view'
         returning id`,
        [orgA, RECORD_ONE, p, grantor],
      )
    ).rows[0]!.id;
    expect(await hasGrant({ personId: p, orgId: orgA })).toBe(false);

    // Extending it is an ordinary update of a mutable column, and takes effect at once.
    await owner.query(
      `update public.record_grants set expires_at = now() + interval '1 hour' where id=$1`,
      [id],
    );
    expect(await hasGrant({ personId: p, orgId: orgA })).toBe(true);

    // and shortening it back into the past does too
    await owner.query(
      `update public.record_grants set expires_at = now() - interval '1 hour' where id=$1`,
      [id],
    );
    expect(await hasGrant({ personId: p, orgId: orgA })).toBe(false);
  });

  it('refuses to rewrite when a grant was made, so its window cannot be back-dated', async () => {
    const id = await mkGrant({ org: orgA, person: alice, by: grantor, entityId: RECORD_TWO });
    await expect(
      owner.query(
        `update public.record_grants set granted_at = now() - interval '10 days' where id=$1`,
        [id],
      ),
    ).rejects.toThrow(/immutable/i);
    await owner.query(`update public.record_grants set revoked_at=now() where id=$1`, [id]);
  });

  it('evaluates expiry in the predicate rather than by anything scheduled', async () => {
    const { rows } = await owner.query<{ src: string }>(
      `select pg_get_functiondef(p.oid) src from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' and p.proname='has_record_grant'`,
    );
    expect(rows[0]!.src).toContain('expires_at is null or rg.expires_at > now()');
  });

  it('refuses an expiry that precedes the grant', async () => {
    await expect(
      owner.query(
        `insert into public.record_grants
           (org_id, entity_type, entity_id, person_id, permission_id, granted_by, expires_at)
         select $1,'lead',$2,$3,p.id,$4, now() - interval '1 day'
         from public.permissions p where p.key='leads.view'`,
        [orgA, RECORD_TWO, alice, grantor],
      ),
    ).rejects.toThrow();
  });
});

// ── C. identity ──────────────────────────────────────────────────────────────────

describe('identity', () => {
  it('is false with no identity at all', async () => {
    expect(await hasGrant({ personId: null, orgId: null })).toBe(false);
    expect(await hasGrant({ personId: null, orgId: orgA })).toBe(false);
  });

  it('is false for an identity that does not exist', async () => {
    expect(await hasGrant({ personId: '00000000-0000-0000-0000-000000000000', orgId: orgA })).toBe(
      false,
    );
  });

  it('is false for a soft-deleted person holding a grant', async () => {
    await mkGrant({ org: orgA, person: removed, by: grantor });
    expect(await hasGrant({ personId: removed, orgId: orgA })).toBe(false);
  });

  it('is false for a person who is not ACTIVE', async () => {
    await mkGrant({ org: orgA, person: dormant, by: grantor });
    expect(await hasGrant({ personId: dormant, orgId: orgA })).toBe(false);
  });
});

// ── D. engagement liveness ───────────────────────────────────────────────────────

describe('engagement liveness', () => {
  it('is false for every engagement status that is not ACTIVE', async () => {
    for (const status of [
      'PRE_ONBOARDING',
      'ONBOARDING',
      'NOTICE_PERIOD',
      'SUSPENDED',
      'OFFBOARDING',
      'ARCHIVED',
    ]) {
      const p = await mkPerson(orgA, `Status ${status}`);
      await mkEngagement(orgA, p, deptA, status);
      await mkGrant({ org: orgA, person: p, by: grantor });
      expect(await hasGrant({ personId: p, orgId: orgA }), status).toBe(false);
    }
  });

  it('is false for a person with no engagement at all', async () => {
    await mkGrant({ org: orgA, person: unengaged, by: grantor });
    expect(await hasGrant({ personId: unengaged, orgId: orgA })).toBe(false);
  });

  it('stops being true the moment the engagement is soft-deleted', async () => {
    const p = await mkPerson(orgA, 'Deletable Engagement');
    const e = await mkEngagement(orgA, p, deptA);
    await mkGrant({ org: orgA, person: p, by: grantor });
    expect(await hasGrant({ personId: p, orgId: orgA })).toBe(true);

    await owner.query(`update public.engagements set deleted_at=now() where id=$1`, [e]);
    expect(await hasGrant({ personId: p, orgId: orgA })).toBe(false);
  });
});

// ── E. organization ──────────────────────────────────────────────────────────────

describe('organization', () => {
  it('works within the correct organization', async () => {
    await mkGrant({ org: orgB, person: carol, by: grantorB });
    expect(await hasGrant({ personId: carol, orgId: orgB })).toBe(true);
  });

  it('fails closed on a mismatched tenant claim rather than widening', async () => {
    expect(await hasGrant({ personId: carol, orgId: orgA })).toBe(false);
    expect(await hasGrant({ personId: alice, orgId: orgB })).toBe(false);
  });

  it('cannot be created across organizations at all', async () => {
    // subject in orgA, grant claimed in orgB
    await expect(mkGrant({ org: orgB, person: alice, by: grantorB })).rejects.toThrow();
    // grantor in orgB, grant claimed in orgA
    await expect(mkGrant({ org: orgA, person: alice, by: grantorB })).rejects.toThrow();
    // both from different organizations
    await expect(mkGrant({ org: orgA, person: carol, by: grantor })).rejects.toThrow();
  });

  it('is false when the organization is suspended, and again when soft-deleted', async () => {
    await mkGrant({ org: orgSuspended, person: dave, by: grantorS });
    expect(await hasGrant({ personId: dave, orgId: orgSuspended })).toBe(true);

    await owner.query(`update public.organizations set status='SUSPENDED' where id=$1`, [
      orgSuspended,
    ]);
    expect(await hasGrant({ personId: dave, orgId: orgSuspended })).toBe(false);

    await owner.query(
      `update public.organizations set status='ACTIVE', deleted_at=now() where id=$1`,
      [orgSuspended],
    );
    expect(await hasGrant({ personId: dave, orgId: orgSuspended })).toBe(false);

    await owner.query(`update public.organizations set deleted_at=null where id=$1`, [
      orgSuspended,
    ]);
  });
});

// ── F. exactly one record, one resource, one permission, one person ──────────────

describe('the target is exact', () => {
  it('matches only the record it names', async () => {
    expect(await hasGrant({ personId: alice, orgId: orgA }, 'lead', RECORD_ONE)).toBe(true);
    expect(await hasGrant({ personId: alice, orgId: orgA }, 'lead', RECORD_TWO)).toBe(false);
    expect(
      await hasGrant(
        { personId: alice, orgId: orgA },
        'lead',
        '99999999-9999-4999-8999-999999999999',
      ),
    ).toBe(false);
  });

  it('matches only the resource it names', async () => {
    expect(await hasGrant({ personId: alice, orgId: orgA }, 'project', RECORD_ONE)).toBe(false);
    expect(await hasGrant({ personId: alice, orgId: orgA }, 'client', RECORD_ONE)).toBe(false);
    // a value that is not a known entity type at all reaches nothing rather than everything
    expect(await hasGrant({ personId: alice, orgId: orgA }, 'leadz', RECORD_ONE)).toBe(false);
    expect(await hasGrant({ personId: alice, orgId: orgA }, '', RECORD_ONE)).toBe(false);
  });

  it('matches only the permission it names', async () => {
    expect(await hasGrant({ personId: alice, orgId: orgA }, 'lead', RECORD_ONE, 'leads.edit')).toBe(
      false,
    );
    expect(
      await hasGrant({ personId: alice, orgId: orgA }, 'lead', RECORD_ONE, 'leads.export'),
    ).toBe(false);
    expect(
      await hasGrant({ personId: alice, orgId: orgA }, 'lead', RECORD_ONE, 'roles.manage'),
    ).toBe(false);
    expect(
      await hasGrant({ personId: alice, orgId: orgA }, 'lead', RECORD_ONE, 'not.a.permission'),
    ).toBe(false);
  });

  it('reaches nobody but the person it names', async () => {
    expect(await hasGrant({ personId: bob, orgId: orgA })).toBe(false);
    expect(await hasGrant({ personId: grantor, orgId: orgA })).toBe(false);
  });

  it('cannot name a permission outside the approved catalogue', async () => {
    await expect(
      owner.query(
        `insert into public.record_grants
           (org_id, entity_type, entity_id, person_id, permission_id, granted_by)
         values ($1,'lead',$2,$3,'00000000-0000-0000-0000-000000000000',$4)`,
        [orgA, RECORD_TWO, alice, grantor],
      ),
    ).rejects.toThrow();
  });

  it('constrains entity_type so it cannot hold arbitrary text', async () => {
    for (const bad of ['Lead', 'lead; drop table public.people', 'lead lead', '', '1lead']) {
      await expect(
        mkGrant({ org: orgA, person: alice, by: grantor, entityType: bad, entityId: RECORD_TWO }),
        bad,
      ).rejects.toThrow();
    }
  });
});

// ── G. several grants ────────────────────────────────────────────────────────────

describe('several grants', () => {
  it('works independently across records, resources and permissions', async () => {
    const p = await mkPerson(orgA, 'Multi Grant');
    await mkEngagement(orgA, p, deptA);
    await Promise.all([
      mkGrant({ org: orgA, person: p, by: grantor, entityId: RECORD_ONE }),
      mkGrant({ org: orgA, person: p, by: grantor, entityId: RECORD_TWO }),
      mkGrant({
        org: orgA,
        person: p,
        by: grantor,
        entityType: 'project',
        entityId: RECORD_ONE,
        permission: 'projects.view',
      }),
    ]);
    const ctx = { personId: p, orgId: orgA };
    expect(await hasGrant(ctx, 'lead', RECORD_ONE)).toBe(true);
    expect(await hasGrant(ctx, 'lead', RECORD_TWO)).toBe(true);
    expect(await hasGrant(ctx, 'project', RECORD_ONE, 'projects.view')).toBe(true);
    // and still nothing beyond them
    expect(await hasGrant(ctx, 'project', RECORD_TWO, 'projects.view')).toBe(false);
    expect(await hasGrant(ctx, 'lead', RECORD_ONE, 'leads.edit')).toBe(false);
  });

  it('lets one grant expire without touching another', async () => {
    const p = await mkPerson(orgA, 'One Expires');
    await mkEngagement(orgA, p, deptA);
    const [expiring] = await Promise.all([
      mkGrant({
        org: orgA,
        person: p,
        by: grantor,
        entityId: RECORD_ONE,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      mkGrant({ org: orgA, person: p, by: grantor, entityId: RECORD_TWO }),
    ]);
    const ctx = { personId: p, orgId: orgA };
    expect(await hasGrant(ctx, 'lead', RECORD_ONE)).toBe(true);
    expect(await hasGrant(ctx, 'lead', RECORD_TWO)).toBe(true);

    await owner.query(
      `update public.record_grants set expires_at = now() - interval '1 second' where id=$1`,
      [expiring],
    );
    expect(await hasGrant(ctx, 'lead', RECORD_ONE)).toBe(false);
    expect(await hasGrant(ctx, 'lead', RECORD_TWO)).toBe(true);
  });

  it('stops answering once revoked, and a second live grant still answers', async () => {
    const p = await mkPerson(orgA, 'Revoked');
    await mkEngagement(orgA, p, deptA);
    const first = await mkGrant({ org: orgA, person: p, by: grantor, entityId: RECORD_ONE });
    const ctx = { personId: p, orgId: orgA };
    expect(await hasGrant(ctx, 'lead', RECORD_ONE)).toBe(true);

    await owner.query(`update public.record_grants set revoked_at=now() where id=$1`, [first]);
    expect(await hasGrant(ctx, 'lead', RECORD_ONE)).toBe(false);

    // re-granting the same target is a new row, and the revoked one stays as history
    await mkGrant({ org: orgA, person: p, by: grantor, entityId: RECORD_ONE });
    expect(await hasGrant(ctx, 'lead', RECORD_ONE)).toBe(true);
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) n from public.record_grants where person_id=$1 and entity_id=$2`,
      [p, RECORD_ONE],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });
});

// ── I. RLS ───────────────────────────────────────────────────────────────────────

describe('RLS', () => {
  it('is enabled and forced', async () => {
    const { rows } = await owner.query<{ enabled: boolean; forced: boolean }>(
      `select c.relrowsecurity enabled, c.relforcerowsecurity forced
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname='record_grants'`,
    );
    expect(rows[0]).toEqual({ enabled: true, forced: true });
  });

  it('returns zero rows without an identity', async () => {
    expect(
      await inContext({ personId: null, orgId: null }, `select * from public.record_grants`),
    ).toEqual([]);
    expect(
      await inContext({ personId: null, orgId: orgA }, `select * from public.record_grants`),
    ).toEqual([]);
  });

  it('shows a person only their own grants', async () => {
    const mine = await inContext<{ person_id: string }>(
      { personId: alice, orgId: orgA },
      `select person_id from public.record_grants`,
    );
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.person_id === alice)).toBe(true);

    // bob holds none, and the organization has many
    const theirs = await inContext(
      { personId: bob, orgId: orgA },
      `select * from public.record_grants`,
    );
    expect(theirs).toEqual([]);
    const total = await owner.query<{ n: string }>(
      `select count(*) n from public.record_grants where org_id=$1`,
      [orgA],
    );
    expect(Number(total.rows[0]!.n)).toBeGreaterThan(5);
  });

  it('shows the grantor nothing they were not themselves granted', async () => {
    const asGrantor = await inContext(
      { personId: grantor, orgId: orgA },
      `select * from public.record_grants`,
    );
    expect(asGrantor).toEqual([]);
  });

  it('returns zero rows across tenants', async () => {
    const rows = await inContext<{ org_id: string }>(
      { personId: carol, orgId: orgB },
      `select org_id from public.record_grants`,
    );
    expect(rows.every((r) => r.org_id === orgB)).toBe(true);
    expect(
      await inContext({ personId: carol, orgId: orgA }, `select * from public.record_grants`),
    ).toEqual([]);
  });

  it('has no app_user policy satisfiable without an identity', async () => {
    const { rows } = await owner.query<{ qual: string }>(
      `select qual from pg_policies
       where schemaname='public' and tablename='record_grants' and 'app_user' = any(roles)`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.qual).toContain('authz.person_id()');
    expect(rows[0]!.qual).toContain('authz.org_id()');
  });
});

// ── J. escalation attempts ───────────────────────────────────────────────────────

describe('escalation attempts', () => {
  it('gives app_user no way to write to the table', async () => {
    const permission = (
      await owner.query<{ id: string }>(`select id from public.permissions where key='leads.view'`)
    ).rows[0]!.id;
    const attempts: [string, string, unknown[]][] = [
      [
        'grant itself access to a record',
        `insert into public.record_grants (org_id,entity_type,entity_id,person_id,permission_id,granted_by)
         values ($1,'lead',$2,$3,$4,$3)`,
        [orgA, RECORD_TWO, bob, permission],
      ],
      [
        'forge a grantor',
        `insert into public.record_grants (org_id,entity_type,entity_id,person_id,permission_id,granted_by)
         values ($1,'lead',$2,$3,$4,$5)`,
        [orgA, RECORD_TWO, bob, permission, grantor],
      ],
      [
        'forge an org_id',
        `insert into public.record_grants (org_id,entity_type,entity_id,person_id,permission_id,granted_by)
         values ($1,'lead',$2,$3,$4,$5)`,
        [orgB, RECORD_TWO, carol, permission, grantorB],
      ],
      [
        'repoint an existing grant at itself',
        `update public.record_grants set person_id=$1 where entity_id=$2`,
        [bob, RECORD_ONE],
      ],
      ['push an expiry out', `update public.record_grants set expires_at=null`, []],
      ['un-revoke a grant', `update public.record_grants set revoked_at=null`, []],
      ['delete the evidence', `delete from public.record_grants where person_id=$1`, [alice]],
    ];
    const outcomes = await Promise.all(
      attempts.map(async ([label, sql, params]) => {
        try {
          await inContext({ personId: bob, orgId: orgA }, sql, params);
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

  it('refuses a forged grantor even on a fully privileged connection', async () => {
    // The composite keys prove the grantor is a real person in the organization. They
    // cannot prove it is the person who actually did it, which is what the trigger adds.
    await expect(
      asActor(
        { personId: alice, orgId: orgA },
        `insert into public.record_grants
           (org_id,entity_type,entity_id,person_id,permission_id,granted_by)
         select $1,'lead',$2,$3,p.id,$4 from public.permissions p where p.key='leads.view'`,
        [orgA, RECORD_TWO, alice, grantor],
      ),
    ).rejects.toThrow(/granted_by cannot name another person/i);
  });

  it('accepts a grant attributed to the actor themselves', async () => {
    const target = await mkPerson(orgA, 'Granted By Actor');
    await mkEngagement(orgA, target, deptA);
    await asActor(
      { personId: grantor, orgId: orgA },
      `insert into public.record_grants
         (org_id,entity_type,entity_id,person_id,permission_id,granted_by)
       select $1,'lead',$2,$3,p.id,$4 from public.permissions p where p.key='leads.view'`,
      [orgA, RECORD_TWO, target, grantor],
    );
    expect(await hasGrant({ personId: target, orgId: orgA }, 'lead', RECORD_TWO)).toBe(true);
  });

  it('refuses a grant written into another organization by an actor', async () => {
    await expect(
      asActor(
        { personId: grantor, orgId: orgA },
        `insert into public.record_grants
           (org_id,entity_type,entity_id,person_id,permission_id,granted_by)
         select $1,'lead',$2,$3,p.id,$4 from public.permissions p where p.key='leads.view'`,
        [orgB, RECORD_TWO, carol, grantorB],
      ),
    ).rejects.toThrow();
  });

  it('freezes the columns that say who may reach what', async () => {
    const id = await mkGrant({ org: orgA, person: alice, by: grantor, entityId: RECORD_TWO });
    const frozen: [string, unknown[]][] = [
      [`update public.record_grants set person_id=$1 where id=$2`, [bob, id]],
      [`update public.record_grants set entity_id=$1 where id=$2`, [RECORD_ONE, id]],
      [`update public.record_grants set entity_type='project' where id=$1`, [id]],
      [`update public.record_grants set granted_by=$1 where id=$2`, [alice, id]],
      [`update public.record_grants set org_id=$1 where id=$2`, [orgB, id]],
      [
        `update public.record_grants set permission_id=(select id from public.permissions where key='leads.edit') where id=$1`,
        [id],
      ],
    ];
    for (const [sql, params] of frozen) {
      await expect(owner.query(sql, params), sql).rejects.toThrow(/immutable/i);
    }
    // but the fields a revocation needs are still writable
    await owner.query(
      `update public.record_grants set revoked_at=now(), reason='revoked by a test' where id=$1`,
      [id],
    );
    expect(await hasGrant({ personId: alice, orgId: orgA }, 'lead', RECORD_TWO)).toBe(false);
  });
});

// ── K. the function itself ───────────────────────────────────────────────────────

describe('has_record_grant() properties', () => {
  it('is SECURITY DEFINER, STABLE, owned by app_owner, search_path pinned empty', async () => {
    const { rows } = await owner.query<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
      owner: string;
      rettype: string;
      args: string;
    }>(
      `select p.prosecdef, p.provolatile, p.proconfig, r.rolname owner,
              t.typname rettype, pg_get_function_arguments(p.oid) args
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       join pg_roles r on r.oid=p.proowner
       join pg_type t on t.oid=p.prorettype
       where n.nspname='authz' and p.proname='has_record_grant'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.prosecdef).toBe(true);
    expect(rows[0]!.provolatile).toBe('s');
    expect(rows[0]!.proconfig ?? []).toContain('search_path=""');
    expect(rows[0]!.owner).toBe('app_owner');
    expect(rows[0]!.rettype).toBe('bool');
    // database.md 4.1: has_record_grant(entity_type text, entity_id uuid, p text)
    expect(rows[0]!.args).toBe('p_entity_type text, p_entity_id uuid, p_permission text');
  });

  it('grants EXECUTE to the runtime roles and never to PUBLIC', async () => {
    const { rows } = await owner.query<{ grantee: string }>(
      `select coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC') grantee
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ac
       where n.nspname='authz' and p.proname='has_record_grant'
         and ac.privilege_type='EXECUTE'`,
    );
    const grantees = rows.map((r) => r.grantee);
    expect(grantees).not.toContain('PUBLIC');
    expect(grantees).toContain('app_user');
    expect(grantees).toContain('app_admin');
  });

  it('uses no dynamic SQL and qualifies every table it reads', async () => {
    const { rows } = await owner.query<{ proname: string; src: string }>(
      `select p.proname, pg_get_functiondef(p.oid) src from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where (n.nspname='authz' and p.proname='has_record_grant')
          or (n.nspname='public' and p.proname='enforce_record_grant_integrity')`,
    );
    expect(rows.length).toBe(2);
    for (const r of rows) {
      const body = (r.src.split('AS $function$')[1] ?? '')
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n');
      // "is distinct from v_actor" is a comparison, not a FROM clause.
      const clauses = body.replace(/is\s+(not\s+)?distinct\s+from/gi, 'IS_DISTINCT');
      for (const t of clauses.match(/\b(from|join)\s+([a-z_.]+)/gi) ?? []) {
        expect(t, `${r.proname}: ${t}`).toMatch(/\s(public|authz)\./);
      }
      expect(body, `${r.proname} dynamic SQL`).not.toMatch(/\bexecute\b/i);
      expect(body, `${r.proname} role-name check`).not.toMatch(/SUPER_ADMIN|ADMIN|r\.key/);
    }
  });

  it('keeps the trigger function off PUBLIC and off the runtime role', async () => {
    const { rows } = await owner.query<{ grantee: string }>(
      `select coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC') grantee
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ac
       where n.nspname='public' and p.proname='enforce_record_grant_integrity'
         and ac.privilege_type='EXECUTE'`,
    );
    const grantees = rows.map((r) => r.grantee);
    expect(grantees).not.toContain('PUBLIC');
    expect(grantees).not.toContain('app_user');
  });

  it('never raises for an ordinary denial', async () => {
    // Every one of these is a denial, and every one of them returns false.
    const denials: [string, Ctx, string, string, string][] = [
      ['no identity', { personId: null, orgId: null }, 'lead', RECORD_ONE, 'leads.view'],
      ['wrong person', { personId: bob, orgId: orgA }, 'lead', RECORD_ONE, 'leads.view'],
      ['wrong record', { personId: alice, orgId: orgA }, 'lead', RECORD_TWO, 'leads.view'],
      ['wrong resource', { personId: alice, orgId: orgA }, 'project', RECORD_ONE, 'leads.view'],
      ['wrong permission', { personId: alice, orgId: orgA }, 'lead', RECORD_ONE, 'leads.edit'],
      ['unknown permission', { personId: alice, orgId: orgA }, 'lead', RECORD_ONE, 'nope.nope'],
    ];
    for (const [label, ctx, type, id, perm] of denials) {
      expect(await hasGrant(ctx, type, id, perm), label).toBe(false);
    }
  });

  it('indexes the exact authorization lookup', async () => {
    const { rows } = await owner.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname='public' and indexname='record_grants_person_entity_idx'`,
    );
    expect(rows.length).toBe(1);
    // database.md section 8, verbatim: (person_id, entity_type, entity_id) where revoked_at is null
    expect(rows[0]!.indexdef).toMatch(/person_id, entity_type, entity_id/);
    expect(rows[0]!.indexdef).toMatch(/revoked_at IS NULL/i);
  });
});

// ── L. nothing already approved has moved ────────────────────────────────────────

describe('the rest of the authorization model is untouched', () => {
  it('leaves scope_for() resolving exactly as Task 1.8 left it', async () => {
    const p = await mkPerson(orgA, 'Scope Unchanged');
    await mkEngagement(orgA, p, deptA);
    const empRole = (
      await owner.query<{ id: string }>(
        `select id from public.roles where org_id=$1 and key='EMPLOYEE'`,
        [orgA],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
      [p, empRole, orgA],
    );
    const ctx = { personId: p, orgId: orgA };
    const scope = await inContext<{ s: string | null }>(
      ctx,
      `select authz.scope_for('people.view') s`,
    );
    expect(scope[0]!.s).toBe('SELF');

    // A record grant on a different permission changes nothing about that answer.
    await mkGrant({ org: orgA, person: p, by: grantor, entityId: RECORD_TWO });
    const after = await inContext<{ s: string | null; h: boolean; l: string | null }>(
      ctx,
      `select authz.scope_for('people.view') s, authz.has('leads.view') h,
              authz.scope_for('leads.view') l`,
    );
    expect(after[0]!.s).toBe('SELF');
    // and the granted permission is still not held at any scope: a record grant is not a role
    expect(after[0]!.h).toBe(false);
    expect(after[0]!.l).toBeNull();
    // while the record-level exception itself does answer
    expect(await hasGrant(ctx, 'lead', RECORD_TWO)).toBe(true);
  });

  it('leaves has() defined as scope_for() is not null', async () => {
    const { rows } = await owner.query<{ src: string }>(
      `select pg_get_functiondef(p.oid) src from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' and p.proname='has'`,
    );
    expect(rows[0]!.src).toContain('authz.scope_for(p_permission) is not null');
    expect(rows[0]!.src).not.toContain('record_grant');
  });

  it('adds exactly one helper and no stubs', async () => {
    const { rows } = await owner.query<{ proname: string }>(
      `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' order by proname`,
    );
    const names = rows.map((r) => r.proname);
    expect(names).toEqual([
      'aal',
      'has',
      'has_record_grant',
      'is_active',
      'is_active_person',
      'my_departments',
      'next_identity_code',
      'org_id',
      'person_id',
      'scope_for',
    ]);
    for (const deferred of ['reports_to_me', 'is_project_member']) {
      expect(names, `${deferred} must not exist as a stub`).not.toContain(deferred);
    }
  });

  it('leaves every table RLS-enabled and forced, and no policy weakened', async () => {
    const unprotected = await owner.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r'
         and c.relname not like '\\_%' and c.relname <> '__drizzle_migrations'
         and (not c.relrowsecurity or not c.relforcerowsecurity)`,
    );
    expect(unprotected.rows).toEqual([]);

    const policies = await owner.query<{ n: string; with_scope: string }>(
      `select count(*) n, count(*) filter (where qual like '%scope_for%') with_scope
       from pg_policies
       where schemaname='public' and 'app_user' = any(roles)
         and tablename not like '\\_%'`,
    );
    // Thirteen from Tasks 1.2-1.7, record_grants from 1.9, audit_logs from 1.10. Only the
    // last branches on scope: audit_logs.view is GLOBAL-only in the matrix, so it needs
    // neither reports_to_me nor is_project_member. record_grants stays SELF-scoped.
    expect(Number(policies.rows[0]!.n)).toBe(15);
    expect(Number(policies.rows[0]!.with_scope)).toBe(1);
  });

  it('leaves app_user with no writes on any authorization table', async () => {
    const { rows } = await owner.query<{ table_name: string }>(
      `select table_name from information_schema.table_privileges
       where table_schema='public' and grantee='app_user'
         and privilege_type in ('INSERT','UPDATE','DELETE')
         and table_name in ('roles','permissions','role_permissions','person_roles','record_grants')`,
    );
    expect(rows).toEqual([]);
  });
});

// ── H. pooled connections ────────────────────────────────────────────────────────

describe('pooled connection isolation', () => {
  it('never lets alternating identities inherit each other grants', async () => {
    for (let i = 0; i < 6; i++) {
      expect(await hasGrant({ personId: alice, orgId: orgA })).toBe(true);
      expect(await hasGrant({ personId: bob, orgId: orgA })).toBe(false);
    }
  });

  it('leaves no grant state behind on a reused connection', async () => {
    const c = await asUser.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
        [alice, orgA],
      );
      const inside = await c.query<{ g: boolean }>(
        `select authz.has_record_grant('lead',$1::uuid,'leads.view') g`,
        [RECORD_ONE],
      );
      expect(inside.rows[0]!.g).toBe(true);
      await c.query('commit');

      const after = await c.query<{ g: boolean }>(
        `select authz.has_record_grant('lead',$1::uuid,'leads.view') g`,
        [RECORD_ONE],
      );
      expect(after.rows[0]!.g).toBe(false);
      const rows = await c.query(`select * from public.record_grants`);
      expect(rows.rows).toEqual([]);
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  });

  it('keeps twelve interleaved grant checks isolated', async () => {
    // carol holds a grant on the SAME entity_id in orgB. Both answer true, independently,
    // which is the tenant boundary working rather than leaking: neither reaches the other.
    const cases: [string, string, boolean][] = [
      [alice, orgA, true],
      [bob, orgA, false],
      [carol, orgB, true],
      [alice, orgA, true],
      [unengaged, orgA, false],
      [grantor, orgA, false],
    ];
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const [person, org] = cases[i % cases.length]!;
        return inContext<{ g: boolean; pid: string | null }>(
          { personId: person, orgId: org },
          `select authz.has_record_grant('lead',$1::uuid,'leads.view') g, authz.person_id() pid`,
          [RECORD_ONE],
        );
      }),
    );
    results.forEach((r, i) => {
      const [person, , expected] = cases[i % cases.length]!;
      expect(r[0]!.g, `row ${i}`).toBe(expected);
      if (r[0]!.pid !== null) expect(r[0]!.pid, `row ${i}`).toBe(person);
    });
  });
});

// ── Task 1.9 amendment: record_grants.manage ─────────────────────────────────────

describe('record_grants.manage', () => {
  const roleId = async (org: string, key: string) =>
    (
      await owner.query<{ id: string }>(`select id from public.roles where org_id=$1 and key=$2`, [
        org,
        key,
      ])
    ).rows[0]!.id;

  it('exists under exactly that key, with the catalogue conventions', async () => {
    const { rows } = await owner.query<{
      key: string;
      resource: string;
      action: string;
      module: string;
      is_sensitive: boolean;
    }>(
      `select key, resource, action, module, is_sensitive
       from public.permissions where key='record_grants.manage'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({
      key: 'record_grants.manage',
      resource: 'record_grants',
      action: 'manage',
      module: 'roles_permissions',
      // The same authority class as roles.manage and permissions.manage: the ability to
      // hand out access outside the normal model.
      is_sensitive: true,
    });
  });

  it('adds exactly one row to the catalogue, and not record_grants.view', async () => {
    const { rows } = await owner.query<{ total: string; rg: string }>(
      `select count(*) total,
              count(*) filter (where key like 'record_grants.%') rg
       from public.permissions`,
    );
    expect(Number(rows[0]!.total)).toBe(82);
    expect(Number(rows[0]!.rg)).toBe(1);
    const view = await owner.query(
      `select 1 from public.permissions where key='record_grants.view'`,
    );
    expect(view.rows).toEqual([]);
  });

  it('is granted to SUPER_ADMIN at GLOBAL in every organization', async () => {
    const { rows } = await owner.query<{ org_id: string; scope: string }>(
      `select r.org_id, rp.scope
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where p.key='record_grants.manage' and r.key='SUPER_ADMIN'`,
    );
    const orgs = new Set(rows.map((r) => r.org_id));
    for (const org of [orgA, orgB, orgSuspended]) expect(orgs.has(org), org).toBe(true);
    for (const r of rows) expect(r.scope).toBe('GLOBAL');
  });

  it('is granted to no other role at all', async () => {
    const { rows } = await owner.query<{ key: string }>(
      `select distinct r.key
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where p.key='record_grants.manage'`,
    );
    expect(rows.map((r) => r.key)).toEqual(['SUPER_ADMIN']);
  });

  it('reaches a brand-new organization through the existing seed, with no backfill', async () => {
    const fresh = (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name,slug) values ($1,$2) returning id`,
        [`Rg amend ${RUN}`, `rg-${RUN}-amend`],
      )
    ).rows[0]!.id;
    const { rows } = await owner.query<{ scope: string }>(
      `select rp.scope from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where r.org_id=$1 and r.key='SUPER_ADMIN' and p.key='record_grants.manage'`,
      [fresh],
    );
    expect(rows.map((r) => r.scope)).toEqual(['GLOBAL']);
  });

  it('leaves the protected-role trigger enabled after the migration', async () => {
    // The migration disables it for one statement to backfill existing tenants. If it were
    // ever left off, every protected-role rule in Task 1.7 would be silently inert.
    const { rows } = await owner.query<{ tgenabled: string }>(
      `select t.tgenabled from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       where c.relname='role_permissions' and t.tgname='role_permissions_enforce_protection'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.tgenabled).toBe('O');
  });

  it('still refuses an actor without roles.manage to hand the permission around', async () => {
    // Close this organization's genesis window with a real holder, then confirm somebody
    // else cannot attach the new permission to a protected role.
    const superAdmin = await roleId(orgA, 'SUPER_ADMIN');
    await owner.query(
      `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
      [grantor, superAdmin, orgA],
    );
    await expect(
      asActor(
        { personId: alice, orgId: orgA },
        `update public.role_permissions set scope='SELF'
          where role_id=$1
            and permission_id=(select id from public.permissions where key='record_grants.manage')`,
        [superAdmin],
      ),
    ).rejects.toThrow(/roles.manage at GLOBAL/i);
  });

  it('does not itself grant any record-level access', async () => {
    // Holding the authority to issue exceptions is not holding an exception. has() and
    // scope_for() answer for the permission; has_record_grant() answers for the record, and
    // the two never consult each other.
    const holder = await mkPerson(orgA, 'Grant Manager');
    await mkEngagement(orgA, holder, deptA);
    await owner
      .query(
        `insert into public.person_roles (person_id, role_id, org_id)
       values ($1,(select id from public.roles where org_id=$2 and key='SUPER_ADMIN'),$2)`,
        [holder, orgA],
      )
      .catch(async () => {
        // genesis already closed by the test above; go through the holder instead
        await asActor(
          { personId: grantor, orgId: orgA },
          `insert into public.person_roles (person_id, role_id, org_id)
         values ($1,(select id from public.roles where org_id=$2 and key='SUPER_ADMIN'),$2)`,
          [holder, orgA],
        );
      });

    const ctx = { personId: holder, orgId: orgA };
    const answers = await inContext<{ h: boolean; s: string | null }>(
      ctx,
      `select authz.has('record_grants.manage') h, authz.scope_for('record_grants.manage') s`,
    );
    expect(answers[0]!.h).toBe(true);
    expect(answers[0]!.s).toBe('GLOBAL');
    // ...and still no grant on any record
    expect(await hasGrant(ctx, 'lead', RECORD_ONE)).toBe(false);
    expect(await hasGrant(ctx, 'lead', RECORD_TWO)).toBe(false);

    // conversely, alice holds a record grant and none of the permission
    const aliceAnswers = await inContext<{ h: boolean; s: string | null }>(
      { personId: alice, orgId: orgA },
      `select authz.has('record_grants.manage') h, authz.scope_for('record_grants.manage') s`,
    );
    expect(aliceAnswers[0]!.h).toBe(false);
    expect(aliceAnswers[0]!.s).toBeNull();
    expect(await hasGrant({ personId: alice, orgId: orgA })).toBe(true);
  });

  it('gives app_user no direct write to record_grants regardless of the permission', async () => {
    const { rows } = await owner.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.table_privileges
       where table_schema='public' and grantee='app_user' and table_name='record_grants'`,
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(['SELECT']);
  });
});
