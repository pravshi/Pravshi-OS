/**
 * WP-W regression — enabling a paused schedule again enforces the minimum interval
 * (SCHEDULE_MIN_INTERVAL_MINUTES), including when its cron is unchanged. Before the fix,
 * PATCH { isActive: true } skipped the check, so a 15-minute schedule paused before the rule
 * existed could come back and keep Neon compute awake.
 *
 * DB-free: the store's transaction is mocked and records every statement, so the tests also
 * prove a refused reactivation writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  statements: [] as string[],
}));

vi.mock('@/lib/db/authorized', () => ({
  withAuthorizedDb: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      execute: async (q: { queryChunks?: unknown[] }) => {
        const text = JSON.stringify(q.queryChunks ?? q);
        hoisted.statements.push(text);
        const isUpdate = /update schedules/.test(text);
        const row = hoisted.current;
        return { rows: row ? [isUpdate ? { ...row, is_active: true } : row] : [], rowCount: 1 };
      },
    }),
  ),
}));
vi.mock('@/lib/jobs/audit', () => ({ auditJobsMutation: vi.fn(async () => undefined) }));
vi.mock('@/lib/jobs/wake', () => ({ requestWorkerWake: vi.fn(async () => 'disabled') }));

import { env } from '@/env';
import { updateSchedule } from '@/app/api/jobs/store';
import type { Authorization } from '@/lib/authz/require-permission';

const AUTH = {
  ctx: {
    personId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    aal: 'aal1',
  },
} as unknown as Authorization;
const ID = '33333333-3333-4333-8333-333333333333';

function scheduleRow(cron: string, isActive: boolean) {
  const now = new Date().toISOString();
  return {
    id: ID,
    org_id: AUTH.ctx.orgId,
    workflow_id: '44444444-4444-4444-8444-444444444444',
    name: 'legacy',
    cron,
    timezone: 'UTC',
    is_active: isActive,
    last_run_at: null,
    next_run_at: now,
    created_by: null,
    created_at: now,
    updated_at: now,
  };
}

const updates = () => hoisted.statements.filter((s) => /update schedules/.test(s));
const saved = env.SCHEDULE_MIN_INTERVAL_MINUTES;

beforeEach(() => {
  hoisted.statements.length = 0;
  env.SCHEDULE_MIN_INTERVAL_MINUTES = undefined; // default: 60
});
afterEach(() => {
  env.SCHEDULE_MIN_INTERVAL_MINUTES = saved;
});

describe('updateSchedule — reactivation enforces the minimum interval', () => {
  it('refuses to enable a paused 15-minute schedule with its cron unchanged, and writes nothing', async () => {
    hoisted.current = scheduleRow('*/15 * * * *', false);
    await expect(updateSchedule(AUTH, ID, { isActive: true })).rejects.toThrow(
      /INVALID_REQUEST: this schedule runs every 15 minutes; the minimum on this deployment is 60 minutes/,
    );
    expect(updates()).toHaveLength(0);
  });

  it('refuses reactivation even when the request also renames it', async () => {
    hoisted.current = scheduleRow('*/15 * * * *', false);
    await expect(updateSchedule(AUTH, ID, { isActive: true, name: 'renamed' })).rejects.toThrow(
      /INVALID_REQUEST/,
    );
    expect(updates()).toHaveLength(0);
  });

  it('allows enabling a paused hourly schedule', async () => {
    hoisted.current = scheduleRow('0 * * * *', false);
    await expect(updateSchedule(AUTH, ID, { isActive: true })).resolves.toMatchObject({
      isActive: true,
    });
    expect(updates()).toHaveLength(1);
  });

  it('allows reactivation with a new, compliant cron in the same request', async () => {
    hoisted.current = scheduleRow('*/15 * * * *', false);
    await expect(
      updateSchedule(AUTH, ID, { isActive: true, cron: '0 */2 * * *' }),
    ).resolves.toBeDefined();
    expect(updates()).toHaveLength(1);
  });

  it('does not check writes that leave the firing plan alone (rename, pause, already active)', async () => {
    hoisted.current = scheduleRow('*/15 * * * *', false);
    await expect(updateSchedule(AUTH, ID, { name: 'still paused' })).resolves.toBeDefined();
    hoisted.current = scheduleRow('*/15 * * * *', true);
    await expect(updateSchedule(AUTH, ID, { isActive: false })).resolves.toBeDefined();
    await expect(updateSchedule(AUTH, ID, { isActive: true })).resolves.toBeDefined(); // no-op
  });

  it("allows it when the deployment turns the check off ('0')", async () => {
    env.SCHEDULE_MIN_INTERVAL_MINUTES = '0';
    hoisted.current = scheduleRow('*/15 * * * *', false);
    await expect(updateSchedule(AUTH, ID, { isActive: true })).resolves.toBeDefined();
  });
});
