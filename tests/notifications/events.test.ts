/**
 * Phase 8 — notification events: pure unit tests (no DB).
 */
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { buildEventId, makeNotificationEvent } from '@/lib/notifications/events';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('makeNotificationEvent', () => {
  it('stamps a uuid eventId when absent', () => {
    const event = makeNotificationEvent({
      type: 'TASK_ASSIGNED',
      orgId: UUID,
      recipientUserId: UUID,
      title: 't',
      body: 'b',
    });
    expect(event.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('keeps a caller-supplied stable eventId', () => {
    const event = makeNotificationEvent({
      eventId: UUID,
      type: 'DEAL_STAGE_CHANGED',
      orgId: UUID,
      recipientUserId: UUID,
      title: 't',
      body: 'b',
      entityType: 'deal',
      entityId: 'deal-1',
    });
    expect(event.eventId).toBe(UUID);
    expect(event.entityType).toBe('deal');
  });

  it('throws ZodError on an unknown event type', () => {
    expect(() =>
      makeNotificationEvent({
        // @ts-expect-error — intentionally invalid
        type: 'BOGUS',
        orgId: UUID,
        recipientUserId: UUID,
        title: 't',
        body: 'b',
      }),
    ).toThrow(ZodError);
  });
});

describe('buildEventId', () => {
  it('joins parts with a colon', () => {
    expect(buildEventId('task-assigned', 'task-1', 'person-2')).toBe(
      'task-assigned:task-1:person-2',
    );
  });
});
