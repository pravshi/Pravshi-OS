import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Task 1.11 — audit event integration.
 *
 * Two properties carry this task. First, a change to an authority or identity table by a
 * named person is recorded whether or not anybody remembered to record it. Second, the same
 * trigger firing from a migration or a seed — where there is no person — skips silently
 * instead of taking organization creation down with it.
 *
 * Everything here is scoped to the rows this file creates. Audit entries are global, other
 * test files write them concurrently, and a test that counted them all would be measuring
 * the rest of the suite.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `T${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

const AUDITED = [
  'roles',
  'permissions',
  'role_permissions',
  'person_roles',
  'record_grants',
  'people',
  'engagements',
] as const;

// Phase 2 CRM Core (migration 0031): the first app_user-WRITABLE audited tables, so they
// cannot share AUDITED — the definer-chain test below asserts every AUDITED table is
// SELECT-only for app_user, which is false for these by design.
const AUDITED_CRM = ['companies', 'contacts', 'deals'] as const;
// Phase 2 Track B (migrations 0034/0035): the activity log and the relationship tables.
const AUDITED_TRACKB = [
  'activities',
  'company_contacts',
  'company_links',
  'contact_links',
] as const;
// Phase 3 (migration 0037): the sales-pipeline tables.
const AUDITED_PHASE3 = ['pipelines', 'pipeline_stages', 'deal_stage_history'] as const;
// Phase 4 (migrations 0042/0043): the work-management tables.
const AUDITED_PHASE4 = [
  'work_projects',
  'work_tasks',
  'project_members',
  'task_reminders',
] as const;
const AUDITED_ALL = [
  ...AUDITED,
  ...AUDITED_CRM,
  ...AUDITED_TRACKB,
  ...AUDITED_PHASE3,
  ...AUDITED_PHASE4,
] as const;

let orgA = '';
let orgB = '';
let deptA = '';
let deptB = '';
let actorA = ''; // orgA, ACTIVE, SUPER_ADMIN — can read audit entries
let subjectA = ''; // orgA, the person things are done TO
let actorB = ''; // orgB, ACTIVE, SUPER_ADMIN

type Ctx = { personId?: string | null; orgId?: string | null };

const mkPerson = async (org: string, name: string) => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people
         (org_id,code,full_legal_name,person_status,work_email,phone,date_of_birth)
       values ($1,$2,$3,'ACTIVE',$4,'+15550001','1990-01-01') returning id`,
      [org, code, name, `${code.toLowerCase()}-${RUN}@example.test`],
    )
  ).rows[0]!.id;
};

const mkEngagement = async (org: string, person: string, dept: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.engagements
         (org_id,person_id,department_id,engagement_type,status,start_date)
       values ($1,$2,$3,'EMPLOYEE','ACTIVE',current_date) returning id`,
      [org, person, dept],
    )
  ).rows[0]!.id;

const mkDept = async (org: string, code: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id,code,name) values ($1,$2,$3) returning id`,
      [org, code, `Dept ${code}`],
    )
  ).rows[0]!.id;

