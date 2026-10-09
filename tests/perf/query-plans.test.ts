import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import type { AuthContext } from '@/lib/db/context';
import type { Authorization } from '@/lib/authz/require-permission';
import { ensurePerfDataset, owner, PERF_PEOPLE_PER_ORG, type PerfDataset } from './seed';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

/**
 * Phase 12 (Wave D) — Tier-1 plan assertions (audit §4.4).
 *
 * The contract: on the seeded plan-stable dataset (tests/perf/seed.ts —
 * two orgs, 20k deals / 5k companies / 50k activities / 20k tasks /
 * 100k notifications / 200k audit rows / 10k jobs per org, ANALYZE run),
 * the seven named hot queries must not plan a `Seq Scan` on their inner
 * table. Plan shape is the hard gate; wall-clock is never asserted here
 * (CI timings are regression signals, not SLOs — audit §4.0).
 *
 * The queries are the REAL service functions — listCompanies, listDeals,
 * listTasks, getUnreadCount, getPipelineValue, searchGlobal — called with
 * a fabricated Authorization over real DB grants (the tests/search
 * fabrication pattern). Their plans are captured by wrapping the tx that
 * withAuthorizedDb hands to each service callback: every SELECT the
 * service executes is ALSO explained (EXPLAIN (FORMAT JSON), no ANALYZE —
 * planning only, no side effects) on the same connection, under the same
 * RLS identity, with the same bound parameters, and the JSON plan tree is
 * walked node by node. Nothing about the SQL is re-typed here, so the
 * assertion cannot drift away from the shipped query text.
 *
 * The one exception is #4: jobs_claim_next() is plpgsql, so EXPLAIN of the
 * call shows only a Function Scan. Its candidate query is therefore
 * explained verbatim from the 0045 definer body, as the owner (the
 * definer's own planning context), and the canonical jobs_claim_idx is
 * named, as §4.4 requires.
 *
 * A failure prints the offending statement text and its full plan JSON —
 * per §4.4, the adjudication is then either a missing index proven by the
 * plan (the ONLY route to a Phase 12 migration) or an assertion fix with
 * the plan attached to the PR. Never a silent edit.
 *
 * For #3 (tasks list) the assertion deliberately covers the WHOLE page
 * query, including the subtask-count derived table in TASK_FROM: it joins
 * work_tasks back onto itself, and its scan is part of the page's real
 * cost. If it ever plans a Seq Scan there, the printed plan says so.
 */

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

interface CapturedPlan {
  text: string;
  plan: PlanNode;
}

const capture = vi.hoisted(() => ({ plans: [] as Array<{ text: string; plan: unknown }> }));

vi.mock('@/lib/db/authorized', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/authorized')>();
  const { sql } = await import('drizzle-orm');
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const dialect = new PgDialect();
  type TxT = import('@/lib/db/authorized').Tx;

  const normalize = (raw: unknown): PlanNode => {
    let value: unknown = raw;
    if (typeof value === 'string') value = JSON.parse(value) as unknown;
    if (Array.isArray(value)) value = value[0];
    const plan = (value as { Plan?: PlanNode } | undefined)?.Plan;
    if (!plan) throw new Error('perf harness: EXPLAIN (FORMAT JSON) returned no Plan');
    return plan;
  };

  const wrapTx = (tx: TxT): TxT =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop === 'execute') {
          return async (query: SQL) => {
            const result = await target.execute(query);
            let text = '';
            try {
              text = dialect.sqlToQuery(query).sql;
            } catch {
              text = '';
            }
            if (/^\s*(select|with)\b/i.test(text)) {
              const explained = await target.execute(sql`explain (format json) ${query}`);
              const raw = (explained.rows[0] as Record<string, unknown> | undefined)?.[
                'QUERY PLAN'
              ];
              capture.plans.push({ text, plan: normalize(raw) });
            }
            return result;
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function'
          ? (value as (...args: never[]) => unknown).bind(target)
          : value;
      },
    });

  return {
    ...actual,
    withAuthorizedDb: (
      ctxArg: Parameters<typeof actual.withAuthorizedDb>[0],
      fn: Parameters<typeof actual.withAuthorizedDb>[1],
    ) => actual.withAuthorizedDb(ctxArg, (tx) => fn(wrapTx(tx))),
  };
});

