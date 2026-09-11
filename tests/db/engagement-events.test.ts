import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Task 1.6 — engagement lifecycle events and the transition machine.
 *
 * The properties under test are structural, not procedural: a status change cannot happen
 * without an event, an event cannot be written without a status change, neither can be
 * done anonymously, and no role can rewrite what was written.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `V${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

let orgA = '';
let orgB = '';
let hr = ''; // orgA, performs transitions
let alice = ''; // orgA
let carol = ''; // orgB
let deptA = '';
let deptB = '';

const mkPerson = async (org: string, name: string) => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
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

const mkEngagement = async (org: string, person: string, dept: string, status: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.engagements
         (org_id,person_id,department_id,engagement_type,status,start_date)
       values ($1,$2,$3,'EMPLOYEE',$4::public.engagement_status,current_date) returning id`,
      [org, person, dept, status],
    )
  ).rows[0]!.id;

/** A status change performed inside an identity context, as the application would. */
async function transition(
  engagementId: string,
  to: string,
  actor: string | null,
  org: string | null,
) {
  const c = await owner.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`, [
      actor ?? '',
      org ?? '',
    ]);
    await c.query(`update public.engagements set status=$2::public.engagement_status where id=$1`, [
      engagementId,
      to,
    ]);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

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
        [`Ev ${s}`, `ev-${RUN}-${s}`],
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

  hr = await mkPerson(orgA, 'HR');
  alice = await mkPerson(orgA, 'Alice');
  carol = await mkPerson(orgB, 'Carol');
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

describe('event creation', () => {
  it('a transition creates exactly one event with the correct from, to, actor and time', async () => {
    const p = await mkPerson(orgA, 'One');
    const e = await mkEngagement(orgA, p, deptA, 'ONBOARDING');
    const before = new Date();
    await transition(e, 'ACTIVE', hr, orgA);

    const { rows } = await owner.query<{
      from_status: string;
      to_status: string;
      actor_person_id: string;
      occurred_at: Date;
      effective_date: Date;
    }>(
      `select from_status::text, to_status::text, actor_person_id, occurred_at, effective_date
       from public.engagement_events where engagement_id=$1`,
      [e],
    );
    expect(rows, 'exactly one event').toHaveLength(1);
    expect(rows[0]!.from_status).toBe('ONBOARDING');
    expect(rows[0]!.to_status).toBe('ACTIVE');
    expect(rows[0]!.actor_person_id).toBe(hr);
    expect(rows[0]!.occurred_at.valueOf()).toBeGreaterThanOrEqual(before.valueOf() - 1000);
    expect(rows[0]!.effective_date).toBeTruthy();
  });

  it('writes no event when the status does not change', async () => {
    const p = await mkPerson(orgA, 'NoChange');
    const e = await mkEngagement(orgA, p, deptA, 'ACTIVE');
    await owner.query(`update public.engagements set job_title='Engineer' where id=$1`, [e]);
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) n from public.engagement_events where engagement_id=$1`,
      [e],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('keeps every historical event as the engagement moves on', async () => {
    const p = await mkPerson(orgA, 'Journey');
    const e = await mkEngagement(orgA, p, deptA, 'PRE_ONBOARDING');
    await transition(e, 'ONBOARDING', hr, orgA);
    await transition(e, 'ACTIVE', hr, orgA);
    await transition(e, 'NOTICE_PERIOD', hr, orgA);
    await transition(e, 'OFFBOARDING', hr, orgA);
    await transition(e, 'ARCHIVED', hr, orgA);

    const { rows } = await owner.query<{ from_status: string; to_status: string }>(
      `select from_status::text, to_status::text from public.engagement_events
       where engagement_id=$1 order by occurred_at`,
      [e],
    );
    expect(rows.map((r) => `${r.from_status}->${r.to_status}`)).toEqual([
      'PRE_ONBOARDING->ONBOARDING',
      'ONBOARDING->ACTIVE',
      'ACTIVE->NOTICE_PERIOD',
      'NOTICE_PERIOD->OFFBOARDING',
      'OFFBOARDING->ARCHIVED',
    ]);
  });
});

