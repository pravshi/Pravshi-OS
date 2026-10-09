import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDateRange } from '@/lib/analytics/date-ranges';
import type { DashboardFilter, DateRange } from '@/lib/analytics/types';
import type { AuthContext } from '@/lib/db/context';
import type { Tx } from '@/lib/db/authorized';
import {
  ANALYTICS_PERMS,
  CODE,
  makeCtx,
  mkActivity,
  mkCompany,
  mkContact,
  mkDeal,
  mkDept,
  mkEngagement,
  mkJob,
  mkOrg,
  mkPerson,
  mkPipeline,
  mkRoleFor,
  mkStage,
  mkWorkflow,
  mkWorkflowExecution,
  mkWorkProject,
  mkWorkTask,
  moveDealToStage,
  owner,
  setHistoryChangedAt,
} from './helpers';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

/**
 * Phase 12 (F-12-01) — analytics transaction composition.
 *
 * The overview route used to fire its 12 metric functions in Promise.all,
 * each opening its OWN withAuthorizedDb transaction — ~13 transactions per
 * dashboard hit against a pool of max 5 (src/lib/db/pool.ts). The contract
 * (phase12 audit §4.1): each metric accepts an optional trailing `tx?: Tx`;
 * the route composes all metrics over ONE shared authorized transaction.
 * Per-route budget: ≤ 2 transactions (the shared metrics tx + the authz tx
 * from withPermission, which is outside this composition).
 *
 * This suite pins the two halves of that contract against a real database:
 *
 *  A. PARITY — every overview metric, and every sibling-route metric,
 *     returns byte-identical results run on a shared tx vs its own tx.
 *     Fixtures are deliberately non-trivial (asserted below) so parity
 *     cannot pass vacuously on an empty org.
 *
 *  B. BUDGET — transactions are COUNTED by wrapping the real
 *     withAuthorizedDb (importOriginal — the wrapper delegates, it does not
 *     fake): the legacy per-metric fan-out opens exactly 12; the composed
 *     fan-out opens exactly 1.
 *
 * The composition below mirrors buildOverview in
 * src/app/api/analytics/overview/route.ts call-for-call (same metrics, same
 * arguments, same assembly); the route is the production caller of the
 * shared-tx path, this suite is its proof.
 *
 * Metric-function imports are dynamic so this file collects (and skips) on
 * a plain `pnpm test` without credentials — the lib import chain validates
 * env at import time. In CI, run with DATABASE_URL_TEST (pooled) and
 * DATABASE_URL_MIGRATE (direct, app_owner).
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

describe.skipIf(!HAS_DB)('overview composition (Phase 12 F-12-01)', () => {
  const NOW = new Date();
  const ago = (days: number) => new Date(NOW.getTime() - days * 24 * 3600_000);
  const noon = (days: number) => {
    const d = ago(days);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0));
  };
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);

  let orgId = '';
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
    sales = await import('@/lib/analytics/sales');
    crm = await import('@/lib/analytics/crm');
    work = await import('@/lib/analytics/work');
    workflows = await import('@/lib/analytics/workflows');
    automation = await import('@/lib/analytics/automation');
    ({ withAuthorizedDb } = await import('@/lib/db/authorized'));

    orgId = await mkOrg(`ovcomp-${CODE}`);
    const dept = await mkDept(orgId, `${CODE}_OC`);
    const person = await mkPerson(orgId, 'Ovcomp User');
    await mkEngagement(orgId, person, dept);
    await mkRoleFor(orgId, person, `${CODE}_OC_FULL`, ANALYTICS_PERMS);
    ctx = makeCtx(person, orgId);

    range = resolveDateRange('LAST_30_DAYS', { now: NOW });
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

    const pipe = await mkPipeline(orgId, `Ovcomp Pipe ${CODE}`);
    const newStage = await mkStage(orgId, pipe, 'NEW', 0);
    const qualified = await mkStage(orgId, pipe, 'QUALIFIED', 1);
    const proposal = await mkStage(orgId, pipe, 'PROPOSAL', 2);
    const won = await mkStage(orgId, pipe, 'WON', 3, { isWon: true });
    const lost = await mkStage(orgId, pipe, 'LOST', 4, { isLost: true });

    const seedDeal = async (
      title: string,
      stage: string,
      opts: { value?: string | null; currency?: string; createdAt?: Date; closedAt?: Date | null },
    ) => {
      const createdAt = opts.createdAt ?? ago(5);
      const id = await mkDeal(orgId, person, title, pipe, { stage, ...opts, createdAt });
      await setHistoryChangedAt(id, createdAt);
      return id;
    };

    await seedDeal(`open-inr ${CODE}`, proposal, { value: '3000', currency: 'INR' });
    await seedDeal(`open-usd ${CODE}`, proposal, { value: '700', currency: 'USD' });
    await seedDeal(`won-1 ${CODE}`, won, {
      value: '1000',
      currency: 'INR',
      closedAt: noon(4),
    });
    await seedDeal(`won-2 ${CODE}`, won, {
      value: '2000',
      currency: 'INR',
      closedAt: noon(3),
    });
    await seedDeal(`lost-1 ${CODE}`, lost, {
      value: '5000',
      currency: 'INR',
      closedAt: noon(2),
    });
    const converting = await seedDeal(`lead-converts ${CODE}`, newStage, {
      value: '100',
      currency: 'INR',
      createdAt: noon(5),
    });
    await seedDeal(`lead-stays ${CODE}`, newStage, {
      value: '100',
      currency: 'INR',
      createdAt: noon(5),
    });
    await moveDealToStage(converting, qualified);

    const anyDeal = await owner.query<{ id: string }>(
      `select id from public.deals where org_id = $1 limit 1`,
      [orgId],
    );
    await mkContact(orgId, person, 'Comp One', ago(3));
    await mkContact(orgId, person, 'Comp Two', ago(3));
    await mkCompany(orgId, person, `Comp Co ${CODE}`, ago(3));
    await mkActivity(orgId, person, 'CALL', anyDeal.rows[0]!.id, ago(2));
    await mkActivity(orgId, person, 'EMAIL', anyDeal.rows[0]!.id, ago(2));

    await mkWorkProject(orgId, `Ovcomp P1 ${CODE}`);
    await mkWorkProject(orgId, `Ovcomp P2 ${CODE}`);
    await mkWorkProject(orgId, `Ovcomp P3 ${CODE}`, true);
    await mkWorkTask(orgId, `t-todo-overdue ${CODE}`, { status: 'todo', dueDate: '2020-01-01' });
    await mkWorkTask(orgId, `t-todo ${CODE}`, { status: 'todo', priority: 'high' });
    await mkWorkTask(orgId, `t-prog ${CODE}`, { status: 'in_progress' });
    await mkWorkTask(orgId, `t-done ${CODE}`, { status: 'done' });

    await mkJob(orgId, 'succeeded', 'workflow_run');
    await mkJob(orgId, 'failed', 'email');
    await mkJob(orgId, 'dead_letter', 'webhook');
    await mkJob(orgId, 'pending', 'notification');

    const wf = await mkWorkflow(orgId, `Ovcomp WF ${CODE}`);
    await mkWorkflowExecution(orgId, wf, 'SUCCEEDED');
    await mkWorkflowExecution(orgId, wf, 'SUCCEEDED');
    await mkWorkflowExecution(orgId, wf, 'FAILED');
    await mkWorkflowExecution(orgId, wf, 'RUNNING');
  }, 60_000);

  afterAll(async () => {
    await owner.end();
  });

  /** The pre-Phase-12 shape: every metric opens its own transaction. */
  async function overviewOwnTx() {
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
      sales.getPipelineValue(ctx, filter),
      sales.getWonRevenue(ctx, filter),
      sales.getWinRate(ctx, filter),
      crm.getLeadCounts(orgId, ctx, filter),
      crm.getLeadConversionRate(orgId, ctx, filter.dateRange),
      work.getProjectStats(ctx, workWindow),
      work.getTasksByStatus(ctx, {}),
      workflows.getWorkflowStats(ctx, filter),
      workflows.getWorkflowSuccessRate(ctx, filter),
      automation.getJobStats(ctx, filter),
      automation.getAutomationSuccessRate(ctx, filter),
      automation.getDeadLetterCount(ctx),
    ]);
    return {
      sales: { pipelineValue, wonRevenue, winRate },
      crm: { leadCounts, leadConversionRate },
      work: { projectStats, tasksByStatus },
      workflows: { stats: workflowStats, successRate: workflowSuccessRate },
      automation: { jobStats, successRate: automationSuccessRate, deadLetterCount },
    };
  }

  /** The Phase-12 shape (mirrors buildOverview in the overview route). */
  async function overviewSharedTx() {
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
        crm.getLeadCounts(orgId, ctx, filter, tx),
        crm.getLeadConversionRate(orgId, ctx, filter.dateRange, tx),
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

  it('fixtures are non-trivial (parity cannot pass on an empty org)', async () => {
    const payload = await overviewSharedTx();
    expect(Number(payload.sales.pipelineValue.INR)).toBe(3000);
    expect(Number(payload.sales.pipelineValue.USD)).toBe(700);
    expect(Number(payload.sales.wonRevenue.INR)).toBe(3000);
    expect(payload.sales.winRate).toBeCloseTo(2 / 3, 10);
    expect(payload.crm.leadCounts).toEqual({ totalLeads: 1, newLeads: 2, qualifiedLeads: 1 });
    expect(payload.crm.leadConversionRate).toBeCloseTo(0.5, 10);
    expect(payload.work.projectStats).toEqual({ active: 2, archived: 1, total: 3 });
    expect(payload.work.tasksByStatus).toEqual({ todo: 2, in_progress: 1, done: 1 });
    expect(payload.workflows.stats.total).toBe(4);
    expect(payload.workflows.stats.succeeded).toBe(2);
    expect(payload.workflows.successRate).toBeCloseTo(2 / 3, 10);
    expect(payload.automation.jobStats.byStatus.succeeded).toBe(1);
    expect(payload.automation.jobStats.byStatus.dead_letter).toBe(1);
    expect(payload.automation.successRate).toBeCloseTo(1 / 3, 10);
    expect(payload.automation.deadLetterCount).toBe(1);
  });

  it('parity: composed overview equals per-metric own-tx overview', async () => {
    const own = await overviewOwnTx();
    const shared = await overviewSharedTx();
    expect(shared).toEqual(own);
  });

  it('budget: legacy fan-out opens 12 transactions, composed opens 1', async () => {
    txCounter.count = 0;
    await overviewOwnTx();
    expect(txCounter.count).toBe(12);

    txCounter.count = 0;
    await overviewSharedTx();
    expect(txCounter.count).toBe(1);
  });

  // Parity for the metrics the sibling routes compose (crm/sales/work/
  // automation dashboards) — same seam, exercised function by function.
  const siblingProbes: Array<[string, (tx?: Tx) => Promise<unknown>]> = [
    ['getDealsByStage', (tx) => sales.getDealsByStage(ctx, filter, tx)],
    ['getAvgDealValue', (tx) => sales.getAvgDealValue(ctx, filter, tx)],
    ['getDealsByOwner', (tx) => sales.getDealsByOwner(ctx, filter, tx)],
    ['getContactGrowth', (tx) => crm.getContactGrowth(orgId, ctx, range, 'day', tx)],
    ['getCompanyGrowth', (tx) => crm.getCompanyGrowth(orgId, ctx, range, 'day', tx)],
    ['getActivityVolume', (tx) => crm.getActivityVolume(orgId, ctx, range, 'day', tx)],
    ['getTasksByPriority', (tx) => work.getTasksByPriority(ctx, {}, tx)],
    ['getOverdueTasks', (tx) => work.getOverdueTasks(ctx, {}, tx)],
    ['getTasksByAssignee', (tx) => work.getTasksByAssignee(ctx, {}, tx)],
    [
      'getTaskCompletionTrend',
      (tx) => work.getTaskCompletionTrend(ctx, { from: isoDay(ago(7)), to: isoDay(NOW) }, {}, tx),
    ],
    ['getExecutionsOverTime', (tx) => workflows.getExecutionsOverTime(ctx, filter, tx)],
    ['getTopWorkflows', (tx) => workflows.getTopWorkflows(ctx, filter, 10, tx)],
    ['getJobsOverTime', (tx) => automation.getJobsOverTime(ctx, filter, tx)],
  ];

  for (const [name, call] of siblingProbes) {
    it(`parity: ${name} on a shared tx equals its own tx`, async () => {
      const own = await call();
      const shared = await withAuthorizedDb(ctx, (tx) => call(tx));
      expect(shared).toEqual(own);
    });
  }
});