const roleId = async (org: string, key: string) =>
  (
    await owner.query<{ id: string }>(`select id from public.roles where org_id=$1 and key=$2`, [
      org,
      key,
    ])
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

/** The owner connection carrying an identity: the path a real mutation takes today. */
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

type Entry = {
  action: string;
  entity_type: string;
  entity_id: string | null;
  severity: string;
  result: string;
  actor_person_id: string | null;
  org_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

/** Entries about one specific record, newest last. */
const entriesFor = async (entityType: string, entityId: string) =>
  (
    await owner.query<Entry>(
      `select action, entity_type, entity_id, severity, result::text, actor_person_id, org_id,
              before, after
       from public.audit_logs
       where entity_type=$1 and entity_id=$2
       order by occurred_at`,
      [entityType, entityId],
    )
  ).rows;

beforeAll(async () => {
  const mkOrg = async (s: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name,slug) values ($1,$2) returning id`,
        [`Tr ${s}`, `tr-${RUN}-${s}`],
      )
    ).rows[0]!.id;
  [orgA, orgB] = await Promise.all([mkOrg('a'), mkOrg('b')]);
  [deptA, deptB] = await Promise.all([mkDept(orgA, `${CODE}_A`), mkDept(orgB, `${CODE}_B`)]);

  [actorA, subjectA, actorB] = await Promise.all([
    mkPerson(orgA, 'Actor A'),
    mkPerson(orgA, 'Subject A'),
    mkPerson(orgB, 'Actor B'),
  ]);

  await Promise.all([
    mkEngagement(orgA, actorA, deptA),
    mkEngagement(orgA, subjectA, deptA),
    mkEngagement(orgB, actorB, deptB),
  ]);

  // Genesis is open in both new organizations, so these land with no actor and no audit.
  await Promise.all([
    owner.query(`insert into public.person_roles (person_id,role_id,org_id) values ($1,$2,$3)`, [
      actorA,
      await roleId(orgA, 'SUPER_ADMIN'),
      orgA,
    ]),
    owner.query(`insert into public.person_roles (person_id,role_id,org_id) values ($1,$2,$3)`, [
      actorB,
      await roleId(orgB, 'SUPER_ADMIN'),
      orgB,
    ]),
  ]);
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

// ── the allow-list ───────────────────────────────────────────────────────────────

describe('the trigger allow-list', () => {
  it('attaches exactly one audit trigger to each of the twenty-one approved tables', async () => {
    const { rows } = await owner.query<{ relname: string; tgname: string; events: number }>(
      `select c.relname, t.tgname, t.tgtype events
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_proc p on p.oid = t.tgfoid
       where n.nspname='public' and not t.tgisinternal and p.proname='audit_row_change'
       order by c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual([...AUDITED_ALL].sort());
    for (const r of rows) {
      expect(r.tgname, r.relname).toBe(`${r.relname}_audit`);
      // AFTER (bit 1 clear), ROW (bit 0 set), INSERT|DELETE|UPDATE (bits 2,3,4)
      expect(r.events & 1, `${r.relname} is a row trigger`).toBe(1);
      expect(r.events & 2, `${r.relname} fires AFTER`).toBe(0);
      expect(r.events & 4, `${r.relname} covers INSERT`).toBe(4);
      expect(r.events & 8, `${r.relname} covers DELETE`).toBe(8);
      expect(r.events & 16, `${r.relname} covers UPDATE`).toBe(16);
    }
  });

  it('attaches no audit trigger to audit_logs, which would recurse', async () => {
    const { rows } = await owner.query(
      `select 1 from pg_trigger t
       join pg_class c on c.oid=t.tgrelid
       join pg_proc p on p.oid=t.tgfoid
       where c.relname like 'audit_logs%' and p.proname='audit_row_change'`,
    );
    expect(rows).toEqual([]);
  });

  it('attaches no audit trigger to engagement_events, which is already history', async () => {
    const { rows } = await owner.query(
      `select 1 from pg_trigger t
       join pg_class c on c.oid=t.tgrelid
       join pg_proc p on p.oid=t.tgfoid
       where c.relname='engagement_events' and p.proname='audit_row_change'`,
    );
    expect(rows).toEqual([]);
  });

  it('attaches audit triggers to nothing else at all', async () => {
    const { rows } = await owner.query<{ relname: string }>(
      `select distinct c.relname from pg_trigger t
       join pg_class c on c.oid=t.tgrelid
       join pg_namespace n on n.oid=c.relnamespace
       join pg_proc p on p.oid=t.tgfoid
       where n.nspname='public' and p.proname='audit_row_change'`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...AUDITED_ALL].sort());
  });

  it('leaves every audit trigger enabled', async () => {
    const { rows } = await owner.query<{ relname: string; tgenabled: string }>(
      `select c.relname, t.tgenabled from pg_trigger t
       join pg_class c on c.oid=t.tgrelid
       join pg_proc p on p.oid=t.tgfoid
       where p.proname='audit_row_change'`,
    );
    expect(rows.length).toBe(21);
    for (const r of rows) expect(r.tgenabled, r.relname).toBe('O');
  });
});

// ── it records what happened ─────────────────────────────────────────────────────

