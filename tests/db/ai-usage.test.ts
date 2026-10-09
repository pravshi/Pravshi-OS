import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Phase 9 (migrations 0054/0055) — ai_usage_requests + ai_org_limits.
 *
 * The questions this file exists to answer:
 *   - is the metering log tenant-isolated (cross-org rows invisible, person
 *     forgery blocked, nobody finalizes another requester's row);
 *   - do the SECURITY DEFINER aggregates (ai_effective_limits /
 *     ai_usage_counters) implement the contract §8.2 counting rules exactly,
 *     and are they callable by an ai.use holder who does NOT hold
 *     ai.usage.view (the whole reason they exist);
 *   - does the schema store metadata only — no prompt/response content
 *     columns, ever (decision D7);
 *   - do the journal entries for 0054/0055 respect the Phase 8 collision
 *     lesson (when strictly greater than 0053's, strictly increasing).
 *
 * Two connections, as in roles-permissions.test.ts:
 *   asUser  the runtime role, governed by RLS.
 *   owner   full privilege; its cross-org insert must fail at the guard
 *           trigger, because triggers — not grants — are the last barrier.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `AI${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

let orgA = '';
let orgB = '';
let orgC = ''; // counters fixtures live here so counts stay exact
let deptA = '';
let deptB = '';
let deptC = '';

let admA = ''; // orgA ADMIN: ai.use + ai.usage.view + ai.usage.manage
let empA1 = ''; // orgA EMPLOYEE: ai.use only
let empA2 = ''; // orgA EMPLOYEE: ai.use only
let plainA = ''; // orgA, no roles: no ai.use
let empB = ''; // orgB EMPLOYEE
let empC = ''; // orgC EMPLOYEE

const mkPerson = async (org: string, name: string) => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people (org_id,code,full_legal_name,person_status)
       values ($1,$2,$3,'ACTIVE'::public.person_status) returning id`,
      [org, code, name],
    )
  ).rows[0]!.id;
};

const mkEngagement = (org: string, person: string, dept: string) =>
  owner.query(
    `insert into public.engagements
       (org_id,person_id,department_id,engagement_type,status,start_date)
     values ($1,$2,$3,'EMPLOYEE','ACTIVE'::public.engagement_status,current_date)`,
    [org, person, dept],
  );

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

const insertUsageAsOwner = (org: string, person: string, over: Record<string, unknown> = {}) =>
  owner.query<{ id: string }>(
    `insert into public.ai_usage_requests
       (org_id, person_id, request_id, capability, provider, model, status,
        prompt_tokens, completion_tokens, total_tokens, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, coalesce($11::timestamptz, now()))
     returning id`,
    [
      org,
      person,
      (over.requestId as string) ?? randomUUID(),
      (over.capability as string) ?? 'deal_summary',
      (over.provider as string) ?? 'mock',
      (over.model as string) ?? 'mock-deterministic',
      (over.status as string) ?? 'SUCCEEDED',
      (over.promptTokens as number) ?? null,
      (over.completionTokens as number) ?? null,
      (over.totalTokens as number) ?? null,
      (over.createdAt as string) ?? null,
    ],
  );

beforeAll(async () => {
  const mkOrg = async (s: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name,slug) values ($1,$2) returning id`,
        [`Ai ${s}`, `ai-${RUN}-${s}`],
      )
    ).rows[0]!.id;
  [orgA, orgB, orgC] = await Promise.all([mkOrg('a'), mkOrg('b'), mkOrg('c')]);

  const mkDept = async (org: string, code: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.departments (org_id,code,name) values ($1,$2,$3) returning id`,
        [org, code, `Dept ${code}`],
      )
    ).rows[0]!.id;
  [deptA, deptB, deptC] = await Promise.all([
    mkDept(orgA, `${CODE}_A`),
    mkDept(orgB, `${CODE}_B`),
    mkDept(orgC, `${CODE}_C`),
  ]);

  [admA, empA1, empA2, plainA, empB, empC] = await Promise.all([
    mkPerson(orgA, 'Ai Admin'),
    mkPerson(orgA, 'Ai Employee One'),
    mkPerson(orgA, 'Ai Employee Two'),
    mkPerson(orgA, 'Ai No Roles'),
    mkPerson(orgB, 'Ai Employee B'),
    mkPerson(orgC, 'Ai Employee C'),
  ]);

  await Promise.all([
    mkEngagement(orgA, admA, deptA),
    mkEngagement(orgA, empA1, deptA),
    mkEngagement(orgA, empA2, deptA),
    mkEngagement(orgA, plainA, deptA),
    mkEngagement(orgB, empB, deptB),
    mkEngagement(orgC, empC, deptC),
  ]);

  const [adminRole, empRoleA, empRoleB, empRoleC] = await Promise.all([
    roleId(orgA, 'ADMIN'),
    roleId(orgA, 'EMPLOYEE'),
    roleId(orgB, 'EMPLOYEE'),
    roleId(orgC, 'EMPLOYEE'),
  ]);
  await Promise.all([
    grantRole(admA, adminRole, orgA),
    grantRole(empA1, empRoleA, orgA),
    grantRole(empA2, empRoleA, orgA),
    grantRole(empB, empRoleB, orgB),
    grantRole(empC, empRoleC, orgC),
  ]);
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

