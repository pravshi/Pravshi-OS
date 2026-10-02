import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { createDeal, getDeal, updateDeal } from '@/lib/crm/deals';
import { getForecast } from '@/lib/crm/pipelines';
import { requirePermission, type Authorization } from '@/lib/authz/require-permission';
import { headersFor, mkAccount, mkCustomRole, type Account } from '../authz/fixtures';

/**
 * Phase 3 exit fixes — service-level coverage for the deal pipeline assignment
 * and the currency-grouped forecast.
 *
 * These tests call the real service functions (createDeal / updateDeal /
 * getForecast) with genuine Authorizations minted by requirePermission() through
 * real Better Auth sessions (the shared Task 1.15 fixtures), so they exercise
 * the full path: zod boundary → withAuthorizedDb (RLS identity) → the 0039
 * SECURITY DEFINER resolvers → triggers (history, closed_at).
 *
 * Run with the CI test environment (DATABASE_URL on the pooled host, APP_URL,
 * NODE_ENV=test, BETTER_AUTH_SECRET) — src/env.ts validates at import time.
 *
 * Covers:
 *  - createDeal assigns the org's default pipeline and the stage matching the
 *    legacy stage name, and writes the history creation row
 *  - createDeal maps WON through the terminal flags on renamed stages
 *  - createDeal fails closed (INVALID_REQUEST) when the org has no live
 *    default pipeline
 *  - updateDeal PATCH {stage} dual-writes pipeline_stage_id: a history row is
 *    written and the forecast sees the move
 *  - getForecast groups money by currency (byCurrency / totalsByCurrency)
 *    while keeping the legacy mixed-currency totals shape
 */

if (!process.env.DATABASE_URL && process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

/** Unique per run: these tables are permanent and the suite must be re-runnable. */
const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `S${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

const mkOrg = async (slug: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1,$2) returning id`,
      [`SVC ${slug}`, slug],
    )
  ).rows[0]!.id;

