/**
 * Worker-side notification and webhook-secret calls are bound to the work item the worker
 * holds (migration 0070; worker-role design §5.3). LIVE DB, real app_worker login.
 *
 * The person-less branch of notifications_insert, notifications_recipient_exists,
 * notification_channel_enabled and integration_webhook_resolve_delivery serves the worker
 * only. Its organization (and, for a reminder, its recipient) is derived from a row the
 * worker provably holds — never from app.org_id, which any caller can write:
 *   - a job: app.work_kind = 'job', app.work_id = the job, app.worker_id = the worker; the
 *     job must be running under that worker's claim, and its org is the bound org;
 *   - a reminder: app.work_kind = 'reminder', app.work_id = the reminder; the reminder must
 *     be claimed (is_sent), and its org and person are the bound org and recipient.
 * So a worker bug that names the wrong organization or person — or a forged app.org_id —
 * cannot write a notification into another tenant, read another tenant's recipients or
 * preferences, or resolve another tenant's webhook secret.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

import { DB_READY, mkOrg, mkPerson, mkTask, RUN } from '../workflows/helpers';
import { inWorkerContext, SYSTEM_ACTOR, WORKER_DB_READY, workerPool } from '../worker-role';

const READY = DB_READY && WORKER_DB_READY;
const W = `bind-worker-${RUN}`;

describe.skipIf(!READY)('worker notification binding (0070, live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  const appUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
  const asWorker = workerPool();
  let orgA = '';
  let orgB = '';
  let personA = '';
  let personA2 = '';
  let personB = '';
  let jobA = ''; // notification job of org A, running under W
  let pendingJobA = ''; // notification job of org A, not claimed
  let webhookJobA = ''; // webhook job of org A, running under W
  let reminderA = ''; // claimed (sent) reminder for personA in org A
  let unclaimedReminderA = ''; // due but not claimed
  let subA = '';
  let subB = '';

  beforeAll(async () => {
    if (!READY) return;
    orgA = await mkOrg(owner, `bind-a-${RUN}`);
    orgB = await mkOrg(owner, `bind-b-${RUN}`);
    personA = await mkPerson(owner, orgA, `Bind A ${RUN}`);
    personA2 = await mkPerson(owner, orgA, `Bind A2 ${RUN}`);
    personB = await mkPerson(owner, orgB, `Bind B ${RUN}`);
    const taskA = await mkTask(owner, orgA, null, `bind task ${RUN}`);
    const job = async (type: string, status: string) =>
      (
        await owner.query<{ id: string }>(
          `insert into public.jobs (org_id, type, status, payload, next_run_at, claimed_by, claimed_at, heartbeat_at)
           values ($1, $2, $3, '{}'::jsonb, now() + interval '30 days',
                   case when $3 = 'running' then $4 end,
                   case when $3 = 'running' then now() end,
                   case when $3 = 'running' then now() + interval '30 days' end)
           returning id`,
          [orgA, type, status, W],
        )
      ).rows[0]!.id;
    jobA = await job('notification', 'running');
    pendingJobA = await job('notification', 'pending');
    webhookJobA = await job('webhook', 'running');
    const reminder = async (sent: boolean) =>
      (
        await owner.query<{ id: string }>(
          `insert into public.task_reminders (org_id, task_id, person_id, remind_at, is_sent)
           values ($1, $2, $3, now() + interval '30 days', $4) returning id`,
          [orgA, taskA, personA, sent],
        )
      ).rows[0]!.id;
    reminderA = await reminder(true);
    unclaimedReminderA = await reminder(false);
    const sub = async (org: string, label: string) =>
      (
        await owner.query<{ id: string }>(
          `insert into public.integration_webhook_subscriptions (org_id, url, events, signing_secret_ciphertext)
           values ($1, 'https://example.com/bind', array['*'], $2) returning id`,
          [org, `bind-cipher-${label}-${RUN}`],
        )
      ).rows[0]!.id;
    subA = await sub(orgA, 'a');
    subB = await sub(orgB, 'b');
  }, 90_000);

  afterAll(async () => {
    await owner.end();
    await appUser.end();
    await asWorker.end();
  });

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ALLOWED';
    } catch (e) {
      return (e as { code?: string }).code ?? 'ERROR';
    }
  };
  const jobItem = (id: string, worker = W) => ({
    'app.work_kind': 'job',
    'app.work_id': id,
    'app.worker_id': worker,
  });
  const reminderItem = (id: string) => ({ 'app.work_kind': 'reminder', 'app.work_id': id });
  /** The worker's context as withWorkerContext sets it, optionally with a forged org claim. */
  const run = (
    org: string,
    sql: string,
    params: unknown[],
    item: Record<string, string>,
    pool: Pool = asWorker,
  ) => inWorkerContext(pool, { personId: SYSTEM_ACTOR, orgId: org }, sql, params, item);

  const INSERT = `select public.notifications_insert($1::uuid, $2::uuid, $3, 'm', '{}'::jsonb) as id`;
  const RECIPIENT = `select public.notifications_recipient_exists($1::uuid, $2::uuid) as ok`;
  const CHANNEL = `select public.notification_channel_enabled($1::uuid, $2::uuid, 'TASK_DUE', 'in_app') as ok`;
  const RESOLVE = `select signing_secret_ciphertext from public.integration_webhook_resolve_delivery($1::uuid, $2::uuid)`;
  const stored = async (title: string) =>
    (
      await owner.query<{ org_id: string; person_id: string }>(
        `select org_id, person_id from public.notifications where title = $1`,
        [title],
      )
    ).rows;

  // ── Jobs ───────────────────────────────────────────────────────────────
  it('a held notification job writes into its own organization', async () => {
    const title = `bind-ok-${RUN}`;
    await run(orgA, INSERT, [orgA, personA, title], jobItem(jobA));
    expect(await stored(title)).toEqual([{ org_id: orgA, person_id: personA }]);
  });

  it('a worker holding org A’s job cannot write into org B — not even by also claiming org B in app.org_id', async () => {
    const title = `bind-cross-${RUN}`;
    expect(await codeOf(run(orgB, INSERT, [orgB, personB, title], jobItem(jobA)))).toBe('42501');
    expect(await codeOf(run(orgA, INSERT, [orgB, personB, title], jobItem(jobA)))).toBe('42501');
    expect(await stored(title)).toEqual([]);
  });

  it('refuses a job the worker does not hold: another worker id, a pending job, or no work item', async () => {
    const title = `bind-unheld-${RUN}`;
    expect(
      await codeOf(run(orgA, INSERT, [orgA, personA, title], jobItem(jobA, 'another-worker'))),
    ).toBe('42501');
    expect(await codeOf(run(orgA, INSERT, [orgA, personA, title], jobItem(pendingJobA)))).toBe(
      '42501',
    );
    expect(await codeOf(run(orgA, INSERT, [orgA, personA, title], {}))).toBe('42501');
    expect(await stored(title)).toEqual([]);
  });

  it('recipient checks are bound the same way', async () => {
    expect((await run(orgA, RECIPIENT, [orgA, personA], jobItem(jobA))).rows[0]!.ok).toBe(true);
    expect(await codeOf(run(orgB, RECIPIENT, [orgB, personB], jobItem(jobA)))).toBe('42501');
    expect(await codeOf(run(orgA, RECIPIENT, [orgA, personA], {}))).toBe('42501');
  });

  it('a held webhook job resolves its own organization’s secret only', async () => {
    expect((await run(orgA, RESOLVE, [orgA, subA], jobItem(webhookJobA))).rows).toEqual([
      { signing_secret_ciphertext: `bind-cipher-a-${RUN}` },
    ]);
    expect(await codeOf(run(orgB, RESOLVE, [orgB, subB], jobItem(webhookJobA)))).toBe('42501');
    expect(await codeOf(run(orgB, RESOLVE, [orgB, subB], {}))).toBe('42501');
  });

  // ── Reminders ──────────────────────────────────────────────────────────
  it('a claimed reminder notifies exactly its own recipient in its own organization', async () => {
    const title = `bind-rem-${RUN}`;
    expect((await run(orgA, RECIPIENT, [orgA, personA], reminderItem(reminderA))).rows[0]!.ok).toBe(
      true,
    );
    expect((await run(orgA, CHANNEL, [orgA, personA], reminderItem(reminderA))).rows[0]!.ok).toBe(
      true,
    );
    await run(orgA, INSERT, [orgA, personA, title], reminderItem(reminderA));
    expect(await stored(title)).toEqual([{ org_id: orgA, person_id: personA }]);
  });

  it('a reminder cannot be used for another person, another organization, or before it is claimed', async () => {
    const title = `bind-rem-bad-${RUN}`;
    // Same organization, a different person than the reminder's.
    for (const sql of [INSERT, RECIPIENT, CHANNEL]) {
      const params = sql === INSERT ? [orgA, personA2, title] : [orgA, personA2];
      expect(await codeOf(run(orgA, sql, params, reminderItem(reminderA))), sql).toBe('42501');
    }
    // Another organization.
    expect(await codeOf(run(orgB, INSERT, [orgB, personB, title], reminderItem(reminderA)))).toBe(
      '42501',
    );
    // A reminder nobody has claimed.
    expect(
      await codeOf(run(orgA, INSERT, [orgA, personA, title], reminderItem(unclaimedReminderA))),
    ).toBe('42501');
    expect(await stored(title)).toEqual([]);
  });

  // ── The app_user side ──────────────────────────────────────────────────
  it('app_user with the complete worker settings reaches none of it', async () => {
    const title = `bind-appuser-${RUN}`;
    expect(await codeOf(run(orgA, INSERT, [orgA, personA, title], jobItem(jobA), appUser))).toBe(
      '42501',
    );
    expect(
      await codeOf(run(orgA, RECIPIENT, [orgA, personA], reminderItem(reminderA), appUser)),
    ).toBe('42501');
    expect(await codeOf(run(orgA, RESOLVE, [orgA, subA], jobItem(webhookJobA), appUser))).toBe(
      '42501',
    );
    expect(await stored(title)).toEqual([]);
  });
});
