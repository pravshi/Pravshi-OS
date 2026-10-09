import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Task 1.10 — the audit log.
 *
 * The threat model here is inverted from every other table. Elsewhere the dangerous act is
 * reading a row you should not see; here it is REMOVING a row that says what you did. So
 * most of this file attacks the append-only guarantee — from app_user, from app_admin, from
 * app_owner, through the parent and through a partition directly, and with the privilege
 * temporarily granted back so the trigger has to be what stops it.
 *
 * The second theme is that the writer cannot be made to lie: actor and organization are not
 * parameters, and no caller can produce an entry naming somebody else.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `A${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

let orgA = '';
let orgB = '';
let deptA = '';
let deptB = '';

let superA = ''; // orgA, SUPER_ADMIN — holds audit_logs.view at GLOBAL
let adminA = ''; // orgA, ADMIN — also holds it at GLOBAL
let hrA = ''; // orgA, HR_ADMIN — deliberately does not
let empA = ''; // orgA, EMPLOYEE — deliberately does not
let suspendedA = ''; // orgA, SUPER_ADMIN but a SUSPENDED engagement
let deletedA = ''; // orgA, soft-deleted person
let superB = ''; // orgB, SUPER_ADMIN

type Ctx = { personId?: string | null; orgId?: string | null };

const mkPerson = async (org: string, name: string, status = 'ACTIVE') => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people (org_id,code,full_legal_name,person_status,work_email)
       values ($1,$2,$3,$4::public.person_status,$5) returning id`,
      [org, code, name, status, `${code.toLowerCase()}-${RUN}@example.test`],
    )
  ).rows[0]!.id;
};

const mkEngagement = (org: string, person: string, dept: string, status = 'ACTIVE') =>
  owner.query(
    `insert into public.engagements
       (org_id,person_id,department_id,engagement_type,status,start_date)
     values ($1,$2,$3,'EMPLOYEE',$4::public.engagement_status,current_date)`,
    [org, person, dept, status],
  );

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

const grantRole = (person: string, role: string, org: string) =>
  owner.query(`insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`, [
    person,
    role,
    org,
  ]);

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

/** Write through the only permitted path, as a named actor. */
const write = async (
  ctx: Ctx,
  opts: {
    action?: string;
    entityType?: string;
    result?: string;
    entityId?: string | null;
    severity?: string;
    before?: string | null;
    after?: string | null;
    metadata?: string | null;
    requestId?: string | null;
  } = {},
) =>
  (
    await asActor<{ id: string }>(
      ctx,
      `select public.write_audit_log(
         p_action := $1, p_entity_type := $2, p_result := $3::public.audit_result,
         p_entity_id := $4::uuid, p_severity := $5,
         p_before := $6::jsonb, p_after := $7::jsonb, p_metadata := $8::jsonb,
         p_request_id := $9::uuid) as id`,
      [
        opts.action ?? 'people.view',
        opts.entityType ?? 'person',
        opts.result ?? 'SUCCESS',
        opts.entityId ?? null,
        opts.severity ?? 'LOW',
        opts.before ?? null,
        opts.after ?? null,
        opts.metadata ?? '{}',
        opts.requestId ?? null,
      ],
    )
  )[0]!.id;