const mkDept = async (org: string, code: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1,$2,$3) returning id`,
      [org, code, `Dept ${code}`],
    )
  ).rows[0]!.id;

const defaultPipelineOf = async (org: string) =>
  (
    await owner.query<{ id: string }>(
      `select p.id from public.pipelines p
       where p.org_id = $1 and p.is_default and p.deleted_at is null`,
      [org],
    )
  ).rows[0]!.id;

const stageIdByName = async (pipeline: string, name: string) =>
  (
    await owner.query<{ id: string }>(
      `select s.id from public.pipeline_stages s where s.pipeline_id = $1 and s.name = $2`,
      [pipeline, name],
    )
  ).rows[0]!.id;

let org = '';
let orgFx = '';
let seller!: Account;
let forecaster!: Account;

/** A genuine Authorization, minted by requirePermission() through the account's session. */
const authFor = (permission: string): Promise<Authorization> =>
  requirePermission(headersFor(seller.cookie), { permission });

const authFx = (permission: string): Promise<Authorization> =>
  requirePermission(headersFor(forecaster.cookie), { permission });

beforeAll(async () => {
  org = await mkOrg(`svc-${RUN}`);
  orgFx = await mkOrg(`svc-fx-${RUN}`);
  const dept = await mkDept(org, `${CODE}_1`);
  const deptFx = await mkDept(orgFx, `${CODE}_2`);
  const sellerRole = await mkCustomRole(owner, org, `${CODE}_D`, [
    ['deals.view', 'GLOBAL'],
    ['deals.create', 'GLOBAL'],
    ['deals.edit', 'GLOBAL'],
    ['pipelines.view', 'GLOBAL'],
  ]);
  const fxRole = await mkCustomRole(owner, orgFx, `${CODE}_F`, [
    ['deals.view', 'GLOBAL'],
    ['deals.create', 'GLOBAL'],
    ['deals.edit', 'GLOBAL'],
    ['pipelines.view', 'GLOBAL'],
  ]);
  seller = await mkAccount(owner, {
    org,
    dept,
    run: RUN,
    label: 'SV-Seller',
    customRoles: [sellerRole],
  });
  forecaster = await mkAccount(owner, {
    org: orgFx,
    dept: deptFx,
    run: RUN,
    label: 'SV-Forecaster',
    customRoles: [fxRole],
  });
});

afterAll(async () => {
  await owner.end();
});

describe('createDeal pipeline assignment', () => {
  it('assigns the default pipeline and the stage matching the legacy stage name', async () => {
    const pipe = await defaultPipelineOf(org);
    const deal = await createDeal(await authFor('deals.create'), {
      title: `Assigned ${RUN}`,
      stage: 'QUALIFIED',
      value: '1000',
    });
    expect(deal.pipelineId).toBe(pipe);
    expect(deal.pipelineStageId).toBe(await stageIdByName(pipe, 'QUALIFIED'));
    expect(deal.stage).toBe('QUALIFIED');
    // The creation history row was written (from NULL → QUALIFIED stage).
    const history = (
      await owner.query<{ from_stage_id: string | null; to_stage_id: string }>(
        `select from_stage_id, to_stage_id from public.deal_stage_history where deal_id = $1`,
        [deal.id],
      )
    ).rows;
    expect(history).toHaveLength(1);
    expect(history[0]!.from_stage_id).toBeNull();
    expect(history[0]!.to_stage_id).toBe(deal.pipelineStageId);
  });

  it('maps WON through the terminal flags when stage names are customized', async () => {
    const pipe = await defaultPipelineOf(org);
    await owner.query(
      `update public.pipeline_stages set name = 'Closed Won' where pipeline_id = $1 and is_won`,
      [pipe],
    );
    try {
      const deal = await createDeal(await authFor('deals.create'), {
        title: `Won Deal ${RUN}`,
        stage: 'WON',
      });
      expect(deal.pipelineId).toBe(pipe);
      expect(deal.pipelineStageId).toBe(await stageIdByName(pipe, 'Closed Won'));
      expect(deal.stage).toBe('WON');
      expect(deal.closedAt).not.toBeNull();
    } finally {
      await owner.query(
        `update public.pipeline_stages set name = 'WON' where pipeline_id = $1 and is_won`,
        [pipe],
      );
    }
  });

  it('fails closed with INVALID_REQUEST when the org has no live default pipeline', async () => {
    const pipe = await defaultPipelineOf(org);
    await owner.query(`update public.pipelines set deleted_at = now() where id = $1`, [pipe]);
    try {
      await expect(
        createDeal(await authFor('deals.create'), { title: `Orphan ${RUN}` }),
      ).rejects.toThrow(/INVALID_REQUEST.*no default pipeline/);
    } finally {
      await owner.query(`select public.seed_default_pipeline($1::uuid)`, [org]);
    }
  });
});

describe('updateDeal stage patch dual-write', () => {
  it('writes pipeline_stage_id and a history row when the legacy stage is patched', async () => {
    const pipe = await defaultPipelineOf(org);
    const created = await createDeal(await authFor('deals.create'), {
      title: `Dual Write ${RUN}`,
      stage: 'NEW',
    });
    expect(created.pipelineStageId).toBe(await stageIdByName(pipe, 'NEW'));

    const updated = await updateDeal(await authFor('deals.edit'), created.id, { stage: 'WON' });
    expect(updated.stage).toBe('WON');
    expect(updated.pipelineStageId).toBe(await stageIdByName(pipe, 'WON'));
    expect(updated.closedAt).not.toBeNull();

    // One creation row + one movement row; the movement goes NEW → WON.
    const history = (
      await owner.query<{ from_stage_id: string | null; to_stage_id: string }>(
        `select from_stage_id, to_stage_id from public.deal_stage_history
         where deal_id = $1 order by changed_at`,
        [created.id],
      )
    ).rows;
    expect(history).toHaveLength(2);
    expect(history[1]!.from_stage_id).toBe(await stageIdByName(pipe, 'NEW'));
    expect(history[1]!.to_stage_id).toBe(await stageIdByName(pipe, 'WON'));

    // The forecast sees the deal in WON now — the writers no longer diverge.
    const forecast = await getForecast(await authFor('pipelines.view'), pipe);
    const won = forecast.stages.find((s) => s.stageId === updated.pipelineStageId);
    expect(won!.dealCount).toBeGreaterThanOrEqual(1);
  });

  it('a stage patch that changes nothing writes no extra history row', async () => {
    const created = await createDeal(await authFor('deals.create'), {
      title: `Noop Patch ${RUN}`,
      stage: 'QUALIFIED',
    });
    const before = (
      await owner.query(
        `select count(*)::int n from public.deal_stage_history where deal_id = $1`,
        [created.id],
      )
    ).rows[0]!.n;
    await updateDeal(await authFor('deals.edit'), created.id, {
      stage: 'QUALIFIED',
      title: `Noop Patch ${RUN} (renamed)`,
    });
    const after = (
      await owner.query(
        `select count(*)::int n from public.deal_stage_history where deal_id = $1`,
        [created.id],
      )
    ).rows;
    expect(after[0]!.n).toBe(before);
  });
});

describe('getForecast currency grouping', () => {
  it('groups money by currency instead of summing across currencies', async () => {
    // A dedicated org keeps the currency assertions exact.
    const pipe = await defaultPipelineOf(orgFx);
    const tag = `FX ${RUN}`;
    await createDeal(await authFx('deals.create'), {
      title: `${tag} INR 1`,
      stage: 'NEW',
      currency: 'INR',
      value: '100',
    });
    await createDeal(await authFx('deals.create'), {
      title: `${tag} INR 2`,
      stage: 'NEW',
      currency: 'INR',
      value: '200',
    });
    await createDeal(await authFx('deals.create'), {
      title: `${tag} USD 1`,
      stage: 'NEW',
      currency: 'USD',
      value: '1000',
    });

    const forecast = await getForecast(await authFx('pipelines.view'), pipe);
    // NEW has probability 10: weighted = value × 10 / 100.
    // (Postgres returns numeric aggregates with scale, e.g. "300.0000".)
    const inr = forecast.totalsByCurrency.find((t) => t.currency === 'INR')!;
    const usd = forecast.totalsByCurrency.find((t) => t.currency === 'USD')!;
    expect(inr.dealCount).toBe(2);
    expect(Number(inr.totalValue)).toBe(300);
    expect(Number(inr.weightedValue)).toBe(30);
    expect(usd.dealCount).toBe(1);
    expect(Number(usd.totalValue)).toBe(1000);
    expect(Number(usd.weightedValue)).toBe(100);

    const newStage = forecast.stages.find((s) => s.stageName === 'NEW')!;
    expect(newStage.byCurrency).toHaveLength(2);
    const inrStage = newStage.byCurrency.find((c) => c.currency === 'INR')!;
    const usdStage = newStage.byCurrency.find((c) => c.currency === 'USD')!;
    expect(inrStage.dealCount).toBe(2);
    expect(Number(inrStage.totalValue)).toBe(300);
    expect(usdStage.dealCount).toBe(1);
    expect(Number(usdStage.totalValue)).toBe(1000);

    // Backward compatibility: the legacy mixed-currency aggregate is still present.
    expect(forecast.totals).toMatchObject({ dealCount: 3 });
    expect(forecast.totals.totalValue).toBeTruthy();
    for (const s of forecast.stages) {
      expect(Array.isArray(s.byCurrency)).toBe(true);
    }
  });

  it('a stage with no deals has an empty byCurrency', async () => {
    const pipe = await defaultPipelineOf(orgFx);
    const forecast = await getForecast(await authFx('pipelines.view'), pipe);
    const proposal = forecast.stages.find((s) => s.stageName === 'PROPOSAL')!;
    expect(proposal.dealCount).toBe(0);
    expect(proposal.byCurrency).toEqual([]);
  });
});

describe('getDeal round-trip', () => {
  it('returns the assigned pipeline columns', async () => {
    const created = await createDeal(await authFor('deals.create'), {
      title: `Round Trip ${RUN}`,
      stage: 'NEGOTIATION',
    });
    const fetched = await getDeal(await authFor('deals.view'), created.id);
    expect(fetched.pipelineId).toBe(created.pipelineId);
    expect(fetched.pipelineStageId).toBe(created.pipelineStageId);
  });
});
