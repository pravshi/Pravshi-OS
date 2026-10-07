import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { resolveDateRange } from '@/lib/analytics/date-ranges';
import type { DashboardFilter, DateRange } from '@/lib/analytics/types';
import type { AuthContext } from '@/lib/db/context';
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
  owner,
} from './helpers';

/**
 * Phase 7 — tenant isolation for analytics. THE BLOCKER SUITE.
 *
 * Two live tenants, deliberately asymmetric values so ANY leak is obvious:
 *
 *   Org A (alice)                              Org B (bob)
 *   ─────────────                              ─────────────
 *   pipeline "Alpha"                           pipeline "Beta"
 *   deals: 2 WON (INR 1000+2000),              deals: 1 WON (INR 99999),
 *          1 LOST (INR 5000),                         1 open (INR 88888)
 *          2 open (INR 11111, INR 100)
 *   contacts: 2                                contacts: 5
 *   companies: 1                               companies: 3
 *   activities: 2 CALL + 1 EMAIL               activities: 4 NOTE
 *   projects: 2 active + 1 archived            projects: 1 active
 *   tasks: 3 todo / 1 in_progress / 1 done     tasks: 3 in_progress
 *          (1 overdue)
 *   jobs: 2 succeeded, 1 failed,               jobs: 3 pending
 *         1 dead_letter, 1 pending
 *   workflow execs: 2 SUCCEEDED + 1 FAILED     workflow execs: 1 PENDING
 *
 * Org C (carol) has a person and permissions but NO data — the empty-tenant
 * probe: zeros/nulls everywhere proves nothing leaks globally.
 *
 * Every assertion calls the REAL metric function, which runs through
 * withAuthorizedDb() — THE ONLY PATH TO POSTGRES — under a real session
 * identity. Nothing is mocked. A final section probes the storage layer
 * directly (raw counts under each identity) to pin the RLS floor the
 * metrics stand on.
 *
 * In CI, run with DATABASE_URL_TEST (pooled, app_user) and
 * DATABASE_URL_MIGRATE (direct, app_owner). Metric-function imports are
 * dynamic so the file collects (and skips) on a plain `pnpm test` without
 * credentials — the lib import chain validates env at import time.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

describe.skipIf(!HAS_DB)('analytics tenant isolation: Org A cannot see Org B', () => {
  let sales: typeof import('@/lib/analytics/sales');
  let crm: typeof import('@/lib/analytics/crm');
  let workM: typeof import('@/lib/analytics/work');
  let automation: typeof import('@/lib/analytics/automation');
  let workflows: typeof import('@/lib/analytics/workflows');
  let withAuthorizedDb: typeof import('@/lib/db/authorized').withAuthorizedDb;

  let orgA = '';
  let orgB = '';
  let orgC = '';
  let ctxA: AuthContext;
  let ctxB: AuthContext;
  let ctxC: AuthContext;
  let alice = '';
  let bob = '';
  let range: DateRange;

  const filter = (): DashboardFilter => ({ dateRange: range });

  beforeAll(async () => {
    sales = await import('@/lib/analytics/sales');
    crm = await import('@/lib/analytics/crm');
    workM = await import('@/lib/analytics/work');
    automation = await import('@/lib/analytics/automation');
    workflows = await import('@/lib/analytics/workflows');
    ({ withAuthorizedDb } = await import('@/lib/db/authorized'));

    range = resolveDateRange('LAST_30_DAYS', { now: new Date() });
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600_000);

    // ── tenants + actors ──────────────────────────────────────────────
    orgA = await mkOrg(`iso-a-${CODE}`);
    orgB = await mkOrg(`iso-b-${CODE}`);
    orgC = await mkOrg(`iso-c-${CODE}`);
    const deptA = await mkDept(orgA, `${CODE}_IA`);
    const deptB = await mkDept(orgB, `${CODE}_IB`);
    const deptC = await mkDept(orgC, `${CODE}_IC`);
    alice = await mkPerson(orgA, 'Alice Iso');
    bob = await mkPerson(orgB, 'Bob Iso');
    const carol = await mkPerson(orgC, 'Carol Iso');
    await mkEngagement(orgA, alice, deptA);
    await mkEngagement(orgB, bob, deptB);
    await mkEngagement(orgC, carol, deptC);
    await mkRoleFor(orgA, alice, `${CODE}_IA_FULL`, ANALYTICS_PERMS);
    await mkRoleFor(orgB, bob, `${CODE}_IB_FULL`, ANALYTICS_PERMS);
    await mkRoleFor(orgC, carol, `${CODE}_IC_FULL`, ANALYTICS_PERMS);
    ctxA = makeCtx(alice, orgA);
    ctxB = makeCtx(bob, orgB);
    ctxC = makeCtx(carol, orgC);

    // ── sales ─────────────────────────────────────────────────────────
    const pipeA = await mkPipeline(orgA, `Alpha ${CODE}`);
    const pipeB = await mkPipeline(orgB, `Beta ${CODE}`);
    const mkStages = async (org: string, pipe: string) => {
      const sNew = await mkStage(org, pipe, 'NEW', 0);
      await mkStage(org, pipe, 'QUALIFIED', 1);
      const sProp = await mkStage(org, pipe, 'PROPOSAL', 2);
      const sWon = await mkStage(org, pipe, 'WON', 3, { isWon: true });
      const sLost = await mkStage(org, pipe, 'LOST', 4, { isLost: true });
      return { sNew, sProp, sWon, sLost };
    };
    const stA = await mkStages(orgA, pipeA);
    const stB = await mkStages(orgB, pipeB);

    const seedDeal = (
      org: string,
      person: string,
      pipe: string,
      title: string,
      stage: string,
      value: string,
      closedAt: Date | null = null,
    ) =>
      mkDeal(org, person, title, pipe, {
        stage,
        value,
        currency: 'INR',
        createdAt: daysAgo(10),
        closedAt,
      });

    // Org A: 2 won + 1 lost closed in range; 2 open.
    await seedDeal(orgA, alice, pipeA, `a1 ${CODE}`, stA.sWon, '1000', daysAgo(5));
    await seedDeal(orgA, alice, pipeA, `a2 ${CODE}`, stA.sWon, '2000', daysAgo(4));
    await seedDeal(orgA, alice, pipeA, `a3 ${CODE}`, stA.sLost, '5000', daysAgo(3));
    await seedDeal(orgA, alice, pipeA, `a4 ${CODE}`, stA.sProp, '11111');
    const a5 = await seedDeal(orgA, alice, pipeA, `a5 ${CODE}`, stA.sNew, '100');
    // Org B: 1 won closed in range; 1 open. Values chosen to never collide.
    await seedDeal(orgB, bob, pipeB, `b1 ${CODE}`, stB.sWon, '99999', daysAgo(5));
    const b2 = await seedDeal(orgB, bob, pipeB, `b2 ${CODE}`, stB.sProp, '88888');

    // ── CRM ───────────────────────────────────────────────────────────
    await mkContact(orgA, alice, 'Ann', daysAgo(5));
    await mkContact(orgA, alice, 'Andy', daysAgo(3));
    for (let i = 0; i < 5; i++) await mkContact(orgB, bob, `Ben${i}`, daysAgo(6 - i));
    await mkCompany(orgA, alice, `Acme ${CODE}`, daysAgo(5));
    for (let i = 0; i < 3; i++) await mkCompany(orgB, bob, `BetaCo${i} ${CODE}`, daysAgo(6 - i));
    await mkActivity(orgA, alice, 'CALL', a5, daysAgo(4));
    await mkActivity(orgA, alice, 'CALL', a5, daysAgo(2));
    await mkActivity(orgA, alice, 'EMAIL', a5, daysAgo(1));
    for (let i = 0; i < 4; i++) await mkActivity(orgB, bob, 'NOTE', b2, daysAgo(4 - i));

    // ── work ──────────────────────────────────────────────────────────
    const projA1 = await mkWorkProject(orgA, `Proj A1 ${CODE}`);
    await mkWorkProject(orgA, `Proj A2 ${CODE}`);
    await mkWorkProject(orgA, `Proj A3 ${CODE}`, true); // archived
    await mkWorkProject(orgB, `Proj B1 ${CODE}`);
    const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);
    await mkWorkTask(orgA, `t1 ${CODE}`, { status: 'todo', priority: 'low', projectId: projA1 });
    await mkWorkTask(orgA, `t2 ${CODE}`, { status: 'todo', priority: 'high' });
    await mkWorkTask(orgA, `t3 ${CODE}`, { status: 'in_progress', priority: 'medium' });
    await mkWorkTask(orgA, `t4 ${CODE}`, { status: 'done', priority: 'urgent' });
    await mkWorkTask(orgA, `t5 ${CODE}`, { status: 'todo', priority: 'low', dueDate: yesterday });
    for (let i = 0; i < 3; i++)
      await mkWorkTask(orgB, `bt${i} ${CODE}`, { status: 'in_progress', priority: 'medium' });

    // ── automation ────────────────────────────────────────────────────
    await mkJob(orgA, 'succeeded', 'workflow_run', daysAgo(3));
    await mkJob(orgA, 'succeeded', 'email', daysAgo(2));
    await mkJob(orgA, 'failed', 'webhook', daysAgo(2));
    await mkJob(orgA, 'dead_letter', 'retry', daysAgo(1));
    await mkJob(orgA, 'pending', 'cleanup', daysAgo(1));
    for (let i = 0; i < 3; i++) await mkJob(orgB, 'pending', 'notification', daysAgo(2 - i * 0.2));

    // ── workflows ─────────────────────────────────────────────────────
    const wfA = await mkWorkflow(orgA, `wf-alpha ${CODE}`);
    await mkWorkflowExecution(orgA, wfA, 'SUCCEEDED', daysAgo(3));
    await mkWorkflowExecution(orgA, wfA, 'SUCCEEDED', daysAgo(2));
    await mkWorkflowExecution(orgA, wfA, 'FAILED', daysAgo(1));
    const wfB = await mkWorkflow(orgB, `wf-beta ${CODE}`);
    await mkWorkflowExecution(orgB, wfB, 'PENDING', daysAgo(1));
  }, 120_000);

  afterAll(async () => {
    await owner.end();
  });

  describe('sales metrics are tenant-isolated', () => {
    it('getWinRate sees only the caller’s closed deals', async () => {
      // A: 2 won / 3 closed = 0.667. B: 1/1 = 1. Cross-leak would give 3/4.
      await expect(sales.getWinRate(ctxA, filter())).resolves.toBeCloseTo(2 / 3, 10);
      await expect(sales.getWinRate(ctxB, filter())).resolves.toBe(1);
    });

    it('getPipelineValue sums only the caller’s open deals', async () => {
      // A: a4 (11111) + a5 (100). B: b2 (88888). Exact equality — any leak
      // changes the sums.
      await expect(sales.getPipelineValue(ctxA, filter())).resolves.toEqual({
        INR: '11211.0000',
      });
      await expect(sales.getPipelineValue(ctxB, filter())).resolves.toEqual({
        INR: '88888.0000',
      });
    });

    it('getWonRevenue sums only the caller’s won deals', async () => {
      await expect(sales.getWonRevenue(ctxA, filter())).resolves.toEqual({ INR: '3000.0000' });
      await expect(sales.getWonRevenue(ctxB, filter())).resolves.toEqual({ INR: '99999.0000' });
    });

    it('getDealsByStage lists only the caller’s pipelines and stages', async () => {
      const rowsA = await sales.getDealsByStage(ctxA, filter());
      const rowsB = await sales.getDealsByStage(ctxB, filter());
      expect(rowsA.length).toBeGreaterThan(0);
      expect(rowsB.length).toBeGreaterThan(0);
      for (const r of rowsA) expect(r.pipelineName).toContain('Alpha');
      for (const r of rowsB) expect(r.pipelineName).toContain('Beta');
      const totalA = rowsA.reduce((n, r) => n + r.dealCount, 0);
      const totalB = rowsB.reduce((n, r) => n + r.dealCount, 0);
      expect(totalA).toBe(5);
      expect(totalB).toBe(2);
    });

    it('getDealsByOwner attributes deals only to the caller’s people', async () => {
      const rowsA = await sales.getDealsByOwner(ctxA, filter());
      const rowsB = await sales.getDealsByOwner(ctxB, filter());
      expect(rowsA.reduce((n, r) => n + r.dealCount, 0)).toBe(5);
      expect(rowsB.reduce((n, r) => n + r.dealCount, 0)).toBe(2);
      for (const r of rowsA) {
        expect(r.ownerPersonId).toBe(alice);
        expect(r.ownerName).toContain('Alice');
      }
      for (const r of rowsB) {
        expect(r.ownerPersonId).toBe(bob);
        expect(r.ownerName).toContain('Bob');
      }
    });
  });

  describe('CRM metrics are tenant-isolated', () => {
    it('getLeadCounts counts only the caller’s leads', async () => {
      const a = await crm.getLeadCounts(orgA, ctxA, filter());
      const b = await crm.getLeadCounts(orgB, ctxB, filter());
      expect(a).toEqual({ totalLeads: 1, newLeads: 1, qualifiedLeads: 0 });
      expect(b).toEqual({ totalLeads: 0, newLeads: 0, qualifiedLeads: 0 });
    });

    it('getLeadConversionRate uses only the caller’s cohort', async () => {
      // A: a5 created into NEW, never converted → 0 (a real measurement).
      // B: no NEW cohort at all → null. A leak would flip these.
      await expect(crm.getLeadConversionRate(orgA, ctxA, range)).resolves.toBe(0);
      await expect(crm.getLeadConversionRate(orgB, ctxB, range)).resolves.toBeNull();
    });

    it('assertTenant fail-closes when orgId !== session orgId', async () => {
      await expect(crm.getLeadCounts(orgB, ctxA, filter())).rejects.toThrow(
        /does not match session orgId/,
      );
      await expect(crm.getContactGrowth(orgB, ctxA, range)).rejects.toThrow(
        /does not match session orgId/,
      );
      await expect(crm.getActivityVolume(orgB, ctxA, range)).rejects.toThrow(
        /does not match session orgId/,
      );
    });

    it('getContactGrowth / getCompanyGrowth count only the caller’s records', async () => {
      const sum = (pts: { value: number | null }[]) => pts.reduce((n, p) => n + (p.value ?? 0), 0);
      expect(sum(await crm.getContactGrowth(orgA, ctxA, range, 'day'))).toBe(2);
      expect(sum(await crm.getContactGrowth(orgB, ctxB, range, 'day'))).toBe(5);
      expect(sum(await crm.getCompanyGrowth(orgA, ctxA, range, 'day'))).toBe(1);
      expect(sum(await crm.getCompanyGrowth(orgB, ctxB, range, 'day'))).toBe(3);
    });

    it('getActivityVolume attributes volume only to the caller’s org', async () => {
      const byType = (rows: { type: string; count: number }[]) => {
        const m: Record<string, number> = {};
        for (const r of rows) m[r.type] = (m[r.type] ?? 0) + r.count;
        return m;
      };
      const a = byType(await crm.getActivityVolume(orgA, ctxA, range, 'day'));
      const b = byType(await crm.getActivityVolume(orgB, ctxB, range, 'day'));
      expect(a).toMatchObject({ CALL: 2, EMAIL: 1, NOTE: 0, MEETING: 0 });
      expect(b).toMatchObject({ NOTE: 4, CALL: 0, EMAIL: 0, MEETING: 0 });
    });
  });

  describe('work metrics are tenant-isolated', () => {
    it('getProjectStats counts only the caller’s projects', async () => {
      await expect(workM.getProjectStats(ctxA)).resolves.toEqual({
        active: 2,
        archived: 1,
        total: 3,
      });
      await expect(workM.getProjectStats(ctxB)).resolves.toEqual({
        active: 1,
        archived: 0,
        total: 1,
      });
    });

    it('getTasksByStatus / getTasksByPriority count only the caller’s tasks', async () => {
      await expect(workM.getTasksByStatus(ctxA)).resolves.toEqual({
        todo: 3,
        in_progress: 1,
        done: 1,
      });
      await expect(workM.getTasksByStatus(ctxB)).resolves.toEqual({
        todo: 0,
        in_progress: 3,
        done: 0,
      });
      await expect(workM.getTasksByPriority(ctxA)).resolves.toEqual({
        low: 2,
        medium: 1,
        high: 1,
        urgent: 1,
      });
      await expect(workM.getTasksByPriority(ctxB)).resolves.toEqual({
        low: 0,
        medium: 3,
        high: 0,
        urgent: 0,
      });
    });

    it('getOverdueTasks lists only the caller’s overdue tasks', async () => {
      const a = await workM.getOverdueTasks(ctxA);
      const b = await workM.getOverdueTasks(ctxB);
      expect(a.total).toBe(1);
      expect(a.rows).toHaveLength(1);
      expect(a.rows[0]!.title).toContain('t5');
      expect(b.total).toBe(0);
      expect(b.rows).toHaveLength(0);
    });
  });

  describe('automation metrics are tenant-isolated', () => {
    it('getJobStats breaks down only the caller’s jobs', async () => {
      const a = await automation.getJobStats(ctxA, filter());
      const b = await automation.getJobStats(ctxB, filter());
      expect(a.byStatus).toMatchObject({
        succeeded: 2,
        failed: 1,
        dead_letter: 1,
        pending: 1,
        claimed: 0,
        running: 0,
        cancelled: 0,
      });
      expect(b.byStatus).toMatchObject({
        pending: 3,
        succeeded: 0,
        failed: 0,
        dead_letter: 0,
      });
      expect(
        a.byType.workflow_run +
          a.byType.email +
          a.byType.webhook +
          a.byType.retry +
          a.byType.cleanup,
      ).toBe(5);
      expect(b.byType.notification).toBe(3);
    });

    it('getAutomationSuccessRate uses only the caller’s terminal jobs', async () => {
      // A: 2 / (2 + 1 + 1) = 0.5. B: only pending → null, not 0.
      await expect(automation.getAutomationSuccessRate(ctxA, filter())).resolves.toBe(0.5);
      await expect(automation.getAutomationSuccessRate(ctxB, filter())).resolves.toBeNull();
    });

    it('getDeadLetterCount counts only the caller’s dead letters', async () => {
      await expect(automation.getDeadLetterCount(ctxA)).resolves.toBe(1);
      await expect(automation.getDeadLetterCount(ctxB)).resolves.toBe(0);
    });
  });

  describe('workflow metrics are tenant-isolated', () => {
    it('getWorkflowStats counts only the caller’s executions', async () => {
      await expect(workflows.getWorkflowStats(ctxA, filter())).resolves.toEqual({
        total: 3,
        pending: 0,
        running: 0,
        succeeded: 2,
        failed: 1,
        cancelled: 0,
      });
      await expect(workflows.getWorkflowStats(ctxB, filter())).resolves.toEqual({
        total: 1,
        pending: 1,
        running: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      });
    });

    it('getWorkflowSuccessRate uses only the caller’s terminal executions', async () => {
      // A: 2 / (2 + 1 + 0) = 2/3. B: only PENDING → null, not 0.
      await expect(workflows.getWorkflowSuccessRate(ctxA, filter())).resolves.toBeCloseTo(
        2 / 3,
        10,
      );
      await expect(workflows.getWorkflowSuccessRate(ctxB, filter())).resolves.toBeNull();
    });

    it('getTopWorkflows ranks only the caller’s workflows', async () => {
      const a = await workflows.getTopWorkflows(ctxA, filter());
      const b = await workflows.getTopWorkflows(ctxB, filter());
      expect(a).toHaveLength(1);
      expect(a[0]!.workflowName).toContain('wf-alpha');
      expect(a[0]!.executions).toBe(3);
      expect(b).toHaveLength(1);
      expect(b[0]!.workflowName).toContain('wf-beta');
      expect(b[0]!.executions).toBe(1);
    });
  });

  describe('empty tenant sees nothing (no global leakage)', () => {
    it('every metric returns zeros / nulls / empties for an org with no data', async () => {
      await expect(sales.getWinRate(ctxC, filter())).resolves.toBeNull();
      await expect(sales.getPipelineValue(ctxC, filter())).resolves.toEqual({});
      await expect(sales.getWonRevenue(ctxC, filter())).resolves.toEqual({});
      await expect(sales.getDealsByStage(ctxC, filter())).resolves.toEqual([]);
      await expect(sales.getDealsByOwner(ctxC, filter())).resolves.toEqual([]);
      await expect(crm.getLeadCounts(orgC, ctxC, filter())).resolves.toEqual({
        totalLeads: 0,
        newLeads: 0,
        qualifiedLeads: 0,
      });
      await expect(crm.getLeadConversionRate(orgC, ctxC, range)).resolves.toBeNull();
      await expect(workM.getProjectStats(ctxC)).resolves.toEqual({
        active: 0,
        archived: 0,
        total: 0,
      });
      await expect(workM.getTasksByStatus(ctxC)).resolves.toEqual({
        todo: 0,
        in_progress: 0,
        done: 0,
      });
      await expect(workM.getOverdueTasks(ctxC)).resolves.toMatchObject({ total: 0 });
      const jobs = await automation.getJobStats(ctxC, filter());
      expect(Object.values(jobs.byStatus).every((n) => n === 0)).toBe(true);
      await expect(automation.getAutomationSuccessRate(ctxC, filter())).resolves.toBeNull();
      await expect(automation.getDeadLetterCount(ctxC)).resolves.toBe(0);
      await expect(workflows.getWorkflowStats(ctxC, filter())).resolves.toMatchObject({
        total: 0,
      });
      await expect(workflows.getWorkflowSuccessRate(ctxC, filter())).resolves.toBeNull();
      await expect(workflows.getTopWorkflows(ctxC, filter())).resolves.toEqual([]);
    });
  });

  describe('storage layer: RLS admits only own-org rows', () => {
    const countAs = async (ctx: AuthContext, table: string) => {
      // Table name is a fixed allowlist member, never caller input.
      const allowed = [
        'deals',
        'contacts',
        'companies',
        'activities',
        'work_projects',
        'work_tasks',
        'jobs',
        'workflow_executions',
      ] as const;
      if (!(allowed as readonly string[]).includes(table)) throw new Error('bad table');
      const rows = await withAuthorizedDb(ctx, (tx) =>
        tx.execute<{ n: string }>(sql`select count(*) as n from ${sql.raw(`public.${table}`)}`),
      );
      return Number(rows.rows[0]?.n ?? -1);
    };

    it('alice’s identity sees exactly Org A rows in every analytics table', async () => {
      await expect(countAs(ctxA, 'deals')).resolves.toBe(5);
      await expect(countAs(ctxA, 'contacts')).resolves.toBe(2);
      await expect(countAs(ctxA, 'companies')).resolves.toBe(1);
      await expect(countAs(ctxA, 'activities')).resolves.toBe(3);
      await expect(countAs(ctxA, 'work_projects')).resolves.toBe(3);
      await expect(countAs(ctxA, 'work_tasks')).resolves.toBe(5);
      await expect(countAs(ctxA, 'jobs')).resolves.toBe(5);
      await expect(countAs(ctxA, 'workflow_executions')).resolves.toBe(3);
    });

    it('bob’s identity sees exactly Org B rows in every analytics table', async () => {
      await expect(countAs(ctxB, 'deals')).resolves.toBe(2);
      await expect(countAs(ctxB, 'contacts')).resolves.toBe(5);
      await expect(countAs(ctxB, 'companies')).resolves.toBe(3);
      await expect(countAs(ctxB, 'activities')).resolves.toBe(4);
      await expect(countAs(ctxB, 'work_projects')).resolves.toBe(1);
      await expect(countAs(ctxB, 'work_tasks')).resolves.toBe(3);
      await expect(countAs(ctxB, 'jobs')).resolves.toBe(3);
      await expect(countAs(ctxB, 'workflow_executions')).resolves.toBe(1);
    });

    it('no identity can count the other org’s rows — cross sums are exact', async () => {
      // If RLS admitted foreign rows, these would exceed the seeded totals.
      const aDeals = await countAs(ctxA, 'deals');
      const bDeals = await countAs(ctxB, 'deals');
      expect(aDeals + bDeals).toBe(7); // 5 + 2 seeded, nothing more
    });
  });
});
