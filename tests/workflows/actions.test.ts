/**
 * Phase 5 — action engine unit tests (A7). No DB, no env beyond import.
 *
 * ── IMPORT CYCLE HISTORY ──
 * src/lib/workflows used to have a module-eval-time import cycle
 * (schema → events → engine → actions → schema) that left
 * actions.ts's IMPLEMENTED_TYPE_SET empty on some import orders. Fixed
 * 2026-10-04: WORKFLOW_TRIGGER_TYPES moved into schema.ts (the cycle-free
 * module) and re-exported from events.ts — the module graph is now acyclic
 * and every import order initializes fully. The `import
 * '@/lib/workflows/triggers'` first is kept as a harmless import-order
 * probe.
 */
import '@/lib/workflows/triggers';
import { describe, expect, it } from 'vitest';
import {
  ACTION_REGISTRY,
  executeAction,
  resolveTemplates,
  type TemplateContext,
} from '@/lib/workflows/actions';
import {
  AssignTaskParamsSchema,
  CreateProjectParamsSchema,
  CreateTaskParamsSchema,
  LinkDealProjectParamsSchema,
  UpdateDealParamsSchema,
  UpdateTaskParamsSchema,
} from '@/lib/workflows/schema';
import type { Authorization } from '@/lib/authz/require-permission';
import type { WorkflowEvent } from '@/lib/workflows/events';

/** Cast, not constructed: the paths under test only read auth.ctx. */
const fakeAuth = {
  ctx: {
    personId: '44444444-4444-4434-8344-444444444444',
    orgId: '22222222-2222-4222-8222-222222222222',
  },
  requestId: 'test-actions-1',
} as Authorization;

const event: WorkflowEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  type: 'deal.stage_changed',
  entityType: 'deal',
  entityId: '33333333-3333-4333-8333-333333333333',
  actorPersonId: '44444444-4444-4434-8344-444444444444',
  occurredAt: '2026-10-04T08:00:00.000Z',
  dedupKey: 'deal_stage_history:h-1',
  payload: { dealId: '33333333-3333-4333-8333-333333333333', dealTitle: 'Acme Renewal' },
};

const context: TemplateContext = {
  event,
  deal: { title: 'Acme Renewal', value: '150000' },
};

const action = (type: string, params: Record<string, unknown>) =>
  ({ type, params }) as Parameters<typeof executeAction>[2];

const UUID = '77777777-7777-4777-8777-777777777777';

describe('resolveTemplates', () => {
  it('resolves a full-string template to the raw value (type preserved)', () => {
    const resolved = resolveTemplates({ dealId: '{{event.entityId}}' }, context);
    expect(resolved.dealId).toBe('33333333-3333-4333-8333-333333333333');
    const num = resolveTemplates({ value: '{{deal.value}}' }, context);
    expect(num.value).toBe('150000');
  });

  it('resolves nested paths (event.payload.*)', () => {
    const resolved = resolveTemplates({ title: '{{event.payload.dealTitle}}' }, context);
    expect(resolved.title).toBe('Acme Renewal');
  });

  it('interpolates templates embedded in larger strings', () => {
    const resolved = resolveTemplates(
      { name: 'Follow up: {{event.payload.dealTitle}} ({{deal.value}})' },
      context,
    );
    expect(resolved.name).toBe('Follow up: Acme Renewal (150000)');
  });

  it('throws INVALID_REQUEST on an unresolvable reference', () => {
    expect(() => resolveTemplates({ dealId: '{{event.missing}}' }, context)).toThrow(
      /INVALID_REQUEST: unresolvable template reference/,
    );
  });

  it('throws INVALID_REQUEST when a path traverses a non-object', () => {
    expect(() => resolveTemplates({ x: '{{deal.title.deep}}' }, context)).toThrow(
      /INVALID_REQUEST: unresolvable template reference/,
    );
  });

  it('rejects __proto__ / constructor / prototype segments (no prototype access)', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      expect(() => resolveTemplates({ x: `{{deal.${bad}}}` }, context)).toThrow(
        /INVALID_REQUEST: unsafe template reference/,
      );
    }
  });

  it('rejects non-primitive interpolation inside embedded templates', () => {
    expect(() => resolveTemplates({ name: 'Task: {{event.payload}}' }, context)).toThrow(
      /INVALID_REQUEST/,
    );
  });

  it('resolves templates inside arrays and nested objects', () => {
    const resolved = resolveTemplates(
      { tags: ['{{event.entityType}}'], meta: { ref: '{{deal.title}}' } },
      context,
    );
    expect(resolved).toEqual({ tags: ['deal'], meta: { ref: 'Acme Renewal' } });
  });

  it('leaves plain strings untouched', () => {
    const resolved = resolveTemplates({ title: 'Static title' }, context);
    expect(resolved.title).toBe('Static title');
  });
});

