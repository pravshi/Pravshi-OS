import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Task 1.6a — the internship extension of an engagement.
 *
 * The load-bearing property is that an internship cannot exist apart from an internship
 * engagement: not without one, not twice for one, and not attached to an EMPLOYEE.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `I${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

let orgA = '';
let orgB = '';
let mentorA = '';
let mentorB = ''; // orgB
let deptA = '';
let deptB = '';

const mkPerson = async (org: string, name: string) => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'INT','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people (org_id,code,full_legal_name,person_status)
       values ($1,$2,$3,'ACTIVE') returning id`,
      [org, code, name],
    )
  ).rows[0]!.id;
};

const mkEngagement = async (org: string, person: string, dept: string, type = 'INTERN') =>
  (
    await owner.query<{ id: string }>(
      `insert into public.engagements
         (org_id,person_id,department_id,engagement_type,status,start_date)
       values ($1,$2,$3,$4::public.engagement_type,'ACTIVE',current_date) returning id`,
      [org, person, dept, type],
    )
  ).rows[0]!.id;

const mkInternship = (org: string, engagement: string, mentor: string | null = null) =>
  owner.query(
    `insert into public.internships (engagement_id, org_id, mentor_person_id, program_name)
     values ($1,$2,$3,'Summer Program')`,
    [engagement, org, mentor],
  );

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

beforeAll(async () => {
  const mkOrg = async (s: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name,slug) values ($1,$2) returning id`,
        [`In ${s}`, `in-${RUN}-${s}`],
      )
    ).rows[0]!.id;
  orgA = await mkOrg('a');
  orgB = await mkOrg('b');

  const mkDept = async (org: string, code: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.departments (org_id,code,name) values ($1,$2,$3) returning id`,
        [org, code, `Dept ${code}`],
      )
    ).rows[0]!.id;
  deptA = await mkDept(orgA, `${CODE}_A`);
  deptB = await mkDept(orgB, `${CODE}_B`);

  mentorA = await mkPerson(orgA, 'Mentor A');
  mentorB = await mkPerson(orgB, 'Mentor B');
}, 120_000); // 120s: setup can queue behind the Phase 12 perf seed + ANALYZE under CI parallel load (PR #70 round 4; PR #72 round 2; PR #74 main run).

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

