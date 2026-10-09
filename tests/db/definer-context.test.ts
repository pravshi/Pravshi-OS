/**
 * Phase 11, Wave A (§4.1) — SECURITY DEFINER context assertions.
 *
 * Migration 0061 brings the two 0054 AI definers up to the 0044 gold
 * standard: a definer that accepts an org/person id asserts it against the
 * transaction context and raises 42501 on mismatch.
 *   - ai_effective_limits(org): org assertion; a context-free call refuses.
 *   - ai_usage_counters(org, person): org assertion; the named person must
 *     be the caller unless the caller holds ai.usage.view (the admin read).
 *   - notification_channel_enabled: org assertion (its only caller runs
 *     under the creator's real-person context).
 *
 * F-11-02 (resolved in 0061 PART 3A): notifications_insert /
 * notifications_recipient_exists are asserted BY CONTEXT KIND. Under a
 * person context the claimed org must equal authz.org_id() (the 0044
 * idiom). On the person-less worker plane — their only caller is the job
 * handler running as the system actor, for whom authz.org_id() is NULL by
 * construction — the claimed org must equal the app.org_id claim that
 * buildJobAuthorization binds from the job row. The worker-shaped cases
 * below pin both halves: the worker plane keeps working with its claim,
 * and a mismatched or absent claim refuses 42501.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random()
  .toString(36)
  .slice(2, 8)
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, 'X');

/** The worker plane's person identity (src/lib/jobs/worker.ts). */
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';

type Ctx = { personId: string; orgId: string };