describe('executeAction: registry guards (never throws)', () => {
  it('rejects deferred (Phase 6+) actions with INVALID_REQUEST', async () => {
    for (const type of ['send_notification', 'send_email', 'webhook', 'run_ai_action']) {
      const result = await executeAction(fakeAuth, event, action(type, {}), context);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('INVALID_REQUEST');
      expect(result.errorMessage).toContain('not implemented in Phase 5');
    }
  });

  it('returns a failure envelope for an unknown action type', async () => {
    const result = await executeAction(fakeAuth, event, action('bogus_action', {}), context);
    expect(result).toMatchObject({ ok: false });
    expect(result.errorCode).toBe('INTERNAL');
    expect(typeof result.errorMessage).toBe('string');
    expect(result.errorMessage).not.toMatch(/bogus_action.*stack|at .*\(/);
  });

  it('never throws on the registry guard paths', async () => {
    await expect(
      Promise.all([
        executeAction(fakeAuth, event, action('send_email', {}), context),
        executeAction(fakeAuth, event, action('nope', {}), context),
      ]),
    ).resolves.toHaveLength(2);
  });

  it('rejects stage changes via update_deal with INVALID_REQUEST', async () => {
    for (const key of ['stage', 'stageId']) {
      const result = await executeAction(
        fakeAuth,
        event,
        action('update_deal', { dealId: event.entityId, [key]: 'WON' }),
        context,
      );
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('INVALID_REQUEST');
      expect(result.errorMessage).toContain('stage changes are not allowed');
    }
  });

  it('converts an unresolvable template into a FAILED envelope (never throws)', async () => {
    const result = await executeAction(
      fakeAuth,
      event,
      action('create_task', { title: '{{event.nope}}' }),
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('INVALID_REQUEST');
    expect(result.errorMessage).toContain('unresolvable template reference');
  });

  it('fails param validation before touching services', async () => {
    const result = await executeAction(
      fakeAuth,
      event,
      action('create_task', { title: '' }),
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('INVALID_REQUEST');
    expect(result.errorMessage).toContain('title');
  });
});

describe('per-action param schemas (direct zod validation)', () => {
  // Tested directly because executeAction's PARAM_SCHEMAS lookup is poisoned
  // by the circular import (see header). These are the exact schemas the
  // engine validates resolved params against.
  it('create_task: title required, uuids validated, templates accepted', () => {
    expect(CreateTaskParamsSchema.safeParse({ title: '', projectId: UUID }).success).toBe(false);
    expect(CreateTaskParamsSchema.safeParse({ title: 'x', projectId: 'not-a-uuid' }).success).toBe(
      false,
    );
    expect(CreateTaskParamsSchema.safeParse({ title: 'x', projectId: UUID }).success).toBe(true);
    expect(
      CreateTaskParamsSchema.safeParse({ title: 'x', projectId: '{{event.projectId}}' }).success,
    ).toBe(true);
    expect(
      CreateTaskParamsSchema.safeParse({ title: 'x', projectId: UUID, priority: 'urgent' }).success,
    ).toBe(true);
    expect(
      CreateTaskParamsSchema.safeParse({ title: 'x', projectId: UUID, priority: 'nope' }).success,
    ).toBe(false);
  });

  it('create_project: name required; dealId optional uuid/template', () => {
    expect(CreateProjectParamsSchema.safeParse({ name: '' }).success).toBe(false);
    expect(CreateProjectParamsSchema.safeParse({ name: 'P' }).success).toBe(true);
    expect(
      CreateProjectParamsSchema.safeParse({ name: 'P', dealId: '{{event.entityId}}' }).success,
    ).toBe(true);
    expect(CreateProjectParamsSchema.safeParse({ name: 'P', dealId: 'bad' }).success).toBe(false);
  });

  it('update_deal: probability 0–100, ownerPersonId carried (executor rejects it loudly)', () => {
    expect(UpdateDealParamsSchema.safeParse({ dealId: UUID, probability: 101 }).success).toBe(
      false,
    );
    expect(UpdateDealParamsSchema.safeParse({ dealId: UUID, probability: 80 }).success).toBe(true);
    expect(
      UpdateDealParamsSchema.safeParse({ dealId: UUID, expectedCloseDate: 'not-a-date' }).success,
    ).toBe(false);
    // ownerPersonId parses (schema-carried) — the EXECUTOR fails it with
    // INVALID_REQUEST rather than silently dropping it (A7 adaptation).
    expect(UpdateDealParamsSchema.safeParse({ dealId: UUID, ownerPersonId: UUID }).success).toBe(
      true,
    );
  });

  it('update_task: status/priority enums validated', () => {
    expect(UpdateTaskParamsSchema.safeParse({ taskId: UUID, status: 'done' }).success).toBe(true);
    expect(UpdateTaskParamsSchema.safeParse({ taskId: UUID, status: 'archived' }).success).toBe(
      false,
    );
    expect(UpdateTaskParamsSchema.safeParse({ taskId: 'bad' }).success).toBe(false);
  });

  it('assign_task: taskId + assigneePersonId required', () => {
    expect(AssignTaskParamsSchema.safeParse({ taskId: UUID }).success).toBe(false);
    expect(AssignTaskParamsSchema.safeParse({ taskId: UUID, assigneePersonId: UUID }).success).toBe(
      true,
    );
    expect(
      AssignTaskParamsSchema.safeParse({ taskId: UUID, assigneePersonId: '{{event.actor}}' })
        .success,
    ).toBe(true);
  });

  it('link_deal_project: projectId + dealId required', () => {
    expect(LinkDealProjectParamsSchema.safeParse({ projectId: UUID }).success).toBe(false);
    expect(LinkDealProjectParamsSchema.safeParse({ projectId: UUID, dealId: UUID }).success).toBe(
      true,
    );
  });
});

describe('action registry', () => {
  it('documents exactly the 6 implemented Phase-5 actions', () => {
    const implemented = Object.entries(ACTION_REGISTRY)
      .filter(([, entry]) => entry.implemented)
      .map(([type]) => type)
      .sort();
    expect(implemented).toEqual(
      [
        'assign_task',
        'create_project',
        'create_task',
        'link_deal_project',
        'update_deal',
        'update_task',
      ].sort(),
    );
  });

  it('marks the 4 Phase-6 actions as not implemented', () => {
    for (const type of ['send_notification', 'send_email', 'webhook', 'run_ai_action']) {
      expect(ACTION_REGISTRY[type as keyof typeof ACTION_REGISTRY].implemented).toBe(false);
    }
  });
});