describe('structure', () => {
  it('is keyed by the engagement itself', async () => {
    const { rows } = await owner.query<{ column_name: string }>(
      `select kcu.column_name from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
       where tc.table_name='internships' and tc.constraint_type='PRIMARY KEY'`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(['engagement_id']);
  });

  it('carries exactly the authoritative fields', async () => {
    const { rows } = await owner.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='internships' order by column_name`,
    );
    const cols = rows.map((r) => r.column_name);
    for (const expected of [
      'engagement_id',
      'mentor_person_id',
      'program_name',
      'stipend_amount',
      'currency',
      'mid_review_date',
      'final_review_date',
      'outcome',
      'certificate_document_id',
    ]) {
      expect(cols, expected).toContain(expected);
    }
    // Nothing from the excluded list leaked in.
    for (const forbidden of ['salary', 'payroll', 'leave_balance', 'attendance', 'performance']) {
      expect(cols).not.toContain(forbidden);
    }
  });

  it('has no deleted_at — its lifecycle belongs to the engagement', async () => {
    const { rows } = await owner.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='internships' and column_name='deleted_at'`,
    );
    expect(rows).toEqual([]);
  });

  it('stores money as numeric with an explicit currency, never a float', async () => {
    const { rows } = await owner.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
       where table_schema='public' and table_name='internships'
         and column_name in ('stipend_amount','currency')`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
    expect(byName['stipend_amount']).toBe('numeric');
    expect(byName['currency']).toBe('character');
  });

  it('uses the blueprint outcome values', async () => {
    const { rows } = await owner.query<{ l: string }>(
      `select unnest(enum_range(null::public.internship_outcome))::text l`,
    );
    expect(rows.map((r) => r.l).sort()).toEqual(['COMPLETED', 'CONVERTED', 'TERMINATED']);
  });

  it('rejects a stipend with no currency, a bad currency and out-of-order reviews', async () => {
    const p = await mkPerson(orgA, 'Constraints');
    const e = await mkEngagement(orgA, p, deptA);
    await expect(
      owner.query(
        `insert into public.internships (engagement_id,org_id,stipend_amount) values ($1,$2,1000)`,
        [e, orgA],
      ),
    ).rejects.toThrow();
    await expect(
      owner.query(
        `insert into public.internships (engagement_id,org_id,stipend_amount,currency)
         values ($1,$2,1000,'rupee')`,
        [e, orgA],
      ),
    ).rejects.toThrow();
    await expect(
      owner.query(
        `insert into public.internships (engagement_id,org_id,mid_review_date,final_review_date)
         values ($1,$2,current_date, current_date - 10)`,
        [e, orgA],
      ),
    ).rejects.toThrow();
  });
});

describe('the engagement relationship', () => {
  it('accepts an internship on an INTERN engagement', async () => {
    const p = await mkPerson(orgA, 'Valid');
    const e = await mkEngagement(orgA, p, deptA, 'INTERN');
    await expect(mkInternship(orgA, e, mentorA)).resolves.toBeTruthy();
  });

  it('cannot exist without an engagement', async () => {
    await expect(
      owner.query(
        `insert into public.internships (engagement_id,org_id) values (gen_random_uuid(),$1)`,
        [orgA],
      ),
    ).rejects.toThrow();
  });

  it('refuses a second internship for the same engagement', async () => {
    const p = await mkPerson(orgA, 'Duplicate');
    const e = await mkEngagement(orgA, p, deptA, 'INTERN');
    await mkInternship(orgA, e, mentorA);
    await expect(mkInternship(orgA, e, mentorA)).rejects.toThrow();
  });

  it('refuses an internship on an EMPLOYEE engagement', async () => {
    const p = await mkPerson(orgA, 'Employee');
    const e = await mkEngagement(orgA, p, deptA, 'EMPLOYEE');
    await expect(mkInternship(orgA, e, mentorA)).rejects.toThrow();
  });

  it('refuses every non-INTERN engagement type', async () => {
    for (const type of ['TRAINEE', 'CONTRACTOR', 'CONSULTANT', 'PART_TIME', 'TEMPORARY']) {
      const p = await mkPerson(orgA, `Type ${type}`);
      const e = await mkEngagement(orgA, p, deptA, type);
      await expect(mkInternship(orgA, e, mentorA), type).rejects.toThrow();
    }
  });

  it('blocks changing the engagement type out from under an existing internship', async () => {
    const p = await mkPerson(orgA, 'TypeChange');
    const e = await mkEngagement(orgA, p, deptA, 'INTERN');
    await mkInternship(orgA, e, mentorA);
    await expect(
      owner.query(
        `update public.engagements set engagement_type='EMPLOYEE'::public.engagement_type where id=$1`,
        [e],
      ),
    ).rejects.toThrow();
  });

  it('survives the engagement lifecycle and remains readable as history', async () => {
    const p = await mkPerson(orgA, 'Lifecycle');
    const e = await mkEngagement(orgA, p, deptA, 'INTERN');
    await mkInternship(orgA, e, mentorA);
    // Move the engagement through to NOTICE_PERIOD via the Task 1.6 machine.
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
        [mentorA, orgA],
      );
      await c.query(`update public.engagements set status='NOTICE_PERIOD' where id=$1`, [e]);
      await c.query('commit');
    } finally {
      c.release();
    }
    await owner.query(
      `update public.internships set outcome='COMPLETED'::public.internship_outcome where engagement_id=$1`,
      [e],
    );
    const { rows } = await owner.query<{ outcome: string }>(
      `select outcome::text from public.internships where engagement_id=$1`,
      [e],
    );
    expect(rows[0]!.outcome).toBe('COMPLETED');
  });
});

describe('mentor integrity', () => {
  it('accepts a same-organization mentor', async () => {
    const p = await mkPerson(orgA, 'MentorOk');
    const e = await mkEngagement(orgA, p, deptA, 'INTERN');
    await expect(mkInternship(orgA, e, mentorA)).resolves.toBeTruthy();
  });

  it('refuses a mentor from another organization', async () => {
    const p = await mkPerson(orgA, 'MentorCross');
    const e = await mkEngagement(orgA, p, deptA, 'INTERN');
    await expect(mkInternship(orgA, e, mentorB)).rejects.toThrow();
  });

  it('refuses a mentor who does not exist', async () => {
    const p = await mkPerson(orgA, 'MentorGhost');
    const e = await mkEngagement(orgA, p, deptA, 'INTERN');
    await expect(
      owner.query(
        `insert into public.internships (engagement_id,org_id,mentor_person_id)
         values ($1,$2,gen_random_uuid())`,
        [e, orgA],
      ),
    ).rejects.toThrow();
  });

  it('allows an internship with no mentor assigned yet', async () => {
    const p = await mkPerson(orgA, 'NoMentor');
    const e = await mkEngagement(orgA, p, deptA, 'INTERN');
    await expect(mkInternship(orgA, e, null)).resolves.toBeTruthy();
  });

  it('requires no particular role of a mentor', async () => {
    // mentorA holds no role — roles do not exist yet — and is a valid mentor.
    const p = await mkPerson(orgA, 'PlainMentor');
    const e = await mkEngagement(orgA, p, deptA, 'INTERN');
    const plain = await mkPerson(orgA, 'Ordinary');
    await expect(mkInternship(orgA, e, plain)).resolves.toBeTruthy();
  });
});

describe('organization consistency', () => {
  it('refuses an org_id disagreeing with the engagement', async () => {
    const p = await mkPerson(orgA, 'OrgMismatch');
    const e = await mkEngagement(orgA, p, deptA, 'INTERN');
    await expect(mkInternship(orgB, e, null)).rejects.toThrow();
  });

  it('refuses an engagement from another organization entirely', async () => {
    const p = await mkPerson(orgB, 'ForeignEngagement');
    const e = await mkEngagement(orgB, p, deptB, 'INTERN');
    await expect(mkInternship(orgA, e, mentorA)).rejects.toThrow();
  });

  it('carries the composite foreign keys', async () => {
    const { rows } = await owner.query<{ conname: string }>(
      `select conname from pg_constraint where contype='f' and conname in (
         'internships_engagement_same_org','internships_engagement_is_intern',
         'internships_mentor_same_org')`,
    );
    expect(rows).toHaveLength(3);
  });
});

describe('RLS and privileges', () => {
  it('has RLS enabled and forced, and no table in public is unprotected', async () => {
    const { rows } = await owner.query<{ e: boolean; f: boolean }>(
      `select relrowsecurity e, relforcerowsecurity f from pg_class c
       join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and relname='internships'`,
    );
    expect(rows[0]!.e).toBe(true);
    expect(rows[0]!.f).toBe(true);

    const unprotected = await owner.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r' and c.relname <> '__drizzle_migrations'
         and (not c.relrowsecurity or not c.relforcerowsecurity)`,
    );
    expect(unprotected.rows.map((r) => r.relname)).toEqual([]);
  });

  it('grants app_user no write privilege', async () => {
    const { rows } = await owner.query<{ p: string }>(
      `select privilege_type p from information_schema.table_privileges
       where grantee='app_user' and table_name='internships'
         and privilege_type in ('INSERT','UPDATE','DELETE')`,
    );
    expect(rows).toEqual([]);
  });

  it('cannot be written by app_user', async () => {
    await expect(
      asUser.query(`update public.internships set program_name='hax'`),
    ).rejects.toThrow();
    await expect(asUser.query(`delete from public.internships`)).rejects.toThrow();
  });

  it('returns nothing without identity — no broad organization policy', async () => {
    const { rows } = await asUser.query<{ n: string }>(`select count(*) n from public.internships`);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('shows an intern only their own record', async () => {
    const intern = await mkPerson(orgA, 'SelfView');
    const e = await mkEngagement(orgA, intern, deptA, 'INTERN');
    await mkInternship(orgA, e, mentorA);

    const mine = await inContext<{ engagement_id: string }>(
      { personId: intern, orgId: orgA },
      `select engagement_id from public.internships`,
    );
    expect(mine.map((r) => r.engagement_id)).toEqual([e]);

    // The mentor gains no visibility from being the mentor — that is a permission,
    // and permissions arrive in Task 1.7.
    const mentorView = await inContext<{ engagement_id: string }>(
      { personId: mentorA, orgId: orgA },
      `select engagement_id from public.internships where engagement_id=$1`,
      [e],
    );
    expect(mentorView).toEqual([]);
  }, 120_000); // 120s: fixture writes + context queries can queue behind the Phase 12 perf seed under CI parallel load (PR #74 main run).

  it('denies a cross-tenant claim', async () => {
    const intern = await mkPerson(orgA, 'CrossTenant');
    const e = await mkEngagement(orgA, intern, deptA, 'INTERN');
    await mkInternship(orgA, e, mentorA);
    const rows = await inContext<{ engagement_id: string }>(
      { personId: intern, orgId: orgB },
      `select engagement_id from public.internships`,
    );
    expect(rows).toEqual([]);
  }, 120_000); // 120s: fixture writes + context queries can queue behind the Phase 12 perf seed under CI parallel load (PR #72 round 2).

  it('keeps app_user unable to bypass RLS and owning nothing', async () => {
    const r = await asUser.query<{ b: boolean; s: boolean }>(
      `select rolbypassrls b, rolsuper s from pg_roles where rolname=current_user`,
    );
    expect(r.rows[0]!.b).toBe(false);
    expect(r.rows[0]!.s).toBe(false);
    const owned = await asUser.query<{ n: number }>(
      `select count(*)::int n from pg_class c join pg_roles g on g.oid=c.relowner
       where g.rolname=current_user and c.relkind='r'`,
    );
    expect(owned.rows[0]!.n).toBe(0);
  });

  it('adds no SECURITY DEFINER function and no PUBLIC execute', async () => {
    const { rows } = await owner.query<{ proname: string; grantee: string }>(
      `select p.proname, coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC') grantee
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) ac
       where n.nspname='authz' and ac.privilege_type='EXECUTE'`,
    );
    expect(rows.map((r) => r.grantee)).not.toContain('PUBLIC');
  });
});

describe('pooled-connection isolation', () => {
  let internX = '';
  let engX = '';
  let internY = '';
  let engY = '';

  beforeAll(async () => {
    internX = await mkPerson(orgA, 'PoolX');
    engX = await mkEngagement(orgA, internX, deptA, 'INTERN');
    await mkInternship(orgA, engX, mentorA);
    internY = await mkPerson(orgB, 'PoolY');
    engY = await mkEngagement(orgB, internY, deptB, 'INTERN');
    await mkInternship(orgB, engY, mentorB);
  }, 120_000); // 120s: setup can queue behind the Phase 12 perf seed + ANALYZE under CI parallel load (PR #70 round 4; PR #72 round 2; PR #74 main run).

  it('alternating interns see only their own record', async () => {
    for (const [pid, oid, expected] of [
      [internX, orgA, engX],
      [internY, orgB, engY],
      [internX, orgA, engX],
      [internY, orgB, engY],
    ] as const) {
      const rows = await inContext<{ engagement_id: string }>(
        { personId: pid, orgId: oid },
        `select engagement_id from public.internships`,
      );
      expect(rows.map((r) => r.engagement_id)).toEqual([expected]);
    }
  });

  it('a reused connection retains no previous identity', async () => {
    await inContext({ personId: internX, orgId: orgA }, `select 1 from public.internships`);
    const leaked = await asUser.query<{ n: string }>(`select count(*) n from public.internships`);
    expect(Number(leaked.rows[0]!.n)).toBe(0);
  });

  it('12 concurrent interleaved contexts stay isolated', async () => {
    const cases = [
      [internX, orgA, engX],
      [internY, orgB, engY],
    ] as const;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const [pid, oid, expected] = cases[i % cases.length]!;
        return inContext<{ engagement_id: string }>(
          { personId: pid, orgId: oid },
          `select engagement_id from public.internships`,
        ).then((rows) => ({ expected, got: rows.map((r) => r.engagement_id) }));
      }),
    );
    for (const r of results) expect(r.got).toEqual([r.expected]);
  }, 60_000);
});
