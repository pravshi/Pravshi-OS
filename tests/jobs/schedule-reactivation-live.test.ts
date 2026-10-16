/**
 * WP-W regression, LIVE DB — a paused schedule that fires more often than the minimum
 * interval cannot be enabled again, through either write path:
 *   - the API store (PATCH /api/schedules/[id] → updateSchedule, { isActive: true });
 *   - the scheduler library (resumeSchedule).
 * Driven as a real person holding jobs.view + jobs.create (the schedules RLS gate), against
 * the migrated database; the row stays paused after the refusal.
 *
 * Isolation: tests/jobs/scheduler-tick.test.ts deletes every schedule in the shared database
 * between its tests. If our row vanishes mid-attempt the attempt proves nothing, so each case
 * re-seeds and retries (up to 3 times) instead of flaking.
 *
 * Gated behind DB_READY; runs in CI against the ephemeral Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import type { Authorization } from '@/lib/authz/require-permission';

import { DB_READY, mkOrg, mkPerson, mkRoleFor, mkWorkflow, RUN } from '../workflows/helpers';

describe.skipIf(!DB_READY)('schedule reactivation respects the minimum interval (live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  let orgId = '';
  let auth: Authorization;
  let workflowId = '';

  beforeAll(async () => {
    if (!DB_READY) return;
    orgId = await mkOrg(owner, `react-${RUN}`);
    const personId = await mkPerson(owner, orgId, `React ${RUN}`);
    await mkRoleFor(owner, orgId, personId, `react_${RUN}`, ['jobs.view', 'jobs.create']);
    workflowId = (await mkWorkflow(owner, orgId)).id;
    // The store takes the caller's identity from auth.ctx; requestId is read on refusals,
    // and meta by the audit entry a successful update writes in the update's transaction.
    auth = {
      ctx: { personId, orgId, aal: 'aal1' },
      requestId: '00000000-0000-4000-8000-0000000000aa',
      meta: { requestId: '00000000-0000-4000-8000-0000000000aa', ip: null, userAgent: null },
    } as unknown as Authorization;
  }, 60_000);

  afterAll(async () => {
    if (!DB_READY) return;
    await owner.end();
  });

  const seedPaused = async (cron: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.schedules (org_id, workflow_id, name, cron, timezone, is_active, next_run_at)
         values ($1, $2, $3, $4, 'UTC', false, null) returning id`,
        [orgId, workflowId, `react-${RUN}-${Math.random()}`, cron],
      )
    ).rows[0]!.id;

  const state = async (id: string) =>
    (
      await owner.query<{ is_active: boolean }>(
        `select is_active from public.schedules where id = $1`,
        [id],
      )
    ).rows[0];

  /** Seed, attempt, and retry if a parallel suite deleted the row underneath us. */
  async function attempt(cron: string, act: (id: string) => Promise<unknown>) {
    for (let i = 0; i < 3; i++) {
      const id = await seedPaused(cron);
      const outcome = await act(id).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const row = await state(id);
      if (row) return { outcome, row };
    }
    throw new Error('schedule row kept disappearing (parallel scheduler-tick cleanup)');
  }

  it('the API store refuses to enable a paused 15-minute schedule; it stays paused', async () => {
    const { updateSchedule } = await import('@/app/api/jobs/store');
    const { outcome, row } = await attempt('*/15 * * * *', (id) =>
      updateSchedule(auth, id, { isActive: true }),
    );
    expect(outcome.ok).toBe(false);
    expect(String((outcome as { error: Error }).error.message)).toMatch(
      /INVALID_REQUEST: this schedule runs every 15 minutes/,
    );
    expect(row.is_active).toBe(false);
  });

  it('the API store enables a paused hourly schedule', async () => {
    const { updateSchedule } = await import('@/app/api/jobs/store');
    const { outcome, row } = await attempt('0 * * * *', (id) =>
      updateSchedule(auth, id, { isActive: true }),
    );
    expect(outcome.ok).toBe(true);
    expect(row.is_active).toBe(true);
  });

  it('the scheduler library refuses resumeSchedule for a paused 15-minute schedule', async () => {
    const { resumeSchedule } = await import('@/lib/jobs/scheduler');
    const { outcome, row } = await attempt('*/15 * * * *', (id) => resumeSchedule(auth, id));
    expect(outcome.ok).toBe(false);
    expect(String((outcome as { error: Error }).error.message)).toMatch(/runs every 15 minutes/);
    expect(row.is_active).toBe(false);
  });

  it('the scheduler library resumes a paused hourly schedule', async () => {
    const { resumeSchedule } = await import('@/lib/jobs/scheduler');
    const { outcome, row } = await attempt('0 * * * *', (id) => resumeSchedule(auth, id));
    expect(outcome.ok).toBe(true);
    expect(row.is_active).toBe(true);
  });
});
