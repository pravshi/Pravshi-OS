/**
 * Phase 8 — notification types: pure unit tests (no DB).
 */
import { describe, expect, it } from 'vitest';
import {
  mapNotificationRow,
  NOTIFICATION_EVENT_TYPES,
  NotificationEventSchema,
  NotificationEventTypeSchema,
  type NotificationRow,
} from '@/lib/notifications/types';

const UUID = '11111111-1111-4111-8111-111111111111';

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: UUID,
    org_id: '22222222-2222-4222-8222-222222222222',
    person_id: '33333333-3333-4333-8333-333333333333',
    type: 'TASK_ASSIGNED',
    title: 'Task assigned',
    message: 'You were assigned "Launch plan"',
    event_id: 'evt-1',
    data: {},
    read_at: null,
    created_at: '2026-10-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('NotificationEventTypeSchema', () => {
  it('accepts all 11 contract event types', () => {
    expect(NOTIFICATION_EVENT_TYPES).toHaveLength(11);
    for (const type of NOTIFICATION_EVENT_TYPES) {
      expect(NotificationEventTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it('rejects unknown types', () => {
    expect(NotificationEventTypeSchema.safeParse('DEAL_WON').success).toBe(false);
    expect(NotificationEventTypeSchema.safeParse('task_assigned').success).toBe(false);
  });
});

describe('NotificationEventSchema', () => {
  it('accepts a valid event', () => {
    const parsed = NotificationEventSchema.safeParse({
      eventId: UUID,
      type: 'MENTION',
      orgId: UUID,
      recipientUserId: UUID,
      title: 'You were mentioned',
      body: '…in a comment',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects empty title/body and non-uuid ids', () => {
    expect(
      NotificationEventSchema.safeParse({
        eventId: UUID,
        type: 'MENTION',
        orgId: UUID,
        recipientUserId: UUID,
        title: ' ',
        body: 'x',
      }).success,
    ).toBe(false);
    expect(
      NotificationEventSchema.safeParse({
        eventId: 'not-a-uuid',
        type: 'MENTION',
        orgId: UUID,
        recipientUserId: UUID,
        title: 't',
        body: 'b',
      }).success,
    ).toBe(false);
  });
});

describe('mapNotificationRow', () => {
  it('maps columns to the contract interface', () => {
    const n = mapNotificationRow(row());
    expect(n).toMatchObject({
      id: UUID,
      recipientUserId: '33333333-3333-4333-8333-333333333333',
      type: 'TASK_ASSIGNED',
      title: 'Task assigned',
      body: 'You were assigned "Launch plan"',
      readAt: null,
    });
    expect(n.metadata).toEqual({});
  });

  it('falls back to data.type for pre-0052 rows, then SYSTEM_ALERT', () => {
    expect(mapNotificationRow(row({ type: null, data: { type: 'DEAL_WON' } })).type).toBe(
      'SYSTEM_ALERT',
    );
    expect(mapNotificationRow(row({ type: null, data: { type: 'DEAL_UPDATED' } })).type).toBe(
      'DEAL_UPDATED',
    );
    expect(mapNotificationRow(row({ type: null, data: {} })).type).toBe('SYSTEM_ALERT');
  });

  it('extracts entityType/entityId from data', () => {
    const n = mapNotificationRow(row({ data: { entityType: 'task', entityId: 'task-9' } }));
    expect(n.entityType).toBe('task');
    expect(n.entityId).toBe('task-9');
  });
});