describe('recording a change', () => {
  it('records an INSERT, an UPDATE and a DELETE on an authority table', async () => {
    const ctx = { personId: actorA, orgId: orgA };
    const created = await asActor<{ id: string }>(
      ctx,
      `insert into public.roles (org_id,key,name) values ($1,$2,$3) returning id`,
      [orgA, `${CODE}_LIFE`, 'Lifecycle'],
    );
    const role = created[0]!.id;

    await asActor(ctx, `update public.roles set name=$1 where id=$2`, ['Renamed', role]);
    await asActor(ctx, `delete from public.roles where id=$1`, [role]);

    const entries = await entriesFor('role', role);
    expect(entries.map((e) => e.action)).toEqual(['role.created', 'role.updated', 'role.deleted']);
    for (const e of entries) {
      expect(e.entity_type).toBe('role');
      expect(e.entity_id).toBe(role);
      expect(e.severity).toBe('HIGH');
      expect(e.result).toBe('SUCCESS');
      expect(e.actor_person_id).toBe(actorA);
      expect(e.org_id).toBe(orgA);
    }
    // before/after are shaped as the operation implies
    expect(entries[0]!.before).toBeNull();
    expect(entries[0]!.after).toMatchObject({ id: role, key: `${CODE}_LIFE` });
    expect(entries[1]!.before).toMatchObject({ name: 'Lifecycle' });
    expect(entries[1]!.after).toMatchObject({ name: 'Renamed' });
    expect(entries[2]!.before).toMatchObject({ id: role });
    expect(entries[2]!.after).toBeNull();
  });

  it('names the subject of a composite-key change, not a row id it does not have', async () => {
    const ctx = { personId: actorA, orgId: orgA };
    const role = await roleId(orgA, 'DEVELOPER');

    await asActor(
      ctx,
      `insert into public.person_roles (person_id,role_id,org_id) values ($1,$2,$3)`,
      [subjectA, role, orgA],
    );
    // person_roles has no id column; the subject is the person
    const assigned = await entriesFor('person_role', subjectA);
    expect(assigned.length).toBeGreaterThan(0);
    const last = assigned[assigned.length - 1]!;
    expect(last.action).toBe('person_role.created');
    expect(last.after).toMatchObject({ person_id: subjectA, role_id: role });

    await asActor(ctx, `delete from public.person_roles where person_id=$1 and role_id=$2`, [
      subjectA,
      role,
    ]);
    const after = await entriesFor('person_role', subjectA);
    expect(after[after.length - 1]!.action).toBe('person_role.deleted');
  });

  it('names the role when its permissions change', async () => {
    const ctx = { personId: actorA, orgId: orgA };
    const role = await roleId(orgA, 'MARKETING');
    const permission = (
      await owner.query<{ id: string }>(`select id from public.permissions where key='teams.view'`)
    ).rows[0]!.id;

    await asActor(
      ctx,
      `insert into public.role_permissions (role_id,permission_id,scope) values ($1,$2,'GLOBAL')`,
      [role, permission],
    );
    const entries = await entriesFor('role_permission', role);
    const last = entries[entries.length - 1]!;
    expect(last.action).toBe('role_permission.created');
    expect(last.entity_id).toBe(role);
    expect(last.severity).toBe('HIGH');
    expect(last.after).toMatchObject({ role_id: role, permission_id: permission, scope: 'GLOBAL' });

    await asActor(
      ctx,
      `delete from public.role_permissions where role_id=$1 and permission_id=$2`,
      [role, permission],
    );
  });

  it('records an engagement status change at MEDIUM with the access-affecting fields', async () => {
    const ctx = { personId: actorA, orgId: orgA };
    const person = await mkPerson(orgA, 'Transitions');
    const engagement = (
      await asActor<{ id: string }>(
        ctx,
        `insert into public.engagements
           (org_id,person_id,department_id,engagement_type,status,start_date)
         values ($1,$2,$3,'EMPLOYEE','ACTIVE',current_date) returning id`,
        [orgA, person, deptA],
      )
    )[0]!.id;

    await asActor(ctx, `update public.engagements set status='SUSPENDED' where id=$1`, [
      engagement,
    ]);

    const entries = await entriesFor('engagement', engagement);
    expect(entries.map((e) => e.action)).toEqual(['engagement.created', 'engagement.updated']);
    const updated = entries[1]!;
    expect(updated.severity).toBe('MEDIUM');
    expect(updated.before).toMatchObject({ status: 'ACTIVE' });
    expect(updated.after).toMatchObject({ status: 'SUSPENDED', person_id: person });
  });

  it('records a record grant being issued and revoked', async () => {
    const ctx = { personId: actorA, orgId: orgA };
    const grant = (
      await asActor<{ id: string }>(
        ctx,
        `insert into public.record_grants
           (org_id, entity_type, entity_id, person_id, permission_id, granted_by)
         select $1,'lead',$2,$3,p.id,$4 from public.permissions p where p.key='leads.view'
         returning id`,
        [orgA, '33333333-3333-4333-8333-333333333333', subjectA, actorA],
      )
    )[0]!.id;

    await asActor(ctx, `update public.record_grants set revoked_at=now() where id=$1`, [grant]);

    const entries = await entriesFor('record_grant', grant);
    expect(entries.map((e) => e.action)).toEqual(['record_grant.created', 'record_grant.updated']);
    for (const e of entries) expect(e.severity).toBe('HIGH');
    expect(entries[1]!.after).toMatchObject({ person_id: subjectA });
  });
});

