import { describe, expect, it } from 'vitest';
import { evaluateConditions, type ConditionSnapshot } from '@/lib/workflows/conditions';
import {
  CreateWorkflowSchema,
  maxConditionDepth,
  type ConditionLeaf,
  type ConditionNode,
} from '@/lib/workflows/schema';
import type { WorkflowEvent } from '@/lib/workflows/events';

/**
 * Phase 5 — condition engine unit tests (A6). No DB, no env beyond import:
 * `evaluateConditions` is pure — it walks the condition tree against a
 * sanitized snapshot plus the event. Never throws; every uncertainty
 * (unknown field/operator, type mismatch, corrupt list) evaluates to
 * `false` (fail-closed). Empty conditions → `true`.
 *
 * Operator vocabulary is the ACTUAL schema enum (schema.ts), not the
 * shorthand from the task brief: equals / not_equals / contains /
 * not_contains / greater_than / greater_than_or_equal / less_than /
 * less_than_or_equal / exists / not_exists / in / not_in.
 */

const event: WorkflowEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  type: 'deal.stage_changed',
  entityType: 'deal',
  entityId: '33333333-3333-4333-8333-333333333333',
  actorPersonId: '44444444-4444-4434-8344-444444444444',
  occurredAt: '2026-10-04T08:00:00.000Z',
  dedupKey: 'deal_stage_history:h-1',
  payload: { isWon: true },
};

const snapshot: ConditionSnapshot = {
  deal: {
    value: '150000', // numeric-string, as deal.value arrives over the wire
    stage: 'WON',
    is_won: true,
    is_lost: false,
    probability: 90,
    owner_person_id: '55555555-5555-4555-8555-555555555555',
    pipeline_id: '66666666-6666-4666-8666-666666666666',
    title: 'Acme Renewal — Q4',
  },
  task: {
    status: 'in_progress',
    priority: 'high',
    assignee_person_id: null,
    project_id: '77777777-7777-4777-8777-777777777777',
    due_date: '2026-10-20',
  },
  project: { name: 'Onboarding', is_archived: false },
};

const leaf = (
  field: string,
  operator: ConditionLeaf['operator'],
  value?: unknown,
): ConditionLeaf => (value === undefined ? { field, operator } : { field, operator, value });

const evalLeaf = (
  field: string,
  operator: ConditionLeaf['operator'],
  value: unknown,
  snap: ConditionSnapshot = snapshot,
): boolean => evaluateConditions([leaf(field, operator, value)], snap, event);