async function inCtx<T extends Record<string, unknown> = Record<string, unknown>>(
  ctx: Ctx,
  text: string,
  params: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  const client = await asUser.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('app.person_id', $1, true),
              set_config('app.org_id', $2, true),
              set_config('app.aal', 'aal1', true)`,
      [ctx.personId, ctx.orgId],
    );
    const result = await client.query<T>(text, params);
    await client.query('commit');
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function sqlstateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'SUCCEEDED';
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? 'UNKNOWN';
  }
}

describe.skipIf(!HAS_DB)('definer context assertions (Phase 11 §4.1)', () => {
  let orgA = '';
  let orgB = '';
  let admA = ''; // orgA, ai.usage.view holder
  let empA = ''; // orgA, ai.use only
  let otherA = ''; // orgA, no roles — a person to name in counters calls
  let empB = ''; // orgB, ai.use only

  const admCtx = (): Ctx => ({ personId: admA, orgId: orgA });
  const empCtx = (): Ctx => ({ personId: empA, orgId: orgA });
  const noCtx = (): Ctx => ({ personId: '', orgId: '' });
  const workerCtx = (): Ctx => ({ personId: SYSTEM_ACTOR, orgId: orgA });

  beforeAll(async () => {
    const fixtures = await import('../authz/fixtures');
    orgA = await fixtures.mkOrg(owner, `p11dc-a-${RUN.toLowerCase()}`);
    orgB = await fixtures.mkOrg(owner, `p11dc-b-${RUN.toLowerCase()}`);
    const deptA = await fixtures.mkDept(owner, orgA, `DCA${RUN}`);
    const deptB = await fixtures.mkDept(owner, orgB, `DCB${RUN}`);

    admA = await fixtures.mkPerson(owner, orgA, 'Definer Admin A');
    empA = await fixtures.mkPerson(owner, orgA, 'Definer Employee A');
    otherA = await fixtures.mkPerson(owner, orgA, 'Definer Other A');
    empB = await fixtures.mkPerson(owner, orgB, 'Definer Employee B');
    for (const [org, person, dept] of [
      [orgA, admA, deptA],
      [orgA, empA, deptA],
      [orgA, otherA, deptA],
      [orgB, empB, deptB],
    ] as const) {
      await fixtures.mkEngagement(owner, org, person, dept);
    }
    const adminRole = await fixtures.mkCustomRole(owner, orgA, `P11DCADM${RUN}`, [
      ['ai.use', 'GLOBAL'],
      ['ai.usage.view', 'GLOBAL'],
      ['ai.usage.manage', 'GLOBAL'],
    ]);
    await fixtures.assignRoleId(owner, admA, orgA, adminRole);
    const empRole = await fixtures.mkCustomRole(owner, orgA, `P11DCEMP${RUN}`, [
      ['ai.use', 'GLOBAL'],
    ]);
    await fixtures.assignRoleId(owner, empA, orgA, empRole);
    const empRoleB = await fixtures.mkCustomRole(owner, orgB, `P11DCEMP${RUN}`, [
      ['ai.use', 'GLOBAL'],
    ]);
    await fixtures.assignRoleId(owner, empB, orgB, empRoleB);

    // orgA has a stored limits row with one distinctive override.
    await owner.query(
      `insert into public.ai_org_limits (org_id, enabled, monthly_request_limit)
       values ($1, true, 777)`,
      [orgA],
    );
    // Two SUCCEEDED usage rows for empA this month (fresh org: exact counts).
    for (const tokens of [30, 12]) {
      await owner.query(
        `insert into public.ai_usage_requests
           (org_id, person_id, request_id, capability, provider, model, status, total_tokens)
         values ($1, $2, $3, 'deal_summary', 'mock', 'mock-1', 'SUCCEEDED', $4)`,
        [orgA, empA, randomUUID(), tokens],
      );
    }
    // A wildcard preference: empA muted the email channel.
    await owner.query(
      `insert into public.notification_preferences (org_id, person_id, event_type, channel, enabled)
       values ($1, $2, '*', 'email', false)`,
      [orgA, empA],
    );
  });

  afterAll(async () => {
    await owner.end();
    await asUser.end();
  });

  it('ai_effective_limits returns the caller-org row, defaults merged', async () => {
    const { rows } = await inCtx<{ monthly_request_limit: number }>(
      empCtx(),
      `select monthly_request_limit from public.ai_effective_limits($1::uuid)`,
      [orgA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.monthly_request_limit).toBe(777);
  });

  it('ai_effective_limits refuses a foreign org with 42501', async () => {
    const code = await sqlstateOf(
      inCtx(empCtx(), `select * from public.ai_effective_limits($1::uuid)`, [orgB]),
    );
    expect(code).toBe('42501');
  });

  it('ai_effective_limits refuses a context-free call (fail closed)', async () => {
    const code = await sqlstateOf(
      inCtx(noCtx(), `select * from public.ai_effective_limits($1::uuid)`, [orgA]),
    );
    expect(code).toBe('42501');
  });

  it('ai_usage_counters returns the caller’s own counters', async () => {
    const { rows } = await inCtx<{ month_requests: number; month_tokens: number }>(
      empCtx(),
      `select month_requests::int as month_requests, month_tokens::int as month_tokens
         from public.ai_usage_counters($1::uuid, $2::uuid)`,
      [orgA, empA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.month_requests).toBe(2);
    expect(rows[0]!.month_tokens).toBe(42);
  });

  it('ai_usage_counters refuses a foreign org with 42501', async () => {
    const code = await sqlstateOf(
      inCtx(empCtx(), `select * from public.ai_usage_counters($1::uuid, $2::uuid)`, [orgB, empB]),
    );
    expect(code).toBe('42501');
  });

  it('ai_usage_counters refuses naming another person without ai.usage.view', async () => {
    const code = await sqlstateOf(
      inCtx(empCtx(), `select * from public.ai_usage_counters($1::uuid, $2::uuid)`, [orgA, otherA]),
    );
    expect(code).toBe('42501');
  });

  it('ai_usage_counters admits the ai.usage.view holder naming another person in-org', async () => {
    const { rows } = await inCtx<{ month_requests: number }>(
      admCtx(),
      `select month_requests::int as month_requests
         from public.ai_usage_counters($1::uuid, $2::uuid)`,
      [orgA, empA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.month_requests).toBe(2);
  });

  it('ai_usage_counters still binds the ai.usage.view holder to its own org', async () => {
    const code = await sqlstateOf(
      inCtx(admCtx(), `select * from public.ai_usage_counters($1::uuid, $2::uuid)`, [orgB, empB]),
    );
    expect(code).toBe('42501');
  });

  it('notification_channel_enabled answers under the creator’s own org', async () => {
    const muted = await inCtx<{ enabled: boolean }>(
      admCtx(),
      `select public.notification_channel_enabled($1::uuid, $2::uuid, 'TASK_DUE', 'email') as enabled`,
      [orgA, empA],
    );
    expect(muted.rows[0]!.enabled).toBe(false);
    const open = await inCtx<{ enabled: boolean }>(
      admCtx(),
      `select public.notification_channel_enabled($1::uuid, $2::uuid, 'TASK_DUE', 'in_app') as enabled`,
      [orgA, empA],
    );
    expect(open.rows[0]!.enabled).toBe(true);
  });

  it('notification_channel_enabled refuses a foreign org with 42501', async () => {
    const code = await sqlstateOf(
      inCtx(
        admCtx(),
        `select public.notification_channel_enabled($1::uuid, $2::uuid, 'TASK_DUE', 'email')`,
        [orgB, empB],
      ),
    );
    expect(code).toBe('42501');
  });

  it('worker plane preserved: recipient_exists answers under the system actor', async () => {
    const yes = await inCtx<{ recipient_exists: boolean }>(
      workerCtx(),
      `select public.notifications_recipient_exists($1::uuid, $2::uuid) as recipient_exists`,
      [orgA, empA],
    );
    expect(yes.rows[0]!.recipient_exists).toBe(true);
    const foreign = await inCtx<{ recipient_exists: boolean }>(
      workerCtx(),
      `select public.notifications_recipient_exists($1::uuid, $2::uuid) as recipient_exists`,
      [orgA, empB],
    );
    expect(foreign.rows[0]!.recipient_exists).toBe(false);
  });

  it('worker plane preserved: notifications_insert writes under the system actor', async () => {
    const { rows } = await inCtx<{ id: string }>(
      workerCtx(),
      `select public.notifications_insert($1::uuid, $2::uuid, 'Phase 11 probe', 'worker-plane write', '{}'::jsonb) as id`,
      [orgA, empA],
    );
    const id = rows[0]!.id;
    expect(id).toBeTruthy();
    const stored = await owner.query<{ org_id: string; person_id: string }>(
      `select org_id, person_id from public.notifications where id = $1`,
      [id],
    );
    expect(stored.rows[0]).toEqual({ org_id: orgA, person_id: empA });
  });

  it('worker plane: notifications_insert refuses a mismatched org claim (42501, no row)', async () => {
    const title = `Phase 11 claim probe ${RUN}`;
    const code = await sqlstateOf(
      inCtx(
        { personId: SYSTEM_ACTOR, orgId: orgB },
        `select public.notifications_insert($1::uuid, $2::uuid, $3, 'worker-plane claim probe', '{}'::jsonb)`,
        [orgA, empA, title],
      ),
    );
    expect(code).toBe('42501');
    const stored = await owner.query<{ n: number }>(
      `select count(*)::int as n from public.notifications where title = $1`,
      [title],
    );
    expect(stored.rows[0]!.n).toBe(0);
  });

  it('worker plane: notifications_recipient_exists refuses a mismatched org claim (42501)', async () => {
    const code = await sqlstateOf(
      inCtx(
        { personId: SYSTEM_ACTOR, orgId: orgB },
        `select public.notifications_recipient_exists($1::uuid, $2::uuid)`,
        [orgA, empA],
      ),
    );
    expect(code).toBe('42501');
  });

  it('worker plane: both notification definers refuse with no org claim in context (42501)', async () => {
    const noClaim: Ctx = { personId: SYSTEM_ACTOR, orgId: '' };
    const insertCode = await sqlstateOf(
      inCtx(
        noClaim,
        `select public.notifications_insert($1::uuid, $2::uuid, 'Phase 11 no-claim probe', 'x', '{}'::jsonb)`,
        [orgA, empA],
      ),
    );
    expect(insertCode).toBe('42501');
    const existsCode = await sqlstateOf(
      inCtx(noClaim, `select public.notifications_recipient_exists($1::uuid, $2::uuid)`, [
        orgA,
        empA,
      ]),
    );
    expect(existsCode).toBe('42501');
  });

  it('person context: notifications_insert refuses naming a foreign org (42501)', async () => {
    const code = await sqlstateOf(
      inCtx(
        empCtx(),
        `select public.notifications_insert($1::uuid, $2::uuid, 'Phase 11 foreign-org probe', 'x', '{}'::jsonb)`,
        [orgB, empB],
      ),
    );
    expect(code).toBe('42501');
  });

  it('person context: notifications_recipient_exists refuses naming a foreign org (42501)', async () => {
    const code = await sqlstateOf(
      inCtx(empCtx(), `select public.notifications_recipient_exists($1::uuid, $2::uuid)`, [
        orgB,
        empB,
      ]),
    );
    expect(code).toBe('42501');
  });
});