// ── structure ────────────────────────────────────────────────────────────────

describe('structure', () => {
  it('creates both tables with RLS enabled and forced', async () => {
    const { rows } = await owner.query<{ relname: string; e: boolean; f: boolean }>(
      `select relname, relrowsecurity e, relforcerowsecurity f from pg_class
       where relname in ('ai_usage_requests','ai_org_limits') order by relname`,
    );
    expect(rows).toEqual([
      { relname: 'ai_org_limits', e: true, f: true },
      { relname: 'ai_usage_requests', e: true, f: true },
    ]);
  });

  it('gives ai_usage_requests exactly the contract §4.1 columns — metadata only, no content', async () => {
    const { rows } = await owner.query<{ cols: string }>(
      `select string_agg(column_name, ',' order by column_name) cols
       from information_schema.columns
       where table_schema='public' and table_name='ai_usage_requests'`,
    );
    expect(rows[0]!.cols).toBe(
      'capability,completion_tokens,created_at,duration_ms,error_code,id,model,org_id,' +
        'person_id,prompt_tokens,provider,provider_attempts,request_id,status,' +
        'target_entity_id,target_entity_type,tool_calls_count,total_tokens,updated_at',
    );
    // D7, asserted by name: nothing that could hold a prompt, a response, or
    // record content may exist on this table.
    const content = await owner.query(
      `select 1 from information_schema.columns
       where table_schema='public' and table_name='ai_usage_requests'
         and column_name in ('prompt','response','content','messages','output','summary','question')`,
    );
    expect(content.rows).toEqual([]);
  });

  it('rejects a capability outside the §6.1 registry and a status outside the lifecycle', async () => {
    await expect(
      insertUsageAsOwner(orgA, empA1, { capability: 'write_email_for_me' }),
    ).rejects.toThrow();
    await expect(insertUsageAsOwner(orgA, empA1, { status: 'HALF_DONE' })).rejects.toThrow();
  });

  it('enforces the (org_id, request_id) unique key, per org', async () => {
    const requestId = randomUUID();
    await insertUsageAsOwner(orgA, empA1, { requestId });
    await expect(insertUsageAsOwner(orgA, empA2, { requestId })).rejects.toThrow();
    // The same request id in another org is a different request.
    await insertUsageAsOwner(orgB, empB, { requestId });
  });

  it('keeps 0054/0055 journal timestamps strictly above 0053 and increasing (Phase 8 lesson)', () => {
    const journal = JSON.parse(
      readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: { idx: number; tag: string; when: number }[] };
    const e53 = journal.entries.find((e) => e.tag === '0053_search_indexes')!;
    const e54 = journal.entries.find((e) => e.tag === '0054_ai_foundation')!;
    const e55 = journal.entries.find((e) => e.tag === '0055_ai_permissions')!;
    expect(e53.when).toBe(1791343891088);
    expect(e54.when).toBeGreaterThan(e53.when);
    expect(e55.when).toBeGreaterThan(e54.when);
  });
});

// ── ai_usage_requests RLS ────────────────────────────────────────────────────