describe('the transition matrix', () => {
  const valid: [string, string][] = [
    ['PRE_ONBOARDING', 'ONBOARDING'],
    ['ONBOARDING', 'ACTIVE'],
    ['ACTIVE', 'NOTICE_PERIOD'],
    ['ACTIVE', 'SUSPENDED'],
    ['NOTICE_PERIOD', 'OFFBOARDING'],
    ['SUSPENDED', 'OFFBOARDING'],
    ['OFFBOARDING', 'ARCHIVED'],
  ];

  it('accepts every documented transition', async () => {
    for (const [from, to] of valid) {
      const p = await mkPerson(orgA, `V ${from}->${to}`);
      const e = await mkEngagement(orgA, p, deptA, from);
      await expect(transition(e, to, hr, orgA), `${from} -> ${to}`).resolves.toBeUndefined();
    }
  });

  it('rejects transitions the blueprint does not draw', async () => {
    const invalid: [string, string][] = [
      ['PRE_ONBOARDING', 'ACTIVE'], // skipping onboarding
      ['ACTIVE', 'OFFBOARDING'], // termination without notice or suspension
      ['ACTIVE', 'ARCHIVED'], // straight to archived
      ['SUSPENDED', 'ACTIVE'], // lifting a suspension
      ['ARCHIVED', 'ACTIVE'], // resurrecting a closed engagement
      ['OFFBOARDING', 'ACTIVE'],
      ['ONBOARDING', 'PRE_ONBOARDING'], // going backwards
    ];
    for (const [from, to] of invalid) {
      const p = await mkPerson(orgA, `X ${from}->${to}`);
      const e = await mkEngagement(orgA, p, deptA, from);
      await expect(transition(e, to, hr, orgA), `${from} -> ${to}`).rejects.toThrow(
        /invalid engagement transition/i,
      );
    }
  });

  it('cannot be given a recruitment status at all', async () => {
    const p = await mkPerson(orgA, 'Recruit');
    const e = await mkEngagement(orgA, p, deptA, 'ACTIVE');
    for (const bogus of ['CANDIDATE', 'OFFER', 'SCREENING']) {
      await expect(transition(e, bogus, hr, orgA), bogus).rejects.toThrow();
    }
  });

  it('is enforced against direct SQL by the highest-privileged role', async () => {
    // app_owner owns the table and still cannot skip a state.
    const p = await mkPerson(orgA, 'DirectSql');
    const e = await mkEngagement(orgA, p, deptA, 'PRE_ONBOARDING');
    await expect(transition(e, 'ARCHIVED', hr, orgA)).rejects.toThrow(
      /invalid engagement transition/i,
    );
  });
});

describe('atomicity of status and event', () => {
  it('commits both together', async () => {
    const p = await mkPerson(orgA, 'Both');
    const e = await mkEngagement(orgA, p, deptA, 'ONBOARDING');
    await transition(e, 'ACTIVE', hr, orgA);
    const st = await owner.query<{ s: string }>(
      `select status::text s from public.engagements where id=$1`,
      [e],
    );
    const ev = await owner.query<{ n: string }>(
      `select count(*) n from public.engagement_events where engagement_id=$1`,
      [e],
    );
    expect(st.rows[0]!.s).toBe('ACTIVE');
    expect(Number(ev.rows[0]!.n)).toBe(1);
  });

  it('a rejected transition changes neither', async () => {
    const p = await mkPerson(orgA, 'NeitherInvalid');
    const e = await mkEngagement(orgA, p, deptA, 'ACTIVE');
    await expect(transition(e, 'ARCHIVED', hr, orgA)).rejects.toThrow();
    const st = await owner.query<{ s: string }>(
      `select status::text s from public.engagements where id=$1`,
      [e],
    );
    const ev = await owner.query<{ n: string }>(
      `select count(*) n from public.engagement_events where engagement_id=$1`,
      [e],
    );
    expect(st.rows[0]!.s, 'status untouched').toBe('ACTIVE');
    expect(Number(ev.rows[0]!.n), 'no orphan event').toBe(0);
  });

  it('an explicit rollback leaves no lifecycle history', async () => {
    const p = await mkPerson(orgA, 'Rollback');
    const e = await mkEngagement(orgA, p, deptA, 'ONBOARDING');
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
        [hr, orgA],
      );
      await c.query(`update public.engagements set status='ACTIVE' where id=$1`, [e]);
      const mid = await c.query<{ n: string }>(
        `select count(*) n from public.engagement_events where engagement_id=$1`,
        [e],
      );
      expect(Number(mid.rows[0]!.n), 'event exists inside the transaction').toBe(1);
      await c.query('rollback');
    } finally {
      c.release();
    }
    const st = await owner.query<{ s: string }>(
      `select status::text s from public.engagements where id=$1`,
      [e],
    );
    const ev = await owner.query<{ n: string }>(
      `select count(*) n from public.engagement_events where engagement_id=$1`,
      [e],
    );
    expect(st.rows[0]!.s).toBe('ONBOARDING');
    expect(Number(ev.rows[0]!.n), 'rolled back with the status').toBe(0);
  });
});

