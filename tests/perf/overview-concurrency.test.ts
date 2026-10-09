import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/lib/db/context';
import type { DashboardFilter, DateRange } from '@/lib/analytics/types';
import { ensurePerfDataset, owner, type PerfDataset } from './seed';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

/**
 * Phase 12 (Wave D) — the F-12-01 concurrency regression (audit §4.4).
 *
 * Pre-Phase-12, one overview request fired 12 metric functions in
 * Promise.all, each opening its OWN transaction against a pool of max 5:
 * four simultaneous dashboard viewers wanted ~52 transactions and the
 * excess checkouts queued behind connectionTimeoutMillis (10 s) until
 * they failed. This suite runs the composed overview — the exact
 * composition buildOverview performs in
 * src/app/api/analytics/overview/route.ts, mirrored call-for-call the
 * same way tests/analytics/overview-composition.test.ts mirrors it —
 * four times CONCURRENTLY at service level against the Tier-1 dataset
 * (tests/perf/seed.ts) and pins the regression shut two ways:
 *
 *  A. All four compositions succeed (a connect-timeout would reject) and
 *     return payloads deep-equal to a serial composition and to owner-side
 *     ground truth — concurrency did not corrupt or starve the reads.
 *  B. Transactions are COUNTED by wrapping the real withAuthorizedDb
 *     (importOriginal; the wrapper delegates, it does not fake — the
 *     Wave A pattern): four compositions open exactly 4 transactions,
 *     one each. Under the pre-fix fan-out this count was 48.
 *
 * "Zero connect-timeouts" is asserted by construction: any timeout is a
 * rejected promise and Promise.all fails the test. No wall-clock
 * threshold is asserted (audit §4.0: CI timings are signals, not SLOs).
 */

const txCounter = vi.hoisted(() => ({ count: 0 }));

vi.mock('@/lib/db/authorized', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/authorized')>();
  type CtxArg = Parameters<typeof actual.withAuthorizedDb>[0];
  type FnArg = Parameters<typeof actual.withAuthorizedDb>[1];
  return {
    ...actual,
    withAuthorizedDb: (ctx: CtxArg, fn: FnArg) => {
      txCounter.count += 1;
      return actual.withAuthorizedDb(ctx, fn);
    },
  };
});

describe.skipIf(!HAS_DB)('overview concurrency (Phase 12 §4.4, F-12-01)', () => {
  let data: PerfDataset;
  let ctx: AuthContext;
  let range: DateRange;
  let filter: DashboardFilter;
  let workWindow: { createdFrom: string; createdTo: string };

  let sales: typeof import('@/lib/analytics/sales');
  let crm: typeof import('@/lib/analytics/crm');
  let work: typeof import('@/lib/analytics/work');
  let workflows: typeof import('@/lib/analytics/workflows');
  let automation: typeof import('@/lib/analytics/automation');
  let withAuthorizedDb: typeof import('@/lib/db/authorized').withAuthorizedDb;

  beforeAll(async () => {
    data = await ensurePerfDataset(1);
    if (data.scale !== 1) {
      throw new Error(
        `perf concurrency: dataset is at scale ${data.scale}, expected the contracted scale 1`,
      );
    }
    ctx = { personId: data.probePersonId, orgId: data.orgA, aal: 'aal1' };

    const { resolveDateRange } = await import('@/lib/analytics/date-ranges');
    const now = new Date();
    const isoDay = (daysAgo: number) =>
      new Date(now.getTime() - daysAgo * 24 * 3600_000).toISOString().slice(0, 10);
    range = resolveDateRange('CUSTOM', {
      timezone: 'UTC',
      now,
      customStart: isoDay(120),
      customEnd: isoDay(0),
    });
    filter = { dateRange: range };
    // Same window the overview route derives via workDateWindow().
    const ymd = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: range.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    workWindow = {
      createdFrom: ymd(range.startInclusive),
      createdTo: ymd(new Date(range.endExclusive.getTime() - 1)),
    };

    sales = await import('@/lib/analytics/sales');
    crm = await import('@/lib/analytics/crm');
    work = await import('@/lib/analytics/work');
    workflows = await import('@/lib/analytics/workflows');
    automation = await import('@/lib/analytics/automation');
    ({ withAuthorizedDb } = await import('@/lib/db/authorized'));
  }, 240_000);

  afterAll(async () => {
    await owner.end();
  });

  /** The Phase-12 composition: 12 metrics over ONE shared transaction. */
  async function composeOverview() {
    return withAuthorizedDb(ctx, async (tx) => {
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
        crm.getLeadCounts(data.orgA, ctx, filter, tx),
        crm.getLeadConversionRate(data.orgA, ctx, filter.dateRange, tx),
        work.getProjectStats(ctx, workWindow, tx),
        work.getTasksByStatus(ctx, {}, tx),
        workflows.getWorkflowStats(ctx, filter, tx),
        workflows.getWorkflowSuccessRate(ctx, filter, tx),
        automation.getJobStats(ctx, filter, tx),
        automation.getAutomationSuccessRate(ctx, filter, tx),
        automation.getDeadLetterCount(ctx, tx),
      ]);
      return {
        sales: { pipelineValue, wonRevenue, winRate },
        crm: { leadCounts, leadConversionRate },
        work: { projectStats, tasksByStatus },
        workflows: { stats: workflowStats, successRate: workflowSuccessRate },
        automation: { jobStats, successRate: automationSuccessRate, deadLetterCount },
      };
    });
  }

  it('4 concurrent compositions all succeed with identical, correct payloads on exactly 4 transactions', async () => {
    const serial = await composeOverview();

    // Non-vacuity anchors (owner-side ground truth): the payload describes
    // the seeded org, not an empty one.
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
    const expectedPipeline: Record<string, string | null> = {};
    for (const row of truth.rows) expectedPipeline[row.currency] = row.total;
    expect(serial.sales.pipelineValue).toEqual(expectedPipeline);
    // Dead-letter truth, mirrored from the owner at read time (the
    // pipeline-value pattern above): the generator seeds exactly 10%
    // dead_letter (i % 10 = 8 → 1,000 at scale 1), but the shared CI
    // database is not hermetic — tests/jobs/scheduler-tick deletes ALL
    // jobs of type 'scheduled_trigger' unscoped, and ~143 of those are
    // dead_letter rows here, so an absolute 1,000 flakes on file order
    // (PR #70 round 4: the seed verify observed the same delete). The
    // anchor stays exact — metric == owner truth, and truth > 0.
    const deadTruth = await owner.query<{ n: string }>(
      `select count(*)::text as n from public.jobs
        where org_id = $1 and status = 'dead_letter'`,
      [data.orgA],
    );
    const expectedDeadLetter = Number(deadTruth.rows[0]!.n);
    expect(expectedDeadLetter).toBeGreaterThan(0);
    expect(serial.automation.deadLetterCount).toBe(expectedDeadLetter);
    const taskTotal =
      serial.work.tasksByStatus.todo +
      serial.work.tasksByStatus.in_progress +
      serial.work.tasksByStatus.done;
    expect(taskTotal).toBe(data.counts.tasks + Math.floor(data.counts.tasks / 12));

    txCounter.count = 0;
    const results = await Promise.all([
      composeOverview(),
      composeOverview(),
      composeOverview(),
      composeOverview(),
    ]);
    // One transaction per composition — the F-12-01 budget, under load.
    expect(txCounter.count).toBe(4);
    for (const result of results) {
      expect(result).toEqual(serial);
    }
  }, 60_000);
});