describe('ai_usage_requests RLS', () => {
  // The row id is pre-generated by the caller, mirroring how the
  // orchestrator inserts (it already holds the app request context).
  const ownRowId = randomUUID();
  const ownRequestId = randomUUID();

  it('lets an ai.use holder insert its own STARTED row', async () => {
    await inContext(
      { personId: empA1, orgId: orgA },
      `insert into public.ai_usage_requests
         (id, org_id, person_id, request_id, capability, provider, status)
       values ($1,$2,$3,$4,'deal_summary','mock','STARTED')`,
      [ownRowId, orgA, empA1, ownRequestId],
    );
    const check = await owner.query<{ status: string }>(
      `select status from public.ai_usage_requests where id=$1`,
      [ownRowId],
    );
    expect(check.rows).toEqual([{ status: 'STARTED' }]);
  });

  it('blocks person forgery on insert (person_id must be the caller)', async () => {
    await expect(
      inContext(
        { personId: empA1, orgId: orgA },
        `insert into public.ai_usage_requests
           (org_id, person_id, request_id, capability, provider, status)
         values ($1,$2,$3,'deal_summary','mock','STARTED')`,
        [orgA, empA2, randomUUID()],
      ),
    ).rejects.toThrow();
  });

  it('blocks insert entirely without ai.use', async () => {
    await expect(
      inContext(
        { personId: plainA, orgId: orgA },
        `insert into public.ai_usage_requests
           (org_id, person_id, request_id, capability, provider, status)
         values ($1,$2,$3,'deal_summary','mock','STARTED')`,
        [orgA, plainA, randomUUID()],
      ),
    ).rejects.toThrow();
  });

  it('shows an ai.use holder only their own rows — org-wide reads stay with ai.usage.view', async () => {
    // Own row: visible (this visibility is also what lets the requester's
    // finalize UPDATE and RETURNING work — Postgres applies the SELECT
    // policy to rows those commands read).
    const own = await inContext<{ id: string }>(
      { personId: empA1, orgId: orgA },
      `select id from public.ai_usage_requests where request_id=$1`,
      [ownRequestId],
    );
    expect(own.map((r) => r.id)).toEqual([ownRowId]);

    // A colleague's row in the same org: invisible without ai.usage.view.
    const otherRequestId = randomUUID();
    await insertUsageAsOwner(orgA, empA2, { requestId: otherRequestId });
    const foreign = await inContext(
      { personId: empA1, orgId: orgA },
      `select id from public.ai_usage_requests where request_id=$1`,
      [otherRequestId],
    );
    expect(foreign).toEqual([]);
  });

  it('shows org rows to ai.usage.view, and never another org’s rows', async () => {
    const mine = await inContext<{ id: string }>(
      { personId: admA, orgId: orgA },
      `select id from public.ai_usage_requests where request_id=$1`,
      [ownRequestId],
    );
    expect(mine.map((r) => r.id)).toEqual([ownRowId]);

    const crossOrg = await inContext(
      { personId: empB, orgId: orgB },
      `select id from public.ai_usage_requests where request_id=$1`,
      [ownRequestId],
    );
    expect(crossOrg).toEqual([]);
  });

  it('lets the requester finalize its own row and nobody else’s', async () => {
    const own = await inContext<{ status: string }>(
      { personId: empA1, orgId: orgA },
      `update public.ai_usage_requests
         set status='SUCCEEDED', total_tokens=42, duration_ms=10
       where id=$1 returning status`,
      [ownRowId],
    );
    expect(own).toEqual([{ status: 'SUCCEEDED' }]);

    const foreign = await inContext(
      { personId: empA2, orgId: orgA },
      `update public.ai_usage_requests set status='FAILED' where id=$1 returning id`,
      [ownRowId],
    );
    expect(foreign).toEqual([]);
    const after = await owner.query<{ status: string }>(
      `select status from public.ai_usage_requests where id=$1`,
      [ownRowId],
    );
    expect(after.rows[0]!.status).toBe('SUCCEEDED');
  });

  it('grants the runtime role no DELETE on the metering log', async () => {
    await expect(
      inContext(
        { personId: admA, orgId: orgA },
        `delete from public.ai_usage_requests where id=$1`,
        [ownRowId],
      ),
    ).rejects.toThrow();
  });

  it('blocks a cross-org person at the guard trigger, even for the owner', async () => {
    // empB belongs to orgB; an orgA row naming them must raise 42501.
    await expect(insertUsageAsOwner(orgA, empB)).rejects.toThrow(/42501|organization/);
  });
});

// ── ai_org_limits RLS ────────────────────────────────────────────────────────

describe('ai_org_limits RLS', () => {
  it('lets ai.usage.manage create the org row, gated from ai.use-only holders', async () => {
    await expect(
      inContext(
        { personId: empA1, orgId: orgA },
        `insert into public.ai_org_limits (org_id, monthly_request_limit) values ($1, 100)`,
        [orgA],
      ),
    ).rejects.toThrow();

    const rows = await inContext<{ org_id: string }>(
      { personId: admA, orgId: orgA },
      `insert into public.ai_org_limits (org_id, monthly_request_limit, updated_by)
       values ($1, 100, $2) returning org_id`,
      [orgA, admA],
    );
    expect(rows).toEqual([{ org_id: orgA }]);
  });

  it('shows the row only to ai.usage.view holders in the same org', async () => {
    const empView = await inContext(
      { personId: empA1, orgId: orgA },
      `select org_id from public.ai_org_limits`,
    );
    expect(empView).toEqual([]);

    const admView = await inContext<{ monthly_request_limit: number }>(
      { personId: admA, orgId: orgA },
      `select monthly_request_limit from public.ai_org_limits where org_id=$1`,
      [orgA],
    );
    expect(admView).toEqual([{ monthly_request_limit: 100 }]);

    const crossOrg = await inContext(
      { personId: empB, orgId: orgB },
      `select org_id from public.ai_org_limits where org_id=$1`,
      [orgA],
    );
    expect(crossOrg).toEqual([]);
  });

  it('lets ai.usage.manage flip the kill switch', async () => {
    const rows = await inContext<{ enabled: boolean }>(
      { personId: admA, orgId: orgA },
      `update public.ai_org_limits set enabled=false where org_id=$1 returning enabled`,
      [orgA],
    );
    expect(rows).toEqual([{ enabled: false }]);
  });
});

