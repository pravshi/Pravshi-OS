import { describe, expect, it } from 'vitest';
import { doesTriggerMatch } from '@/lib/workflows/triggers';
import type { TriggerConfig } from '@/lib/workflows/schema';
import type { WorkflowEvent } from '@/lib/workflows/events';

/**
 * Phase 5 — trigger matcher unit tests (A5). No DB, no env beyond import:
 * `doesTriggerMatch` is the pure in-memory narrowing stage of matching
 * (type → entityType → filters EQUALS, all filters ANDed). Fail-closed on
 * every uncertainty: unknown filter keys and prototype-unsafe keys never
 * match and never throw.
 *
 * NOT covered here (DB-backed, see tests/workflows/workflow-pipeline.test.ts):
 *  - the SQL narrowing stage (`findMatchingWorkflows`): org scoping, the
 *    `status = 'ACTIVE'` + `deleted_at IS NULL` exclusion, `trigger_type`
 *    generated-column equality;
 *  - disabled-workflow exclusion (DRAFT/PAUSED/ARCHIVED workflows are dropped
 *    by the SQL stage and never execute).
 */

const baseEvent = (overrides: Partial<WorkflowEvent> = {}): WorkflowEvent => ({
  id: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  type: 'deal.stage_changed',
  entityType: 'deal',
  entityId: '33333333-3333-4333-8333-333333333333',
  actorPersonId: '44444444-4444-4434-8344-444444444444',
  occurredAt: '2026-10-04T08:00:00.000Z',
  dedupKey: 'deal_stage_history:h-1',
  payload: { isWon: true, dealValue: '150000', toStageName: 'Won' },
  ...overrides,
});

describe('doesTriggerMatch', () => {
  it('matches when the trigger type equals the event type and nothing narrows it', () => {
    const trigger: TriggerConfig = { type: 'deal.stage_changed' };
    expect(doesTriggerMatch(trigger, baseEvent())).toBe(true);
  });

  it('does not match when the trigger type differs from the event type', () => {
    const trigger: TriggerConfig = { type: 'task.created' };
    expect(doesTriggerMatch(trigger, baseEvent())).toBe(false);
  });

  it('matches when entityType narrows to the event entity type', () => {
    const trigger: TriggerConfig = { type: 'deal.stage_changed', entityType: 'deal' };
    expect(doesTriggerMatch(trigger, baseEvent())).toBe(true);
  });

  it('does not match when entityType narrows to a different entity', () => {
    const trigger: TriggerConfig = { type: 'deal.stage_changed', entityType: 'task' };
    expect(doesTriggerMatch(trigger, baseEvent())).toBe(false);
  });

  it('does not match an entityType-narrowed trigger when the event has no entity', () => {
    const trigger: TriggerConfig = { type: 'manual', entityType: 'deal' };
    const event = baseEvent({ type: 'manual', entityType: null, entityId: null });
    expect(doesTriggerMatch(trigger, event)).toBe(false);
  });

  it('matches when a single boolean filter equals the payload value', () => {
    const trigger: TriggerConfig = { type: 'deal.stage_changed', filters: { isWon: true } };
    expect(doesTriggerMatch(trigger, baseEvent())).toBe(true);
  });

  it('ANDs every filter: all matching filters match', () => {
    const trigger: TriggerConfig = {
      type: 'deal.stage_changed',
      filters: { isWon: true, dealValue: 150000, toStageName: 'Won' },
    };
    expect(doesTriggerMatch(trigger, baseEvent())).toBe(true);
  });

  it('ANDs every filter: one mismatching filter rejects the workflow', () => {
    const trigger: TriggerConfig = {
      type: 'deal.stage_changed',
      filters: { isWon: true, toStageName: 'Lost' },
    };
    expect(doesTriggerMatch(trigger, baseEvent())).toBe(false);
  });

  it('rejects when a filter key is absent from the payload (fail-closed)', () => {
    const trigger: TriggerConfig = {
      type: 'deal.stage_changed',
      filters: { pipelineId: 'some-pipeline' },
    };
    expect(doesTriggerMatch(trigger, baseEvent())).toBe(false);
  });

  it('compares numeric strings numerically against numbers', () => {
    const trigger: TriggerConfig = { type: 'deal.stage_changed', filters: { dealValue: 150000 } };
    expect(doesTriggerMatch(trigger, baseEvent())).toBe(true);
  });

  it('compares strings case-sensitively (WON !== won)', () => {
    const trigger: TriggerConfig = {
      type: 'deal.stage_changed',
      filters: { toStageName: 'won' },
    };
    expect(doesTriggerMatch(trigger, baseEvent())).toBe(false);
  });

  it('compares booleans strictly (true !== "true")', () => {
    const trigger: TriggerConfig = { type: 'deal.stage_changed', filters: { isWon: 'true' } };
    expect(doesTriggerMatch(trigger, baseEvent())).toBe(false);
  });

  it('rejects prototype-unsafe filter keys without throwing', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const trigger: TriggerConfig = { type: 'deal.stage_changed', filters: { [key]: true } };
      expect(() => doesTriggerMatch(trigger, baseEvent())).not.toThrow();
      expect(doesTriggerMatch(trigger, baseEvent())).toBe(false);
    }
  });

  it('treats an empty filters object as no constraint', () => {
    const trigger: TriggerConfig = { type: 'deal.stage_changed', filters: {} };
    expect(doesTriggerMatch(trigger, baseEvent())).toBe(true);
  });

  it('treats explicit undefined filters as no constraint', () => {
    const trigger: TriggerConfig = { type: 'deal.stage_changed', filters: undefined };
    expect(doesTriggerMatch(trigger, baseEvent())).toBe(true);
  });

  it('matches null filter values only against null payload values', () => {
    const trigger: TriggerConfig = { type: 'task.assigned', filters: { assigneePersonId: null } };
    const event = baseEvent({
      type: 'task.assigned',
      entityType: 'task',
      payload: { assigneePersonId: null },
    });
    expect(doesTriggerMatch(trigger, event)).toBe(true);
    const nonNull = baseEvent({
      type: 'task.assigned',
      entityType: 'task',
      payload: { assigneePersonId: undefined },
    });
    expect(doesTriggerMatch(trigger, nonNull)).toBe(false);
  });
});