function walkPlans(node: PlanNode, visit: (n: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walkPlans(child, visit);
}

function capturedPlans(): CapturedPlan[] {
  return capture.plans as unknown as CapturedPlan[];
}

/**
 * Assert at least one captured plan touches `table` (the harness really
 * measured this surface) and none of them Seq Scans it. Violations carry
 * the statement text and the full plan — the §4.4 diagnosis artefact.
 */
function assertNoSeqScanOn(table: string, label: string): void {
  const touching = capturedPlans().filter((entry) => {
    let found = false;
    walkPlans(entry.plan, (n) => {
      if (n['Relation Name'] === table) found = true;
    });
    return found;
  });
  expect(
    touching.length,
    `${label}: no captured EXPLAIN plan touched ${table} — the harness captured nothing for this surface`,
  ).toBeGreaterThan(0);
  const violations: string[] = [];
  for (const entry of touching) {
    walkPlans(entry.plan, (n) => {
      if (n['Node Type'] === 'Seq Scan' && n['Relation Name'] === table) {
        violations.push(`statement: ${entry.text}\nplan: ${JSON.stringify(entry.plan, null, 2)}`);
      }
    });
  }
  expect(
    violations,
    `${label}: Seq Scan planned on ${table} (§4.4 — fix is a proven-missing index or an assertion change with this plan attached):\n${violations.join('\n---\n')}`,
  ).toEqual([]);
}

describe.skipIf(!HAS_DB)('Tier-1 query plans (Phase 12 §4.4)', () => {
  let data: PerfDataset;
  let ctx: AuthContext;

  let companies: typeof import('@/lib/crm/companies');
  let deals: typeof import('@/lib/crm/deals');
  let work: typeof import('@/lib/work/tasks');
  let notifications: typeof import('@/lib/notifications/service');
  let sales: typeof import('@/lib/analytics/sales');
  let search: typeof import('@/lib/search/query');
  let dateRanges: typeof import('@/lib/analytics/date-ranges');

  const makeAuth = (permission: string): Authorization => ({
    ctx: { personId: data.probePersonId, orgId: data.orgA, aal: 'aal1' } as AuthContext,
    permission,
    scope: 'GLOBAL',
    aal: 'aal1',
    requestId: randomUUID(),
    meta: { requestId: randomUUID(), ip: null, userAgent: null },
  });

  const ownerCount = async (text: string, params: unknown[]): Promise<number> => {
    const { rows } = await owner.query<{ n: string }>(text, params);
    return Number(rows[0]!.n);
  };

  beforeAll(async () => {
    data = await ensurePerfDataset(1);
    if (data.scale !== 1) {
      throw new Error(
        `perf plans: dataset is at scale ${data.scale}, plans are only plan-stable at the contracted scale 1`,
      );
    }
    ctx = { personId: data.probePersonId, orgId: data.orgA, aal: 'aal1' };
    companies = await import('@/lib/crm/companies');
    deals = await import('@/lib/crm/deals');
    work = await import('@/lib/work/tasks');
    notifications = await import('@/lib/notifications/service');
    sales = await import('@/lib/analytics/sales');
    search = await import('@/lib/search/query');
    dateRanges = await import('@/lib/analytics/date-ranges');
  }, 240_000);

  afterAll(async () => {
    await owner.end();
  });

  it('1. companies list page (org + live + name order) — src/lib/crm/companies.ts', async () => {
    capture.plans.length = 0;
    const page = await companies.listCompanies(makeAuth('companies.view'), {
      limit: 25,
      offset: 0,
    });
    const truth = await ownerCount(
      `select count(*) as n from public.companies where org_id = $1 and deleted_at is null`,
      [data.orgA],
    );
    expect(truth).toBe(data.counts.companies);
    expect(page.total).toBe(truth);
    expect(page.rows).toHaveLength(25);
    assertNoSeqScanOn('companies', 'companies list page');
  });

  it('2. deals list page (org + updated_at desc) — src/lib/crm/deals.ts', async () => {
    capture.plans.length = 0;
    const page = await deals.listDeals(makeAuth('deals.view'), { limit: 25, offset: 0 });
    const truth = await ownerCount(
      `select count(*) as n from public.deals where org_id = $1 and deleted_at is null`,
      [data.orgA],
    );
    expect(truth).toBe(data.counts.deals);
    expect(page.total).toBe(truth);
    expect(page.rows).toHaveLength(25);
    assertNoSeqScanOn('deals', 'deals list page');
  });

  it('3. tasks list (project + status + sort) — src/lib/work/tasks.ts', async () => {
    capture.plans.length = 0;
    const page = await work.listTasks(makeAuth('tasks.view'), {
      projectId: data.probeProjectId,
      status: 'in_progress',
      limit: 25,
      offset: 0,
    });
    const truth = await ownerCount(
      `select count(*) as n from public.work_tasks
        where org_id = $1 and project_id = $2 and status = 'in_progress' and deleted_at is null`,
      [data.orgA, data.probeProjectId],
    );
    expect(truth).toBeGreaterThan(0);
    expect(page.total).toBe(truth);
    assertNoSeqScanOn('work_tasks', 'tasks list page');
  });

  it('4. jobs claim internals (jobs_claim_next due-scan) — 0045 definer, canonical jobs_claim_idx', async () => {
    // The candidate query, verbatim from the jobs_claim_next() body in
    // drizzle/0045_automation_jobs.sql (p_worker_id stamps the claimed
    // row and does not appear in the scan). Explained as the owner — the
    // SECURITY DEFINER's planning context — because plpgsql bodies are
    // opaque to EXPLAIN of the call itself.
    const { rows } = await owner.query<{ 'QUERY PLAN': unknown }>(
      `explain (format json)
         select id
           from public.jobs
          where status = 'pending'
            and next_run_at <= now()
            and ($1::text[] is null or type = any($1::text[]))
          order by priority desc, next_run_at asc
          limit 1
          for update skip locked`,
      [null],
    );
    let raw: unknown = rows[0]!['QUERY PLAN'];
    if (typeof raw === 'string') raw = JSON.parse(raw) as unknown;
    if (Array.isArray(raw)) raw = raw[0];
    const plan = (raw as { Plan: PlanNode }).Plan;

    const seqScans: string[] = [];
    const claimIndexScans: string[] = [];
    walkPlans(plan, (n) => {
      if (n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'jobs') {
        seqScans.push(JSON.stringify(n));
      }
      if (
        (n['Node Type'] === 'Index Scan' ||
          n['Node Type'] === 'Index Only Scan' ||
          n['Node Type'] === 'Bitmap Index Scan') &&
        n['Relation Name'] === 'jobs' &&
        n['Index Name'] === 'jobs_claim_idx'
      ) {
        claimIndexScans.push(n['Node Type']);
      }
    });
    expect(
      seqScans,
      `jobs claim: Seq Scan on jobs — plan: ${JSON.stringify(plan, null, 2)}`,
    ).toEqual([]);
    expect(
      claimIndexScans.length,
      `jobs claim: the canonical jobs_claim_idx (§4.4) does not appear in the plan — plan: ${JSON.stringify(plan, null, 2)}`,
    ).toBeGreaterThan(0);
  });

  it('5. notifications unread count — src/lib/notifications/service.ts', async () => {
    capture.plans.length = 0;
    const unread = await notifications.getUnreadCount(makeAuth('notifications.view'));
    // Ground truth: person #1 holds every 100th seeded notification, all unread.
    expect(unread).toBe(data.counts.notifications / PERF_PEOPLE_PER_ORG);
    assertNoSeqScanOn('notifications', 'notifications unread count');
  });

  it('6. sales pipeline-value aggregation (deals ⋈ stages, by currency) — src/lib/analytics/sales.ts', async () => {
    const now = new Date();
    const isoDay = (daysAgo: number) =>
      new Date(now.getTime() - daysAgo * 24 * 3600_000).toISOString().slice(0, 10);
    const range = dateRanges.resolveDateRange('CUSTOM', {
      timezone: 'UTC',
      now,
      customStart: isoDay(120),
      customEnd: isoDay(0),
    });
    capture.plans.length = 0;
    const value = await sales.getPipelineValue(ctx, { dateRange: range });
    // Ground truth: the metric's own predicate, read back as the owner.
    const truth = await owner.query<{ currency: string; total: string | null }>(
      `select d.currency as currency, sum(d.value)::text as total
         from public.deals d
         join public.pipeline_stages ps on ps.id = d.pipeline_stage_id and ps.org_id = d.org_id
        where d.org_id = $1 and d.deleted_at is null
          and d.created_at >= $2 and d.created_at < $3
          and not (ps.is_won or ps.is_lost)
        group by d.currency`,
      [data.orgA, range.startInclusive, range.endExclusive],
    );
    const expected: Record<string, string | null> = {};
    for (const row of truth.rows) expected[row.currency] = row.total;
    expect(Object.keys(expected).sort()).toEqual(['INR', 'USD']);
    expect(value).toEqual(expected);
    assertNoSeqScanOn('deals', 'sales pipeline-value aggregation');
  });

  it('7. search entity query (trigram term match) — src/lib/search/query.ts', async () => {
    capture.plans.length = 0;
    const res = await search.searchGlobal(makeAuth('companies.view'), {
      query: 'Zephyr',
      entityTypes: ['companies'],
      limit: 20,
      offset: 0,
    });
    // Seeded: exactly 10 'Zephyr Holdings' companies per org at scale 1
    // (every 500th of 5,000). Fuzzy neighbours may add a few; a total in
    // this band proves the query matched the trigram surface, not nothing
    // and not everything.
    expect(res.total).toBeGreaterThanOrEqual(10);
    expect(res.total).toBeLessThanOrEqual(100);
    assertNoSeqScanOn('companies', 'search entity query (companies)');
  });
});