// ── the actor ────────────────────────────────────────────────────────────────────

describe('the actor', () => {
  it('cannot be forged, because no audited table carries a column that names one', async () => {
    // record_grants.granted_by is the closest thing to a caller-supplied actor anywhere in
    // the schema. The audit entry ignores it entirely and names the transaction identity.
    const ctx = { personId: actorA, orgId: orgA };
    const grant = (
      await asActor<{ id: string }>(
        ctx,
        `insert into public.record_grants
           (org_id, entity_type, entity_id, person_id, permission_id, granted_by)
         select $1,'lead',$2,$3,p.id,$4 from public.permissions p where p.key='leads.view'
         returning id`,
        [orgA, '44444444-4444-4444-8444-444444444444', subjectA, actorA],
      )
    )[0]!.id;
    const entries = await entriesFor('record_grant', grant);
    expect(entries[0]!.actor_person_id).toBe(actorA);
    expect(entries[0]!.after).toMatchObject({ granted_by: actorA, person_id: subjectA });
    // the entry names the ACTOR, and the subject only appears in the payload
    expect(entries[0]!.actor_person_id).not.toBe(subjectA);
  });

  it('is the acting identity even when the change is about somebody else', async () => {
    const ctx = { personId: actorA, orgId: orgA };
    await asActor(ctx, `update public.people set person_status='INACTIVE' where id=$1`, [subjectA]);
    const entries = await entriesFor('person', subjectA);
    const last = entries[entries.length - 1]!;
    expect(last.actor_person_id).toBe(actorA);
    expect(last.entity_id).toBe(subjectA);
    await asActor(ctx, `update public.people set person_status='ACTIVE' where id=$1`, [subjectA]);
  });

  it('records the tenant the change was made from, and keeps tenants apart', async () => {
    const ctxB = { personId: actorB, orgId: orgB };
    const role = (
      await asActor<{ id: string }>(
        ctxB,
        `insert into public.roles (org_id,key,name) values ($1,$2,$3) returning id`,
        [orgB, `${CODE}_B`, 'B Role'],
      )
    )[0]!.id;

    const entries = await entriesFor('role', role);
    expect(entries[0]!.org_id).toBe(orgB);
    expect(entries[0]!.actor_person_id).toBe(actorB);

    // and orgA's administrator cannot read it
    const seen = await inContext<{ id: string }>(
      { personId: actorA, orgId: orgA },
      `select entity_id id from public.audit_logs where entity_id=$1`,
      [role],
    );
    expect(seen).toEqual([]);

    // while orgB's can
    const theirs = await inContext<{ id: string }>(
      { personId: actorB, orgId: orgB },
      `select entity_id id from public.audit_logs where entity_id=$1`,
      [role],
    );
    expect(theirs.length).toBe(1);
  });
});