// ── SECURITY DEFINER aggregates (contract §8.1/§8.2) ─────────────────────────

describe('definer aggregates', () => {
  it('are SECURITY DEFINER, search_path-pinned, executable by app_user and never PUBLIC', async () => {
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
       where n.nspname='public' and p.proname in ('ai_effective_limits','ai_usage_counters')
       group by p.proname, p.prosecdef, p.proconfig order by p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['ai_effective_limits', 'ai_usage_counters']);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.proconfig ?? [], r.proname).toContain('search_path=""');
      expect(r.grantees, r.proname).toContain('app_user');
      expect(r.grantees, r.proname).not.toContain('PUBLIC');
    }
  });

  it('returns the §8.2 defaults for an org with no limits row — callable without ai.usage.view', async () => {
    // orgB has no limits row. empB holds ai.use but NOT ai.usage.view: the
    // call succeeding at all is the §8.1 definer exception working.
    const rows = await inContext<{
      enabled: boolean;
      monthly_request_limit: number;
      monthly_token_limit: number;
      max_requests_per_minute_per_user: number;
      max_concurrent_requests: number;
    }>({ personId: empB, orgId: orgB }, `select * from public.ai_effective_limits($1)`, [orgB]);
    expect(rows).toEqual([
      {
        enabled: true,
        monthly_request_limit: 5000,
        monthly_token_limit: 2000000,
        max_requests_per_minute_per_user: 10,
        max_concurrent_requests: 4,
      },
    ]);
  });

  it('merges a partial limits row over the defaults', async () => {
    // orgA's row from the limits suite: enabled=false, monthly_request_limit=100,
    // every other column NULL.
    const rows = await inContext<{ enabled: boolean; monthly_request_limit: number }>(
      { personId: empA1, orgId: orgA },
      `select * from public.ai_effective_limits($1)`,
      [orgA],
    );
    expect(rows[0]).toEqual({
      enabled: false,
      monthly_request_limit: 100,
      monthly_token_limit: 2000000,
      max_requests_per_minute_per_user: 10,
      max_concurrent_requests: 4,
    });
  });

  it('counts exactly per §8.2: quota statuses, NULL tokens as 0, windows, stale STARTED aging', async () => {
    // orgC fixtures (isolated org, exact counts).
    await insertUsageAsOwner(orgC, empC, { status: 'SUCCEEDED', totalTokens: 100 });
    await insertUsageAsOwner(orgC, empC, { status: 'SUCCEEDED', totalTokens: null });
    await insertUsageAsOwner(orgC, empC, { status: 'FAILED' });
    await insertUsageAsOwner(orgC, empC, { status: 'LIMITED' });
    await insertUsageAsOwner(orgC, empC, { status: 'NOT_CONFIGURED' });
    await insertUsageAsOwner(orgC, empC, { status: 'STARTED' });
    // A STARTED row from 10 minutes ago: aged out of the 5-minute in-flight window.
    await owner.query(
      `insert into public.ai_usage_requests
         (org_id, person_id, request_id, capability, provider, status, created_at)
       values ($1,$2,$3,'deal_summary','mock','STARTED', now() - interval '10 minutes')`,
      [orgC, empC, randomUUID()],
    );
    // Last month's success: outside the monthly windows entirely.
    await owner.query(
      `insert into public.ai_usage_requests
         (org_id, person_id, request_id, capability, provider, status, total_tokens, created_at)
       values ($1,$2,$3,'deal_summary','mock','SUCCEEDED', 999,
               date_trunc('month', now()) - interval '1 day')`,
      [orgC, empC, randomUUID()],
    );

    const rows = await inContext<Record<string, string>>(
      { personId: empC, orgId: orgC },
      `select * from public.ai_usage_counters($1, $2)`,
      [orgC, empC],
    );
    expect(rows.length).toBe(1);
    // Aggregates only: exactly the four counters, nothing else can leak.
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'in_flight',
      'last_minute_requests',
      'month_requests',
      'month_tokens',
    ]);
    expect(rows[0]).toEqual({
      // SUCCEEDED x2 + FAILED; LIMITED / NOT_CONFIGURED / STARTED never consume quota.
      month_requests: '3',
      // 100 + NULL-as-0; last month's 999 excluded.
      month_tokens: '100',
      // Trailing 60s, status <> LIMITED: 2 SUCCEEDED + FAILED + NOT_CONFIGURED + fresh STARTED.
      last_minute_requests: '5',
      // Only the fresh STARTED row; the 10-minute-old one aged out.
      in_flight: '1',
    });
  });
});