beforeAll(async () => {
  const mkOrg = async (s: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name,slug) values ($1,$2) returning id`,
        [`Au ${s}`, `au-${RUN}-${s}`],
      )
    ).rows[0]!.id;
  [orgA, orgB] = await Promise.all([mkOrg('a'), mkOrg('b')]);
  [deptA, deptB] = await Promise.all([mkDept(orgA, `${CODE}_A`), mkDept(orgB, `${CODE}_B`)]);

  [superA, adminA, hrA, empA, suspendedA, deletedA, superB] = await Promise.all([
    mkPerson(orgA, 'Super A'),
    mkPerson(orgA, 'Admin A'),
    mkPerson(orgA, 'HR A'),
    mkPerson(orgA, 'Employee A'),
    mkPerson(orgA, 'Suspended A'),
    mkPerson(orgA, 'Deleted A'),
    mkPerson(orgB, 'Super B'),
  ]);

  const [saRoleA, adRoleA, hrRoleA, empRoleA, saRoleB] = await Promise.all([
    roleId(orgA, 'SUPER_ADMIN'),
    roleId(orgA, 'ADMIN'),
    roleId(orgA, 'HR_ADMIN'),
    roleId(orgA, 'EMPLOYEE'),
    roleId(orgB, 'SUPER_ADMIN'),
  ]);

  await Promise.all([
    ...[superA, adminA, hrA, empA, deletedA].map((p) => mkEngagement(orgA, p, deptA)),
    mkEngagement(orgA, suspendedA, deptA, 'SUSPENDED'),
    mkEngagement(orgB, superB, deptB),
  ]);

  // Genesis is open in both brand-new organizations, so the first protected grant lands.
  await Promise.all([grantRole(superA, saRoleA, orgA), grantRole(superB, saRoleB, orgB)]);
  await Promise.all([
    grantRole(adminA, adRoleA, orgA),
    grantRole(hrA, hrRoleA, orgA),
    grantRole(empA, empRoleA, orgA),
  ]);
  // Genesis is now closed for orgA, so this goes through the holder.
  await asActor(
    { personId: superA, orgId: orgA },
    `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
    [suspendedA, saRoleA, orgA],
  );

  await owner.query(`update public.people set deleted_at=now() where id=$1`, [deletedA]);
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

// ── structure ────────────────────────────────────────────────────────────────────

describe('structure', () => {
  it('is a range-partitioned table keyed on occurred_at', async () => {
    const { rows } = await owner.query<{ relkind: string; strategy: string; col: string }>(
      `select c.relkind, pt.partstrat strategy, a.attname col
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_partitioned_table pt on pt.partrelid = c.oid
       join pg_attribute a on a.attrelid = c.oid and a.attnum = pt.partattrs[0]
       where n.nspname='public' and c.relname='audit_logs'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.relkind).toBe('p');
    expect(rows[0]!.strategy).toBe('r');
    expect(rows[0]!.col).toBe('occurred_at');
  });

  it('carries the partition key in the primary key, as Postgres requires', async () => {
    const { rows } = await owner.query<{ cols: string[] }>(
      `select array_agg(a.attname::text order by k.ord) cols
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       cross join lateral unnest(con.conkey) with ordinality as k(attnum, ord)
       join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
       where c.relname='audit_logs' and con.contype='p'`,
    );
    expect(rows[0]!.cols).toEqual(['id', 'occurred_at']);
  });

  it('pre-creates the current month plus twelve, contiguous and monthly', async () => {
    // The CI branch is one per PR ref and is reused across pushes, so migration
    // 0011 — which pre-creates the window — may have run in an earlier month.
    // Bring the window current before asserting the contract; the idempotency
    // test below then verifies the second run is a no-op.
    await owner.query(`select public.ensure_audit_log_partitions(12)`);
    const { rows } = await owner.query<{ relname: string; bounds: string }>(
      `select c.relname, pg_get_expr(c.relpartbound, c.oid) bounds
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
       join pg_inherits i on i.inhrelid = c.oid
       join pg_class p on p.oid = i.inhparent
       where n.nspname='public' and p.relname='audit_logs'
       order by c.relname`,
    );
    // The expected names come from the database's own clock, not the test runner's, so this
    // does not drift across a timezone boundary. The count is a floor rather than an exact
    // number: the maintenance test below legitimately extends the window, and partitions are
    // schema, so they outlive the transaction that created them.
    const expected = (
      await owner.query<{ name: string }>(
        `select 'audit_logs_' || to_char(date_trunc('month', now()) + make_interval(months => g),
                                         'YYYY_MM') name
         from generate_series(0, 12) g`,
      )
    ).rows.map((r) => r.name);
    const names = rows.map((r) => r.relname);
    expect(rows.length).toBeGreaterThanOrEqual(13);
    for (const name of expected) expect(names, name).toContain(name);
    for (const r of rows) {
      expect(r.relname, r.relname).toMatch(/^audit_logs_\d{4}_\d{2}$/);
      expect(r.bounds, r.relname).toMatch(/FOR VALUES FROM \('.+'\) TO \('.+'\)/);
    }
  });

  it('creates no DEFAULT partition', async () => {
    const { rows } = await owner.query(
      `select 1 from pg_class c
       join pg_inherits i on i.inhrelid = c.oid
       join pg_class p on p.oid = i.inhparent
       where p.relname='audit_logs' and pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'`,
    );
    expect(rows).toEqual([]);
  });

  it('has the database.md section 8 indexes plus the request correlation index', async () => {
    const { rows } = await owner.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname='public' and tablename='audit_logs'`,
    );
    const names = rows.map((r) => r.indexname);
    for (const idx of [
      'audit_logs_org_occurred_idx',
      'audit_logs_entity_idx',
      'audit_logs_actor_idx',
      'audit_logs_request_idx',
    ]) {
      expect(names, idx).toContain(idx);
    }
  });

  it('propagates those indexes onto every partition', async () => {
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) n from pg_indexes
       where schemaname='public' and tablename like 'audit_logs_2%'
         and indexname like '%occurred_at%'`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(13);
  });

  it('declares result as an enum and severity as a checked vocabulary', async () => {
    const enumLabels = await owner.query<{ labels: string[] }>(
      `select array_agg(e.enumlabel::text order by e.enumsortorder) labels
       from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='audit_result'`,
    );
    expect(enumLabels.rows[0]!.labels).toEqual(['SUCCESS', 'DENIED', 'ERROR']);

    const check = await owner.query<{ def: string }>(
      `select pg_get_constraintdef(oid) def from pg_constraint
       where conname='audit_logs_severity_valid'`,
    );
    for (const level of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) {
      expect(check.rows[0]!.def, level).toContain(level);
    }
  });

  it('has no soft delete and no mutable timestamps', async () => {
    const { rows } = await owner.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='audit_logs'`,
    );
    const cols = rows.map((r) => r.column_name);
    for (const absent of ['deleted_at', 'updated_at', 'created_at']) {
      expect(cols, `${absent} must not exist on an immutable table`).not.toContain(absent);
    }
    for (const present of [
      'id',
      'org_id',
      'occurred_at',
      'actor_person_id',
      'actor_email_snapshot',
      'actor_ip',
      'user_agent',
      'request_id',
      'action',
      'entity_type',
      'entity_id',
      'severity',
      'before',
      'after',
      'metadata',
      'result',
    ]) {
      expect(cols, present).toContain(present);
    }
  });
});

// ── the writer ───────────────────────────────────────────────────────────────────

describe('write_audit_log()', () => {
  it('writes an entry and returns its id', async () => {
    const id = await write({ personId: superA, orgId: orgA }, { action: 'people.view' });
    const { rows } = await owner.query<{ action: string; org_id: string; actor: string }>(
      `select action, org_id, actor_person_id actor from public.audit_logs where id=$1`,
      [id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe('people.view');
    expect(rows[0]!.org_id).toBe(orgA);
    expect(rows[0]!.actor).toBe(superA);
  });

  it('takes neither the actor nor the organization as a parameter', async () => {
    const { rows } = await owner.query<{ args: string }>(
      `select pg_get_function_arguments(p.oid) args from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='write_audit_log'`,
    );
    const args = rows[0]!.args;
    expect(args).not.toMatch(/actor_person_id|p_org|org_id|p_actor_person/);
    // the caller may describe the request, never who made it
    expect(args).toContain('p_action');
    expect(args).toContain('p_entity_type');
  });

  it('snapshots the actor email so the entry outlives the person record', async () => {
    const id = await write({ personId: adminA, orgId: orgA });
    const { rows } = await owner.query<{ snap: string | null }>(
      `select actor_email_snapshot snap from public.audit_logs where id=$1`,
      [id],
    );
    const email = await owner.query<{ e: string }>(
      `select work_email e from public.people where id=$1`,
      [adminA],
    );
    expect(rows[0]!.snap).toBe(email.rows[0]!.e);
  });

  it('routes the row into the partition its occurred_at belongs to', async () => {
    const id = await write({ personId: superA, orgId: orgA });
    const { rows } = await owner.query<{ partition: string; month: string }>(
      `select c.relname partition, to_char(a.occurred_at, 'YYYY_MM') as "month"
       from public.audit_logs a join pg_class c on c.oid = a.tableoid where a.id=$1`,
      [id],
    );
    expect(rows[0]!.partition).toBe(`audit_logs_${rows[0]!.month}`);
  });

  it('records a DENIED result as readily as a success', async () => {
    const id = await write(
      { personId: empA, orgId: orgA },
      { action: 'leads.view', result: 'DENIED', severity: 'HIGH' },
    );
    const { rows } = await owner.query<{ result: string; severity: string }>(
      `select result::text, severity from public.audit_logs where id=$1`,
      [id],
    );
    expect(rows[0]).toEqual({ result: 'DENIED', severity: 'HIGH' });
  });

  it('records a denial by somebody whose engagement is suspended', async () => {
    // The entry most worth having, and the one authz.person_id() would refuse to name.
    const gate = await inContext<{ active: boolean }>(
      { personId: suspendedA, orgId: orgA },
      `select authz.is_active() active`,
    );
    expect(gate[0]!.active).toBe(false);

    const id = await write(
      { personId: suspendedA, orgId: orgA },
      { action: 'people.export', result: 'DENIED', severity: 'CRITICAL' },
    );
    const { rows } = await owner.query<{ actor: string; result: string }>(
      `select actor_person_id actor, result::text from public.audit_logs where id=$1`,
      [id],
    );
    expect(rows[0]!.actor).toBe(suspendedA);
    expect(rows[0]!.result).toBe('DENIED');
  });

  it('records a denial by a soft-deleted person', async () => {
    const id = await write(
      { personId: deletedA, orgId: orgA },
      { action: 'documents.download', result: 'DENIED' },
    );
    const { rows } = await owner.query<{ actor: string }>(
      `select actor_person_id actor from public.audit_logs where id=$1`,
      [id],
    );
    expect(rows[0]!.actor).toBe(deletedA);
  });

  it('refuses to write with no identity, naming login_events instead of inventing one', async () => {
    await expect(write({ personId: null, orgId: null })).rejects.toThrow(/login_events/i);
    await expect(
      write({ personId: '00000000-0000-0000-0000-000000000000', orgId: orgA }),
    ).rejects.toThrow(/identified actor/i);
  });

  it('cannot be made to name an actor from another organization', async () => {
    // superB is a real person, but in orgB. The entry is written into orgB, derived from
    // the person — there is no parameter that could place it in orgA.
    const id = await write({ personId: superB, orgId: orgA }, { action: 'people.view' });
    const { rows } = await owner.query<{ org_id: string; actor: string }>(
      `select org_id, actor_person_id actor from public.audit_logs where id=$1`,
      [id],
    );
    expect(rows[0]!.org_id).toBe(orgB);
    expect(rows[0]!.actor).toBe(superB);
  });

  it('enforces the severity vocabulary and the action and entity formats', async () => {
    await expect(
      write({ personId: superA, orgId: orgA }, { severity: 'URGENT' }),
    ).rejects.toThrow();
    await expect(write({ personId: superA, orgId: orgA }, { severity: 'low' })).rejects.toThrow();
    await expect(
      write({ personId: superA, orgId: orgA }, { action: 'People.View' }),
    ).rejects.toThrow();
    await expect(
      write({ personId: superA, orgId: orgA }, { entityType: 'Person; drop table x' }),
    ).rejects.toThrow();
  });

  it('strips obvious credential keys from the payloads as a backstop', async () => {
    const id = await write(
      { personId: superA, orgId: orgA },
      {
        before: '{"password":"hunter2","name":"before"}',
        after: '{"password_hash":"x","token":"y","secret":"z","credential":"c","keep":"me"}',
        metadata: '{"token":"abc","request":"kept"}',
      },
    );
    const { rows } = await owner.query<{
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      metadata: Record<string, unknown>;
    }>(`select before, after, metadata from public.audit_logs where id=$1`, [id]);
    expect(rows[0]!.before).toEqual({ name: 'before' });
    expect(rows[0]!.after).toEqual({ keep: 'me' });
    expect(rows[0]!.metadata).toEqual({ request: 'kept' });
  });

  it('leaves a null or non-object payload alone rather than failing', async () => {
    const id = await write(
      { personId: superA, orgId: orgA },
      { before: null, after: '[1,2,3]', metadata: '{}' },
    );
    const { rows } = await owner.query<{ before: unknown; after: unknown; metadata: unknown }>(
      `select before, after, metadata from public.audit_logs where id=$1`,
      [id],
    );
    expect(rows[0]!.before).toBeNull();
    expect(rows[0]!.after).toEqual([1, 2, 3]);
    expect(rows[0]!.metadata).toEqual({});
  });

  it('orders entries written in one transaction, because occurred_at is clock_timestamp', async () => {
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.person_id',$1,true)`, [superA]);
      const ids: string[] = [];
      for (const action of ['people.view', 'people.edit', 'people.archive']) {
        const r = await c.query<{ id: string }>(
          `select public.write_audit_log(p_action := $1, p_entity_type := 'person') id`,
          [action],
        );
        ids.push(r.rows[0]!.id);
      }
      const seen = await c.query<{ action: string }>(
        `select action from public.audit_logs where id = any($1::uuid[]) order by occurred_at`,
        [ids],
      );
      expect(seen.rows.map((r) => r.action)).toEqual([
        'people.view',
        'people.edit',
        'people.archive',
      ]);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  });
});

