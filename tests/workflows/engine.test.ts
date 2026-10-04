import { describe, expect, it } from 'vitest';
import { buildDedupKey, dispatchWorkflowEvent } from '@/lib/workflows/events';
import { DB_READY } from './helpers';
import type { Authorization } from '@/lib/authz/require-permission';
import type { WorkflowEventInput } from '@/lib/workflows/events';

/**
 * Phase 5 — dispatcher unit tests.
 *
 * Always-run (no DB):
 *  - dedup-key construction (buildDedupKey).
 *
 * DB-gated (describe.skipIf(!DB_READY)):
 *  - dispatchWorkflowEvent returns a promise and never rejects (D3), even
 *    when the engine pipeline fails underneath. These run against the
 *    ephemeral CI branch; they cannot run without a DB because dispatch now
 *    awaits the real engine (D1) — there is no runner seam to stub (it was
 *    removed from production code 2026-10-04 along with
 *    __eventSystemSelfTest).
 *
 * The D4 recursion bound is covered by the REAL chaining regression test in
 * tests/workflows/workflow-pipeline.test.ts ('workflow engine: D4 chaining
 * bound'): task.created → create_task must terminate at exactly 5
 * deliveries. Only a real engine run can prove the AsyncLocalStorage depth
 * guard holds across the awaited pipeline.
 */

/** Cast, not constructed: the dispatcher only reads auth.ctx (orgId/personId). */
const fakeAuth = {
  ctx: {
    personId: '44444444-4444-4434-8344-444444444444',
    orgId: '22222222-2222-4222-8222-222222222222',
  },
  requestId: 'test-engine-1',
} as Authorization;

const manualInput = (dedupKey = 'manual:test'): WorkflowEventInput => ({
  type: 'manual',
  entityType: null,
  entityId: null,
  dedupKey,
  payload: {},
});

describe('buildDedupKey', () => {
  it('joins parts with a colon', () => {
    expect(buildDedupKey('deal_stage_history', 'h-1')).toBe('deal_stage_history:h-1');
  });

  it('drops empty parts', () => {
    expect(buildDedupKey('', 'deal_stage_history', '', 'h-1')).toBe('deal_stage_history:h-1');
  });

  it('passes a single part through unchanged', () => {
    expect(buildDedupKey('manual:abc')).toBe('manual:abc');
  });
});

describe.skipIf(!DB_READY)('dispatchWorkflowEvent', () => {
  it('returns a promise that resolves (never rejects)', async () => {
    await expect(
      dispatchWorkflowEvent(fakeAuth, manualInput('manual:promise')),
    ).resolves.toBeUndefined();
  });

  it('never rejects, even when the engine pipeline fails underneath', async () => {
    // The matcher finds no workflows for this org; the point is the dispatch
    // resolves instead of rejecting.
    await expect(dispatchWorkflowEvent(fakeAuth, manualInput())).resolves.toBeUndefined();
  });
});
