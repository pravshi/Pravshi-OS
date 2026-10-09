/**
 * Phase 8 — notifications integration tests (Workstream F, §42 + §35).
 *
 * Calls the REAL notification service functions against a live test database
 * under fabricated session identities (the Phase-7 harness pattern: owner
 * seeds fixtures, every service call runs through withAuthorizedDb() so RLS
 * evaluates under the caller's real identity). Nothing is mocked.
 *
 * Fixtures: Org A holds alice (recipient) and bob (other user); Org B holds
 * carol. Any row belonging to another user or tenant that becomes visible to
 * alice is an instant, obvious leak.
 *
 * On a plain `pnpm test` without credentials the suite collects and skips:
 * the service import chain validates env at import time, so service modules
 * are imported dynamically behind the HAS_DB gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '@/lib/db/context';
import type { Authorization } from '@/lib/authz/require-permission';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

/** Owner connection: seeds fixtures, bypasses RLS. */
const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

/** Unique per run: every seeded value is namespaced so other suites can't collide. */
const RUN = Math.random()
  .toString(36)
  .slice(2, 8)
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, 'X');
const newEid = () => randomUUID();

const tryImport = async <T>(path: string): Promise<T | null> => {
  try {
    return (await import(path)) as T;
  } catch {
    return null;
  }
};

type ServiceModule = typeof import('@/lib/notifications/service');
type PrefsModule = typeof import('@/lib/notifications/preferences');
type HandlersModule = typeof import('@/lib/jobs/handlers');
type WorkerModule = typeof import('@/lib/jobs/worker');
type RetryModule = typeof import('@/lib/jobs/retry');
type Job = import('@/lib/jobs/types').Job;
type CreateInput = import('@/lib/notifications/service').CreateNotificationInput;
type CreateResult = import('@/lib/notifications/service').CreateNotificationResult;

/* ── fixtures (owner connection) ─────────────────────────────────────────── */

const mkOrg = async (slug: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1,$2) returning id`,
      [`NOTIF ${slug}`, `notif-${slug.toLowerCase()}-${RUN.toLowerCase()}`],
    )
  ).rows[0]!.id;

const mkPerson = async (org: string, name: string) => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people
         (org_id, code, full_legal_name, person_status, date_of_birth, personal_email, phone)
       values ($1,$2,$3,'ACTIVE'::public.person_status,'1990-01-01',$4,'+91-00000-00000')
       returning id`,
      [org, code, name, `${name.toLowerCase().replace(/[^a-z]/g, '')}.${RUN}@example.test`],
    )
  ).rows[0]!.id;
};

const mkDept = async (org: string, code: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1,$2,$3) returning id`,
      [org, code, `Dept ${code}`],
    )
  ).rows[0]!.id;

const mkEngagement = async (org: string, person: string, dept: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.engagements
         (org_id, person_id, department_id, engagement_type, status, start_date)
       values ($1,$2,$3,'EMPLOYEE','ACTIVE'::public.engagement_status, current_date)
       returning id`,
      [org, person, dept],
    )
  ).rows[0]!.id;

