import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/env';
import { WorkflowRunPayloadSchema, type Job } from '@/lib/jobs/types';
import type { Authorization } from '@/lib/authz/require-permission';
import type { WorkflowEventInput } from '@/lib/workflows/events';

// Inline-engine seam: observe whether the dispatcher ran the engine in-request.
vi.mock('@/lib/workflows/engine', () => ({
  runWorkflowsForEvent: vi.fn(),
}));

// Queue seam: observe enqueue attempts. This also intercepts the dispatcher's
// dynamic import('@/lib/jobs/queue'), since vitest serves dynamic imports from
// the same mocked module registry.
vi.mock('@/lib/jobs/queue', () => ({
  enqueueJob: vi.fn(),
}));

import { dispatchWorkflowEvent } from '@/lib/workflows/events';
import { runWorkflowsForEvent } from '@/lib/workflows/engine';
import { enqueueJob } from '@/lib/jobs/queue';

/**
 * Phase 6 — dispatcher queue-transport unit tests (Dispatcher Wiring Agent).
 *
 * Always-run (no DB): the engine and the queue are both mocked, so these
 * verify the transport decision only — flag off → inline, flag on →
 * enqueue, enqueue failure → inline fallback (D3). The real engine and the
 * real queue are covered by their own suites.
 */
const inlineRun = vi.mocked(runWorkflowsForEvent);
const enqueue = vi.mocked(enqueueJob);

/** Cast, not constructed: the dispatcher only reads auth.ctx (orgId/personId). */
const fakeAuth = {
  ctx: {
    personId: '44444444-4444-4434-8344-444444444444',
    orgId: '22222222-2222-4222-8222-222222222222',
  },
  requestId: 'test-dispatcher-queue-1',
} as Authorization;

const testInput = (dedupKey = 'queue:test:1'): WorkflowEventInput => ({
  type: 'deal.stage_changed',
  entityType: 'deal',
  entityId: '11111111-1111-4111-8111-111111111111',
  dedupKey,
  payload: { dealId: '11111111-1111-4111-8111-111111111111' },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fakeJob = { id: 'job-00000000-0000-4000-8000-000000000001' } as unknown as Job;

describe('dispatchWorkflowEvent queue transport (WORKFLOWS_USE_QUEUE)', () => {
  let savedFlag: string | undefined;

  beforeEach(() => {
    savedFlag = env.WORKFLOWS_USE_QUEUE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore the flag exactly (absent vs set matters: absent = default).
    if (savedFlag === undefined) {
      delete (env as Record<string, unknown>).WORKFLOWS_USE_QUEUE;
    } else {
      env.WORKFLOWS_USE_QUEUE = savedFlag;
    }
  });

  it('flag unset → runs inline, never enqueues (default behavior preserved)', async () => {
    delete (env as Record<string, unknown>).WORKFLOWS_USE_QUEUE;

    await dispatchWorkflowEvent(fakeAuth, testInput());

    expect(inlineRun).toHaveBeenCalledOnce();
    expect(inlineRun.mock.calls[0]?.[0]).toBe(fakeAuth);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('flag "false" → runs inline, never enqueues', async () => {
    env.WORKFLOWS_USE_QUEUE = 'false';

    await dispatchWorkflowEvent(fakeAuth, testInput());

    expect(inlineRun).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('flag "true" → enqueues a workflow_run job, does not run inline', async () => {
    env.WORKFLOWS_USE_QUEUE = 'true';
    enqueue.mockResolvedValue(fakeJob);
    const input = testInput('queue:test:payload');

    await dispatchWorkflowEvent(fakeAuth, input);

    expect(inlineRun).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
    const [authArg, jobInput] = enqueue.mock.calls[0] ?? [];
    expect(authArg).toBe(fakeAuth);
    expect(jobInput?.type).toBe('workflow_run');
    expect(jobInput?.dedupKey).toBe('queue:test:payload');
    // The payload must satisfy the queue contract the worker validates.
    const parsed = WorkflowRunPayloadSchema.parse(jobInput?.payload);
    expect(parsed.workflowId).toMatch(UUID_RE);
    expect(parsed.eventInput).toMatchObject({
      type: 'deal.stage_changed',
      entityType: 'deal',
      entityId: '11111111-1111-4111-8111-111111111111',
      dedupKey: 'queue:test:payload',
    });
    expect(parsed.depth).toBe(0);
  });

  it('flag "true" but enqueue throws (e.g. caller lacks jobs.create) → inline fallback, never rejects', async () => {
    env.WORKFLOWS_USE_QUEUE = 'true';
    enqueue.mockRejectedValueOnce(new Error('FORBIDDEN: PERMISSION_DENIED'));

    await expect(dispatchWorkflowEvent(fakeAuth, testInput())).resolves.toBeUndefined();

    expect(enqueue).toHaveBeenCalledOnce();
    expect(inlineRun).toHaveBeenCalledOnce();
  });
});
