/**
 * Phase 8 — notification job-payload builder: pure unit tests (no DB).
 */
import { describe, expect, it } from 'vitest';
import { buildNotificationJobPayload } from '@/lib/notifications/service';
import { makeNotificationEvent } from '@/lib/notifications/events';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('buildNotificationJobPayload', () => {
  it('builds the canonical Phase-6 notification payload with type/eventId in data', () => {
    const event = makeNotificationEvent({
      eventId: UUID,
      type: 'TASK_ASSIGNED',
      orgId: UUID,
      recipientUserId: UUID,
      title: 'Task assigned',
      body: 'You were assigned "Launch plan"',
      entityType: 'task',
      entityId: 'task-9',
    });
    const payload = buildNotificationJobPayload(event);
    expect(payload['personId']).toBe(UUID);
    expect(payload['title']).toBe('Task assigned');
    expect(payload['message']).toBe('You were assigned "Launch plan"');
    const data = payload['data'] as Record<string, unknown>;
    expect(data['type']).toBe('TASK_ASSIGNED');
    expect(data['eventId']).toBe(UUID);
    expect(data['entityType']).toBe('task');
    expect(data['entityId']).toBe('task-9');
  });

  it('omits absent optional fields and merges metadata without clobbering reserved keys', () => {
    const event = makeNotificationEvent({
      type: 'MENTION',
      orgId: UUID,
      recipientUserId: UUID,
      title: 't',
      body: 'b',
      metadata: { type: 'SPOOFED', custom: 1 },
    });
    const data = buildNotificationJobPayload(event)['data'] as Record<string, unknown>;
    expect(data['type']).toBe('MENTION');
    expect(data['custom']).toBe(1);
    expect(data).not.toHaveProperty('entityType');
    expect(data).not.toHaveProperty('link');
  });
});