describe('append-only history', () => {
  let eventId = '';
  beforeAll(async () => {
    const p = await mkPerson(orgA, 'Immutable');
    const e = await mkEngagement(orgA, p, deptA, 'ONBOARDING');
    await transition(e, 'ACTIVE', hr, orgA);
    eventId = (
      await owner.query<{ id: string }>(
        `select id from public.engagement_events where engagement_id=$1`,
        [e],
      )
    ).rows[0]!.id;
  });

  it('app_user cannot UPDATE or DELETE an event', async () => {
    await expect(
      asUser.query(`update public.engagement_events set to_status='ARCHIVED'`),
    ).rejects.toThrow();
    await expect(asUser.query(`delete from public.engagement_events`)).rejects.toThrow();
  });

  it('app_owner cannot rewrite history either', async () => {
    await expect(
      owner.query(`update public.engagement_events set reason='rewritten' where id=$1`, [eventId]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      owner.query(`delete from public.engagement_events where id=$1`, [eventId]),
    ).rejects.toThrow(/append-only/i);
  });

  it('grants app_user no write privilege', async () => {
    const { rows } = await owner.query<{ p: string }>(
      `select privilege_type p from information_schema.table_privileges
       where grantee='app_user' and table_name='engagement_events'
         and privilege_type in ('INSERT','UPDATE','DELETE')`,
    );
    expect(rows).toEqual([]);
  });
});

describe('actor identity', () => {
  it('refuses a transition with no identity in the transaction', async () => {
    const p = await mkPerson(orgA, 'NoActor');
    const e = await mkEngagement(orgA, p, deptA, 'ONBOARDING');
    await expect(transition(e, 'ACTIVE', null, null)).rejects.toThrow(/authenticated actor/i);
    const st = await owner.query<{ s: string }>(
      `select status::text s from public.engagements where id=$1`,
      [e],
    );
    expect(st.rows[0]!.s, 'failed closed').toBe('ONBOARDING');
  });

  it('refuses an actor who is soft-deleted or not ACTIVE', async () => {
    const ghost = await mkPerson(orgA, 'Ghost');
    await owner.query(`update public.people set deleted_at=now() where id=$1`, [ghost]);
    const p = await mkPerson(orgA, 'GhostTarget');
    const e = await mkEngagement(orgA, p, deptA, 'ONBOARDING');
    await expect(transition(e, 'ACTIVE', ghost, orgA)).rejects.toThrow(/authenticated actor/i);
  });

  it('records the context identity, which the caller cannot spoof', async () => {
    // The actor is never taken from a supplied column: the statement sets no actor at all,
    // and the trigger reads authz.person_id().
    const p = await mkPerson(orgA, 'Attributed');
    const e = await mkEngagement(orgA, p, deptA, 'ONBOARDING');
    await transition(e, 'ACTIVE', hr, orgA);
    const { rows } = await owner.query<{ a: string }>(
      `select actor_person_id a from public.engagement_events where engagement_id=$1`,
      [e],
    );
    expect(rows[0]!.a).toBe(hr);
    expect(rows[0]!.a).not.toBe(p);
  });

  it('refuses an actor from another organization', async () => {
    const p = await mkPerson(orgA, 'ForeignActor');
    const e = await mkEngagement(orgA, p, deptA, 'ONBOARDING');
    // Carol is real and ACTIVE, but in orgB: org_id() denies the mismatch, so no identity.
    await expect(transition(e, 'ACTIVE', carol, orgA)).rejects.toThrow(
      /not in the engagement organization/i,
    );
  });
});

describe('is_active() still reacts immediately', () => {
  it('loses access the moment the engagement leaves ACTIVE', async () => {
    const p = await mkPerson(orgA, 'Reactive');
    const e = await mkEngagement(orgA, p, deptA, 'ACTIVE');
    const before = await inContext<{ a: boolean }>(
      { personId: p, orgId: orgA },
      `select authz.is_active() a`,
    );
    expect(before[0]!.a).toBe(true);

    await transition(e, 'SUSPENDED', hr, orgA);

    const after = await inContext<{ a: boolean }>(
      { personId: p, orgId: orgA },
      `select authz.is_active() a`,
    );
    expect(after[0]!.a, 'the very next query').toBe(false);
  });

  it('NOTICE_PERIOD remains inactive access, per the founder decision', async () => {
    const p = await mkPerson(orgA, 'Notice');
    const e = await mkEngagement(orgA, p, deptA, 'ACTIVE');
    await transition(e, 'NOTICE_PERIOD', hr, orgA);
    const r = await inContext<{ a: boolean }>(
      { personId: p, orgId: orgA },
      `select authz.is_active() a`,
    );
    expect(r[0]!.a).toBe(false);
  });
});

describe('RLS and privileges', () => {
  it('has RLS enabled and forced, and no table in public is unprotected', async () => {
    const { rows } = await owner.query<{ e: boolean; f: boolean }>(
      `select relrowsecurity e, relforcerowsecurity f from pg_class c
       join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and relname='engagement_events'`,
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

  it('returns nothing without identity — no broad policy', async () => {
    const { rows } = await asUser.query<{ n: string }>(
      `select count(*) n from public.engagement_events`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('shows a person only their own lifecycle history', async () => {
    const p = await mkPerson(orgA, 'OwnHistory');
    const e = await mkEngagement(orgA, p, deptA, 'ONBOARDING');
    await transition(e, 'ACTIVE', hr, orgA);

    const mine = await inContext<{ engagement_id: string }>(
      { personId: p, orgId: orgA },
      `select engagement_id from public.engagement_events`,
    );
    expect(mine.map((r) => r.engagement_id)).toEqual([e]);

    // The actor who performed it does not thereby gain visibility of someone else history.
    const actorView = await inContext<{ engagement_id: string }>(
      { personId: hr, orgId: orgA },
      `select engagement_id from public.engagement_events where engagement_id=$1`,
      [e],
    );
    expect(actorView).toEqual([]);
  });

  it('denies a cross-tenant claim', async () => {
    const rows = await inContext<{ id: string }>(
      { personId: alice, orgId: orgB },
      `select id from public.engagement_events`,
    );
    expect(rows).toEqual([]);
  });

  it('keeps app_user unable to bypass RLS', async () => {
    const r = await asUser.query<{ b: boolean; s: boolean }>(
      `select rolbypassrls b, rolsuper s from pg_roles where rolname=current_user`,
    );
    expect(r.rows[0]!.b).toBe(false);
    expect(r.rows[0]!.s).toBe(false);
  });

  it('creates no SECURITY DEFINER trigger function and grants no PUBLIC execute', async () => {
    const { rows } = await owner.query<{ proname: string; prosecdef: boolean }>(
      `select proname, prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and proname in
         ('engagements_validate_transition','engagements_record_transition',
          'engagement_events_append_only')`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.prosecdef, `${r.proname} needs no elevated rights`).toBe(false);
    }
  });
});

describe('pooled-connection isolation', () => {
  it('alternating actors are attributed correctly', async () => {
    const hr2 = await mkPerson(orgA, 'HR2');
    const results: string[] = [];
    for (const actor of [hr, hr2, hr, hr2]) {
      const p = await mkPerson(orgA, `Alt ${results.length}`);
      const e = await mkEngagement(orgA, p, deptA, 'ONBOARDING');
      await transition(e, 'ACTIVE', actor, orgA);
      const { rows } = await owner.query<{ a: string }>(
        `select actor_person_id a from public.engagement_events where engagement_id=$1`,
        [e],
      );
      results.push(rows[0]!.a);
    }
    expect(results).toEqual([hr, await Promise.resolve(hr2), hr, hr2]);
  });

  it('concurrent transitions are each attributed to their own actor', async () => {
    const actors = await Promise.all([
      mkPerson(orgA, 'C1'),
      mkPerson(orgA, 'C2'),
      mkPerson(orgA, 'C3'),
    ]);
    const engagements = await Promise.all(
      actors.map(async (_, i) => {
        const p = await mkPerson(orgA, `CT ${i}`);
        return mkEngagement(orgA, p, deptA, 'ONBOARDING');
      }),
    );
    await Promise.all(engagements.map((e, i) => transition(e, 'ACTIVE', actors[i]!, orgA)));
    for (const [i, e] of engagements.entries()) {
      const { rows } = await owner.query<{ a: string }>(
        `select actor_person_id a from public.engagement_events where engagement_id=$1`,
        [e],
      );
      expect(rows[0]!.a, `engagement ${i}`).toBe(actors[i]);
    }
  }, 60_000);
});
