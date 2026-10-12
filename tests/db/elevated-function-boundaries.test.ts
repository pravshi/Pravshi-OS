/**
 * WP-T2 — tenant boundaries inside elevated (SECURITY DEFINER) functions, and
 * background work that stops for organizations that are not ACTIVE
 * (migration 0068; multi-tenant audit MT-M2, design decision K10). LIVE DB.
 *
 * Each affected function gets a negative test (the cross-tenant or
 * identity-less call 0068 refuses) and a positive one (the legitimate caller
 * still works). The lifecycle block then walks every listed background-work
 * path through SUSPENDED / ARCHIVED / deleted and back to ACTIVE.
 *
 * Isolation: the worker-plane functions are global across organizations and
 * other suites run in parallel on the same database. Every lifecycle check
 * therefore seeds its rows, flips the organization's state and calls the
 * function inside ONE owner transaction that is always rolled back, with
 * timestamps in the distant past (and an ACTIVE-org control row just after
 * them), so a `limit 1` claim answers exactly "was the inactive org's row
 * skipped?" and nothing another suite owns is ever claimed or seen.
 *
 * Gated behind DB_READY; runs in CI against the ephemeral Postgres.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from '@neondatabase/serverless';

import {
  DB_READY,
  mkOrg,
  mkPerson,
  mkRoleFor,
  mkTask,
  mkWorkflow,
  RUN,
  sqlstateOf,
} from '../workflows/helpers';

const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';
const hex = () => randomBytes(32).toString('hex');

type Ctx = { personId?: string | null; orgId?: string | null };

describe.skipIf(!DB_READY)('elevated function boundaries (0068, live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  const appUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
  // The worker's own login (0070): worker-plane functions belong to it alone.
  const appWorker = new Pool({ connectionString: process.env.DATABASE_URL_WORKER });

  let orgA = '';
  let orgB = '';
  let orgS = ''; // the organization the lifecycle block suspends / archives / deletes
  let orgX = ''; // a committed-SUSPENDED organization (person-context refusal)
  let alice = ''; // orgA, holds jobs.delete
  let carol = ''; // orgA, engaged, holds nothing
  let bob = ''; // orgB
  let xavier = ''; // orgX, holds jobs.delete
  let protectedHolder = ''; // orgA, holds roles.manage → derived protection
  let sPerson = '';
  let sTask = '';
  let sWorkflow = '';
  let aWorkflow = '';
  let aTask = '';
  let aliceAuthUser = '';
  const aliceEmail = `alice.elev.${RUN}@example.test`;
  let subA = '';
  let subB = '';
  const hashA = hex();
  const hashB = hex();
  const hashS = hex();
  let connA = '';
  let receiptA = '';

  beforeAll(async () => {
    if (!DB_READY) return;
    orgA = await mkOrg(owner, `elev-a-${RUN}`);
    orgB = await mkOrg(owner, `elev-b-${RUN}`);
    orgS = await mkOrg(owner, `elev-s-${RUN}`);
    orgX = await mkOrg(owner, `elev-x-${RUN}`);
    alice = await mkPerson(owner, orgA, `Alice Elev ${RUN}`);
    carol = await mkPerson(owner, orgA, `Carol Elev ${RUN}`);
    bob = await mkPerson(owner, orgB, `Bob Elev ${RUN}`);
    xavier = await mkPerson(owner, orgX, `Xavier Elev ${RUN}`);
    protectedHolder = await mkPerson(owner, orgA, `Prot Elev ${RUN}`);
    sPerson = await mkPerson(owner, orgS, `Sam Elev ${RUN}`);
    await mkRoleFor(owner, orgA, alice, `ELEV_DEL_${RUN}`, ['jobs.delete']);
    await mkRoleFor(owner, orgX, xavier, `ELEV_DELX_${RUN}`, ['jobs.delete']);
    await mkRoleFor(owner, orgA, protectedHolder, `ELEV_PROT_${RUN}`, ['roles.manage']);
    await owner.query(`update public.organizations set status = 'SUSPENDED' where id = $1`, [orgX]);

    aWorkflow = (await mkWorkflow(owner, orgA)).id;
    sWorkflow = (await mkWorkflow(owner, orgS)).id;
    aTask = await mkTask(owner, orgA, null, `elev task a ${RUN}`);
    sTask = await mkTask(owner, orgS, null, `elev task s ${RUN}`);

    aliceAuthUser = (
      await owner.query<{ id: string }>(
        `insert into auth.auth_users (name, email) values ($1, $2) returning id`,
        [`Alice Elev ${RUN}`, aliceEmail],
      )
    ).rows[0]!.id;
    await owner.query(`update public.people set work_email = $2, auth_user_id = $3 where id = $1`, [
      alice,
      aliceEmail,
      aliceAuthUser,
    ]);

    const ins = async (text: string, params: unknown[]) =>
      (await owner.query<{ id: string }>(text, params)).rows[0]!.id;
    subA = await ins(
      `insert into public.integration_webhook_subscriptions (org_id, url, events, signing_secret_ciphertext)
       values ($1, 'https://example.com/a', array['*'], $2) returning id`,
      [orgA, `cipher-a-${RUN}`],
    );
    subB = await ins(
      `insert into public.integration_webhook_subscriptions (org_id, url, events, signing_secret_ciphertext)
       values ($1, 'https://example.com/b', array['*'], $2) returning id`,
      [orgB, `cipher-b-${RUN}`],
    );
    connA = await ins(
      `insert into public.integration_connections
         (org_id, provider_key, display_name, status, config, connected_by, inbound_endpoint_key_hash)
       values ($1, 'webhooks', $2, 'CONNECTED', '{}'::jsonb, $3, $4) returning id`,
      [orgA, `Elev A ${RUN}`, alice, hashA],
    );
    await ins(
      `insert into public.integration_connections
         (org_id, provider_key, display_name, status, config, connected_by, inbound_endpoint_key_hash)
       values ($1, 'webhooks', $2, 'CONNECTED', '{}'::jsonb, $3, $4) returning id`,
      [orgB, `Elev B ${RUN}`, bob, hashB],
    );
    await ins(
      `insert into public.integration_connections
         (org_id, provider_key, display_name, status, config, connected_by, inbound_endpoint_key_hash)
       values ($1, 'webhooks', $2, 'CONNECTED', '{}'::jsonb, $3, $4) returning id`,
      [orgS, `Elev S ${RUN}`, sPerson, hashS],
    );
    receiptA = await ins(
      `insert into public.integration_inbound_events
         (org_id, connection_id, provider_key, endpoint_key, external_event_id, payload_hash, status)
       values ($1, $2, 'webhooks', $3, $4, $5, 'RECEIVED') returning id`,
      [orgA, connA, hashA, `elev-evt-${RUN}`, hex()],
    );
  }, 120_000);

  afterAll(async () => {
    await owner.end();
    await appUser.end();
    await appWorker.end();
  });

  /** One committed transaction as app_user (or the given pool), carrying exactly the identity given. */
  async function asUser<T extends Record<string, unknown> = Record<string, unknown>>(
    ctx: Ctx,
    text: string,
    params: unknown[] = [],
    pool: Pool = appUser,
    extra: Record<string, string> = {},
  ): Promise<T[]> {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
        [ctx.personId ?? '', ctx.orgId ?? ''],
      );
      for (const [name, value] of Object.entries(extra)) {
        await c.query(`select set_config($1, $2, true)`, [name, value]);
      }
      const result = await c.query<T>(text, params);
      await c.query('commit');
      return result.rows;
    } catch (error) {
      await c.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }

  /** Run `fn` in one owner transaction that is ALWAYS rolled back. */
  async function rolledBack<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await owner.connect();
    try {
      await c.query('begin');
      return await fn(c);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  }

  // ── PART 1: jobs_claim_next ─────────────────────────────────────────────
  describe('jobs_claim_next', () => {
    it('refuses a person context — a tenant request can never claim a job', async () => {
      expect(
        await sqlstateOf(
          asUser(
            { personId: alice, orgId: orgA },
            `select id from public.jobs_claim_next('elev', null)`,
          ),
        ),
      ).toBe('42501');
    });

    it('app_user cannot claim at all, even with no identity (0070: the worker role only)', async () => {
      expect(
        await sqlstateOf(
          asUser({}, `select id from public.jobs_claim_next('elev', array['cleanup'])`),
        ),
      ).toBe('42501');
    });

    it('still claims on the worker plane (app_worker, no identity) — see the lifecycle block for the claim itself', async () => {
      // Identity-less call reaches the claim (no 42501). Inside a rolled-back
      // transaction so nothing another suite queued is consumed.
      const c = await appWorker.connect();
      try {
        await c.query('begin');
        await expect(
          c.query(`select id from public.jobs_claim_next('elev', array['cleanup'])`),
        ).resolves.toBeDefined();
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
    });
  });

  // ── PART 2: integration_webhook_resolve_delivery ────────────────────────
  describe('integration_webhook_resolve_delivery', () => {
    // The worker resolves secrets (0070: app_worker only, bound to the webhook job it
    // holds — org A's here); the context-kind assertion (0068) still applies.
    const ELEV_WORKER = `elev-webhook-worker-${RUN}`;
    let heldWebhookA = '';
    beforeAll(async () => {
      heldWebhookA = (
        await owner.query<{ id: string }>(
          `insert into public.jobs (org_id, type, status, payload, next_run_at, claimed_by, claimed_at, heartbeat_at)
           values ($1, 'webhook', 'running', '{}'::jsonb, now() + interval '30 days', $2, now(), now() + interval '30 days')
           returning id`,
          [orgA, ELEV_WORKER],
        )
      ).rows[0]!.id;
    });
    const resolve = (ctx: Ctx, org: string, sub: string, pool: Pool = appWorker) =>
      asUser<{ is_active: boolean; signing_secret_ciphertext: string }>(
        ctx,
        `select is_active, signing_secret_ciphertext
           from public.integration_webhook_resolve_delivery($1::uuid, $2::uuid)`,
        [org, sub],
        pool,
        { 'app.work_kind': 'job', 'app.work_id': heldWebhookA, 'app.worker_id': ELEV_WORKER },
      );

    it('app_user cannot resolve a secret in any context — not even its own org (0070)', async () => {
      expect(await sqlstateOf(resolve({ personId: alice, orgId: orgA }, orgA, subA, appUser))).toBe(
        '42501',
      );
      expect(
        await sqlstateOf(resolve({ personId: SYSTEM_ACTOR, orgId: orgA }, orgA, subA, appUser)),
      ).toBe('42501');
    });

    it('answers its own organization — person context and worker (system-actor) context', async () => {
      expect(await resolve({ personId: alice, orgId: orgA }, orgA, subA)).toEqual([
        { is_active: true, signing_secret_ciphertext: `cipher-a-${RUN}` },
      ]);
      expect(await resolve({ personId: SYSTEM_ACTOR, orgId: orgA }, orgA, subA)).toEqual([
        { is_active: true, signing_secret_ciphertext: `cipher-a-${RUN}` },
      ]);
    });

    it('refuses another organization in every context kind', async () => {
      // A person naming another org.
      expect(await sqlstateOf(resolve({ personId: alice, orgId: orgA }, orgB, subB))).toBe('42501');
      // The worker holding org A's webhook job naming org B — with app.org_id saying A or B.
      expect(await sqlstateOf(resolve({ personId: SYSTEM_ACTOR, orgId: orgA }, orgB, subB))).toBe(
        '42501',
      );
      expect(await sqlstateOf(resolve({ personId: SYSTEM_ACTOR, orgId: orgB }, orgB, subB))).toBe(
        '42501',
      );
      // No identity at all.
      expect(await sqlstateOf(resolve({}, orgB, subB))).toBe('42501');
      // A person whose org claim names another org (authz.org_id() resolves to nothing).
      expect(await sqlstateOf(resolve({ personId: alice, orgId: orgB }, orgB, subB))).toBe('42501');
    });
  });

  // ── PART 3: scheduler_admin_delete ──────────────────────────────────────
  describe('scheduler_admin_delete', () => {
    const mkSchedule = async (org: string, workflowId: string) =>
      (
        await owner.query<{ id: string }>(
          `insert into public.schedules (org_id, workflow_id, name, cron, is_active, next_run_at)
           values ($1, $2, $3, '0 9 * * *', false, now() + interval '1 day') returning id`,
          [org, workflowId, `elev-${RUN}-${randomUUID().slice(0, 8)}`],
        )
      ).rows[0]!.id;
    const exists = async (id: string) =>
      (await owner.query(`select 1 from public.schedules where id = $1`, [id])).rowCount === 1;
    const del = (ctx: Ctx, id: string) =>
      asUser(ctx, `select public.scheduler_admin_delete($1::uuid)`, [id]);

    it('deletes a schedule of the caller’s own organization when the caller holds jobs.delete', async () => {
      const id = await mkSchedule(orgA, aWorkflow);
      await del({ personId: alice, orgId: orgA }, id);
      expect(await exists(id)).toBe(false);
    });

    it('refuses a transaction with no identity, or the worker plane', async () => {
      const id = await mkSchedule(orgA, aWorkflow);
      expect(await sqlstateOf(del({}, id))).toBe('42501');
      expect(await sqlstateOf(del({ personId: SYSTEM_ACTOR, orgId: orgA }, id))).toBe('42501');
      expect(await exists(id)).toBe(true);
    });

    it('refuses a person without jobs.delete', async () => {
      const id = await mkSchedule(orgA, aWorkflow);
      expect(await sqlstateOf(del({ personId: carol, orgId: orgA }, id))).toBe('42501');
      expect(await exists(id)).toBe(true);
    });

    it('refuses a person of a SUSPENDED organization, even holding jobs.delete', async () => {
      const xWorkflow = (await mkWorkflow(owner, orgX)).id;
      const id = await mkSchedule(orgX, xWorkflow);
      expect(await sqlstateOf(del({ personId: xavier, orgId: orgX }, id))).toBe('42501');
      expect(await exists(id)).toBe(true);
    });

    it('never deletes another organization’s schedule', async () => {
      const bWorkflow = (await mkWorkflow(owner, orgB)).id;
      const id = await mkSchedule(orgB, bWorkflow);
      await del({ personId: alice, orgId: orgA }, id); // no error — like a missing one
      expect(await exists(id)).toBe(true);
    });
  });

  // ── PART 4: record_login_event ──────────────────────────────────────────
  describe('record_login_event', () => {
    const record = (org: string | null, email: string | null, authUser: string | null) =>
      asUser<{ id: string }>(
        {},
        `select public.record_login_event($1::uuid, 'LOGIN_FAILURE', $2::citext, $3::uuid, null, null, '{}') as id`,
        [org, email, authUser],
      );

    it('records against the organization the email resolves to (the pre-auth callers)', async () => {
      expect((await record(orgA, aliceEmail, null))[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('records against the organization of the login’s person (the invitation-accept shape)', async () => {
      expect((await record(orgA, null, aliceAuthUser))[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        (await record(orgA, `someone-else.${RUN}@example.test`, aliceAuthUser))[0]!.id,
      ).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('records an unknown address with no organization, unchanged', async () => {
      expect((await record(null, `nobody.${RUN}@example.test`, null))[0]!.id).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    });

    it('refuses to attribute an event to an organization the event does not name', async () => {
      expect(await sqlstateOf(record(orgB, aliceEmail, null))).toBe('42501');
      expect(await sqlstateOf(record(orgB, null, aliceAuthUser))).toBe('42501');
      expect(await sqlstateOf(record(orgA, `nobody.${RUN}@example.test`, null))).toBe('42501');
      expect(await sqlstateOf(record(orgA, null, null))).toBe('42501');
    });
  });

  // ── PART 5: identity codes ──────────────────────────────────────────────
  describe('authz.next_identity_code / next_identity_code_for_current_org', () => {
    const type = `EL${RUN.toUpperCase()
      .replace(/[^A-Z]/g, 'Q')
      .slice(0, 5)}`;

    it('app_user can no longer call the organization-taking generator, for any org', async () => {
      expect(
        await sqlstateOf(
          asUser({}, `select authz.next_identity_code($1::uuid, 'EMP', '2026')`, [orgB]),
        ),
      ).toBe('42501');
      expect(
        await sqlstateOf(
          asUser(
            { personId: alice, orgId: orgA },
            `select authz.next_identity_code($1::uuid, 'EMP', '2026')`,
            [orgB],
          ),
        ),
      ).toBe('42501');
    });

    it('the wrapper advances the caller’s own organization only', async () => {
      const rows = await asUser<{ code: string }>(
        { personId: alice, orgId: orgA },
        `select authz.next_identity_code_for_current_org($1, '2026') as code`,
        [type],
      );
      expect(rows[0]!.code).toBe(`${type}-2026-0001`);
      const next = async (org: string) =>
        (
          await owner.query<{ c: string }>(
            `select authz.next_identity_code($1::uuid, $2, '2026') c`,
            [org, type],
          )
        ).rows[0]!.c;
      expect(await next(orgA)).toBe(`${type}-2026-0002`);
      expect(await next(orgB)).toBe(`${type}-2026-0001`);
    });

    it('the wrapper refuses no identity, the worker plane, and a mismatched org claim', async () => {
      const call = (ctx: Ctx) =>
        asUser(ctx, `select authz.next_identity_code_for_current_org('EMP', '2026')`);
      expect(await sqlstateOf(call({}))).toBe('42501');
      expect(await sqlstateOf(call({ personId: SYSTEM_ACTOR, orgId: orgA }))).toBe('42501');
      expect(await sqlstateOf(call({ personId: alice, orgId: orgB }))).toBe('42501');
    });
  });

  // ── PART 6: integration_inbound_set_receipt_status ──────────────────────
  describe('integration_inbound_set_receipt_status', () => {
    const NIL = '00000000-0000-0000-0000-000000000000';
    const setStatus = (receipt: string, hash: string, status: string) =>
      asUser<{ ok: boolean }>(
        { personId: NIL, orgId: NIL },
        `select public.integration_inbound_set_receipt_status($1::uuid, $2, $3, true) as ok`,
        [receipt, hash, status],
      );
    const statusOf = async (id: string) =>
      (
        await owner.query<{ status: string }>(
          `select status from public.integration_inbound_events where id = $1`,
          [id],
        )
      ).rows[0]!.status;

    it('refuses a key that is not the receipt connection’s — another tenant’s key included', async () => {
      expect(await sqlstateOf(setStatus(receiptA, hashB, 'FAILED'))).toBe('42501');
      expect(await sqlstateOf(setStatus(receiptA, hex(), 'FAILED'))).toBe('42501');
      expect(await statusOf(receiptA)).toBe('RECEIVED');
    });

    it('moves the receipt with the right key; a missing receipt is a plain false', async () => {
      expect((await setStatus(receiptA, hashA, 'PROCESSED'))[0]!.ok).toBe(true);
      expect(await statusOf(receiptA)).toBe('PROCESSED');
      expect((await setStatus(randomUUID(), hashA, 'PROCESSED'))[0]!.ok).toBe(false);
    });

    it('the unverified 3-argument signature is gone', async () => {
      const { rows } = await owner.query<{ p: string | null }>(
        `select to_regprocedure('public.integration_inbound_set_receipt_status(uuid,text,boolean)')::text p`,
      );
      expect(rows[0]!.p).toBeNull();
    });
  });

  // ── PART 7: person_holds_protected_role ─────────────────────────────────
  describe('person_holds_protected_role', () => {
    const ask = (ctx: Ctx, person: string, org: string) =>
      asUser<{ p: boolean }>(
        ctx,
        `select public.person_holds_protected_role($1::uuid, $2::uuid) p`,
        [person, org],
      );

    it('answers about the caller’s own organization', async () => {
      expect((await ask({ personId: alice, orgId: orgA }, protectedHolder, orgA))[0]!.p).toBe(true);
      expect((await ask({ personId: alice, orgId: orgA }, carol, orgA))[0]!.p).toBe(false);
    });

    it('refuses another organization, no identity, and a mismatched org claim', async () => {
      expect(await sqlstateOf(ask({ personId: alice, orgId: orgA }, bob, orgB))).toBe('42501');
      expect(await sqlstateOf(ask({}, protectedHolder, orgA))).toBe('42501');
      expect(await sqlstateOf(ask({ personId: alice, orgId: orgB }, bob, orgB))).toBe('42501');
    });
  });

  // ── PART 8: background work stops for organizations that are not ACTIVE ─
  describe.each([
    ['SUSPENDED', `update public.organizations set status = 'SUSPENDED' where id = $1`],
    ['ARCHIVED', `update public.organizations set status = 'ARCHIVED' where id = $1`],
    ['deleted', `update public.organizations set deleted_at = now() where id = $1`],
  ])('an organization that is %s', (_label, deactivate) => {
    const reactivate = `update public.organizations set status = 'ACTIVE', deleted_at = null where id = $1`;

    const job = (c: PoolClient, org: string, status: string, at: string, priority = 0) =>
      c
        .query<{ id: string }>(
          `insert into public.jobs (org_id, type, status, priority, attempts, max_attempts, next_run_at,
                                    claimed_by, claimed_at, heartbeat_at)
           values ($1, 'cleanup', $2, $4, 0, 5, $3::timestamptz,
                   ${status === 'claimed' ? `'elev-w', $3::timestamptz, $3::timestamptz` : 'null, null, null'})
           returning id`,
          [org, status, at, priority],
        )
        .then((r) => r.rows[0]!.id);

    it('job claims skip it, and resume on reactivation', async () => {
      await rolledBack(async (c) => {
        const sJob = await job(c, orgS, 'pending', '1970-01-03T00:00:00Z', 2_000_000_000);
        const control = await job(c, orgA, 'pending', '1970-01-03T00:00:00Z', 1_999_999_999);
        await c.query(deactivate, [orgS]);
        const claim = async () =>
          (
            await c.query<{ id: string | null }>(
              `select id from public.jobs_claim_next('elev', null)`,
            )
          ).rows[0]!.id;
        expect(await claim()).toBe(control); // the higher-priority S job was skipped
        await c.query(reactivate, [orgS]);
        expect(await claim()).toBe(sJob);
      });
    });

    it('the retry sweep leaves its failed jobs failed, and re-queues them on reactivation', async () => {
      await rolledBack(async (c) => {
        const sJob = await job(c, orgS, 'failed', '1970-01-02T00:00:00Z');
        const control = await job(c, orgA, 'failed', '1970-01-02T00:00:01Z');
        await c.query(deactivate, [orgS]);
        const statusOf = async (id: string) =>
          (await c.query<{ status: string }>(`select status from public.jobs where id = $1`, [id]))
            .rows[0]!.status;
        expect(
          (await c.query<{ n: number }>(`select public.jobs_sweep_retryable(1) n`)).rows[0]!.n,
        ).toBe(1);
        expect(await statusOf(sJob)).toBe('failed'); // older, but skipped
        expect(await statusOf(control)).toBe('pending');
        await c.query(reactivate, [orgS]);
        await c.query(`select public.jobs_sweep_retryable(1)`);
        expect(await statusOf(sJob)).toBe('pending');
      });
    });

    it('reminder claims skip it, and resume on reactivation', async () => {
      await rolledBack(async (c) => {
        const reminder = async (org: string, task: string, person: string, at: string) =>
          (
            await c.query<{ id: string }>(
              `insert into public.task_reminders (org_id, task_id, person_id, remind_at)
               values ($1, $2, $3, $4::timestamptz) returning id`,
              [org, task, person, at],
            )
          ).rows[0]!.id;
        const sRem = await reminder(orgS, sTask, sPerson, '1970-01-02T00:00:00Z');
        const control = await reminder(orgA, aTask, alice, '1970-01-02T00:00:01Z');
        await c.query(deactivate, [orgS]);
        const claim = async () =>
          (
            await c.query<{ reminder_id: string }>(
              `select reminder_id from public.claim_due_task_reminders(1)`,
            )
          ).rows.map((r) => r.reminder_id);
        expect(await claim()).toEqual([control]);
        await c.query(reactivate, [orgS]);
        expect(await claim()).toEqual([sRem]);
      });
    });

    it('scheduler ticks skip its schedules, and resume on reactivation', async () => {
      await rolledBack(async (c) => {
        const schedule = async (org: string, wf: string, at: string) =>
          (
            await c.query<{ id: string }>(
              `insert into public.schedules (org_id, workflow_id, name, cron, timezone, is_active, next_run_at)
               values ($1, $2, $3, '0 9 * * *', 'UTC', true, $4::timestamptz) returning id`,
              [org, wf, `elev-tick-${RUN}-${randomUUID().slice(0, 8)}`, at],
            )
          ).rows[0]!.id;
        const sSched = await schedule(orgS, sWorkflow, '1970-01-02T00:00:00Z');
        const control = await schedule(orgA, aWorkflow, '1970-01-02T00:00:01Z');
        await c.query(deactivate, [orgS]);
        const tick = async () =>
          (
            await c.query<{ id: string }>(
              `select id from public.scheduler_tick_claim('1970-01-03T00:00:00Z'::timestamptz)`,
            )
          ).rows.map((r) => r.id);
        expect(await tick()).toEqual([control]);
        await c.query(reactivate, [orgS]);
        expect(await tick()).toEqual([sSched, control]);
      });
    });

    it('the next-due lookup ignores its due work but still reaps its in-flight claims', async () => {
      const due = (c: PoolClient) =>
        c
          .query<{ due: string | null }>(
            `select to_char(public.worker_next_due_at() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as due`,
          )
          .then((r) => r.rows[0]!.due);
      const ignored = (d: string | null) => expect(d === null || d > '1975-01-01').toBe(true);

      const seeds: [string, (c: PoolClient) => Promise<unknown>, string][] = [
        [
          'pending job',
          (c) => job(c, orgS, 'pending', '1970-02-01T00:00:00Z'),
          '1970-02-01T00:00:00',
        ],
        [
          'failed job',
          (c) => job(c, orgS, 'failed', '1970-03-01T00:00:00Z'),
          '1970-03-01T00:00:00',
        ],
        [
          'reminder',
          (c) =>
            c.query(
              `insert into public.task_reminders (org_id, task_id, person_id, remind_at)
               values ($1, $2, $3, '1970-04-01T00:00:00Z')`,
              [orgS, sTask, sPerson],
            ),
          '1970-04-01T00:00:00',
        ],
        [
          'schedule',
          (c) =>
            c.query(
              `insert into public.schedules (org_id, workflow_id, name, cron, timezone, is_active, next_run_at)
               values ($1, $2, $3, '0 9 * * *', 'UTC', true, '1970-05-01T00:00:00Z')`,
              [orgS, sWorkflow, `elev-due-${RUN}-${randomUUID().slice(0, 8)}`],
            ),
          '1970-05-01T00:00:00',
        ],
      ];
      for (const [label, seed, expected] of seeds) {
        await rolledBack(async (c) => {
          await seed(c);
          await c.query(deactivate, [orgS]);
          ignored(await due(c));
          await c.query(reactivate, [orgS]);
          expect(await due(c), label).toBe(expected);
        });
      }

      // In flight before the org was deactivated: the reaper must still come for it.
      await rolledBack(async (c) => {
        await job(c, orgS, 'claimed', '1970-06-01T00:00:00Z');
        await c.query(deactivate, [orgS]);
        expect(await due(c)).toBe('1970-06-01T00:01:00');
      });
    });

    it('inbound endpoints stop resolving, and resolve again on reactivation', async () => {
      await rolledBack(async (c) => {
        const resolve = async () =>
          (
            await c.query<{ org_id: string }>(
              `select org_id from public.integration_inbound_resolve_endpoint($1)`,
              [hashS],
            )
          ).rows.map((r) => r.org_id);
        expect(await resolve()).toEqual([orgS]);
        await c.query(deactivate, [orgS]);
        expect(await resolve()).toEqual([]);
        await c.query(reactivate, [orgS]);
        expect(await resolve()).toEqual([orgS]);
      });
    });
  });

  // ── PART 9: catalogue ───────────────────────────────────────────────────
  it('every function in scope is SECURITY DEFINER, search_path pinned, owned by app_owner, not PUBLIC', async () => {
    const NOT_APP_USER = new Set([
      'authz.next_identity_code(uuid,text,text)',
      'public.jobs_claim_next(text,text[])',
      'public.integration_webhook_resolve_delivery(uuid,uuid)',
      'public.scheduler_tick_claim(timestamptz)',
      'public.claim_due_task_reminders(integer)',
      'public.jobs_sweep_retryable(integer)',
      'public.worker_next_due_at()',
    ]);
    const sigs = [
      'public.jobs_claim_next(text,text[])',
      'public.integration_webhook_resolve_delivery(uuid,uuid)',
      'public.scheduler_admin_delete(uuid)',
      'public.record_login_event(uuid,text,public.citext,uuid,inet,text,jsonb)',
      'authz.next_identity_code(uuid,text,text)',
      'authz.next_identity_code_for_current_org(text,text)',
      'public.integration_inbound_set_receipt_status(uuid,text,text,boolean)',
      'public.person_holds_protected_role(uuid,uuid)',
      'public.scheduler_tick_claim(timestamptz)',
      'public.claim_due_task_reminders(integer)',
      'public.jobs_sweep_retryable(integer)',
      'public.worker_next_due_at()',
      'public.integration_inbound_resolve_endpoint(text)',
    ];
    const { rows } = await owner.query<{
      sig: string;
      definer: boolean;
      config: string[] | null;
      owner_name: string;
      public_exec: boolean;
      user_exec: boolean;
    }>(
      `select s.sig, p.prosecdef definer, p.proconfig config, pg_get_userbyid(p.proowner) owner_name,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE') public_exec,
              has_function_privilege('app_user', p.oid, 'execute') user_exec
         from unnest($1::text[]) s(sig)
         join pg_proc p on p.oid = to_regprocedure(s.sig)`,
      [sigs],
    );
    expect(rows).toHaveLength(sigs.length);
    for (const r of rows) {
      expect(r.definer, r.sig).toBe(true);
      expect(r.config, r.sig).toContain('search_path=""');
      expect(r.owner_name, r.sig).toBe('app_owner');
      expect(r.public_exec, r.sig).toBe(false);
      // 0070: worker-plane functions belong to app_worker alone; the organization-taking
      // identity-code generator is not app_user's either (0068).
      expect(r.user_exec, r.sig).toBe(!NOT_APP_USER.has(r.sig));
    }
  });
});
