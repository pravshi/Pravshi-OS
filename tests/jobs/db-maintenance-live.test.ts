/**
 * WP-2 (Core V1 audit D-1, D-2) — database maintenance LIVE DB tests.
 *
 * Migration 0065 adds two worker-plane SECURITY DEFINER functions, driven by
 * src/worker/maintenance.ts on the worker's maintenance cadence:
 *
 *   - maintain_audit_log_partitions(): keeps audit_logs partitioned twelve
 *     months ahead (no DEFAULT partition exists, so a lapsed window would fail
 *     every audited write);
 *   - run_data_retention(limit): deletes operational history and expired auth
 *     bookkeeping past fixed periods, in bounded batches.
 *
 * Only real Postgres can prove which rows go and which must stay, so this file
 * seeds rows as the owner (DATABASE_URL_MIGRATE) and calls the same functions
 * the worker calls. Retention is global across orgs, so every assertion is
 * about THIS file's rows (fresh org per run), never about global counts.
 *
 * Deliberately NOT done here: dropping a live audit partition to watch it come
 * back. Partition DDL takes a lock on audit_logs that parallel suites write to;
 * the window assertions below prove the function's contract without it.
 *
 * Gated behind DB_READY; runs in CI against the ephemeral Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

import {
  DB_READY,
  inContext,
  mkOrg,
  mkPerson,
  mkWorkflow,
  RUN,
  sqlstateOf,
} from '../workflows/helpers';

describe.skipIf(!DB_READY)('database maintenance (live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  const appUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
  // The worker's own login (0070): the only role that may run maintenance.
  const appWorker = new Pool({ connectionString: process.env.DATABASE_URL_WORKER });
  let orgId = '';
  let personId = '';

  let maintainAuditLogPartitions: typeof import('@/worker/maintenance').maintainAuditLogPartitions;
  let runDataRetention: typeof import('@/worker/maintenance').runDataRetention;

  beforeAll(async () => {
    if (!DB_READY) return;
    ({ maintainAuditLogPartitions, runDataRetention } = await import('@/worker/maintenance'));
    orgId = await mkOrg(owner, `maint-${RUN}`);
    personId = await mkPerson(owner, orgId, `Maint ${RUN}`);
  }, 60_000);

  afterAll(async () => {
    if (!DB_READY) return;
    // Org cleanup intentionally omitted (system roles make orgs undeletable; the CI
    // database is discarded after the run) — the reaper-live.test.ts pattern.
    await owner.end();
    await appUser.end();
    await appWorker.end();
  });

  const exists = async (table: string, id: string) =>
    (await owner.query(`select 1 from ${table} where id = $1::uuid`, [id])).rows.length === 1;

  // ── Audit partitions (D-1) ────────────────────────────────────────────────

  describe('audit partitions', () => {
    it('keeps the window at least twelve months ahead and reports its real end', async () => {
      const { windowEnd } = await maintainAuditLogPartitions();

      // The bound the function reports must be the catalog's actual last bound.
      const { rows } = await owner.query<{ end: string }>(
        `select max((regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \\(''([0-9-]+)'))[1]::date)::text as end
         from pg_inherits i join pg_class c on c.oid = i.inhrelid
         where i.inhparent = 'public.audit_logs'::regclass`,
      );
      expect(windowEnd).toBe(rows[0]!.end);

      // Current month + 12 means the window ends no earlier than month + 13.
      const { rows: min } = await owner.query<{ d: string }>(
        `select (date_trunc('month', now()) + interval '13 months')::date::text as d`,
      );
      expect(windowEnd >= min[0]!.d).toBe(true);
    });

    it('is idempotent: a second pass with the window full creates nothing', async () => {
      await maintainAuditLogPartitions();
      const second = await maintainAuditLogPartitions();
      expect(second.created).toBe(0);
    });
  });

  // ── Worker-plane only ─────────────────────────────────────────────────────

  describe('who may call', () => {
    it('refuses a signed-in person context with 42501 (both functions, either role)', async () => {
      const ctx = { personId, orgId };
      for (const pool of [appUser, appWorker]) {
        expect(
          await sqlstateOf(
            inContext(pool, ctx, `select * from public.maintain_audit_log_partitions()`),
          ),
        ).toBe('42501');
        expect(
          await sqlstateOf(inContext(pool, ctx, `select * from public.run_data_retention(10)`)),
        ).toBe('42501');
      }
    });

    it('runs for app_worker with no identity set — the worker plane', async () => {
      const rows = await inContext(appWorker, {}, `select * from public.run_data_retention(1)`);
      expect(rows.length).toBe(12);
    });

    it('refuses app_user even with no identity set (0070: worker role only)', async () => {
      expect(
        await sqlstateOf(inContext(appUser, {}, `select * from public.run_data_retention(1)`)),
      ).toBe('42501');
      expect(
        await sqlstateOf(
          inContext(appUser, {}, `select * from public.maintain_audit_log_partitions()`),
        ),
      ).toBe('42501');
    });

    it('rejects an out-of-range batch limit (22023)', async () => {
      for (const bad of [0, 10001]) {
        expect(
          await sqlstateOf(
            inContext(appWorker, {}, `select * from public.run_data_retention($1)`, [bad]),
          ),
        ).toBe('22023');
      }
    });
  });

  // ── Retention (D-2) ───────────────────────────────────────────────────────

  describe('retention', () => {
    const insertJob = async (status: string, age: string): Promise<string> =>
      (
        await owner.query<{ id: string }>(
          `insert into public.jobs (org_id, type, status, next_run_at, created_at)
           values ($1::uuid, 'email', $2, now(), now() - ($3)::interval)
           returning id`,
          [orgId, status, age],
        )
      ).rows[0]!.id;

    it('jobs: deletes only succeeded/cancelled older than 90 days; keeps dead_letter, failed and recent', async () => {
      const oldSucceeded = await insertJob('succeeded', '100 days');
      const oldCancelled = await insertJob('cancelled', '100 days');
      const oldDeadLetter = await insertJob('dead_letter', '100 days');
      const oldFailed = await insertJob('failed', '100 days');
      const recentSucceeded = await insertJob('succeeded', '10 days');

      await runDataRetention(10000);

      expect(await exists('public.jobs', oldSucceeded)).toBe(false);
      expect(await exists('public.jobs', oldCancelled)).toBe(false);
      expect(await exists('public.jobs', oldDeadLetter)).toBe(true);
      expect(await exists('public.jobs', oldFailed)).toBe(true);
      expect(await exists('public.jobs', recentSucceeded)).toBe(true);
    });

    it('jobs with webhook deliveries: the delivery goes first, then the job, in one pass', async () => {
      const subscriptionId = (
        await owner.query<{ id: string }>(
          `insert into public.integration_webhook_subscriptions (org_id, url)
           values ($1::uuid, 'https://example.com/hook') returning id`,
          [orgId],
        )
      ).rows[0]!.id;
      const jobId = await insertJob('succeeded', '100 days');
      const deliveryId = (
        await owner.query<{ id: string }>(
          `insert into public.integration_webhook_deliveries (org_id, subscription_id, job_id, event_key)
           values ($1::uuid, $2::uuid, $3::uuid, $4) returning id`,
          [orgId, subscriptionId, jobId, `deal.won:${RUN}`],
        )
      ).rows[0]!.id;
      const recentJobId = await insertJob('succeeded', '10 days');
      const recentDeliveryId = (
        await owner.query<{ id: string }>(
          `insert into public.integration_webhook_deliveries (org_id, subscription_id, job_id, event_key)
           values ($1::uuid, $2::uuid, $3::uuid, $4) returning id`,
          [orgId, subscriptionId, recentJobId, `deal.lost:${RUN}`],
        )
      ).rows[0]!.id;

      await runDataRetention(10000);

      expect(await exists('public.integration_webhook_deliveries', deliveryId)).toBe(false);
      expect(await exists('public.jobs', jobId)).toBe(false);
      expect(await exists('public.integration_webhook_deliveries', recentDeliveryId)).toBe(true);
      expect(await exists('public.jobs', recentJobId)).toBe(true);
    });

    it('notifications: read over 90 days ago or created over 365 days ago go; the rest stay', async () => {
      const insert = async (createdAge: string, readAge: string | null) =>
        (
          await owner.query<{ id: string }>(
            `insert into public.notifications (org_id, person_id, type, title, message, created_at, read_at)
             values ($1::uuid, $2::uuid, 'SYSTEM_ALERT', 't', 'm', now() - ($3)::interval,
                     case when $4::text is null then null else now() - ($4)::interval end)
             returning id`,
            [orgId, personId, createdAge, readAge],
          )
        ).rows[0]!.id;
      const readLongAgo = await insert('120 days', '100 days');
      const unreadOld = await insert('100 days', null);
      const unreadAncient = await insert('400 days', null);
      const readRecently = await insert('20 days', '10 days');

      await runDataRetention(10000);

      expect(await exists('public.notifications', readLongAgo)).toBe(false);
      expect(await exists('public.notifications', unreadOld)).toBe(true);
      expect(await exists('public.notifications', unreadAncient)).toBe(false);
      expect(await exists('public.notifications', readRecently)).toBe(true);
    });

    it('workflow executions: finished over 180 days ago go; running and recent stay', async () => {
      const wf = await mkWorkflow(owner, orgId);
      const insert = async (status: string, finishedAge: string | null) =>
        (
          await owner.query<{ id: string }>(
            `insert into public.workflow_executions
               (org_id, workflow_id, workflow_version, dedup_key, status, trigger_type, started_at, finished_at)
             values ($1::uuid, $2::uuid, 1, $3, $4, 'manual', now() - interval '300 days',
                     case when $5::text is null then null else now() - ($5)::interval end)
             returning id`,
            [orgId, wf.id, `maint-${RUN}-${Math.random()}`, status, finishedAge],
          )
        ).rows[0]!.id;
      const oldSucceeded = await insert('SUCCEEDED', '200 days');
      const stillRunning = await insert('RUNNING', null);
      const recentFailed = await insert('FAILED', '100 days');

      await runDataRetention(10000);

      expect(await exists('public.workflow_executions', oldSucceeded)).toBe(false);
      expect(await exists('public.workflow_executions', stillRunning)).toBe(true);
      expect(await exists('public.workflow_executions', recentFailed)).toBe(true);
    });

    it('rate-limit bookkeeping: windows older than a day go, current ones stay', async () => {
      const oldKey = `maint-old-${RUN}`;
      const newKey = `maint-new-${RUN}`;
      await owner.query(
        `insert into auth.auth_rate_limits (key, count, last_request) values
           ($1, 1, (extract(epoch from now() - interval '2 days') * 1000)::bigint),
           ($2, 1, (extract(epoch from now()) * 1000)::bigint)`,
        [oldKey, newKey],
      );
      await owner.query(
        `insert into auth.api_rate_limits (key, window_start) values
           ($1, now() - interval '2 days'), ($2, now())`,
        [oldKey, newKey],
      );

      await runDataRetention(10000);

      const left = async (table: string) =>
        (
          await owner.query<{ key: string }>(
            `select key from ${table} where key = any($1::text[]) order by key`,
            [[oldKey, newKey]],
          )
        ).rows.map((r) => r.key);
      expect(await left('auth.auth_rate_limits')).toEqual([newKey]);
      expect(await left('auth.api_rate_limits')).toEqual([newKey]);
    });

    it('never deletes more than the batch limit per target in one call', async () => {
      await insertJob('succeeded', '100 days');
      await insertJob('succeeded', '100 days');
      await insertJob('succeeded', '100 days');

      const counts = await runDataRetention(1);
      for (const [target, n] of Object.entries(counts)) {
        expect(n, target).toBeLessThanOrEqual(1);
      }
      expect(Object.keys(counts)).toHaveLength(12);
    });
  });
});
