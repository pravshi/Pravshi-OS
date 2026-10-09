import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDateRange } from '@/lib/analytics/date-ranges';
import type { DashboardFilter, DateRange } from '@/lib/analytics/types';
import type { AuthContext } from '@/lib/db/context';
import type { Tx } from '@/lib/db/authorized';
import {
  ANALYTICS_PERMS,
  CODE,
  makeCtx,
  mkDeal,
  mkDept,
  mkEngagement,
  mkOrg,
  mkPerson,
  mkPipeline,
  mkRoleFor,
  mkStage,
  mkWorkProject,
  mkWorkTask,
  owner,
} from './helpers';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

/**
 * Phase 12 Wave J (adversarial) — analytics composition under hostile data.
 *
 * Wave A's suite (overview-composition.test.ts) pins F-12-01 parity and the
 * transaction budget on one deliberately non-trivial org. This suite attacks
 * the shapes that happy-seed parity cannot see:
 *
 *  1. EMPTY ORG — an org with a full pipeline but zero data rows. Every
 *     metric must produce its exact empty shape ({} money maps, null
 *     ratios, zero counts, [] funnels) identically on both paths — and the
 *     shapes are pinned, so "both paths returned the same garbage" fails.
 *  2. SOFT-DELETED-ONLY ORG — every data row carries deleted_at, plus ONE
 *     live control row. The metrics' deleted_at filters must make the dead
 *     rows invisible in both paths; the pins are the live row's values
 *     alone, proving the zeros come from the filter, not a broken org.
 *  3. MULTI-CURRENCY + RANGE-BOUNDARY ORG — NULL-valued deals (a currency
 *     whose total is unmeasurable must surface as a null map entry, not 0
 *     and not an absent key), a mixed NULL/valued currency, and deals
 *     closed/created at the exact half-open range edges: startInclusive
 *     counts, endExclusive does not, one millisecond either side flips the
 *     answer. Parity alone cannot catch a boundary bug shared by both
 *     paths, so the boundary answers are pinned to hand-computed values.
 *  4. SECOND-ROUTE BUDGET — the automation dashboard's composition (a
 *     different route than Wave A's overview) counted the same way:
 *     8 own-tx transactions vs 1 composed.
 *
 * Grep-level proof accompanies this suite (Wave J report): every metric
 * function in src/lib/analytics/*.ts dispatches `tx ? run(tx) :
 * withAuthorizedDb(ctx, run)` — when a route passes tx, no metric can
 * silently open its own transaction; the counters here prove it at runtime
 * for two of the five routes and per-function in Wave A's sibling probes.
 *
 * Same gating and mocking idiom as Wave A's suite: skipIf(!HAS_DB),
 * metric imports dynamic, transactions counted by wrapping the real
 * withAuthorizedDb via importOriginal (delegating, never faking).
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

describe.skipIf(!HAS_DB)('analytics composition — adversarial shapes (Phase 12 Wave J)', () => {
  // Wide deterministic window covering every fixture below (365 days,
  // inside the CUSTOM 370-day cap): [2026-01-01Z, 2027-01-01Z).
  const rangeWide: DateRange = resolveDateRange('CUSTOM', {
    customStart: '2026-01-01',
    customEnd: '2026-12-31',
    timezone: 'UTC',
  });
  const filterWide: DashboardFilter = { dateRange: rangeWide };
  // Tight window for the boundary pins: [2026-01-01Z, 2026-02-01Z).
  const rangeJan: DateRange = resolveDateRange('CUSTOM', {
    customStart: '2026-01-01',
    customEnd: '2026-01-31',
    timezone: 'UTC',
  });
  const filterJan: DashboardFilter = { dateRange: rangeJan };

  let sales: typeof import('@/lib/analytics/sales');
  let crm: typeof import('@/lib/analytics/crm');
  let work: typeof import('@/lib/analytics/work');
  let workflows: typeof import('@/lib/analytics/workflows');
  let automation: typeof import('@/lib/analytics/automation');
  let withAuthorizedDb: typeof import('@/lib/db/authorized').withAuthorizedDb;

  let emptyCtx: AuthContext;
  let deletedCtx: AuthContext;
  let edgeCtx: AuthContext;
  let edgeOrgId = '';

  /** Run one metric both ways; assert byte-identical results; return them. */
  async function parity<T>(ctx: AuthContext, call: (tx?: Tx) => Promise<T>): Promise<T> {
    const own = await call();
    const shared = await withAuthorizedDb(ctx, (tx) => call(tx));
    expect(shared).toEqual(own);
    return shared;
  }

  async function seedOrgWithPipeline(slug: string) {
    const orgId = await mkOrg(slug);
    const dept = await mkDept(orgId, `${CODE}_EJ`);
    const person = await mkPerson(orgId, 'Edge User');
    await mkEngagement(orgId, person, dept);
    await mkRoleFor(orgId, person, `${CODE}_EJ_FULL`, ANALYTICS_PERMS);
    const pipe = await mkPipeline(orgId, `Edge Pipe ${CODE}`);
    const stages = {
      new: await mkStage(orgId, pipe, 'NEW', 0),
      qualified: await mkStage(orgId, pipe, 'QUALIFIED', 1),
      proposal: await mkStage(orgId, pipe, 'PROPOSAL', 2),
      won: await mkStage(orgId, pipe, 'WON', 3, { isWon: true }),
      lost: await mkStage(orgId, pipe, 'LOST', 4, { isLost: true }),
    };
    return { orgId, person, pipe, stages, ctx: makeCtx(person, orgId) };
  }

  beforeAll(async () => {
    sales = await import('@/lib/analytics/sales');
    crm = await import('@/lib/analytics/crm');
    work = await import('@/lib/analytics/work');
    workflows = await import('@/lib/analytics/workflows');
    automation = await import('@/lib/analytics/automation');
    ({ withAuthorizedDb } = await import('@/lib/db/authorized'));

    // ── 1. Empty org: pipeline + stages, deliberately nothing else. ──────
    emptyCtx = (await seedOrgWithPipeline(`cedge-empty-${CODE}`)).ctx;

    // ── 2. Soft-deleted-only org + one live control deal/project. ────────
    const del = await seedOrgWithPipeline(`cedge-deleted-${CODE}`);
    deletedCtx = del.ctx;
    const now = new Date();
    await mkDeal(del.orgId, del.person, `dead-lead ${CODE}`, del.pipe, {
      stage: del.stages.new,
      value: '111111',
      createdAt: now,
      deletedAt: now,
    });
    await mkDeal(del.orgId, del.person, `dead-won ${CODE}`, del.pipe, {
      stage: del.stages.won,
      value: '999999',
      createdAt: now,
      closedAt: now,
      deletedAt: now,
    });
    await mkDeal(del.orgId, del.person, `dead-open ${CODE}`, del.pipe, {
      stage: del.stages.proposal,
      value: '888888',
      createdAt: now,
      deletedAt: now,
    });
    // The live control: the ONLY row any metric may see in this org.
    await mkDeal(del.orgId, del.person, `live-open ${CODE}`, del.pipe, {
      stage: del.stages.proposal,
      value: '700',
      currency: 'INR',
      createdAt: now,
    });
    const deadTask1 = await mkWorkTask(del.orgId, `dead-todo ${CODE}`, { status: 'todo' });
    const deadTask2 = await mkWorkTask(del.orgId, `dead-done ${CODE}`, { status: 'done' });
    await owner.query(`update public.work_tasks set deleted_at = now() where id = any($1)`, [
      [deadTask1, deadTask2],
    ]);
    const deadProject = await mkWorkProject(del.orgId, `Dead P ${CODE}`);
    await owner.query(`update public.work_projects set deleted_at = now() where id = $1`, [
      deadProject,
    ]);
    await mkWorkProject(del.orgId, `Live P ${CODE}`);

    // ── 3. Multi-currency + range-boundary org (rangeJan pins). ──────────
    const edge = await seedOrgWithPipeline(`cedge-edge-${CODE}`);
    edgeCtx = edge.ctx;
    edgeOrgId = edge.orgId;
    const createdLongAgo = new Date('2025-12-15T12:00:00.000Z');
    // Won/lost deals: closed_at sits exactly on the half-open edges.
    await mkDeal(edge.orgId, edge.person, `w-at-start ${CODE}`, edge.pipe, {
      stage: edge.stages.won,
      value: '100',
      currency: 'INR',
      createdAt: createdLongAgo,
      closedAt: new Date('2026-01-01T00:00:00.000Z'), // == startInclusive → IN
    });
    await mkDeal(edge.orgId, edge.person, `w-before-end ${CODE}`, edge.pipe, {
      stage: edge.stages.won,
      value: '300',
      currency: 'INR',
      createdAt: createdLongAgo,
      closedAt: new Date('2026-01-31T23:59:59.999Z'), // endExclusive − 1ms → IN
    });
    await mkDeal(edge.orgId, edge.person, `w-at-end ${CODE}`, edge.pipe, {
      stage: edge.stages.won,
      value: '10000',
      currency: 'INR',
      createdAt: createdLongAgo,
      closedAt: new Date('2026-02-01T00:00:00.000Z'), // == endExclusive → OUT
    });
    await mkDeal(edge.orgId, edge.person, `w-before-start ${CODE}`, edge.pipe, {
      stage: edge.stages.won,
      value: '10000',
      currency: 'INR',
      createdAt: createdLongAgo,
      closedAt: new Date('2025-12-31T23:59:59.999Z'), // startInclusive − 1ms → OUT
    });
    await mkDeal(edge.orgId, edge.person, `l-mid ${CODE}`, edge.pipe, {
      stage: edge.stages.lost,
      value: '50',
      currency: 'INR',
      createdAt: createdLongAgo,
      closedAt: new Date('2026-01-15T12:00:00.000Z'), // IN (win-rate denominator)
    });
    // Open deals: created_at on the edges + the currency matrix.
    await mkDeal(edge.orgId, edge.person, `o-at-start ${CODE}`, edge.pipe, {
      stage: edge.stages.proposal,
      value: '1000',
      currency: 'INR',
      createdAt: new Date('2026-01-01T00:00:00.000Z'), // == startInclusive → IN
    });
    await mkDeal(edge.orgId, edge.person, `o-at-end ${CODE}`, edge.pipe, {
      stage: edge.stages.proposal,
      value: '10000',
      currency: 'INR',
      createdAt: new Date('2026-02-01T00:00:00.000Z'), // == endExclusive → OUT
    });
    const midJan = new Date('2026-01-15T12:00:00.000Z');
    await mkDeal(edge.orgId, edge.person, `o-inr ${CODE}`, edge.pipe, {
      stage: edge.stages.proposal,
      value: '500',
      currency: 'INR',
      createdAt: midJan,
    });
    await mkDeal(edge.orgId, edge.person, `o-usd ${CODE}`, edge.pipe, {
      stage: edge.stages.proposal,
      value: '250.50',
      currency: 'USD',
      createdAt: midJan,
    });
    await mkDeal(edge.orgId, edge.person, `o-eur-null ${CODE}`, edge.pipe, {
      stage: edge.stages.proposal,
      value: null, // EUR exists but is unmeasurable → null map entry
      currency: 'EUR',
      createdAt: midJan,
    });
    await mkDeal(edge.orgId, edge.person, `o-gbp-null ${CODE}`, edge.pipe, {
      stage: edge.stages.proposal,
      value: null,
      currency: 'GBP',
      createdAt: midJan,
    });
    await mkDeal(edge.orgId, edge.person, `o-gbp ${CODE}`, edge.pipe, {
      stage: edge.stages.proposal,
      value: '40', // GBP mixes NULL + valued → sum ignores the NULL
      currency: 'GBP',
      createdAt: midJan,
    });
  }, 60_000);

  afterAll(async () => {
    await owner.end();
  });

  it('empty org: every metric returns its exact empty shape on both paths', async () => {
    const ctx = emptyCtx;
    expect(await parity(ctx, (tx) => sales.getPipelineValue(ctx, filterWide, tx))).toEqual({});
    expect(await parity(ctx, (tx) => sales.getWonRevenue(ctx, filterWide, tx))).toEqual({});
    expect(await parity(ctx, (tx) => sales.getAvgDealValue(ctx, filterWide, tx))).toEqual({});
    expect(await parity(ctx, (tx) => sales.getWinRate(ctx, filterWide, tx))).toBeNull();
    expect(await parity(ctx, (tx) => sales.getDealsByStage(ctx, filterWide, tx))).toEqual([]);
    expect(await parity(ctx, (tx) => sales.getDealsByOwner(ctx, filterWide, tx))).toEqual([]);
    const orgId = ctx.orgId;
    expect(await parity(ctx, (tx) => crm.getLeadCounts(orgId, ctx, filterWide, tx))).toEqual({
      totalLeads: 0,
      newLeads: 0,
      qualifiedLeads: 0,
    });
    expect(await parity(ctx, (tx) => work.getProjectStats(ctx, {}, tx))).toEqual({
      active: 0,
      archived: 0,
      total: 0,
    });
    expect(await parity(ctx, (tx) => work.getTasksByStatus(ctx, {}, tx))).toEqual({
      todo: 0,
      in_progress: 0,
      done: 0,
    });
    const wfStats = await parity(ctx, (tx) => workflows.getWorkflowStats(ctx, filterWide, tx));
    expect(wfStats.total).toBe(0);
    expect(await parity(ctx, (tx) => automation.getDeadLetterCount(ctx, tx))).toBe(0);
    expect(
      await parity(ctx, (tx) => automation.getAutomationSuccessRate(ctx, filterWide, tx)),
    ).toBeNull();
    const jobStats = await parity(ctx, (tx) => automation.getJobStats(ctx, filterWide, tx));
    expect(Object.values(jobStats.byStatus).every((v) => v === 0)).toBe(true);
    expect(Object.values(jobStats.byType).every((v) => v === 0)).toBe(true);
  });

  it('soft-deleted org: dead rows are invisible on both paths; the live control remains', async () => {
    const ctx = deletedCtx;
    // The deleted 888888 open deal must not appear; only the live 700 does.
    const pv = await parity(ctx, (tx) => sales.getPipelineValue(ctx, filterWide, tx));
    expect(Object.keys(pv)).toEqual(['INR']);
    expect(Number(pv.INR)).toBe(700);
    // The deleted 999999 won deal must not appear.
    expect(await parity(ctx, (tx) => sales.getWonRevenue(ctx, filterWide, tx))).toEqual({});
    expect(await parity(ctx, (tx) => sales.getWinRate(ctx, filterWide, tx))).toBeNull();
    // The deleted NEW-stage deal is not a lead.
    expect(await parity(ctx, (tx) => crm.getLeadCounts(ctx.orgId, ctx, filterWide, tx))).toEqual({
      totalLeads: 0,
      newLeads: 0,
      qualifiedLeads: 0,
    });
    // Funnel sees exactly one deal: the live one, in PROPOSAL.
    const byStage = await parity(ctx, (tx) => sales.getDealsByStage(ctx, filterWide, tx));
    expect(byStage).toHaveLength(1);
    expect(byStage[0]!.stageName).toBe('PROPOSAL');
    expect(byStage[0]!.dealCount).toBe(1);
    // Deleted tasks and the deleted project vanish; the live project stays.
    expect(await parity(ctx, (tx) => work.getTasksByStatus(ctx, {}, tx))).toEqual({
      todo: 0,
      in_progress: 0,
      done: 0,
    });
    expect(await parity(ctx, (tx) => work.getProjectStats(ctx, {}, tx))).toEqual({
      active: 1,
      archived: 0,
      total: 1,
    });
  });

  it('range boundaries: startInclusive counts, endExclusive does not (closed_at metrics)', async () => {
    const ctx = edgeCtx;
    // In-range wins: 100 (at start) + 300 (1ms before end) = 400.
    // The two 10000 deals sit exactly outside the half-open edges.
    const won = await parity(ctx, (tx) => sales.getWonRevenue(ctx, filterJan, tx));
    expect(Object.keys(won)).toEqual(['INR']);
    expect(Number(won.INR)).toBe(400);
    // 2 wins / (2 wins + 1 loss) — the out-of-range wins would make it 3/4.
    const winRate = await parity(ctx, (tx) => sales.getWinRate(ctx, filterJan, tx));
    expect(winRate).not.toBeNull();
    expect(winRate as number).toBeCloseTo(2 / 3, 10);
    // (100 + 300) / 2 = 200 — the excluded 10000s would poison this to 5100.
    const avg = await parity(ctx, (tx) => sales.getAvgDealValue(ctx, filterJan, tx));
    expect(Number(avg.INR)).toBe(200);
  });

  it('range boundaries + currencies: created_at edges and NULL-value money maps', async () => {
    const ctx = edgeCtx;
    const pv = await parity(ctx, (tx) => sales.getPipelineValue(ctx, filterJan, tx));
    // INR: 1000 (created exactly at start) + 500 (mid) = 1500;
    // the 10000 created exactly at endExclusive is OUT.
    expect(Number(pv.INR)).toBe(1500);
    expect(Number(pv.USD)).toBe(250.5);
    // EUR has deals but every value is NULL: the key exists, the total is
    // null (unmeasurable) — never 0, never absent.
    expect('EUR' in pv).toBe(true);
    expect(pv.EUR).toBeNull();
    // GBP mixes a NULL with a valued deal: the sum ignores the NULL.
    expect(Number(pv.GBP)).toBe(40);
    expect(Object.keys(pv).sort()).toEqual(['EUR', 'GBP', 'INR', 'USD']);
  });

  it('edge org: remaining metrics agree on both paths', async () => {
    const ctx = edgeCtx;
    await parity(ctx, (tx) => sales.getDealsByStage(ctx, filterJan, tx));
    await parity(ctx, (tx) => sales.getDealsByOwner(ctx, filterJan, tx));
    // No NEW-stage deals exist in this org and stage history was written
    // "now" (outside rangeJan): lead counts are exactly zero on both paths.
    expect(await parity(ctx, (tx) => crm.getLeadCounts(edgeOrgId, ctx, filterJan, tx))).toEqual({
      totalLeads: 0,
      newLeads: 0,
      qualifiedLeads: 0,
    });
    await parity(ctx, (tx) => workflows.getWorkflowStats(ctx, filterJan, tx));
    await parity(ctx, (tx) => automation.getJobStats(ctx, filterJan, tx));
  });

  it('budget: the automation route composition opens 1 transaction, its legacy fan-out 8', async () => {
    // Mirrors buildAutomationDashboard in src/app/api/analytics/automation/
    // route.ts call-for-call — the second route proven against the counter
    // (Wave A proved the overview: 12 vs 1).
    const ctx = emptyCtx;
    const metrics = (tx?: Tx) =>
      Promise.all([
        workflows.getWorkflowStats(ctx, filterWide, tx),
        workflows.getWorkflowSuccessRate(ctx, filterWide, tx),
        workflows.getExecutionsOverTime(ctx, filterWide, tx),
        workflows.getTopWorkflows(ctx, filterWide, 10, tx),
        automation.getJobStats(ctx, filterWide, tx),
        automation.getAutomationSuccessRate(ctx, filterWide, tx),
        automation.getDeadLetterCount(ctx, tx),
        automation.getJobsOverTime(ctx, filterWide, tx),
      ]);

    txCounter.count = 0;
    const legacy = await metrics();
    expect(txCounter.count).toBe(8);

    txCounter.count = 0;
    const composed = await withAuthorizedDb(ctx, (tx) => metrics(tx));
    expect(txCounter.count).toBe(1);
    expect(composed).toEqual(legacy);
  });
});
