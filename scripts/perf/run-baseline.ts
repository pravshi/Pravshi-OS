/**
 * Phase 12 (Wave D) — Tier-2 service-level baseline runner (audit §4.4).
 *
 * Vitest-free: scripts/perf/baseline.mjs spawns this file through the
 * worker's own TS mechanism (node --experimental-transform-types +
 * scripts/worker-loader.mjs), so the scenarios below call the REAL
 * service functions — the composed overview, the CRM services, search,
 * the AI orchestrator on the deterministic mock provider, the fan-out
 * enqueue, and the executions read model — against the seeded perf
 * dataset (tests/perf/seed.ts).
 *
 * RECORD-ONLY, NEVER GATED (audit §4.0/§4.4): the output is a markdown
 * table of p50/p95/p99 per scenario for the run's report and, on the
 * first full post-Nov-1 run, for docs/phase12-performance.md §5. No
 * threshold is asserted anywhere in this file; a scenario that errors is
 * reported as an error row, not hidden.
 *
 * Usage (via baseline.mjs):
 *   node scripts/perf/baseline.mjs [--ci] [--scale <n>] [--iterations <n>]
 *                                  [--warmup <n>] [--out <path>]
 *     --ci          reduced scale (0.05) + 5 iterations, for trend lines
 *                   on a THROWAWAY database (CI services container).
 *     --scale <n>   dataset scale (default 1 = the §4.4 contracted size).
 *     --iterations  timed iterations per scenario (default 30).
 *     --warmup      untimed warm-up iterations per scenario (default 3).
 *     --out <path>  also write the markdown report to this path.
 *
 * Environment: DATABASE_URL (app_user, pooled) + DATABASE_URL_MIGRATE
 * (app_owner) + the app env src/env.ts requires (APP_URL,
 * BETTER_AUTH_SECRET). In CI, NEON_LOCAL_WSPROXY / NEON_LOCAL_PG_ADDRESS
 * point the driver at the job's Postgres (scripts/ci/neon-local.mjs,
 * imported below exactly as tests/setup.ts imports it).
 *
 * AI_PROVIDER is forced to 'mock' before any lib import: the baseline
 * measures OUR request path, never a real provider's latency (§2.3(d) of
 * the audit — the provider distribution is unmeasured by construction).
 * The perf org's AI limits are raised through the real upsertAiOrgLimits
 * service so the scenario measures the assist path, not the limiter;
 * that is harness setup on a fixture org and is stated in the report.
 */
import '../ci/neon-local.mjs';

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

process.env.AI_PROVIDER = 'mock';

/* ── args ───────────────────────────────────────────────────────────────── */

interface Args {
  ci: boolean;
  scale: number;
  iterations: number;
  warmup: number;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ci: false, scale: 1, iterations: 30, warmup: 3, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`baseline: ${flag} requires a value`);
      i += 1;
      return v;
    };
    switch (flag) {
      case '--ci':
        args.ci = true;
        break;
      case '--scale':
        args.scale = Number(value());
        break;
      case '--iterations':
        args.iterations = Number(value());
        break;
      case '--warmup':
        args.warmup = Number(value());
        break;
      case '--out':
        args.out = value();
        break;
      default:
        throw new Error(`baseline: unknown argument ${flag}`);
    }
  }
  if (args.ci) {
    if (!argv.includes('--scale')) args.scale = 0.05;
    if (!argv.includes('--iterations')) args.iterations = 5;
  }
  if (!(args.scale > 0 && args.scale <= 1)) {
    throw new Error(`baseline: --scale must be in (0, 1], got ${args.scale}`);
  }
  if (!Number.isInteger(args.iterations) || args.iterations < 1) {
    throw new Error(`baseline: --iterations must be a positive integer, got ${args.iterations}`);
  }
  return args;
}

/* ── timing ─────────────────────────────────────────────────────────────── */

function percentile(sortedMs: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sortedMs.length);
  return sortedMs[Math.min(Math.max(rank, 1), sortedMs.length) - 1]!;
}

interface ScenarioResult {
  name: string;
  n: number;
  p50: number;
  p95: number;
  p99: number;
  error?: string;
}