describe('condition operators', () => {
  it('equals: numeric string compares numerically against a number', () => {
    expect(evalLeaf('deal.value', 'equals', 150000)).toBe(true);
    expect(evalLeaf('deal.value', 'equals', 149999)).toBe(false);
  });

  it('equals: booleans compare strictly', () => {
    expect(evalLeaf('deal.is_won', 'equals', true)).toBe(true);
    expect(evalLeaf('deal.is_won', 'equals', 'true')).toBe(false);
  });

  it('equals: null and undefined equal each other, but not concrete values', () => {
    // Numeric-aware equality: null/undefined equal only each other.
    expect(evalLeaf('task.assignee_person_id', 'equals', null)).toBe(true);
    expect(evalLeaf('task.assignee_person_id', 'equals', undefined)).toBe(true);
    expect(evalLeaf('task.assignee_person_id', 'equals', 'x')).toBe(false);
    expect(evalLeaf('deal.title', 'equals', null)).toBe(false);
  });

  it('not_equals: strict negation of equals', () => {
    expect(evalLeaf('deal.stage', 'not_equals', 'LOST')).toBe(true);
    expect(evalLeaf('deal.stage', 'not_equals', 'WON')).toBe(false);
  });

  it('contains: case-insensitive substring on text', () => {
    expect(evalLeaf('deal.title', 'contains', 'acme renewal')).toBe(true);
    expect(evalLeaf('deal.title', 'contains', 'globex')).toBe(false);
  });

  it('contains: non-text on either side is false (fail-closed)', () => {
    expect(evalLeaf('deal.probability', 'contains', '9')).toBe(false);
    expect(evalLeaf('deal.title', 'contains', 42)).toBe(false);
  });

  it('not_contains: strict negation of contains', () => {
    expect(evalLeaf('deal.title', 'not_contains', 'globex')).toBe(true);
    expect(evalLeaf('deal.title', 'not_contains', 'ACME')).toBe(false);
  });

  it('greater_than: numeric comparison incl. numeric-string coercion', () => {
    expect(evalLeaf('deal.probability', 'greater_than', 50)).toBe(true);
    expect(evalLeaf('deal.probability', 'greater_than', 90)).toBe(false);
    expect(evalLeaf('deal.value', 'greater_than', '100000')).toBe(true);
  });

  it('greater_than_or_equal / less_than / less_than_or_equal: boundary semantics', () => {
    expect(evalLeaf('deal.probability', 'greater_than_or_equal', 90)).toBe(true);
    expect(evalLeaf('deal.probability', 'less_than', 90)).toBe(false);
    expect(evalLeaf('deal.probability', 'less_than_or_equal', 90)).toBe(true);
    expect(evalLeaf('deal.probability', 'less_than', '100')).toBe(true);
  });

  it('ordered operators compare ISO date strings lexicographically', () => {
    expect(evalLeaf('task.due_date', 'greater_than', '2026-10-01')).toBe(true);
    expect(evalLeaf('task.due_date', 'less_than', '2026-10-01')).toBe(false);
    expect(evalLeaf('task.due_date', 'less_than_or_equal', '2026-10-20')).toBe(true);
  });

  it('ordered operators fail closed on incomparable operands', () => {
    expect(evalLeaf('deal.title', 'greater_than', '2026-10-01')).toBe(false);
    expect(evalLeaf('task.due_date', 'greater_than', 12345)).toBe(false);
    expect(evalLeaf('deal.stage', 'less_than', 'zzz')).toBe(false);
  });

  it('exists / not_exists: null and undefined count as missing', () => {
    expect(evalLeaf('task.assignee_person_id', 'exists', undefined)).toBe(false);
    expect(evalLeaf('task.assignee_person_id', 'not_exists', undefined)).toBe(true);
    expect(evalLeaf('deal.title', 'exists', undefined)).toBe(true);
    expect(evalLeaf('deal.title', 'not_exists', undefined)).toBe(false);
  });

  it('exists: empty string counts as existing', () => {
    const snap: ConditionSnapshot = { task: { ...snapshot.task, status: '' } };
    expect(evalLeaf('task.status', 'exists', undefined, snap)).toBe(true);
  });

  it('in: numeric-aware membership', () => {
    expect(evalLeaf('deal.stage', 'in', ['WON', 'NEGOTIATION'])).toBe(true);
    expect(evalLeaf('deal.stage', 'in', ['LOST'])).toBe(false);
    expect(evalLeaf('deal.probability', 'in', ['90', 80])).toBe(true); // "90" == 90
  });

  it('not_in: strict negation of in', () => {
    expect(evalLeaf('deal.stage', 'not_in', ['LOST'])).toBe(true);
    expect(evalLeaf('deal.stage', 'not_in', ['WON'])).toBe(false);
  });

  it('in / not_in with a corrupt list fail closed to false', () => {
    expect(evalLeaf('deal.stage', 'in', [])).toBe(false);
    expect(evalLeaf('deal.stage', 'in', 'WON')).toBe(false);
    // not_in must NOT negate a false that came from corruption.
    expect(evalLeaf('deal.stage', 'not_in', [])).toBe(false);
  });
});

describe('condition groups and nesting', () => {
  const won: ConditionNode = leaf('deal.is_won', 'equals', true);
  const bigDeal: ConditionNode = leaf('deal.value', 'greater_than', 100000);
  const lost: ConditionNode = leaf('deal.is_lost', 'equals', true);

  it('AND requires every child to be true', () => {
    expect(
      evaluateConditions([{ operator: 'AND', conditions: [won, bigDeal] }], snapshot, event),
    ).toBe(true);
    expect(
      evaluateConditions([{ operator: 'AND', conditions: [won, lost] }], snapshot, event),
    ).toBe(false);
  });

  it('OR requires at least one child to be true', () => {
    expect(evaluateConditions([{ operator: 'OR', conditions: [won, lost] }], snapshot, event)).toBe(
      true,
    );
    expect(
      evaluateConditions(
        [{ operator: 'OR', conditions: [lost, leaf('deal.value', 'greater_than', 999999)] }],
        snapshot,
        event,
      ),
    ).toBe(false);
  });

  it('NOT is expressed by negation operators nested inside groups', () => {
    const notWon: ConditionNode = {
      operator: 'OR',
      conditions: [leaf('deal.is_won', 'not_equals', true)],
    };
    expect(evaluateConditions([notWon], snapshot, event)).toBe(false);
    const notLost: ConditionNode = {
      operator: 'AND',
      conditions: [leaf('deal.is_lost', 'not_equals', true)],
    };
    expect(evaluateConditions([notLost], snapshot, event)).toBe(true);
  });

  it('supports arbitrarily nested AND/OR trees', () => {
    const tree: ConditionNode = {
      operator: 'AND',
      conditions: [
        { operator: 'OR', conditions: [won, lost] },
        {
          operator: 'AND',
          conditions: [bigDeal, leaf('project.is_archived', 'equals', false)],
        },
      ],
    };
    expect(evaluateConditions([tree], snapshot, event)).toBe(true);

    const failingTree: ConditionNode = {
      operator: 'AND',
      conditions: [{ operator: 'OR', conditions: [lost] }, bigDeal],
    };
    expect(evaluateConditions([failingTree], snapshot, event)).toBe(false);
  });

  it('evaluates event.* fields against the fixed event view', () => {
    expect(evalLeaf('event.type', 'equals', 'deal.stage_changed')).toBe(true);
    expect(evalLeaf('event.type', 'equals', 'task.created')).toBe(false);
    expect(
      evalLeaf('event.actor_person_id', 'equals', '44444444-4444-4434-8344-444444444444'),
    ).toBe(true);
  });

  it('missing snapshot sections resolve to undefined (exists → false)', () => {
    expect(evalLeaf('task.due_date', 'exists', undefined, {})).toBe(false);
    expect(evalLeaf('task.due_date', 'not_exists', undefined, {})).toBe(true);
    expect(evalLeaf('deal.title', 'equals', 'Acme', {})).toBe(false);
  });
});