const mkRoleFor = async (
  org: string,
  person: string,
  key: string,
  permissions: readonly string[],
) => {
  const role = (
    await owner.query<{ id: string }>(
      `insert into public.roles (org_id, key, name) values ($1,$2,$3) returning id`,
      [org, key.toUpperCase().replace(/[^A-Z0-9_]/g, '_'), `NOTIF ${key}`],
    )
  ).rows[0]!.id;
  for (const permission of permissions) {
    const { rowCount } = await owner.query(
      `insert into public.role_permissions (role_id, permission_id, scope)
       select $1, p.id, 'GLOBAL'::public.access_scope from public.permissions p where p.key = $2`,
      [role, permission],
    );
    if (rowCount !== 1) {
      throw new Error(`permission key ${permission} is not in the catalogue — cannot grant it`);
    }
  }
  await owner.query(
    `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
    [person, role, org],
  );
};

const makeAuth = (personId: string, orgId: string, permission: string): Authorization => ({
  ctx: { personId, orgId, aal: 'aal1' } as AuthContext,
  permission,
  scope: 'GLOBAL',
  aal: 'aal1',
  requestId: randomUUID(),
  meta: { requestId: randomUUID(), ip: null, userAgent: null },
});

describe.skipIf(!HAS_DB)('notifications integration (§42)', () => {
  let svc: ServiceModule | null = null;
  let prefs: PrefsModule | null = null;
  let handlers: HandlersModule | null = null;
  let worker: WorkerModule | null = null;
  let retry: RetryModule | null = null;

  let orgA = '';
  let orgB = '';
  let alice = '';
  let bob = '';
  let carol = '';
  let authAlice!: Authorization;
  let authBob!: Authorization;
  let authCarol!: Authorization;

  beforeAll(async () => {
    svc = await tryImport<ServiceModule>('@/lib/notifications/service');
    prefs = await tryImport<PrefsModule>('@/lib/notifications/preferences');
    handlers = await tryImport<HandlersModule>('@/lib/jobs/handlers');
    worker = await tryImport<WorkerModule>('@/lib/jobs/worker');
    retry = await tryImport<RetryModule>('@/lib/jobs/retry');
    if (!svc || !prefs || !handlers || !worker || !retry) return;

    orgA = await mkOrg('A');
    orgB = await mkOrg('B');
    alice = await mkPerson(orgA, `Alice ${RUN}`);
    bob = await mkPerson(orgA, `Bob ${RUN}`);
    carol = await mkPerson(orgB, `Carol ${RUN}`);

    // authz.scope_for()/has() resolve NO scope without a live engagement
    // (authz.is_active() reads engagements, 0005/0009) — every other suite's
    // fixtures create one per person; these must too, or RLS and the
    // jobs.create gate fail closed for every caller.
    const deptA = await mkDept(orgA, 'N8A');
    const deptB = await mkDept(orgB, 'N8B');
    await mkEngagement(orgA, alice, deptA);
    await mkEngagement(orgA, bob, deptA);
    await mkEngagement(orgB, carol, deptB);

    // alice: can receive + read notifications, enqueue jobs, see people (recipient check).
    await mkRoleFor(orgA, alice, `n_a_${RUN}`, [
      'notifications.view',
      'notifications.preferences.manage',
      // jobs.view accompanies jobs.create in every seeded system role
      // (0045 matrix): enqueueJob's INSERT ... RETURNING is only visible
      // under the jobs SELECT policy, which keys on jobs.view.
      'jobs.view',
      'jobs.create',
      'people.view',
    ]);
    // bob: a plain recipient (who manages his own preferences, per 0052 RLS).
    await mkRoleFor(orgA, bob, `n_b_${RUN}`, [
      'notifications.view',
      'notifications.preferences.manage',
    ]);
    await mkRoleFor(orgB, carol, `n_c_${RUN}`, [
      'notifications.view',
      'notifications.preferences.manage',
    ]);

    authAlice = makeAuth(alice, orgA, 'notifications.view');
    authBob = makeAuth(bob, orgA, 'notifications.view');
    authCarol = makeAuth(carol, orgB, 'notifications.view');
  }, 60_000);

  afterAll(async () => {
    await owner.end().catch(() => undefined);
  });

  /* ── worker-plane drain ──────────────────────────────────────────────────
   * createNotification only ENQUEUES a 'notification' job; the row appears
   * when the worker-plane handler runs. These helpers execute exactly the
   * enqueued job through the real path — buildJobAuthorization() (the
   * nil-UUID system actor) + handleNotification() — never a global claim,
   * so unrelated pending jobs are never touched. */
  const toIso = (v: unknown): string =>
    v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

  const loadJob = async (jobId: string): Promise<Job> => {
    const rows = await owner.query<Record<string, unknown>>(
      `select id, org_id, type, status, priority, payload, attempts, max_attempts,
              next_run_at, claimed_by, claimed_at, heartbeat_at, dedup_key,
              error_code, error_message, created_at, updated_at
       from public.jobs where id = $1`,
      [jobId],
    );
    const row = rows.rows[0];
    if (!row) throw new Error(`drain: job ${jobId} not found`);
    return {
      id: String(row.id),
      orgId: String(row.org_id),
      type: row.type as Job['type'],
      status: row.status as Job['status'],
      priority: Number(row.priority),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      nextRunAt: toIso(row.next_run_at),
      claimedBy: row.claimed_by == null ? null : String(row.claimed_by),
      claimedAt: row.claimed_at == null ? null : toIso(row.claimed_at),
      heartbeatAt: row.heartbeat_at == null ? null : toIso(row.heartbeat_at),
      dedupKey: row.dedup_key == null ? null : String(row.dedup_key),
      errorCode: row.error_code == null ? null : String(row.error_code),
      errorMessage: row.error_message == null ? null : String(row.error_message),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  };

  const runNotificationJob = async (job: Job): Promise<void> => {
    const auth = worker!.buildJobAuthorization(job);
    await handlers!.handleNotification({ job, auth, signal: new AbortController().signal });
  };

  const drainJob = async (jobId: string): Promise<void> => {
    await runNotificationJob(await loadJob(jobId));
  };

  /** createNotification + immediate worker-plane delivery of its exact job. */
  const createAndDrain = async (auth: Authorization, input: CreateInput): Promise<CreateResult> => {
    const res = await svc!.createNotification(auth, input);
    if (res.jobId) await drainJob(res.jobId);
    return res;
  };

  it('creates a notification for an event (in-app queued)', async () => {
    const res = await createAndDrain(authAlice, {
      eventId: newEid(),
      type: 'TASK_ASSIGNED',
      recipientUserId: alice,
      title: `Task assigned ${RUN}`,
      body: 'You were assigned a task',
    });
    expect(res.status).toBe('queued');
    expect(res.jobId).toBeDefined();

    const listed = await svc!.listNotifications(authAlice, { unreadOnly: true });
    const found = listed.notifications.find((n) => n.title === `Task assigned ${RUN}`);
    expect(found).toBeDefined();
    expect(found!.readAt).toBeNull();
    expect(found!.type).toBe('TASK_ASSIGNED');
  });

  // Five sequential create+drain cycles against a remote database: each
  // create is several authorized transactions plus a worker-plane delivery.
  // The 30s default is an environment-latency limit here, not a logic bound.
  it('retrieves own notifications newest-first with pagination', { timeout: 120_000 }, async () => {
    for (let i = 0; i < 5; i++) {
      await createAndDrain(authAlice, {
        eventId: newEid(),
        type: 'MENTION',
        recipientUserId: alice,
        title: `Mention ${RUN} #${i}`,
        body: 'ping',
      });
    }
    const p1 = await svc!.listNotifications(authAlice, { limit: 2, offset: 0 });
    const p2 = await svc!.listNotifications(authAlice, { limit: 2, offset: 2 });
    expect(p1.limit).toBe(2);
    expect(p1.notifications).toHaveLength(2);
    expect(p1.total).toBeGreaterThanOrEqual(5);
    const ids1 = new Set(p1.notifications.map((n) => n.id));
    for (const n of p2.notifications) expect(ids1.has(n.id)).toBe(false);
    // Newest first: created_at non-increasing.
    const all = await svc!.listNotifications(authAlice, { limit: 50 });
    const times = all.notifications.map((n) => new Date(n.createdAt).getTime());
    for (let i = 1; i < times.length; i++) expect(times[i - 1]!).toBeGreaterThanOrEqual(times[i]!);
    // Server clamps an absurd limit to the 50 max.
    const clamped = await svc!.listNotifications(authAlice, { limit: 9999 });
    expect(clamped.limit).toBe(50);
  });

  it('tracks the unread count', async () => {
    const before = await svc!.getUnreadCount(authBob);
    await createAndDrain(authAlice, {
      eventId: newEid(),
      type: 'TASK_DUE',
      recipientUserId: bob,
      title: `Due soon ${RUN}`,
      body: 'deadline approaching',
    });
    expect(await svc!.getUnreadCount(authBob)).toBe(before + 1);
  });

  it('marks one notification read, unread, and all read', async () => {
    await createAndDrain(authAlice, {
      eventId: newEid(),
      type: 'SYSTEM_ALERT',
      recipientUserId: bob,
      title: `Alert ${RUN}`,
      body: 'system',
    });
    const listed = await svc!.listNotifications(authBob, { unreadOnly: true });
    const target = listed.notifications.find((n) => n.title === `Alert ${RUN}`)!;
    expect(target).toBeDefined();

    const read = await svc!.markNotificationRead(authBob, target.id);
    expect(read.readAt).not.toBeNull();
    const unreadNow = (await svc!.listNotifications(authBob, { unreadOnly: true })).notifications;
    expect(unreadNow.some((n) => n.id === target.id)).toBe(false);

    const unread = await svc!.markNotificationUnread(authBob, target.id);
    expect(unread.readAt).toBeNull();

    const allRead = await svc!.markAllNotificationsRead(authBob);
    expect(allRead.updated).toBeGreaterThanOrEqual(1);
    expect(await svc!.getUnreadCount(authBob)).toBe(0);
  });

  it('dedupes on event_id (idempotent redelivery)', async () => {
    const dupEid = newEid();
    const first = await createAndDrain(authAlice, {
      eventId: dupEid,
      type: 'DEAL_UPDATED',
      recipientUserId: alice,
      title: `Deal update ${RUN}`,
      body: 'stage changed',
    });
    const second = await createAndDrain(authAlice, {
      eventId: dupEid,
      type: 'DEAL_UPDATED',
      recipientUserId: alice,
      title: `Deal update ${RUN}`,
      body: 'stage changed',
    });
    expect(first.status).toBe('queued');
    expect(second.status).toBe('duplicate');
    // The service contract returns `notification` only on the duplicate path;
    // the first call's delivered row is the one the duplicate must point at.
    const delivered = await owner.query<{ id: string }>(
      `select id from public.notifications where org_id=$1 and event_id=$2`,
      [orgA, dupEid],
    );
    expect(delivered.rows).toHaveLength(1);
    expect(second.notification!.id).toBe(delivered.rows[0]!.id);

    const rows = await owner.query<{ c: string }>(
      `select count(*) c from public.notifications where org_id=$1 and event_id=$2`,
      [orgA, dupEid],
    );
    expect(Number(rows.rows[0]!.c)).toBe(1);
  });

  it('isolates users: alice cannot see or touch bob (§35 IDOR)', async () => {
    await createAndDrain(authAlice, {
      eventId: newEid(),
      type: 'MENTION',
      recipientUserId: bob,
      title: `Bob-only ${RUN}`,
      body: 'for bob',
    });
    // Enumeration: bob's notification never appears in alice's list.
    const aliceList = await svc!.listNotifications(authAlice, { limit: 50 });
    expect(aliceList.notifications.some((n) => n.title === `Bob-only ${RUN}`)).toBe(false);
    // IDOR on the id: marking bob's notification read as alice → NOT_FOUND (no leak).
    const bobList = await svc!.listNotifications(authBob, {});
    const bobOnly = bobList.notifications.find((n) => n.title === `Bob-only ${RUN}`)!;
    await expect(svc!.markNotificationRead(authAlice, bobOnly.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // …and it is still unread for bob.
    expect(await svc!.getUnreadCount(authBob)).toBeGreaterThan(0);
    // Invalid UUID shape → validation error, not a DB probe.
    await expect(svc!.markNotificationRead(authAlice, 'not-a-uuid')).rejects.toThrow();
  });

  it('isolates tenants: carol (org B) cannot see org A notifications (§35)', async () => {
    await createAndDrain(authAlice, {
      eventId: newEid(),
      type: 'MENTION',
      recipientUserId: alice,
      title: `OrgA secret ${RUN}`,
      body: 'tenant a',
    });
    const carolList = await svc!.listNotifications(authCarol, { limit: 50 });
    expect(carolList.notifications.some((n) => n.title === `OrgA secret ${RUN}`)).toBe(false);
    expect(carolList.total).toBe(0);
    expect(await svc!.getUnreadCount(authCarol)).toBe(0);
  });

  it('rejects a cross-tenant recipient at creation', async () => {
    // alice (org A) tries to notify carol (org B) → INVALID_REQUEST.
    await expect(
      svc!.createNotification(authAlice, {
        eventId: newEid(),
        type: 'MENTION',
        recipientUserId: carol,
        title: `Cross ${RUN}`,
        body: 'nope',
      }),
    ).rejects.toThrow(/INVALID_REQUEST/);
  });

  it('honours preferences: disabling in_app skips the enqueue', async () => {
    // Default is enabled (opt-out model).
    const eff = await prefs!.getEffectivePreferences(authBob);
    const taskAssigned = eff.find(
      (p) => p.eventType === 'TASK_ASSIGNED' && p.channel === 'in_app',
    )!;
    expect(taskAssigned.enabled).toBe(true);

    await prefs!.upsertPreferences(authBob, [
      { eventType: 'TASK_ASSIGNED', channel: 'in_app', enabled: false },
    ]);
    const res = await createAndDrain(authAlice, {
      eventId: newEid(),
      type: 'TASK_ASSIGNED',
      recipientUserId: bob,
      title: `Suppressed ${RUN}`,
      body: 'in-app disabled',
    });
    expect(res.status).toBe('skipped');
    expect(res.inAppSkipped).toBe(true);
    expect(res.jobId).toBeUndefined();

    const eff2 = await prefs!.getEffectivePreferences(authBob);
    expect(
      eff2.find((p) => p.eventType === 'TASK_ASSIGNED' && p.channel === 'in_app')!.enabled,
    ).toBe(false);

    // Re-enable for later tests.
    await prefs!.upsertPreferences(authBob, [
      { eventType: 'TASK_ASSIGNED', channel: 'in_app', enabled: true },
    ]);
  });

  it('rejects invalid preference rows', async () => {
    await expect(
      prefs!.upsertPreferences(authBob, [
        { eventType: 'BOGUS_EVENT', channel: 'in_app', enabled: true },
      ]),
    ).rejects.toThrow();
    await expect(
      prefs!.upsertPreferences(authBob, [{ eventType: 'MENTION', channel: 'sms', enabled: true }]),
    ).rejects.toThrow();
  });

  it('handles concurrent reads consistently', async () => {
    await createAndDrain(authAlice, {
      eventId: newEid(),
      type: 'SYSTEM_ALERT',
      recipientUserId: alice,
      title: `Concurrent ${RUN}`,
      body: 'race',
    });
    // Two all-read sweeps at once: both succeed, unread ends at 0.
    const [r1, r2] = await Promise.all([
      svc!.markAllNotificationsRead(authAlice),
      svc!.markAllNotificationsRead(authAlice),
    ]);
    expect(r1.updated + r2.updated).toBeGreaterThanOrEqual(1);
    expect(await svc!.getUnreadCount(authAlice)).toBe(0);

    // Two concurrent mark-read on the same id: both resolve to a read notification.
    const one = (await svc!.listNotifications(authAlice, {})).notifications[0]!;
    const [m1, m2] = await Promise.all([
      svc!.markNotificationRead(authAlice, one.id),
      svc!.markNotificationRead(authAlice, one.id),
    ]);
    expect(m1.readAt).not.toBeNull();
    expect(m2.readAt).not.toBeNull();
  });

  it('preserves notifications whose target record was deleted (§43 scenario 7)', async () => {
    // A notification referencing a soft-deleted deal id still lists fine —
    // the notification is the durable record, not a live join.
    const res = await createAndDrain(authAlice, {
      eventId: newEid(),
      type: 'DEAL_UPDATED',
      recipientUserId: alice,
      title: `Deleted deal ${RUN}`,
      body: 'deal was deleted',
      entityType: 'deal',
      entityId: randomUUID(),
    });
    expect(res.status).toBe('queued');
    const listed = await svc!.listNotifications(authAlice, {});
    expect(listed.notifications.some((n) => n.title === `Deleted deal ${RUN}`)).toBe(true);
  });

  /* ── worker plane (regression: system-actor recipient check) ─────────────
   * The handler runs as the nil-UUID system actor from buildJobAuthorization,
   * which is not a people row and cannot see recipients through people_select
   * RLS. Migration 0052's notifications_recipient_exists() SECURITY DEFINER
   * check is what lets a real recipient through; these tests pin that path
   * with real recipients and no mocks. */
  const fabricatedJob = (orgId: string, payload: Record<string, unknown>): Job => ({
    id: randomUUID(),
    orgId,
    type: 'notification',
    status: 'running',
    priority: 0,
    payload,
    attempts: 1,
    maxAttempts: 5,
    nextRunAt: new Date().toISOString(),
    claimedBy: 'integration-worker',
    claimedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    dedupKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  it('worker plane: system actor delivers, and redelivery stays idempotent', async () => {
    const eid = newEid();
    const res = await svc!.createNotification(authAlice, {
      eventId: eid,
      type: 'MENTION',
      recipientUserId: alice,
      title: `Worker-delivered ${RUN}`,
      body: 'via the real handler',
    });
    expect(res.status).toBe('queued');
    const job = await loadJob(res.jobId!);
    await runNotificationJob(job);
    // At-least-once delivery: running the same job again must not duplicate.
    await runNotificationJob(job);
    const rows = await owner.query<{ id: string; type: string; person_id: string }>(
      `select id, type, person_id from public.notifications where org_id=$1 and event_id=$2`,
      [orgA, eid],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.type).toBe('MENTION');
    expect(rows.rows[0]!.person_id).toBe(alice);
  });

  it('worker plane: cross-org recipient fails NOT_FOUND (non-retryable), writes nothing', async () => {
    const eid = newEid();
    // Org A job naming carol (org B) — e.g. a corrupted or replayed payload.
    const job = fabricatedJob(orgA, {
      personId: carol,
      title: `Cross-org worker ${RUN}`,
      message: 'must never deliver',
      data: { type: 'MENTION', eventId: eid },
    });
    let caught: unknown = null;
    try {
      await runNotificationJob(job);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'NOT_FOUND' });
    expect(retry!.classifyError(caught).retryable).toBe(false);
    const rows = await owner.query<{ c: string }>(
      `select count(*) c from public.notifications where event_id=$1`,
      [eid],
    );
    expect(Number(rows.rows[0]!.c)).toBe(0);
  });

  it('worker plane: nonexistent recipient fails NOT_FOUND (non-retryable), writes nothing', async () => {
    const eid = newEid();
    const job = fabricatedJob(orgA, {
      personId: randomUUID(),
      title: `Ghost worker ${RUN}`,
      message: 'must never deliver',
      data: { type: 'MENTION', eventId: eid },
    });
    let caught: unknown = null;
    try {
      await runNotificationJob(job);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'NOT_FOUND' });
    expect(retry!.classifyError(caught).retryable).toBe(false);
    const rows = await owner.query<{ c: string }>(
      `select count(*) c from public.notifications where event_id=$1`,
      [eid],
    );
    expect(Number(rows.rows[0]!.c)).toBe(0);
  });
});