// ── append-only ──────────────────────────────────────────────────────────────────

describe('append-only', () => {
  it('gives app_user no way to insert, update or delete', async () => {
    const id = await write({ personId: superA, orgId: orgA });
    const attempts: [string, string, unknown[]][] = [
      [
        'insert directly, bypassing the writer',
        `insert into public.audit_logs (org_id, action, entity_type, result)
         values ($1,'forged.entry','person','SUCCESS')`,
        [orgA],
      ],
      ['soften a severity', `update public.audit_logs set severity='LOW' where id=$1`, [id]],
      ['rewrite an action', `update public.audit_logs set action='people.view' where id=$1`, [id]],
      ['delete the evidence', `delete from public.audit_logs where id=$1`, [id]],
      ['delete everything', `delete from public.audit_logs`, []],
    ];
    const outcomes = await Promise.all(
      attempts.map(async ([label, sql, params]) => {
        try {
          await inContext({ personId: superA, orgId: orgA }, sql, params);
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

  it('gives app_owner no UPDATE or DELETE either', async () => {
    // Hermetic precondition: the trigger test below temporarily grants UPDATE/DELETE
    // on audit_logs to app_owner. If a CI run is ever interrupted between that grant
    // and its revoke on a reused database branch, the grant leaks into the next run
    // and this test would see the trigger error instead of the grant denial.
    // Re-establishing the revoke keeps the test asserting the schema, not the history.
    await owner.query(`revoke update, delete on public.audit_logs from app_owner`);
    const id = await write({ personId: superA, orgId: orgA });
    await expect(
      owner.query(`update public.audit_logs set severity='LOW' where id=$1`, [id]),
    ).rejects.toThrow(/permission denied/i);
    await expect(owner.query(`delete from public.audit_logs where id=$1`, [id])).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('is stopped by the TRIGGER even when the privilege is handed back', async () => {
    // The revoke is the first barrier. This proves the second one, which is the barrier that
    // survives somebody re-granting the privilege in a future migration.
    const id = await write({ personId: superA, orgId: orgA });
    await owner.query(`grant update, delete on public.audit_logs to app_owner`);
    try {
      await expect(
        owner.query(`update public.audit_logs set severity='LOW' where id=$1`, [id]),
      ).rejects.toThrow(/append-only/i);
      await expect(owner.query(`delete from public.audit_logs where id=$1`, [id])).rejects.toThrow(
        /append-only/i,
      );
    } finally {
      await owner.query(`revoke update, delete on public.audit_logs from app_owner`);
    }
    // and the row is still there
    const { rows } = await owner.query(`select 1 from public.audit_logs where id=$1`, [id]);
    expect(rows.length).toBe(1);
  });

  it('clones the append-only triggers onto every partition', async () => {
    const { rows } = await owner.query<{ relname: string; n: string }>(
      `select c.relname, count(*) n
       from pg_trigger t join pg_class c on c.oid=t.tgrelid
       join pg_namespace nsp on nsp.oid=c.relnamespace
       where nsp.nspname='public' and c.relname like 'audit_logs_2%' and not t.tgisinternal
       group by c.relname`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(13);
    for (const r of rows) expect(Number(r.n), r.relname).toBe(2);
  });

  it('cannot be circumvented by writing to a partition directly', async () => {
    const id = await write({ personId: superA, orgId: orgA });
    const partition = (
      await owner.query<{ p: string }>(
        `select c.relname p from public.audit_logs a join pg_class c on c.oid=a.tableoid
         where a.id=$1`,
        [id],
      )
    ).rows[0]!.p;

    // app_user has no privilege on a partition at all
    await expect(
      inContext({ personId: superA, orgId: orgA }, `select * from public.${partition}`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      inContext({ personId: superA, orgId: orgA }, `delete from public.${partition}`),
    ).rejects.toThrow(/permission denied/i);

    // and the owner is refused by the cloned trigger
    await owner.query(`grant update, delete on public.${partition} to app_owner`);
    try {
      await expect(
        owner.query(`delete from public.${partition} where id=$1`, [id]),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await owner.query(`revoke update, delete on public.${partition} from app_owner`);
    }
  });
});

// ── RLS ──────────────────────────────────────────────────────────────────────────

describe('RLS', () => {
  const visible = async (ctx: Ctx) =>
    inContext<{ id: string; org_id: string }>(ctx, `select id, org_id from public.audit_logs`);

  it('is enabled and forced on the parent and on every partition', async () => {
    const { rows } = await owner.query<{ relname: string; enabled: boolean; forced: boolean }>(
      `select c.relname, c.relrowsecurity enabled, c.relforcerowsecurity forced
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname like 'audit_logs%' and c.relkind in ('r','p')`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(14); // parent + at least 13 partitions
    for (const r of rows) {
      expect(r.enabled, r.relname).toBe(true);
      expect(r.forced, r.relname).toBe(true);
    }
  });

  it('lets a GLOBAL audit_logs.view holder read their organization', async () => {
    await write({ personId: superA, orgId: orgA }, { action: 'people.view' });
    for (const person of [superA, adminA]) {
      const scope = await inContext<{ s: string | null }>(
        { personId: person, orgId: orgA },
        `select authz.scope_for('audit_logs.view') s`,
      );
      expect(scope[0]!.s).toBe('GLOBAL');
      const rows = await visible({ personId: person, orgId: orgA });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.org_id === orgA)).toBe(true);
    }
  });

  it('shows nothing to HR or to an employee, who hold no audit_logs.view', async () => {
    for (const person of [hrA, empA]) {
      const scope = await inContext<{ s: string | null }>(
        { personId: person, orgId: orgA },
        `select authz.scope_for('audit_logs.view') s`,
      );
      expect(scope[0]!.s).toBeNull();
      expect(await visible({ personId: person, orgId: orgA })).toEqual([]);
    }
  });

  it('shows a person nothing of their own, because the matrix grants no SELF scope', async () => {
    const id = await write({ personId: empA, orgId: orgA }, { action: 'people.view' });
    const mine = await inContext<{ id: string }>(
      { personId: empA, orgId: orgA },
      `select id from public.audit_logs where id=$1`,
      [id],
    );
    expect(mine).toEqual([]);
  });

  it('returns nothing without an identity', async () => {
    expect(await visible({ personId: null, orgId: null })).toEqual([]);
    expect(await visible({ personId: null, orgId: orgA })).toEqual([]);
  });

  it('never crosses an organization boundary', async () => {
    await write({ personId: superB, orgId: orgB }, { action: 'people.view' });
    const seen = await visible({ personId: superB, orgId: orgB });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.org_id === orgB)).toBe(true);
    // a mismatched tenant claim denies rather than falling back
    expect(await visible({ personId: superB, orgId: orgA })).toEqual([]);
  });

  it('shows nothing to a SUPER_ADMIN whose engagement is not live', async () => {
    // suspendedA holds SUPER_ADMIN. Holding the role is not the same as being engaged.
    expect(await visible({ personId: suspendedA, orgId: orgA })).toEqual([]);
  });

  it('has exactly one app_user policy, and it is permission-driven', async () => {
    const { rows } = await owner.query<{ policyname: string; cmd: string; qual: string }>(
      `select policyname, cmd, qual from pg_policies
       where schemaname='public' and tablename='audit_logs' and 'app_user' = any(roles)`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.cmd).toBe('SELECT');
    expect(rows[0]!.qual).toContain('audit_logs.view');
    expect(rows[0]!.qual).toContain('scope_for');
    expect(rows[0]!.qual).toContain('is_active');
  });
});

// ── functions ────────────────────────────────────────────────────────────────────

describe('function properties', () => {
  it('writes as a SECURITY DEFINER, VOLATILE function pinned to an empty search_path', async () => {
    const { rows } = await owner.query<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
      owner: string;
    }>(
      `select p.prosecdef, p.provolatile, p.proconfig, r.rolname owner
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       join pg_roles r on r.oid=p.proowner
       where n.nspname='public' and p.proname='write_audit_log'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.prosecdef).toBe(true);
    expect(rows[0]!.provolatile).toBe('v'); // it writes
    expect(rows[0]!.proconfig ?? []).toContain('search_path=""');
    expect(rows[0]!.owner).toBe('app_owner');
  });

  it('grants the writer to the runtime roles and never to PUBLIC', async () => {
    const { rows } = await owner.query<{ grantee: string }>(
      `select coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC') grantee
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ac
       where n.nspname='public' and p.proname='write_audit_log' and ac.privilege_type='EXECUTE'`,
    );
    const grantees = rows.map((r) => r.grantee);
    expect(grantees).not.toContain('PUBLIC');
    expect(grantees).toContain('app_user');
    expect(grantees).toContain('app_admin');
  });

  it('keeps the partition maintenance function callable by nobody but its owner', async () => {
    const { rows } = await owner.query<{ grantee: string }>(
      `select coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC') grantee
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ac
       where n.nspname='public' and p.proname='ensure_audit_log_partitions'
         and ac.privilege_type='EXECUTE'`,
    );
    expect(rows.map((r) => r.grantee)).toEqual(['app_owner']);
    await expect(
      inContext({ personId: superA, orgId: orgA }, `select public.ensure_audit_log_partitions(1)`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('keeps the writer free of dynamic SQL and schema-qualified throughout', async () => {
    const { rows } = await owner.query<{ src: string }>(
      `select pg_get_functiondef(p.oid) src from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='write_audit_log'`,
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

  it('confines dynamic SQL to the DDL routine and the soft-delete helper, where it is unavoidable', async () => {
    const { rows } = await owner.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname in ('public','authz') and p.prosecdef
         and pg_get_functiondef(p.oid) ~* '(^|[^a-z_])execute[[:space:]]+format'
       order by p.proname`,
    );
    // ensure_audit_log_partitions builds partition DDL; crm_soft_delete (0034) builds one
    // UPDATE per call, but the table name comes from a hardcoded CASE allow-list and is
    // interpolated with %I — no caller-controlled identifier ever reaches the SQL.
    expect(rows.map((r) => r.proname)).toEqual(['crm_soft_delete', 'ensure_audit_log_partitions']);
  });
});

// ── partition maintenance ────────────────────────────────────────────────────────

describe('partition maintenance', () => {
  it('is idempotent: a second run creates nothing', async () => {
    const { rows } = await owner.query<{ created: number }>(
      `select public.ensure_audit_log_partitions(12) created`,
    );
    expect(rows[0]!.created).toBe(0);
  });

  it('extends the window, and each new partition arrives protected', async () => {
    // Written to be re-runnable: partitions are schema and survive the suite, so the
    // assertion is that the window REACHES month 14 afterwards and that a repeat call is a
    // no-op — not that this particular call created a particular number.
    await owner.query(`select public.ensure_audit_log_partitions(14)`);
    const again = await owner.query<{ created: number }>(
      `select public.ensure_audit_log_partitions(14) created`,
    );
    expect(again.rows[0]!.created).toBe(0);

    const expected = (
      await owner.query<{ name: string }>(
        `select 'audit_logs_' || to_char(date_trunc('month', now()) + make_interval(months => g),
                                         'YYYY_MM') name
         from generate_series(13, 14) g`,
      )
    ).rows.map((r) => r.name);

    const after = await owner.query<{
      relname: string;
      enabled: boolean;
      forced: boolean;
      grants: string | null;
    }>(
      `select c.relname, c.relrowsecurity enabled, c.relforcerowsecurity forced,
              (select string_agg(distinct grantee, ',') from information_schema.table_privileges
               where table_schema='public' and table_name=c.relname
                 and grantee in ('app_user','app_admin')) grants
       from pg_class c join pg_inherits i on i.inhrelid=c.oid
       join pg_class p on p.oid=i.inhparent
       join pg_namespace n on n.oid=c.relnamespace
       where p.relname='audit_logs' and n.nspname='public'`,
    );
    const names = after.rows.map((r) => r.relname);
    for (const name of expected) expect(names, name).toContain(name);
    for (const r of after.rows) {
      expect(r.enabled, r.relname).toBe(true);
      expect(r.forced, r.relname).toBe(true);
      expect(r.grants, `${r.relname} must grant the runtime roles nothing`).toBeNull();
    }
  });

  it('refuses an absurd window rather than creating a decade of tables', async () => {
    await expect(owner.query(`select public.ensure_audit_log_partitions(-1)`)).rejects.toThrow();
    await expect(owner.query(`select public.ensure_audit_log_partitions(121)`)).rejects.toThrow();
  });

  it('fails loudly when a write falls outside the window, rather than silently misfiling it', async () => {
    // This is the whole reason there is no DEFAULT partition.
    await expect(
      owner.query(
        `insert into public.audit_logs (org_id, occurred_at, action, entity_type, result)
         values ($1, now() + interval '20 years', 'x.y', 'thing', 'SUCCESS')`,
        [orgA],
      ),
    ).rejects.toThrow(/no partition of relation/i);
  });
});

// ── nothing already approved has moved ───────────────────────────────────────────

describe('the rest of the model is untouched', () => {
  it('leaves has(), scope_for() and has_record_grant() exactly as they were', async () => {
    const { rows } = await owner.query<{ proname: string; src: string }>(
      `select p.proname, pg_get_functiondef(p.oid) src from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' and p.proname in ('has','scope_for','has_record_grant')`,
    );
    expect(rows.length).toBe(3);
    const byName = new Map(rows.map((r) => [r.proname, r.src]));
    expect(byName.get('has')).toContain('authz.scope_for(p_permission) is not null');
    expect(byName.get('scope_for')).toContain('min(rp.scope)');
    expect(byName.get('has_record_grant')).toContain('rg.revoked_at is null');
    for (const src of byName.values()) expect(src).not.toContain('audit_logs');
  });

  it('adds one app_user policy and weakens none', async () => {
    const { rows } = await owner.query<{ n: string; with_scope: string }>(
      `select count(*) n, count(*) filter (where qual like '%scope_for%') with_scope
       from pg_policies
       where schemaname='public' and 'app_user' = any(roles)
         and tablename not like '\\_%'`,
    );
    // Fourteen through Task 1.9, plus audit_logs — the first one driven by a permission.
    // Task 1.16 replaced three more in place, so the count holds and four branch on scope.
    // Migrations 0018/0022 added four more scope-driven policies for the invitation
    // flow (invitations, invitation_roles, login_events, departments inviter view).
    // The self-service migration (0029) adds one more: login_events_select_self.
    // The CRM migration (0033) adds nine: select/insert/update on each of companies,
    // contacts, and deals — six of them scope-driven (the select and update policies
    // branch on scope_for for view/edit), so with_scope rises from eight to fourteen.
    // The Track B migrations add twelve more: select/insert/update on activities
    // (0034) and on company_contacts, company_links and contact_links (0035) — eight
    // of them scope-driven (select/update branch on scope_for for view/edit), so
    // with_scope rises from fourteen to twenty-two.
    // The Phase 3 migration (0037) adds eight more app_user policies — select/insert/
    // update on pipelines and pipeline_stages, select/insert on deal_stage_history —
    // none of them scope-driven, so with_scope stays at twenty-two.
    // The Phase 5 migration (0044) adds five more app_user policies — select/insert/
    // update on workflows, select on workflow_executions, select on
    // workflow_execution_steps — none of them scope-driven (they branch on
    // authz.has, not scope_for), so with_scope stays at twenty-two.
    // The Phase 6 automation migrations (0045/0047) add nine more app_user policies —
    // select/insert/update on each of jobs, schedules, and notifications — none of
    // them scope-driven, so with_scope stays at twenty-two.
    // The Phase 8 migration (0052) adds three more app_user policies —
    // select/insert/update on notification_preferences — none of them
    // scope-driven, so with_scope stays at twenty-two.
    // The Phase 9 migration (0054) adds six more app_user policies —
    // select/insert/update on each of ai_usage_requests and ai_org_limits —
    // none of them scope-driven, so with_scope stays at twenty-two.
    // The Phase 10 migration (0056) adds sixteen more app_user policies —
    // select/insert/update/delete on each of integration_connections and
    // integration_webhook_subscriptions, select/insert on
    // integration_webhook_deliveries, select/insert/update on each of
    // integration_inbound_events and integration_sync_checkpoints —
    // none of them scope-driven, so with_scope stays at twenty-two.
    expect(Number(rows[0]!.n)).toBe(105);
    expect(Number(rows[0]!.with_scope)).toBe(22);
  });

  it('leaves every table in public RLS-enabled and forced', async () => {
    const { rows } = await owner.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind in ('r','p')
         and c.relname not like '\\_%' and c.relname <> '__drizzle_migrations'
         and (not c.relrowsecurity or not c.relforcerowsecurity)`,
    );
    expect(rows).toEqual([]);
  });

  it('adds no authz helper and no stub', async () => {
    const { rows } = await owner.query<{ proname: string }>(
      `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' order by proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      'aal',
      'audit_two_factor_change',
      'check_login_lockout',
      'check_rate_limit',
      'clear_login_lockout',
      'consume_password_reset',
      'crm_owner_reachable',
      'has',
      'has_record_grant',
      'in_my_departments',
      'is_active',
      'is_active_person',
      'login_person_active',
      'mfa_enrollment_required',
      'my_departments',
      'next_identity_code',
      'org_id',
      'person_id',
      'record_login_failure',
      'record_password_reset_audit',
      'reports_to_me',
      'request_password_reset',
      'scope_for',
      'stamp_sessions_revoked',
      'update_credential_password',
    ]);
  });

  it('is written to by exactly the Task 1.11 trigger allow-list plus the CRM tables, and by nothing else', async () => {
    // Task 1.10 asserted this set was EMPTY, because blueprint 19.3's trigger source was a
    // separate task and starting it early would have gone unnoticed. Task 1.11 filled it,
    // and the assertion inverts rather than disappears: the set is now closed at seven.
    // The CRM migration (0033) adds its three tables, closing the set at ten. The Track B
    // migrations add four more — activities (0034) and company_contacts, company_links,
    // contact_links (0035) — closing the set at fourteen. The Phase 3 sales-pipeline
    // migration (0037) adds pipelines, pipeline_stages and deal_stage_history —
    // closing the set at seventeen. The Phase 5 workflow-engine migration (0044)
    // adds workflows and workflow_executions — closing the set at twenty-three.
    // (workflow_execution_steps carry no audit trigger by design.)
    // Matched on the trigger FUNCTION, not the trigger name: audit_logs and its partitions
    // carry append-only triggers whose names also contain "audit", and they are a different
    // mechanism entirely.
    const { rows } = await owner.query<{ relname: string }>(
      `select distinct c.relname from pg_trigger t
       join pg_class c on c.oid=t.tgrelid
       join pg_namespace n on n.oid=c.relnamespace
       join pg_proc p on p.oid=t.tgfoid
       where n.nspname='public' and not t.tgisinternal and p.proname='audit_row_change'
       order by 1`,
    );
    expect(rows.map((r) => r.relname)).toEqual([
      'activities',
      'companies',
      'company_contacts',
      'company_links',
      'contact_links',
      'contacts',
      'deal_stage_history',
      'deals',
      'engagements',
      'people',
      'permissions',
      'person_roles',
      'pipeline_stages',
      'pipelines',
      'project_members',
      'record_grants',
      'role_permissions',
      'roles',
      'task_reminders',
      'work_projects',
      'work_tasks',
      'workflow_executions',
      'workflows',
    ]);
    // and never on audit_logs itself, which would recurse
    expect(rows.map((r) => r.relname)).not.toContain('audit_logs');
  });
});

// ── pooled connections ───────────────────────────────────────────────────────────

describe('pooled connection isolation', () => {
  it('never lets alternating identities inherit each other visibility', async () => {
    for (let i = 0; i < 6; i++) {
      const seen = await inContext<{ id: string }>(
        { personId: superA, orgId: orgA },
        `select id from public.audit_logs limit 1`,
      );
      expect(seen.length).toBe(1);
      const blind = await inContext(
        { personId: empA, orgId: orgA },
        `select id from public.audit_logs limit 1`,
      );
      expect(blind).toEqual([]);
    }
  });

  it('leaves no visibility behind on a reused connection', async () => {
    const c = await asUser.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
        [superA, orgA],
      );
      const inside = await c.query(`select id from public.audit_logs limit 1`);
      expect(inside.rows.length).toBe(1);
      await c.query('commit');

      const after = await c.query(`select id from public.audit_logs`);
      expect(after.rows).toEqual([]);
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  });

  it('keeps twelve interleaved reads isolated', async () => {
    const cases: [string, string, boolean][] = [
      [superA, orgA, true],
      [empA, orgA, false],
      [superB, orgB, true],
      [adminA, orgA, true],
      [hrA, orgA, false],
      [suspendedA, orgA, false],
    ];
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const [person, org] = cases[i % cases.length]!;
        return inContext<{ n: string }>(
          { personId: person, orgId: org },
          `select count(*) n from public.audit_logs`,
        );
      }),
    );
    results.forEach((r, i) => {
      const [, , canSee] = cases[i % cases.length]!;
      expect(Number(r[0]!.n) > 0, `row ${i}`).toBe(canSee);
    });
  });
});