describe('fail-closed evaluation', () => {
  it('empty conditions evaluate to true (no constraints)', () => {
    expect(evaluateConditions([], snapshot, event)).toBe(true);
  });

  it('unknown fields evaluate to false', () => {
    expect(evalLeaf('deal.evil_column', 'equals', 'x')).toBe(false);
    expect(evalLeaf('deal.title.evil', 'equals', 'x')).toBe(false);
    // Control: an allowlisted field still evaluates normally.
    expect(evalLeaf('deal.is_won', 'equals', true)).toBe(true);
  });

  it('forbidden path segments evaluate to false and never throw', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      expect(() =>
        evaluateConditions([leaf(`deal.${bad}`, 'equals', 'x')], snapshot, event),
      ).not.toThrow();
      expect(evaluateConditions([leaf(`deal.${bad}`, 'equals', 'x')], snapshot, event)).toBe(false);
    }
  });

  it('unknown operators evaluate to false (never throws)', () => {
    const rogue = {
      field: 'deal.title',
      operator: 'starts_with',
      value: 'A',
    } as unknown as ConditionNode;
    expect(() => evaluateConditions([rogue], snapshot, event)).not.toThrow();
    expect(evaluateConditions([rogue], snapshot, event)).toBe(false);
  });

  it('non-array groups and corrupt nodes evaluate to false', () => {
    const corrupt = { operator: 'AND', conditions: 'nope' } as unknown as ConditionNode;
    expect(evaluateConditions([corrupt], snapshot, event)).toBe(false);
  });
});

describe('save-time depth bound (schema)', () => {
  const nest = (depth: number): ConditionNode => {
    if (depth === 0) return leaf('deal.is_won', 'equals', true);
    return { operator: 'AND', conditions: [nest(depth - 1)] };
  };

  // The §11.2 DoS bounds live on the workflow-level conditions array
  // (CreateWorkflowSchema), not on ConditionNodeSchema itself — so the
  // bound tests parse a full workflow input with a valid trigger + action.
  const validAction = {
    type: 'create_task',
    params: { title: 'x', projectId: '77777777-7777-4777-8777-777777777777' },
  };
  const parseConditions = (conditions: unknown[]) =>
    CreateWorkflowSchema.safeParse({
      name: 'wf',
      trigger: { type: 'manual' },
      conditions,
      actions: [validAction],
    });

  it('maxConditionDepth measures nesting depth (lone leaf = 1, each group +1)', () => {
    expect(maxConditionDepth([leaf('deal.is_won', 'equals', true)])).toBe(1);
    expect(maxConditionDepth([nest(3)])).toBe(4);
    expect(maxConditionDepth([])).toBe(0);
  });

  it('rejects condition trees deeper than 5', () => {
    expect(parseConditions([nest(4)]).success).toBe(true); // depth exactly 5: allowed
    const tooDeep = parseConditions([nest(5)]); // depth 6
    expect(tooDeep.success).toBe(false);
    if (!tooDeep.success) {
      expect(tooDeep.error.issues[0]!.message).toContain('max nesting depth');
    }
  });

  it('rejects trees with more than 50 leaf nodes', () => {
    const leaves: ConditionNode[] = Array.from({ length: 51 }, () =>
      leaf('deal.is_won', 'equals', true),
    );
    const tooMany = parseConditions([{ operator: 'AND', conditions: leaves }]);
    expect(tooMany.success).toBe(false);
    if (!tooMany.success) {
      expect(tooMany.error.issues[0]!.message).toContain('50-leaf bound');
    }
    expect(parseConditions([{ operator: 'AND', conditions: leaves.slice(0, 50) }]).success).toBe(
      true,
    );
  });
});