async function runScenario(
  name: string,
  fn: () => Promise<void>,
  warmup: number,
  iterations: number,
): Promise<ScenarioResult> {
  try {
    for (let i = 0; i < warmup; i += 1) await fn();
    const samples: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const started = performance.now();
      await fn();
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    return {
      name,
      n: samples.length,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
    };
  } catch (error) {
    return {
      name,
      n: 0,
      p50: Number.NaN,
      p95: Number.NaN,
      p99: Number.NaN,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ── main ───────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  for (const required of ['DATABASE_URL', 'DATABASE_URL_MIGRATE']) {
    if (!process.env[required]) {
      throw new Error(
        `baseline: ${required} is not set — the runner needs the app_user (pooled) and ` +
          `app_owner (direct) URLs of a SEEDED, disposable database. See docs/phase12-performance.md §5.`,
      );
    }
  }

  const { ensurePerfDataset, owner } = await import('../../tests/perf/seed');
  const data = await ensurePerfDataset(args.scale);

  const { resolveDateRange } = await import('@/lib/analytics/date-ranges');
  const { withAuthorizedDb } = await import('@/lib/db/authorized');
  const sales = await import('@/lib/analytics/sales');
  const crmAnalytics = await import('@/lib/analytics/crm');
  const workAnalytics = await import('@/lib/analytics/work');
  const workflowAnalytics = await import('@/lib/analytics/workflows');
  const automationAnalytics = await import('@/lib/analytics/automation');
  const crm = await import('@/lib/crm/companies');
  const deals = await import('@/lib/crm/deals');
  const search = await import('@/lib/search/query');
  const ai = await import('@/lib/ai/orchestrator');
  const aiUsage = await import('@/lib/ai/usage');
  const fanout = await import('@/lib/integrations/fanout');
  const executions = await import('@/lib/integrations/executions');

  type AuthContext = import('@/lib/db/context').AuthContext;
  type Authorization = import('@/lib/authz/require-permission').Authorization;
  const ctx: AuthContext = { personId: data.probePersonId, orgId: data.orgA, aal: 'aal1' };
  const makeAuth = (permission: string): Authorization => ({
    ctx,
    permission,
    scope: 'GLOBAL',
    aal: 'aal1',
    requestId: randomUUID(),
    meta: { requestId: randomUUID(), ip: null, userAgent: null },
  });
  const now = new Date();
  const isoDay = (daysAgo: number) =>
    new Date(now.getTime() - daysAgo * 24 * 3600_000).toISOString().slice(0, 10);
  const range = resolveDateRange('CUSTOM', {
    timezone: 'UTC',
    now,
    customStart: isoDay(120),
    customEnd: isoDay(0),
  });
  const filter = { dateRange: range };
  const ymd = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: range.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  const workWindow = {
    createdFrom: ymd(range.startInclusive),
    createdTo: ymd(new Date(range.endExclusive.getTime() - 1)),
  };

  // Harness setup (fixture org only, stated in the report): raise the AI
  // limits through the real admin service so the AI scenario measures the
  // assist path rather than tripping the limiter mid-run.
  await aiUsage.upsertAiOrgLimits(makeAuth('ai.usage.manage'), {
    enabled: true,
    monthlyRequestLimit: 1_000_000_000,
    monthlyTokenLimit: 1_000_000_000,
    maxRequestsPerMinutePerUser: 1_000_000_000,
    maxConcurrentRequests: 1_000,
  });

  // The composed overview — mirrors buildOverview in
  // src/app/api/analytics/overview/route.ts call-for-call (the route is
  // the production caller; this is its Tier-2 timing twin, exactly as
  // tests/perf/overview-concurrency.test.ts mirrors it for CI).
  const composeOverview = () =>
    withAuthorizedDb(ctx, async (tx) => {
      const [
        pipelineValue,
        wonRevenue,
        winRate,
        leadCounts,
        leadConversionRate,
        projectStats,
        tasksByStatus,
        workflowStats,
        workflowSuccessRate,
        jobStats,
        automationSuccessRate,
        deadLetterCount,
      ] = await Promise.all([
        sales.getPipelineValue(ctx, filter, tx),
        sales.getWonRevenue(ctx, filter, tx),
        sales.getWinRate(ctx, filter, tx),
        crmAnalytics.getLeadCounts(data.orgA, ctx, filter, tx),
        crmAnalytics.getLeadConversionRate(data.orgA, ctx, filter.dateRange, tx),
        workAnalytics.getProjectStats(ctx, workWindow, tx),
        workAnalytics.getTasksByStatus(ctx, {}, tx),
        workflowAnalytics.getWorkflowStats(ctx, filter, tx),
        workflowAnalytics.getWorkflowSuccessRate(ctx, filter, tx),
        automationAnalytics.getJobStats(ctx, filter, tx),
        automationAnalytics.getAutomationSuccessRate(ctx, filter, tx),
        automationAnalytics.getDeadLetterCount(ctx, tx),
      ]);
      return {
        sales: { pipelineValue, wonRevenue, winRate },
        crm: { leadCounts, leadConversionRate },
        work: { projectStats, tasksByStatus },
        workflows: { stats: workflowStats, successRate: workflowSuccessRate },
        automation: { jobStats, successRate: automationSuccessRate, deadLetterCount },
      };
    });

  const scenarios: Array<[string, () => Promise<void>]> = [
    [
      'Overview composition (12 metrics, 1 shared tx)',
      async () => {
        await composeOverview();
      },
    ],
    [
      'CRM list/detail (companies page + deals page + company detail)',
      async () => {
        await crm.listCompanies(makeAuth('companies.view'), { limit: 25, offset: 0 });
        await deals.listDeals(makeAuth('deals.view'), { limit: 25, offset: 0 });
        await crm.getCompany(makeAuth('companies.view'), data.sampleCompanyId);
      },
    ],
    [
      'Search (companies, trigram term)',
      async () => {
        await search.searchGlobal(makeAuth('companies.view'), {
          query: 'Zephyr',
          entityTypes: ['companies'],
          limit: 20,
          offset: 0,
        });
      },
    ],
    [
      'AI assist (mock provider, deal_summary)',
      async () => {
        const outcome = await ai.runAiRequest(makeAuth('ai.use'), {
          capability: 'deal_summary',
          target: { entityType: 'deal', entityId: data.sampleDealId },
        });
        if (outcome.status !== 'ok') {
          throw new Error(`AI assist outcome was '${outcome.status}', expected 'ok'`);
        }
      },
    ],
    [
      'Fan-out enqueue (deal.won → 3 subscriptions)',
      async () => {
        const emission = await fanout.emitIntegrationEvent(
          makeAuth('integrations.manage'),
          'deal.won',
          { dealId: data.sampleDealId },
          { eventInstanceId: randomUUID() },
        );
        if (emission.enqueued !== 3) {
          throw new Error(
            `fan-out enqueued ${emission.enqueued} jobs (matched ${emission.matched}, failed ${emission.failed}), expected 3`,
          );
        }
      },
    ],
    [
      'Executions read (integrations, first page)',
      async () => {
        await executions.listExecutions(makeAuth('integrations.view'), { limit: 25, offset: 0 });
      },
    ],
  ];

  const results: ScenarioResult[] = [];
  for (const [name, fn] of scenarios) {
    results.push(await runScenario(name, fn, args.warmup, args.iterations));
  }

  const dbHost = (() => {
    try {
      return new URL(process.env.DATABASE_URL!).hostname;
    } catch {
      return 'unparseable';
    }
  })();
  const environment = args.ci
    ? `CI mode (reduced scale), node ${process.version}, db host ${dbHost}`
    : `node ${process.version}, db host ${dbHost}`;
  const dataset =
    `2 orgs × ${data.counts.deals.toLocaleString('en-US')} deals, ` +
    `${data.counts.companies.toLocaleString('en-US')} companies/contacts, ` +
    `${data.counts.activities.toLocaleString('en-US')} activities, ` +
    `${data.counts.tasks.toLocaleString('en-US')} tasks, ` +
    `${data.counts.notifications.toLocaleString('en-US')} notifications, ` +
    `${data.counts.auditLogs.toLocaleString('en-US')} audit rows, ` +
    `${data.counts.jobs.toLocaleString('en-US')} jobs (scale ${data.scale})`;

  const fmt = (ms: number) => (Number.isFinite(ms) ? `${ms.toFixed(1)} ms` : '—');
  const lines = [
    `# Tier-2 baseline — ${now.toISOString()}`,
    '',
    `Dataset: ${dataset}`,
    `Environment: ${environment}`,
    `Iterations per scenario: ${args.iterations} timed after ${args.warmup} warm-up. ` +
      `AI provider forced to the deterministic mock; the perf org's AI limits were ` +
      `raised via upsertAiOrgLimits (harness setup on a fixture org). Record-only — never gated.`,
    '',
    '| Scenario | Dataset | Environment | n | p50 | p95 | p99 |',
    '| -------- | ------- | ----------- | - | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.name} | ${dataset} | ${environment} | ${r.n} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} |`,
    ),
    '',
    ...results.filter((r) => r.error).map((r) => `> ERROR — ${r.name}: ${r.error}`),
  ];
  const report = `${lines.join('\n')}\n`;
  console.log(report);
  if (args.out) {
    await writeFile(args.out, report, 'utf8');
    console.log(`baseline: report written to ${args.out}`);
  }
  await owner.end();
  const { pool } = await import('@/lib/db/pool');
  await pool.end();
  if (results.some((r) => r.error)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('baseline: fatal:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