// ── no actor ─────────────────────────────────────────────────────────────────────

describe('when nobody is acting', () => {
  it('lets an organization be created, seeding roles and grants, without failing', async () => {
    const org = (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name,slug) values ($1,$2) returning id`,
        [`Tr seed ${RUN}`, `tr-${RUN}-seed`],
      )
    ).rows[0]!.id;

    const seeded = await owner.query<{ roles: string; grants: string }>(
      `select (select count(*) from public.roles where org_id=$1) roles,
              (select count(*) from public.role_permissions rp
                 join public.roles r on r.id=rp.role_id where r.org_id=$1) grants`,
      [org],
    );
    expect(Number(seeded.rows[0]!.roles)).toBe(14);
    expect(Number(seeded.rows[0]!.grants)).toBeGreaterThan(200);
  });

  it('writes no audit entry for any of those seeded rows', async () => {
    const org = (
      await owner.query<{ id: string }>(`select id from public.organizations where slug=$1`, [
        `tr-${RUN}-seed`,
      ])
    ).rows[0]!.id;

    const { rows } = await owner.query<{ n: string }>(
      `select count(*) n from public.audit_logs a
       where a.entity_id in (select id from public.roles where org_id=$1)`,
      [org],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('fabricates no actor: the entries simply do not exist', async () => {
    // Not "entries with a null or invented actor" — no entries at all. actor_person_id is
    // NOT NULL on audit_logs, so a fabricated identity is the only way one could appear.
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) n from public.audit_logs where actor_person_id is null`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('skips rather than failing when the identity names nobody real', async () => {
    const ghost = '00000000-0000-0000-0000-000000000000';
    const created = await asActor<{ id: string }>(
      { personId: ghost, orgId: orgA },
      `insert into public.roles (org_id,key,name) values ($1,$2,$3) returning id`,
      [orgA, `${CODE}_GHOST`, 'Ghost'],
    );
    // the write succeeded
    expect(created[0]!.id).toBeTruthy();
    // and produced nothing
    expect(await entriesFor('role', created[0]!.id)).toEqual([]);
  });
});

// ── payload discipline ───────────────────────────────────────────────────────────

describe('payload discipline', () => {
  it('keeps personal data out of a person entry', async () => {
    const ctx = { personId: actorA, orgId: orgA };
    const person = await mkPerson(orgA, 'Payload Subject');
    await asActor(ctx, `update public.people set person_status='INACTIVE' where id=$1`, [person]);

    const entries = await entriesFor('person', person);
    expect(entries.length).toBe(1); // the create was actor-less; only the update is recorded
    const keys = Object.keys(entries[0]!.after ?? {}).sort();
    expect(keys).toEqual([
      'auth_user_id',
      'code',
      'deleted_at',
      'id',
      'org_id',
      'person_status',
      'sessions_revoked_at',
      'updated_at',
    ]);
    for (const forbidden of [
      'full_legal_name',
      'preferred_name',
      'work_email',
      'personal_email',
      'phone',
      'date_of_birth',
      'photo_url',
      'location',
    ]) {
      expect(keys, `${forbidden} must never reach the audit log`).not.toContain(forbidden);
    }
  });

  it('keeps HR detail out of an engagement entry while keeping what decides access', async () => {
    const ctx = { personId: actorA, orgId: orgA };
    const person = await mkPerson(orgA, 'Engagement Payload');
    const engagement = (
      await asActor<{ id: string }>(
        ctx,
        `insert into public.engagements
           (org_id,person_id,department_id,engagement_type,status,start_date,job_title,exit_reason)
         values ($1,$2,$3,'EMPLOYEE','ACTIVE',current_date,'Secret Title','none') returning id`,
        [orgA, person, deptA],
      )
    )[0]!.id;

    const keys = Object.keys((await entriesFor('engagement', engagement))[0]!.after ?? {}).sort();
    expect(keys).toEqual([
      'deleted_at',
      'department_id',
      'engagement_type',
      'id',
      'is_primary',
      'manager_person_id',
      'org_id',
      'person_id',
      'status',
      'team_id',
      'updated_at',
    ]);
    for (const forbidden of ['job_title', 'exit_reason', 'work_location', 'start_date']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('captures authorization rows whole, because they hold no personal data', async () => {
    const ctx = { personId: actorA, orgId: orgA };
    const role = (
      await asActor<{ id: string }>(
        ctx,
        `insert into public.roles (org_id,key,name,description) values ($1,$2,$3,$4) returning id`,
        [orgA, `${CODE}_WHOLE`, 'Whole', 'captured entirely'],
      )
    )[0]!.id;
    const after = (await entriesFor('role', role))[0]!.after ?? {};
    for (const column of [
      'id',
      'org_id',
      'key',
      'name',
      'description',
      'is_system',
      'is_protected',
      'status',
      'created_at',
      'updated_at',
      'deleted_at',
    ]) {
      expect(Object.keys(after), column).toContain(column);
    }
  });

  it('still redacts credential keys, so the Task 1.10 backstop is intact', async () => {
    const id = (
      await asActor<{ id: string }>(
        { personId: actorA, orgId: orgA },
        `select public.write_audit_log(
           p_action := 'people.edit', p_entity_type := 'person',
           p_after := '{"password":"hunter2","token":"t","keep":"me"}'::jsonb) as id`,
      )
    )[0]!.id;
    const { rows } = await owner.query<{ after: Record<string, unknown> }>(
      `select after from public.audit_logs where id=$1`,
      [id],
    );
    expect(rows[0]!.after).toEqual({ keep: 'me' });
  });
});

// ── the guarantees that must survive ─────────────────────────────────────────────

describe('nothing already approved has moved', () => {
  it('keeps audit_logs append-only for every role', async () => {
    const ctx = { personId: actorA, orgId: orgA };
    const role = (
      await asActor<{ id: string }>(
        ctx,
        `insert into public.roles (org_id,key,name) values ($1,$2,$3) returning id`,
        [orgA, `${CODE}_APPEND`, 'Append'],
      )
    )[0]!.id;
    const entry = (await entriesFor('role', role))[0]!;
    expect(entry).toBeTruthy();

    // Either barrier is a pass. The privilege revoke is the first; the append-only trigger
    // is the second and the one that survives somebody re-granting the privilege. Task 1.10's
    // own suite does exactly that re-grant to prove the trigger, and vitest runs these files
    // in parallel against one database, so which barrier answers here is a race. What must
    // never happen is the statement succeeding.
    const refused = /permission denied|append-only/i;
    await expect(
      owner.query(`update public.audit_logs set severity='LOW' where entity_id=$1`, [role]),
    ).rejects.toThrow(refused);
    await expect(
      owner.query(`delete from public.audit_logs where entity_id=$1`, [role]),
    ).rejects.toThrow(refused);
    await expect(
      inContext(ctx, `delete from public.audit_logs where entity_id=$1`, [role]),
    ).rejects.toThrow(refused);

    // and the entry is still there afterwards
    expect((await entriesFor('role', role)).length).toBe(1);
  });

  it('gives the runtime role no way to switch auditing off', async () => {
    for (const table of AUDITED) {
      await expect(
        inContext(
          { personId: actorA, orgId: orgA },
          `alter table public.${table} disable trigger ${table}_audit`,
        ),
        table,
      ).rejects.toThrow(/must be owner|permission denied/i);
    }
  });

  it('keeps the 0010 protected-role trigger armed alongside the audit trigger', async () => {
    // They are separate rows in pg_trigger, so disabling one by name cannot reach the other.
    const { rows } = await owner.query<{ tgname: string; tgenabled: string }>(
      `select t.tgname, t.tgenabled from pg_trigger t
       join pg_class c on c.oid=t.tgrelid
       where c.relname='role_permissions' and not t.tgisinternal
       order by t.tgname`,
    );
    const byName = new Map(rows.map((r) => [r.tgname, r.tgenabled]));
    expect(byName.get('role_permissions_enforce_protection')).toBe('O');
    expect(byName.get('role_permissions_audit')).toBe('O');
  });

  it('still refuses an escalation, and does not audit what it refused', async () => {
    const superAdmin = await roleId(orgA, 'SUPER_ADMIN');
    const climber = await mkPerson(orgA, 'Climber');
    await mkEngagement(orgA, climber, deptA);

    await expect(
      asActor(
        { personId: climber, orgId: orgA },
        `insert into public.person_roles (person_id,role_id,org_id) values ($1,$2,$3)`,
        [climber, superAdmin, orgA],
      ),
    ).rejects.toThrow(/protected role requires roles.manage at GLOBAL/i);

    // The BEFORE trigger raised, so the AFTER audit trigger never ran and the whole
    // statement rolled back. A refused attempt is application-layer intent — a DENIED entry
    // written by requirePermission() in Task 1.15 — not something a row trigger can see.
    expect(await entriesFor('person_role', climber)).toEqual([]);
  });

  it('leaves has(), scope_for() and has_record_grant() untouched', async () => {
    const { rows } = await owner.query<{ proname: string; src: string }>(
      `select p.proname, pg_get_functiondef(p.oid) src from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' and p.proname in ('has','scope_for','has_record_grant')`,
    );
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.src, r.proname).not.toContain('audit');
  });

  it('adds no app_user policy and leaves every table protected', async () => {
    const policies = await owner.query<{ n: string }>(
      `select count(*) n from pg_policies
       where schemaname='public' and 'app_user' = any(roles)
         and tablename not like '\\_%'`,
    );
    // 51: the 22 pre-existing policies plus the 9 CRM policies (select/insert/update
    // × companies, contacts, deals) from the CRM core migration (0033), plus the
    // 12 Track B policies (select/insert/update × activities, company_contacts,
    // company_links, contact_links) from migrations 0034/0035, plus the 8 Phase 3
    // policies (select/insert/update × pipelines, pipeline_stages; select/insert ×
    // deal_stage_history) from migration 0037.
    expect(Number(policies.rows[0]!.n)).toBe(66);

    const unprotected = await owner.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind in ('r','p')
         and c.relname not like '\\_%' and c.relname <> '__drizzle_migrations'
         and (not c.relrowsecurity or not c.relforcerowsecurity)`,
    );
    expect(unprotected.rows).toEqual([]);
  });
});

// ── the definer chain ────────────────────────────────────────────────────────────

describe('writing without the privilege to write', () => {
  it('leaves the runtime role unable to mutate any audited table at all', async () => {
    // Worth stating as a property rather than a gap: today every audited table is
    // SELECT-only for app_user, so the trigger path is not reachable from the application
    // until Task 1.15 introduces a write path. The chain below is what will carry it.
    //
    // Both catalogues are consulted, because a grant can be narrower than a table: Task 1.16
    // replaced people's table-level SELECT with a column list, so people has no row in
    // table_privileges at all. The property under test is unchanged — no audited table grants
    // app_user anything but SELECT, by either route.
    const { rows } = await owner.query<{ table_name: string; privs: string }>(
      `with granted as (
         select table_name, privilege_type
           from information_schema.table_privileges
          where table_schema='public' and grantee='app_user' and table_name = any($1)
         union
         select table_name, privilege_type
           from information_schema.column_privileges
          where table_schema='public' and grantee='app_user' and table_name = any($1)
       )
       select table_name, string_agg(distinct privilege_type, ',' order by privilege_type) privs
       from granted group by table_name order by table_name`,
      [[...AUDITED]],
    );
    expect(rows.map((r) => r.table_name)).toEqual([...AUDITED].sort());
    for (const r of rows) expect(r.privs, r.table_name).toBe('SELECT');
  });

  it('lets a role with no INSERT on audit_logs still produce an entry', async () => {
    const privileges = await owner.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.table_privileges
       where table_schema='public' and grantee='app_user' and table_name='audit_logs'`,
    );
    expect(privileges.rows.map((r) => r.privilege_type)).toEqual(['SELECT']);

    // app_user, holding SELECT alone, writes through the SECURITY DEFINER chain the
    // triggers depend on.
    const id = (
      await inContext<{ id: string }>(
        { personId: actorA, orgId: orgA },
        `select public.write_audit_log(
           p_action := 'people.view', p_entity_type := 'person', p_entity_id := $1::uuid) as id`,
        [subjectA],
      )
    )[0]!.id;
    const { rows } = await owner.query<{ actor: string }>(
      `select actor_person_id actor from public.audit_logs where id=$1`,
      [id],
    );
    expect(rows[0]!.actor).toBe(actorA);
  });

  it('is SECURITY DEFINER, owned by app_owner, search_path pinned, off PUBLIC', async () => {
    const { rows } = await owner.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      owner: string;
      grantees: string[];
    }>(
      `select p.proname, p.prosecdef, p.proconfig, r.rolname owner,
              coalesce(array_agg(coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC'))
                       filter (where ac.privilege_type='EXECUTE'), '{}') grantees
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       join pg_roles r on r.oid=p.proowner
       left join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ac on true
       where n.nspname='public' and p.proname in ('audit_row_change','audit_payload')
       group by p.proname, p.prosecdef, p.proconfig, r.rolname order by p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['audit_payload', 'audit_row_change']);
    for (const r of rows) {
      expect(r.owner, r.proname).toBe('app_owner');
      expect(r.proconfig ?? [], r.proname).toContain('search_path=""');
      expect(r.grantees, `${r.proname} must not grant PUBLIC`).not.toContain('PUBLIC');
      expect(r.grantees, `${r.proname} must not be an app API`).not.toContain('app_user');
    }
    // the trigger function must see the truth about who is acting; the filter needs nothing
    expect(rows.find((r) => r.proname === 'audit_row_change')!.prosecdef).toBe(true);
    expect(rows.find((r) => r.proname === 'audit_payload')!.prosecdef).toBe(false);
  });

  it('uses no dynamic SQL and qualifies everything it reads', async () => {
    const { rows } = await owner.query<{ src: string }>(
      `select pg_get_functiondef(p.oid) src from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='audit_row_change'`,
    );
    const body = (rows[0]!.src.split('AS $function$')[1] ?? '')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    expect(body).not.toMatch(/\bexecute\b/i);
    const clauses = body.replace(/is\s+(not\s+)?distinct\s+from/gi, 'IS_DISTINCT');
    for (const t of clauses.match(/\b(from|join)\s+([a-z_.]+)/gi) ?? []) {
      expect(t, t).toMatch(/\s(public|authz)\./);
    }
  });
});

// ── pooled connections ───────────────────────────────────────────────────────────

describe('pooled connection isolation', () => {
  it('attributes interleaved changes to the right actor every time', async () => {
    const made: [string, string, string][] = [];
    for (let i = 0; i < 6; i++) {
      const [person, org] = i % 2 === 0 ? [actorA, orgA] : [actorB, orgB];
      const role = (
        await asActor<{ id: string }>(
          { personId: person, orgId: org },
          `insert into public.roles (org_id,key,name) values ($1,$2,$3) returning id`,
          [org, `${CODE}_P${i}`, `Pooled ${i}`],
        )
      )[0]!.id;
      made.push([role, person, org]);
    }
    for (const [role, person, org] of made) {
      const entries = await entriesFor('role', role);
      expect(entries.length).toBe(1);
      expect(entries[0]!.actor_person_id).toBe(person);
      expect(entries[0]!.org_id).toBe(org);
    }
  });

  it('keeps concurrent changes attributed correctly', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const [person, org] = i % 2 === 0 ? [actorA, orgA] : [actorB, orgB];
        const role = (
          await asActor<{ id: string }>(
            { personId: person, orgId: org },
            `insert into public.roles (org_id,key,name) values ($1,$2,$3) returning id`,
            [org, `${CODE}_C${i}`, `Concurrent ${i}`],
          )
        )[0]!.id;
        return [role, person] as const;
      }),
    );
    for (const [role, person] of results) {
      const entries = await entriesFor('role', role);
      expect(entries.length).toBe(1);
      expect(entries[0]!.actor_person_id).toBe(person);
    }
  });
});
